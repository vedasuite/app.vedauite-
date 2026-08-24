#!/usr/bin/env node
/**
 * Records the 14 historical migrations as applied. Nothing else.
 *
 * WHY
 * ---
 * Production's schema was created with `prisma db push`, so `_prisma_migrations`
 * has no record of the 14 migration files that were written afterwards. Prisma
 * therefore refuses to continue with P3005. Once every structure those
 * migrations create has been VERIFIED PRESENT, recording them as applied is
 * simply telling Prisma the truth.
 *
 * WHAT THIS DOES NOT DO
 * ---------------------
 *   - does not run any migration SQL
 *   - does not create, alter or drop any table, column, index or constraint
 *   - does not touch any foreign key or delete rule (production's CASCADE
 *     behaviour is correct and is left exactly as it is)
 *   - does not modify, delete or backfill any row of application data
 *   - does not run `prisma migrate deploy` or `prisma db push`
 *   - does NOT resolve 20260804_intelligence_finding_foundation, which must be
 *     APPLIED normally by a later `migrate deploy`
 *
 * The only thing that changes is the contents of `_prisma_migrations`.
 *
 * SAFETY PROPERTIES
 * -----------------
 * 1. Its own confirmation phrase, distinct from the verifier's and the repair's.
 * 2. The list of 14 is imported from the verifier, so it cannot drift from what
 *    was actually verified.
 * 3. It refuses outright if the pending migration appears anywhere in that list.
 * 4. Idempotent: a migration already recorded is reported and skipped, so a
 *    partial run can be re-run safely.
 * 5. Afterwards it re-reads `_prisma_migrations` and refuses to report success
 *    unless it holds exactly the 14 expected rows and NOT the pending one.
 * 6. Never prints the connection string.
 *
 * USAGE
 *   VEDASUITE_BASELINE_APPLY_CONFIRM=baseline-14-historical-migrations \
 *     node scripts/baseline-production-migrations.js
 *
 * EXIT CODES
 *   0  all 14 recorded, history verified
 *   1  something went wrong — read the output
 *   2  refused to start
 */

const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { Client } = require("pg");

const {
  HISTORICAL_MIGRATIONS,
  PENDING_MIGRATION,
} = require("./verify-production-baseline.js");

const REQUIRED_CONFIRMATION = "baseline-14-historical-migrations";

function refuse(message) {
  console.error(`\n[REFUSED] ${message}\n`);
  process.exit(2);
}

/** True when Prisma is telling us the migration is already recorded. */
function alreadyApplied(output) {
  return /already recorded as applied|P3008/i.test(output);
}

async function main() {
  if (process.env.VEDASUITE_BASELINE_APPLY_CONFIRM !== REQUIRED_CONFIRMATION) {
    refuse(
      "This script WRITES migration history to a production database and will not\n" +
        "run without an explicit confirmation, so it cannot execute as a side effect\n" +
        "of a build.\n\n" +
        `Set VEDASUITE_BASELINE_APPLY_CONFIRM=${REQUIRED_CONFIRMATION} to proceed.`
    );
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    refuse("DATABASE_URL is not set in this environment.");
  }

  const names = HISTORICAL_MIGRATIONS.map((m) => m.name);

  // Guard 3: the pending migration must never be resolved.
  if (names.includes(PENDING_MIGRATION)) {
    refuse(
      `${PENDING_MIGRATION} appears in the historical list. It must be APPLIED by\n` +
        "migrate deploy, never marked as done. Refusing to continue."
    );
  }
  if (names.length !== 14) {
    refuse(`expected 14 historical migrations, found ${names.length}. Refusing.`);
  }

  let hostFingerprint = "unknown";
  try {
    hostFingerprint = crypto
      .createHash("sha256")
      .update(new URL(connectionString).host)
      .digest("hex")
      .slice(0, 12);
  } catch {
    /* advisory only */
  }

  console.log("=".repeat(74));
  console.log("VedaSuite — record the 14 historical migrations as applied");
  console.log("=".repeat(74));
  console.log(`host fingerprint : sha256:${hostFingerprint}`);
  console.log(`timestamp        : ${new Date().toISOString()}`);
  console.log(`will NOT resolve : ${PENDING_MIGRATION}`);

  console.log(`\n${"-".repeat(74)}`);
  console.log("STEP A — prisma migrate resolve --applied (14 times)");
  console.log("-".repeat(74));

  const recorded = [];
  const skipped = [];

  for (const name of names) {
    try {
      execFileSync("npx", ["prisma", "migrate", "resolve", "--applied", name], {
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf8",
        shell: process.platform === "win32",
      });
      recorded.push(name);
      console.log(`  recorded  ${name}`);
    } catch (error) {
      const output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
      if (alreadyApplied(output)) {
        // Idempotent: a re-run after a partial success must not fail.
        skipped.push(name);
        console.log(`  already   ${name}`);
        continue;
      }
      console.error(`\n[FAILED] could not resolve ${name}`);
      console.error(output.trim().slice(0, 2000));
      console.error(
        "\nStop here. Migrations recorded so far are safe to keep — re-running this\n" +
          "script will skip them. Report this output."
      );
      process.exit(1);
    }
  }

  // --- Verify the resulting history -------------------------------------
  console.log(`\n${"-".repeat(74)}`);
  console.log("STEP B — verifying _prisma_migrations (read-only)");
  console.log("-".repeat(74));

  const client = new Client({
    connectionString,
    ssl: /sslmode=disable/.test(connectionString)
      ? false
      : { rejectUnauthorized: false },
  });
  await client.connect();

  let ok = true;
  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    const rows = (
      await client.query(
        `SELECT migration_name, finished_at, rolled_back_at
           FROM "_prisma_migrations" ORDER BY migration_name`
      )
    ).rows;

    const check = (condition, label) => {
      console.log(`  ${condition ? "PASS" : "FAIL"}  ${label}`);
      if (!condition) ok = false;
    };

    check(rows.length === 14, `exactly 14 rows recorded (found ${rows.length})`);
    check(
      rows.every((r) => r.finished_at),
      "every row is marked finished"
    );
    check(
      rows.every((r) => !r.rolled_back_at),
      "no row is marked rolled back"
    );
    check(
      !rows.some((r) => r.migration_name === PENDING_MIGRATION),
      `${PENDING_MIGRATION} is NOT recorded — it must still be applied normally`
    );

    const missing = names.filter(
      (n) => !rows.some((r) => r.migration_name === n)
    );
    check(missing.length === 0, `all 14 expected names present${missing.length ? `: missing ${missing.join(", ")}` : ""}`);

    await client.query("ROLLBACK");
  } finally {
    await client.end().catch(() => undefined);
  }

  console.log(`\n${"=".repeat(74)}`);
  if (ok) {
    console.log(
      `BASELINE COMPLETE — ${recorded.length} recorded, ${skipped.length} already present.`
    );
    console.log("Production Prisma is now baselined.");
    console.log(
      `\nThe next deploy will apply exactly one migration: ${PENDING_MIGRATION}.`
    );
    console.log("Do not deploy the application until that is explicitly approved.");
  } else {
    console.log("BASELINE INCOMPLETE — see the FAIL lines above. Report this output.");
  }
  console.log("=".repeat(74));

  process.exit(ok ? 0 : 1);
}

module.exports = { REQUIRED_CONFIRMATION };

if (require.main !== module) {
  return;
}

main().catch((error) => {
  console.error(`\n[ERROR] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

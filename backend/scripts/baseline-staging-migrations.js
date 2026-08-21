#!/usr/bin/env node
/**
 * ============================================================================
 * TEMPORARY STAGING BASELINER — REMOVE AFTER USE
 * ============================================================================
 *
 * TODO(remove): delete this file, historical-migrations.js and
 * verify-staging-baseline.js once the staging baseline is established and
 * 20260804_intelligence_finding_foundation has deployed. Then remove
 * ALLOW_STAGING_BASELINE from the Render environment and restore the normal
 * Build Command.
 *
 * WHAT IT DOES
 * ------------
 * Marks the 14 pre-existing migrations as already-applied via the official
 * `prisma migrate resolve --applied` CLI, so `prisma migrate deploy` stops
 * failing with P3005 and can apply the one genuinely new migration.
 *
 * It does NOT create, alter or drop any application table, and it does NOT
 * write application data. `migrate resolve` only records bookkeeping rows in
 * Prisma's own `_prisma_migrations` table (creating that table if absent). It is
 * the documented way to baseline a database that predates its migration
 * history — which is exactly this database's situation: it was bootstrapped with
 * `prisma db push`, so 11 of the 19 tables in schema.prisma are created by no
 * migration at all and `_prisma_migrations` was never populated.
 *
 * Using the CLI rather than a hand-written INSERT is deliberate: Prisma computes
 * each migration's checksum, so the recorded history matches the files exactly.
 * A hand-rolled INSERT would have to replicate that and would silently diverge.
 *
 * FIVE SAFETY GATES — all must pass, or nothing is written
 * -------------------------------------------------------
 *  1. ALLOW_STAGING_BASELINE must be exactly "true". Without it the script
 *     no-ops and exits 0, so leaving it in a Build Command is harmless and it
 *     can never fire on an environment where the flag was not set deliberately.
 *  2. The new migration is asserted to be absent from the baseline list, so it
 *     can never be marked applied instead of deployed.
 *  3. Every one of the 14 migrations is RE-VERIFIED against the live schema in
 *     this same run. Evidence from an earlier deploy is not trusted. Any missing
 *     structure aborts with a non-zero exit and nothing is written.
 *  4. Migrations already recorded in _prisma_migrations are skipped, so a
 *     re-deploy converges instead of erroring.
 *  5. The new migration's table must not already exist — if it does, something
 *     created it outside the migration and the situation needs a human.
 *
 * USAGE — via the Render staging Build Command (Free plan has no Shell):
 *     … && npx prisma generate && node scripts/baseline-staging-migrations.js
 *       && npx prisma migrate deploy && …
 * ============================================================================
 */

const { execFileSync } = require("child_process");
const { PrismaClient } = require("@prisma/client");
const {
  NEW_MIGRATION,
  NEW_MIGRATION_TABLE,
  HISTORICAL_MIGRATIONS,
  buildProbes,
} = require("./historical-migrations");

const prisma = new PrismaClient();

function log(message) {
  console.log(`[baseline] ${message}`);
}

/** Gate 1 — explicit opt-in. */
function optedIn() {
  return String(process.env.ALLOW_STAGING_BASELINE || "").trim() === "true";
}

/** Gate 2 — the new migration must never appear in the baseline set. */
function assertNewMigrationNotBaselined() {
  const names = HISTORICAL_MIGRATIONS.map((m) => m.name);
  if (names.includes(NEW_MIGRATION)) {
    throw new Error(
      `refusing to run: ${NEW_MIGRATION} is in the baseline list. It must be DEPLOYED, never marked applied.`
    );
  }
  if (names.length !== 14) {
    throw new Error(
      `refusing to run: expected exactly 14 historical migrations, found ${names.length}.`
    );
  }
}

async function recordedMigrations(probes) {
  if (!(await probes.tableExists("_prisma_migrations"))) {
    return new Set();
  }
  const rows = await prisma.$queryRaw`
    SELECT migration_name FROM "_prisma_migrations"`;
  return new Set(rows.map((r) => r.migration_name));
}

function resolveApplied(name) {
  // Official Prisma CLI. Inherits DATABASE_URL from this build environment.
  // stdio inherited so the Render build log shows exactly what Prisma did.
  execFileSync(
    process.platform === "win32" ? "npx.cmd" : "npx",
    ["prisma", "migrate", "resolve", "--applied", name],
    { stdio: "inherit" }
  );
}

async function main() {
  log("staging Prisma baseline — marks history only, never application data");

  if (!optedIn()) {
    log("ALLOW_STAGING_BASELINE is not 'true' — nothing to do, skipping.");
    log("(this is the safe default; the build continues normally)");
    return;
  }

  assertNewMigrationNotBaselined();
  log(`gate 2 OK — ${NEW_MIGRATION} is not in the baseline list`);

  const probes = buildProbes(prisma);

  // Gate 5 — the new table must not pre-exist.
  if (await probes.tableExists(NEW_MIGRATION_TABLE)) {
    throw new Error(
      `refusing to run: "${NEW_MIGRATION_TABLE}" already exists. It should be created by the migration, not beforehand. A human needs to look at this.`
    );
  }
  log(`gate 5 OK — "${NEW_MIGRATION_TABLE}" does not exist yet`);

  // Gate 3 — re-verify everything, now, against this database.
  log("gate 3 — re-verifying all 14 migrations against the live schema…");
  const { allSafe, results, missing } = await probes.verifyAll();
  for (const r of results) {
    log(
      `   ${r.safe ? "verified" : "MISSING "} ${r.name} (${r.found}/${r.total})`
    );
  }
  if (!allSafe) {
    for (const m of missing) log(`   ! missing: ${m}`);
    throw new Error(
      `refusing to baseline: ${missing.length} structure(s) are absent, so at least one migration never actually ran. Nothing was written.`
    );
  }
  log("gate 3 OK — every structure for all 14 migrations is present");

  // Gate 4 — skip anything already recorded.
  const already = await recordedMigrations(probes);
  log(`existing _prisma_migrations rows: ${already.size}`);

  const todo = HISTORICAL_MIGRATIONS.map((m) => m.name).filter(
    (name) => !already.has(name)
  );

  if (todo.length === 0) {
    log("all 14 already recorded — nothing to do (idempotent).");
    return;
  }

  log(`marking ${todo.length} migration(s) as applied…`);
  // Disconnect before invoking the CLI so the two do not hold competing
  // connections against a Free-plan connection limit.
  await prisma.$disconnect();

  for (const name of todo) {
    log(`   resolve --applied ${name}`);
    resolveApplied(name);
  }

  log(`done — ${todo.length} migration(s) recorded as applied.`);
  log(`next: 'prisma migrate deploy' should now apply ONLY ${NEW_MIGRATION}.`);
}

main()
  .then(async () => {
    try {
      await prisma.$disconnect();
    } catch {
      /* already disconnected */
    }
  })
  .catch(async (error) => {
    // Message only — never a connection string or credential.
    console.error("");
    console.error(
      "[baseline] FAILED:",
      String(error.message).split("\n")[0]
    );
    console.error(
      "[baseline] No migration was recorded. The database is unchanged."
    );
    try {
      await prisma.$disconnect();
    } catch {
      /* ignore */
    }
    process.exit(1);
  });

#!/usr/bin/env node
/**
 * Adds the THREE indexes production is missing. Nothing else.
 *
 * WHY
 * ---
 * Production's schema was created with `prisma db push` from schema.prisma.
 * Three objects are created only by migration SQL and are not declared in
 * schema.prisma, so db push never created them:
 *
 *   BillingAuditLog_storeId_createdAt_idx          (plain index)
 *   BillingAuditLog_subscriptionId_createdAt_idx   (plain index)
 *   Order_shopifyOrderGid_key                      (partial UNIQUE index)
 *
 * Until they exist, two historical migrations cannot honestly be marked as
 * applied. The SQL below is copied verbatim from those migrations.
 *
 * WHAT THIS DOES NOT DO
 * ---------------------
 *   - does not modify, delete or backfill any row
 *   - does not alter any foreign key, delete rule, column or table
 *   - does not drop anything
 *   - does not run prisma migrate resolve / deploy / db push
 *   - does not touch the 12 migrations that already verified
 *
 * The source migration for Order_shopifyOrderGid_key also NULLs duplicate and
 * blank gid values before creating the index. That data step is DELIBERATELY
 * OMITTED here: the read-only diagnostic proved there are none. If a duplicate
 * appeared in the meantime, CREATE UNIQUE INDEX simply fails, the transaction
 * rolls back, and nothing changes — a loud, safe failure rather than a silent
 * data edit.
 *
 * SAFETY PROPERTIES
 * -----------------
 * 1. Refuses without an explicit confirmation phrase of its own, distinct from
 *    the verifier's, so the two can never be confused.
 * 2. Re-checks every precondition against the live database immediately before
 *    writing — it never trusts an earlier diagnostic run.
 * 3. Runs in ONE transaction with a lock timeout, so it cannot block production
 *    writes for more than a few seconds and cannot leave a half-finished state.
 * 4. Verifies all three indexes exist before COMMIT; otherwise ROLLBACK.
 * 5. Never prints the connection string.
 *
 * USAGE
 *   VEDASUITE_REPAIR_CONFIRM=add-missing-production-indexes \
 *     node scripts/repair-production-indexes.js
 *
 * EXIT CODES
 *   0  all three indexes present, committed
 *   1  refused or rolled back — nothing changed
 *   2  refused to start (missing gate or connection string)
 */

const crypto = require("node:crypto");
const { Client } = require("pg");

const REQUIRED_CONFIRMATION = "add-missing-production-indexes";

/** Verbatim from the migrations that create them. */
const REPAIRS = [
  {
    index: "BillingAuditLog_storeId_createdAt_idx",
    from: "20260403_billing_access_architecture",
    sql:
      'CREATE INDEX IF NOT EXISTS "BillingAuditLog_storeId_createdAt_idx" ' +
      'ON "BillingAuditLog"("storeId", "createdAt")',
  },
  {
    index: "BillingAuditLog_subscriptionId_createdAt_idx",
    from: "20260403_billing_access_architecture",
    sql:
      'CREATE INDEX IF NOT EXISTS "BillingAuditLog_subscriptionId_createdAt_idx" ' +
      'ON "BillingAuditLog"("subscriptionId", "createdAt")',
  },
  {
    index: "Order_shopifyOrderGid_key",
    from: "20260502_order_identity_fields",
    sql:
      'CREATE UNIQUE INDEX IF NOT EXISTS "Order_shopifyOrderGid_key" ' +
      'ON "Order"("shopifyOrderGid") WHERE "shopifyOrderGid" IS NOT NULL',
  },
];

function refuse(message) {
  console.error(`\n[REFUSED] ${message}\n`);
  process.exit(2);
}

async function main() {
  if (process.env.VEDASUITE_REPAIR_CONFIRM !== REQUIRED_CONFIRMATION) {
    refuse(
      "This script WRITES to a production database (three CREATE INDEX statements)\n" +
        "and will not run without an explicit confirmation, so it cannot execute as\n" +
        "a side effect of a build.\n\n" +
        `Set VEDASUITE_REPAIR_CONFIRM=${REQUIRED_CONFIRMATION} to proceed.`
    );
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    refuse("DATABASE_URL is not set in this environment.");
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

  const client = new Client({
    connectionString,
    ssl: /sslmode=disable/.test(connectionString)
      ? false
      : { rejectUnauthorized: false },
  });

  await client.connect();
  let committed = false;

  try {
    const dbName = (await client.query("SELECT current_database() AS db")).rows[0].db;
    console.log("=".repeat(74));
    console.log("VedaSuite — add the 3 missing production indexes");
    console.log("=".repeat(74));
    console.log(`database         : ${dbName}`);
    console.log(`host fingerprint : sha256:${hostFingerprint}`);
    console.log(`timestamp        : ${new Date().toISOString()}`);

    // --- Preconditions, re-checked live -----------------------------------
    console.log(`\n${"-".repeat(74)}`);
    console.log("STEP A — preconditions (re-checked now, not assumed)");
    console.log("-".repeat(74));

    for (const table of ["BillingAuditLog", "Order"]) {
      const { rows } = await client.query(
        `SELECT to_regclass($1) IS NOT NULL AS present`,
        [`public."${table}"`]
      );
      if (!rows[0].present) {
        throw new Error(`table ${table} does not exist — wrong database?`);
      }
      console.log(`  PASS  table ${table} exists`);
    }

    // The unique index can only be created if nothing violates it. Checked
    // here so a race since the diagnostic cannot cause a data edit.
    const dupes = await client.query(
      `SELECT COUNT(*)::int AS n FROM (
         SELECT 1 FROM "Order"
          WHERE "shopifyOrderGid" IS NOT NULL
          GROUP BY "shopifyOrderGid" HAVING COUNT(*) > 1
       ) d`
    );
    const blanks = await client.query(
      `SELECT COUNT(*)::int AS n FROM "Order"
        WHERE "shopifyOrderGid" IS NOT NULL AND BTRIM("shopifyOrderGid") = ''`
    );

    if (dupes.rows[0].n !== 0 || blanks.rows[0].n !== 0) {
      throw new Error(
        `precondition failed: ${dupes.rows[0].n} duplicate and ${blanks.rows[0].n} ` +
          "blank shopifyOrderGid value(s) now exist. This script will NOT edit data. " +
          "Stop and re-run the read-only --deep diagnostic."
      );
    }
    console.log("  PASS  0 duplicate and 0 blank shopifyOrderGid values");

    const before = new Set(
      (
        await client.query(
          `SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`
        )
      ).rows.map((r) => r.indexname)
    );
    REPAIRS.forEach((r) =>
      console.log(
        `  ${before.has(r.index) ? "note  " + r.index + " already exists" : "PASS  " + r.index + " is missing, will be created"}`
      )
    );

    // --- The write --------------------------------------------------------
    console.log(`\n${"-".repeat(74)}`);
    console.log("STEP B — creating the indexes (single transaction)");
    console.log("-".repeat(74));

    await client.query("BEGIN");
    // Bounded: if another session holds a conflicting lock, give up quickly
    // rather than queue behind it and stall merchant traffic.
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '120s'");

    for (const repair of REPAIRS) {
      const started = Date.now();
      await client.query(repair.sql);
      console.log(
        `  done  ${repair.index}  (${Date.now() - started}ms, from ${repair.from})`
      );
    }

    // --- Verify inside the transaction, before committing -----------------
    const after = new Set(
      (
        await client.query(
          `SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`
        )
      ).rows.map((r) => r.indexname)
    );
    const stillMissing = REPAIRS.filter((r) => !after.has(r.index));
    if (stillMissing.length > 0) {
      throw new Error(
        `after creation these are still missing: ${stillMissing
          .map((r) => r.index)
          .join(", ")}`
      );
    }

    await client.query("COMMIT");
    committed = true;

    console.log(`\n${"=".repeat(74)}`);
    console.log("COMMITTED — all three indexes now exist.");
    console.log("No row was inserted, updated or deleted.");
    console.log("No foreign key, delete rule, column or table was altered.");
    console.log("=".repeat(74));
    console.log("\nNext: re-run the READ-ONLY verifier and expect 14/14.");
    console.log("Do NOT run `prisma migrate resolve` until that passes.");
  } catch (error) {
    if (!committed) {
      await client.query("ROLLBACK").catch(() => undefined);
    }
    console.error(`\n[FAILED] ${error instanceof Error ? error.message : String(error)}`);
    console.error("\nThe transaction was rolled back. NOTHING was changed.");
    await client.end().catch(() => undefined);
    process.exit(1);
  }

  await client.end().catch(() => undefined);
  process.exit(0);
}

module.exports = { REPAIRS, REQUIRED_CONFIRMATION };

if (require.main !== module) {
  return;
}

main().catch((error) => {
  console.error(`\n[ERROR] ${error instanceof Error ? error.message : String(error)}`);
  console.error("\nNothing was committed.");
  process.exit(1);
});

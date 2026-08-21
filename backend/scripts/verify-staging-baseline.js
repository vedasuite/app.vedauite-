#!/usr/bin/env node
/**
 * ============================================================================
 * TEMPORARY STAGING BASELINE VERIFIER — READ-ONLY — REMOVE AFTER USE
 * ============================================================================
 *
 * TODO(remove): delete this file once the staging Prisma baseline has been
 * established and `20260804_intelligence_finding_foundation` has deployed.
 * It is a one-off operational diagnostic, not application code. Nothing in the
 * app imports it, and it is never executed by the server, a route, a job or a
 * build step — it only runs when a human invokes it explicitly.
 *
 * WHY THIS EXISTS
 * ---------------
 * `prisma migrate deploy` fails on staging with P3005 ("the database schema is
 * not empty"). Both databases were originally bootstrapped with `prisma db
 * push`, so `_prisma_migrations` was never populated: 11 of the 19 tables in
 * schema.prisma are created by NO migration at all, the first migration only
 * ALTERs an already-existing Store table, and migrations/migration_lock.toml is
 * absent. The migrations folder was added later as hand-written incremental SQL.
 *
 * The correct fix is Prisma's documented baselining flow: mark the historical
 * migrations as already-applied, then deploy only the genuinely new one. But a
 * migration must only be marked applied if the structures it creates ACTUALLY
 * EXIST — otherwise the database is permanently out of step with the code.
 *
 * This script provides that evidence. It answers, per migration:
 *   "is every structure this migration creates already present?"
 *
 * SAFETY
 * ------
 *  - Read-only. Issues ONLY SELECT statements against information_schema and
 *    COUNT(*) aggregates. Contains no INSERT / UPDATE / DELETE / CREATE /
 *    ALTER / DROP / TRUNCATE, no $executeRaw, and no Prisma migrate command.
 *  - Prints no secrets. It never reads or logs DATABASE_URL, passwords or
 *    tokens; the connection comes from the environment Prisma already uses.
 *  - Prints no merchant or customer data. Table checks read information_schema
 *    metadata only, and the data section reports COUNT(*) totals — never a row.
 *
 * USAGE
 * -----
 * Run inside the Render `vedasuite-staging` service shell, where DATABASE_URL
 * already points at the staging database:
 *
 *     cd /opt/render/project/src/backend && node scripts/verify-staging-baseline.js
 *
 * Do NOT run it from a developer laptop: backend/.env may point at production.
 * The script only reads, so it could do no damage, but the output would then
 * describe the wrong database and could lead to baselining the wrong one.
 * ============================================================================
 */

const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

// The 14 historical migrations, the structures each one creates, the row-count
// tables and the read-only probes all live in historical-migrations.js (see that
// file for the spec grammar). Sharing them means this verifier and
// baseline-staging-migrations.js can never disagree about what is being VERIFIED
// versus what is being MARKED APPLIED.
const {
  NEW_MIGRATION_TABLE,
  HISTORICAL_MIGRATIONS,
  ROW_COUNT_TABLES,
  buildProbes,
} = require("./historical-migrations");

const { tableExists, checkSpec } = buildProbes(prisma);


// --- report sections ---------------------------------------------------------

async function reportMigrationHistory() {
  console.log("=== A. PRISMA MIGRATION HISTORY ===");
  const exists = await tableExists("_prisma_migrations");
  console.log(`_prisma_migrations table exists : ${exists}`);

  if (!exists) {
    console.log("recorded migration rows        : 0 (table absent)");
    console.log(
      "note                           : an absent history table with a populated schema is exactly what produces P3005."
    );
    return;
  }

  const rows = await prisma.$queryRaw`
    SELECT migration_name, finished_at, rolled_back_at
    FROM "_prisma_migrations" ORDER BY started_at`;
  console.log(`recorded migration rows        : ${rows.length}`);
  for (const row of rows) {
    const state = row.rolled_back_at
      ? "ROLLED BACK"
      : row.finished_at
      ? "applied"
      : "INCOMPLETE";
    console.log(`   - ${row.migration_name} [${state}]`);
  }
  if (rows.length === 0) {
    console.log(
      "note                           : table present but empty — still P3005."
    );
  }
}

async function reportVerdicts() {
  console.log("");
  console.log("=== B. PER-MIGRATION BASELINE VERDICT ===");

  const missing = [];
  let allSafe = true;

  for (const migration of HISTORICAL_MIGRATIONS) {
    let found = 0;
    for (const spec of migration.specs) {
      if (await checkSpec(spec)) {
        found += 1;
      } else {
        missing.push(`${migration.name} -> ${spec}`);
      }
    }
    const safe = found === migration.specs.length;
    if (!safe) allSafe = false;
    const label = safe ? "SAFE TO BASELINE" : "DO NOT BASELINE ";
    console.log(
      `${label}  ${migration.name}  (${found}/${migration.specs.length} present)`
    );
  }

  console.log("");
  if (missing.length === 0) {
    console.log("MISSING STRUCTURES : none");
  } else {
    console.log(`MISSING STRUCTURES : ${missing.length}`);
    for (const item of missing) console.log(`   ! ${item}`);
  }

  console.log("");
  console.log(
    `OVERALL VERDICT    : ${
      allSafe
        ? `ALL ${HISTORICAL_MIGRATIONS.length} SAFE TO BASELINE`
        : "NOT ALL SAFE — DO NOT BASELINE"
    }`
  );
  if (!allSafe) {
    console.log(
      "                     A missing structure means that migration never actually ran."
    );
    console.log(
      "                     Recording it as applied would leave the database out of step with the code."
    );
  }
  return allSafe;
}

async function reportNewTable() {
  console.log("");
  console.log("=== C. NEW MIGRATION TARGET ===");
  const exists = await tableExists(NEW_MIGRATION_TABLE);
  console.log(`${NEW_MIGRATION_TABLE} exists : ${exists}`);
  console.log(
    `expected before deploy   : false (it must be created BY the migration, never by hand)`
  );

  if (exists) {
    const indexes = await prisma.$queryRaw`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = ${NEW_MIGRATION_TABLE}
      ORDER BY indexname`;
    console.log(`indexes present          : ${indexes.length}`);
    for (const index of indexes) console.log(`   - ${index.indexname}`);

    const fks = await prisma.$queryRaw`
      SELECT c.conname, c.confdeltype
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      WHERE t.relname = ${NEW_MIGRATION_TABLE} AND c.contype = 'f'`;
    for (const fk of fks) {
      console.log(
        `   FK ${fk.conname} (on delete: ${
          fk.confdeltype === "c" ? "CASCADE" : fk.confdeltype
        })`
      );
    }
  }
}

async function reportRowCounts() {
  console.log("");
  console.log("=== D. ROW COUNTS (totals only — no row data) ===");
  for (const table of ROW_COUNT_TABLES) {
    try {
      // Identifier is from the hard-coded ROW_COUNT_TABLES list above, never
      // from input, so there is no injection surface here.
      const rows = await prisma.$queryRawUnsafe(
        `SELECT COUNT(*)::text AS n FROM "${table}"`
      );
      console.log(`   ${table.padEnd(20)} ${rows[0].n}`);
    } catch (error) {
      const first = String(error.message).split("\n")[0];
      console.log(`   ${table.padEnd(20)} (not readable: ${first})`);
    }
  }
  console.log("");
  console.log(
    "Re-run this script after the deploy and compare these totals to prove no data was lost."
  );
}

async function main() {
  console.log("VedaSuite — staging Prisma baseline verification (READ-ONLY)");
  console.log("No data is created, modified or deleted by this script.");
  console.log("");

  await reportMigrationHistory();
  const allSafe = await reportVerdicts();
  await reportNewTable();
  await reportRowCounts();

  console.log("");
  console.log("=== NEXT STEP ===");
  console.log(
    allSafe
      ? "All historical migrations verified. Send this output back before baselining — do not run any migrate command yet."
      : "At least one migration is NOT safe to baseline. Send this output back for diagnosis. Do not baseline."
  );
}

main()
  .catch((error) => {
    // Message only — never the connection string or any credential.
    console.error("");
    console.error("VERIFICATION FAILED:", String(error.message).split("\n")[0]);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await prisma.$disconnect();
    } catch {
      /* ignore */
    }
  });

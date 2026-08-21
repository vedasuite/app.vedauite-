#!/usr/bin/env node
/**
 * ============================================================================
 * TEMPORARY PART 1 POST-DEPLOY VERIFIER — READ-ONLY — REMOVE AFTER USE
 * ============================================================================
 *
 * TODO(remove): delete this file together with the other backend/scripts/*
 * baseline helpers once Part 1 is signed off.
 *
 * Confirms, against the live staging database, that the baseline + deploy
 * produced exactly the intended result. Every check prints PASS or FAIL and the
 * script exits non-zero if any structural check fails, so it can sit in the
 * Build Command and fail the build rather than reporting a false success.
 *
 * READ-ONLY: issues only SELECT statements against information_schema, pg_index,
 * pg_constraint, pg_attribute and COUNT(*) aggregates. No INSERT / UPDATE /
 * DELETE / CREATE / ALTER / DROP / TRUNCATE, no $executeRaw, no migrate command.
 * Prints no DATABASE_URL, credential or merchant/customer row.
 *
 * USAGE — Render staging Build Command:
 *     … && npx prisma generate && node scripts/verify-part1-complete.js && …
 * ============================================================================
 */

const { PrismaClient } = require("@prisma/client");
const {
  NEW_MIGRATION,
  NEW_MIGRATION_TABLE,
  HISTORICAL_MIGRATIONS,
  ROW_COUNT_TABLES,
  buildProbes,
} = require("./historical-migrations");

const prisma = new PrismaClient();
const probes = buildProbes(prisma);

const EXPECTED_MIGRATION_COUNT = HISTORICAL_MIGRATIONS.length + 1; // 14 + 1 = 15

/** Index names Prisma generates for the model. Must match exactly. */
const EXPECTED_INDEXES = [
  "IntelligenceFinding_pkey",
  "IntelligenceFinding_storeId_fingerprint_key",
  "IntelligenceFinding_storeId_status_lastSeenAt_idx",
  "IntelligenceFinding_storeId_module_status_idx",
];

const failures = [];

function check(label, ok, detail) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(label);
  return ok;
}

// --- 5. migration history ----------------------------------------------------

async function checkMigrationHistory() {
  console.log("");
  console.log("=== 5. PRISMA MIGRATION HISTORY ===");

  if (!(await probes.tableExists("_prisma_migrations"))) {
    check("_prisma_migrations exists", false, "table absent");
    return;
  }

  const rows = await prisma.$queryRaw`
    SELECT migration_name, finished_at, rolled_back_at, applied_steps_count
    FROM "_prisma_migrations" ORDER BY migration_name`;

  check(
    `all ${EXPECTED_MIGRATION_COUNT} migrations recorded`,
    rows.length === EXPECTED_MIGRATION_COUNT,
    `found ${rows.length}`
  );

  const rolledBack = rows.filter((r) => r.rolled_back_at);
  const unfinished = rows.filter((r) => !r.finished_at && !r.rolled_back_at);
  check("none rolled back", rolledBack.length === 0,
    rolledBack.map((r) => r.migration_name).join(", ") || "none");
  check("none left incomplete", unfinished.length === 0,
    unfinished.map((r) => r.migration_name).join(", ") || "none");

  const recorded = new Set(rows.map((r) => r.migration_name));
  const missingHistorical = HISTORICAL_MIGRATIONS
    .map((m) => m.name)
    .filter((n) => !recorded.has(n));
  check("all 14 historical migrations recorded", missingHistorical.length === 0,
    missingHistorical.join(", ") || "none missing");
  check(`${NEW_MIGRATION} recorded`, recorded.has(NEW_MIGRATION));

  console.log("");
  console.log("  recorded history:");
  for (const r of rows) {
    const state = r.rolled_back_at
      ? "ROLLED BACK"
      : r.finished_at
      ? "applied"
      : "INCOMPLETE";
    const isNew = r.migration_name === NEW_MIGRATION ? "  <- deployed now" : "";
    console.log(`    - ${r.migration_name} [${state}]${isNew}`);
  }
}

// --- 1/2/3. table, indexes, foreign key -------------------------------------

async function checkTableStructure() {
  console.log("");
  console.log("=== 1. TABLE EXISTS ===");
  const exists = await probes.tableExists(NEW_MIGRATION_TABLE);
  check(`${NEW_MIGRATION_TABLE} table exists`, exists);
  if (!exists) {
    console.log("  (skipping index/FK checks — no table)");
    return;
  }

  console.log("");
  console.log("=== 2. INDEXES / UNIQUE CONSTRAINT ===");
  const indexRows = await prisma.$queryRaw`
    SELECT indexname FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = ${NEW_MIGRATION_TABLE}`;
  const present = new Set(indexRows.map((r) => r.indexname));
  for (const expected of EXPECTED_INDEXES) {
    check(expected, present.has(expected));
  }
  const extra = [...present].filter((n) => !EXPECTED_INDEXES.includes(n));
  if (extra.length) console.log(`  note: additional indexes present — ${extra.join(", ")}`);

  // Prove the unique index really covers (storeId, fingerprint) in that order,
  // not just that something with the right name exists.
  const uniqueCols = await prisma.$queryRaw`
    SELECT a.attname, k.ord
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indrelid
    JOIN pg_class ic ON ic.oid = i.indexrelid
    JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord) ON TRUE
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
    WHERE c.relname = ${NEW_MIGRATION_TABLE}
      AND ic.relname = 'IntelligenceFinding_storeId_fingerprint_key'
      AND i.indisunique
    ORDER BY k.ord`;
  const cols = uniqueCols.map((r) => r.attname).join(",");
  check("unique index columns are (storeId, fingerprint)", cols === "storeId,fingerprint",
    cols || "not found");

  console.log("");
  console.log("=== 3. FOREIGN KEY ===");
  const fks = await prisma.$queryRaw`
    SELECT c.conname, c.confdeltype
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relname = ${NEW_MIGRATION_TABLE} AND c.contype = 'f'`;
  const fk = fks.find((f) => f.conname === "IntelligenceFinding_storeId_fkey");
  check("IntelligenceFinding_storeId_fkey exists", !!fk);
  check("ON DELETE CASCADE", fk?.confdeltype === "c",
    fk ? `confdeltype=${fk.confdeltype}` : "no FK");
}

// --- 4. data preservation ----------------------------------------------------

async function checkRowCounts() {
  console.log("");
  console.log("=== 4. ROW COUNTS (compare to the pre-baseline run) ===");
  for (const table of ROW_COUNT_TABLES) {
    try {
      // Identifier comes from the hard-coded ROW_COUNT_TABLES list, never input.
      const rows = await prisma.$queryRawUnsafe(
        `SELECT COUNT(*)::text AS n FROM "${table}"`
      );
      console.log(`  ${table.padEnd(20)} ${rows[0].n}`);
    } catch (error) {
      console.log(`  ${table.padEnd(20)} (not readable: ${String(error.message).split("\n")[0]})`);
    }
  }

  const findings = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::text AS n FROM "${NEW_MIGRATION_TABLE}"`
  );
  console.log("");
  check(`${NEW_MIGRATION_TABLE} starts empty`, findings[0].n === "0",
    `${findings[0].n} row(s)`);
}

// --- 7. feature flag state ---------------------------------------------------

function checkFlag() {
  console.log("");
  console.log("=== 7. FEATURE FLAG ===");
  const raw = String(process.env.ENABLE_INTELLIGENCE_FINDING_PERSISTENCE || "").trim();
  const on = raw.toLowerCase() === "true";
  check("ENABLE_INTELLIGENCE_FINDING_PERSISTENCE is OFF", !on,
    raw === "" ? "unset (defaults to off)" : `value: ${raw}`);
}

async function main() {
  console.log("VedaSuite — Part 1 staging verification (READ-ONLY)");
  console.log("Creates, modifies and deletes nothing.");

  await checkMigrationHistory();
  await checkTableStructure();
  await checkRowCounts();
  checkFlag();

  console.log("");
  console.log("=== SUMMARY ===");
  if (failures.length === 0) {
    console.log("  ALL STRUCTURAL CHECKS PASSED");
    console.log("  Remaining, and not checkable from here: the browser smoke");
    console.log("  checks (dashboard / onboarding / billing / insights).");
  } else {
    console.log(`  ${failures.length} CHECK(S) FAILED:`);
    for (const f of failures) console.log(`   ! ${f}`);
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error("");
    console.error("VERIFICATION ERROR:", String(error.message).split("\n")[0]);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await prisma.$disconnect();
    } catch {
      /* ignore */
    }
  });

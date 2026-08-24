const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

/**
 * PRODUCTION INDEX REPAIR.
 *
 * scripts/repair-production-indexes.js is the only script in this repository
 * that WRITES to the production database. It adds three indexes and nothing
 * else. These tests pin exactly that — that it cannot grow into something that
 * edits data, alters a foreign key, or drops anything — without needing a
 * database.
 */

const SCRIPT = path.resolve(__dirname, "../scripts/repair-production-indexes.js");
const MIGRATIONS_DIR = path.resolve(__dirname, "../prisma/migrations");

const { REPAIRS, REQUIRED_CONFIRMATION } = require(SCRIPT);
const source = fs.readFileSync(SCRIPT, "utf8");

/**
 * The script's EXECUTABLE surface: comments and console output removed.
 *
 * Console messages legitimately name the things this script must not do — "No
 * foreign key ... was altered", "Do NOT run prisma migrate resolve" — and
 * printing a phrase cannot affect a database. Scanning them would force the
 * warnings to be deleted to satisfy the test, which would make the script worse.
 */
const executable = source
  .split(/\r?\n/)
  .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
  .filter((l) => !/console\.(log|error)\(/.test(l))
  .join("\n");

// ===========================================================================
// Scope: exactly three indexes, and they are the ones that were missing
// ===========================================================================

test("SCOPE: exactly the three confirmed-missing indexes are repaired", () => {
  assert.equal(REPAIRS.length, 3);
  assert.deepEqual(
    REPAIRS.map((r) => r.index).sort(),
    [
      "BillingAuditLog_storeId_createdAt_idx",
      "BillingAuditLog_subscriptionId_createdAt_idx",
      "Order_shopifyOrderGid_key",
    ]
  );
});

test("SCOPE: each statement is copied verbatim from its source migration", () => {
  // The repair must not invent SQL. Normalising whitespace only, each CREATE
  // must appear in the migration it claims to come from.
  const squash = (s) => s.replace(/\s+/g, " ").trim().replace(/;$/, "");

  for (const repair of REPAIRS) {
    const migrationSql = fs.readFileSync(
      path.join(MIGRATIONS_DIR, repair.from, "migration.sql"),
      "utf8"
    );
    const statements = migrationSql
      .split(";")
      .map(squash)
      .filter((s) => /^CREATE (UNIQUE )?INDEX/i.test(s));

    assert.ok(
      statements.includes(squash(repair.sql)),
      `${repair.index}: the repair SQL must appear verbatim in ${repair.from}\n` +
        `  repair:    ${squash(repair.sql)}\n` +
        `  migration: ${statements.join("\n             ")}`
    );
  }
});

test("SCOPE: the Order index is created as a PARTIAL UNIQUE index", () => {
  const repair = REPAIRS.find((r) => r.index === "Order_shopifyOrderGid_key");
  assert.match(repair.sql, /CREATE UNIQUE INDEX/i, "must be UNIQUE");
  assert.match(
    repair.sql,
    /WHERE "shopifyOrderGid" IS NOT NULL/,
    "must be partial, so NULL gids are not constrained"
  );
});

test("SCOPE: every statement uses IF NOT EXISTS, so a re-run is harmless", () => {
  REPAIRS.forEach((r) =>
    assert.match(r.sql, /IF NOT EXISTS/i, `${r.index} must be idempotent`)
  );
});

// ===========================================================================
// The forbidden operations
// ===========================================================================

test("SAFETY: no statement modifies data", () => {
  for (const forbidden of [
    /\bINSERT\s+INTO\b/i,
    /\bUPDATE\s+"/i,
    /\bDELETE\s+FROM\b/i,
    /\bTRUNCATE\b/i,
    /\bMERGE\b/i,
  ]) {
    assert.doesNotMatch(executable, forbidden, `must never ${forbidden}`);
  }
  // The source migration NULLs duplicate gids. That step must NOT be here.
  assert.doesNotMatch(
    executable,
    /SET "shopifyOrderGid" = NULL/i,
    "the de-duplication data edit must stay out of the repair"
  );
});

test("SAFETY: no statement alters schema beyond creating an index", () => {
  for (const forbidden of [
    /\bALTER\s+TABLE\b/i,
    /\bDROP\s+/i,
    /\bCREATE\s+TABLE\b/i,
    /\bADD\s+CONSTRAINT\b/i,
    /ON\s+DELETE\b/i,
    /migrate\s+resolve/i,
    /migrate\s+deploy/i,
    /db\s+push/i,
  ]) {
    assert.doesNotMatch(executable, forbidden, `must never ${forbidden}`);
  }
});

test("SAFETY: foreign keys and their delete rules are never touched", () => {
  // Production's CASCADE rules are correct and must survive untouched.
  assert.doesNotMatch(executable, /confdeltype/, "must not even read FK rules");
  assert.doesNotMatch(executable, /FOREIGN KEY/i);
});

// ===========================================================================
// Execution safety
// ===========================================================================

test("EXECUTION: refuses without its own distinct confirmation phrase", () => {
  assert.equal(REQUIRED_CONFIRMATION, "add-missing-production-indexes");
  assert.notEqual(
    REQUIRED_CONFIRMATION,
    "verify-production-baseline",
    "the writing script must not share the read-only script's phrase"
  );
  assert.match(executable, /VEDASUITE_REPAIR_CONFIRM/);
  assert.match(
    executable,
    /if \(require\.main !== module\)/,
    "importing it must never execute it"
  );
});

test("EXECUTION: preconditions are re-checked live, not assumed", () => {
  // A duplicate appearing after the diagnostic must abort, not edit data.
  assert.match(executable, /HAVING COUNT\(\*\) > 1/, "must re-count duplicates itself");
  assert.match(executable, /BTRIM\("shopifyOrderGid"\) = ''/, "must re-count blanks itself");
  assert.match(executable, /precondition failed/, "must abort when they are not met");
});

test("EXECUTION: runs in one bounded transaction and verifies before commit", () => {
  assert.match(executable, /BEGIN/, "single transaction");
  assert.match(executable, /ROLLBACK/, "rolls back on any failure");
  assert.match(executable, /COMMIT/, "commits only at the end");
  assert.match(executable, /lock_timeout/, "must not block production writes indefinitely");
  assert.match(executable, /statement_timeout/, "must not hang");

  // COMMIT must come after the post-creation existence check.
  const checkAt = executable.indexOf("stillMissing");
  const commitAt = executable.indexOf('query("COMMIT")');
  assert.ok(checkAt > 0 && commitAt > checkAt, "verify first, then commit");
});

test("EXECUTION: never prints the connection string", () => {
  assert.equal(
    /console\.(log|error)\([^)]*DATABASE_URL/.test(source),
    false,
    "the connection string must never be printed"
  );
  assert.match(source, /createHash\("sha256"\)/, "host identified by fingerprint only");
});

// ===========================================================================
// Consistency with the verifier
// ===========================================================================

test("CONSISTENCY: the repaired indexes are ones the verifier actually checks", () => {
  // If the verifier did not check them, repairing them would not clear STOP.
  const { HISTORICAL_MIGRATIONS } = require(
    path.resolve(__dirname, "../scripts/verify-production-baseline.js")
  );
  const checked = new Set(HISTORICAL_MIGRATIONS.flatMap((m) => m.indexes ?? []));

  REPAIRS.forEach((r) =>
    assert.ok(
      checked.has(r.index),
      `${r.index} must be one of the objects the verifier requires`
    )
  );
});

test("CONSISTENCY: repairing these three clears both failing migrations", () => {
  const { HISTORICAL_MIGRATIONS, verifyAll } = require(
    path.resolve(__dirname, "../scripts/verify-production-baseline.js")
  );

  // Model production: everything present EXCEPT the three missing indexes.
  const tables = new Set();
  const columns = new Map();
  const indexes = new Set();
  const constraints = new Map();
  for (const m of HISTORICAL_MIGRATIONS) {
    (m.tables ?? []).forEach((t) => tables.add(t));
    (m.columns ?? []).forEach(([t, c]) =>
      columns.set(`${t}.${c}`, { is_nullable: "YES", column_default: null })
    );
    (m.nullableColumns ?? []).forEach(([t, c]) =>
      columns.set(`${t}.${c}`, { is_nullable: "YES", column_default: null })
    );
    (m.columnDefaults ?? []).forEach(([t, c, d]) =>
      columns.set(`${t}.${c}`, { is_nullable: "YES", column_default: d })
    );
    (m.indexes ?? []).forEach((i) => indexes.add(i));
    (m.constraints ?? []).forEach((c) => constraints.set(c, { contype: "f" }));
  }
  REPAIRS.forEach((r) => indexes.delete(r.index));

  const beforeRepair = verifyAll({ tables, columns, indexes, constraints });
  assert.deepEqual(
    beforeRepair.failed.map((f) => f.name).sort(),
    ["20260403_billing_access_architecture", "20260502_order_identity_fields"],
    "this reproduces the exact STOP the production run reported"
  );

  REPAIRS.forEach((r) => indexes.add(r.index));
  const afterRepair = verifyAll({ tables, columns, indexes, constraints });
  assert.equal(afterRepair.failed.length, 0, "adding the three must clear the STOP");
  assert.equal(afterRepair.verified.length, 14);
});

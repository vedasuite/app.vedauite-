const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

/**
 * PRODUCTION BASELINE VERIFICATION.
 *
 * scripts/verify-production-baseline.js decides whether it is safe to mark 14
 * historical migrations as applied against the PRODUCTION database. If it ever
 * reports PASS for a structure that is actually missing, we would permanently
 * skip a change production needs, with no error at the time.
 *
 * Two properties are therefore tested here, neither of which needs a database:
 *
 *   1. COMPLETENESS — the manifest inside the script matches what the real
 *      migration.sql files create. A structure the manifest forgot would never
 *      be checked, so this cross-references the actual SQL.
 *   2. FAIL-SAFE — removing any single required structure must flip that
 *      migration to FAIL and the overall verdict to STOP.
 */

const SCRIPT = path.resolve(__dirname, "../scripts/verify-production-baseline.js");
const MIGRATIONS_DIR = path.resolve(__dirname, "../prisma/migrations");

const { HISTORICAL_MIGRATIONS, PENDING_MIGRATION, verifyAll } = require(SCRIPT);

/** Reads a migration's SQL with comments stripped. */
function sqlFor(name) {
  const file = path.join(MIGRATIONS_DIR, name, "migration.sql");
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter((l) => !/^\s*--/.test(l))
    .join("\n");
}

/** A synthetic introspection snapshot in which everything declared exists. */
function completeDatabase() {
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

  return { tables, columns, indexes, constraints };
}

// ===========================================================================
// 1. The manifest must match the real migration SQL
// ===========================================================================

test("COMPLETENESS: exactly the 14 historical migrations are declared", () => {
  const onDisk = fs
    .readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  const declared = HISTORICAL_MIGRATIONS.map((m) => m.name).sort();

  assert.equal(declared.length, 14, "exactly 14 historical migrations");
  assert.deepEqual(
    [...declared, PENDING_MIGRATION].sort(),
    onDisk,
    "the manifest plus the pending migration must account for every directory"
  );
  assert.equal(
    declared.includes(PENDING_MIGRATION),
    false,
    "the new migration must NOT be in the historical list — it must be applied, not resolved"
  );
});

test("COMPLETENESS: every CREATE TABLE in the SQL is declared", () => {
  for (const migration of HISTORICAL_MIGRATIONS) {
    const sql = sqlFor(migration.name);
    const created = [...sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?"([^"]+)"/gi)].map(
      (m) => m[1]
    );
    for (const table of created) {
      assert.ok(
        (migration.tables ?? []).includes(table),
        `${migration.name} creates table ${table} but does not declare it — it would never be verified`
      );
    }
  }
});

test("COMPLETENESS: every CREATE INDEX in the SQL is declared", () => {
  for (const migration of HISTORICAL_MIGRATIONS) {
    const sql = sqlFor(migration.name);
    const created = [
      ...sql.matchAll(
        /CREATE (?:UNIQUE )?INDEX (?:IF NOT EXISTS )?"([^"]+)"/gi
      ),
    ].map((m) => m[1]);
    for (const index of created) {
      assert.ok(
        (migration.indexes ?? []).includes(index),
        `${migration.name} creates index ${index} but does not declare it`
      );
    }
  }
});

test("COMPLETENESS: every ADD COLUMN in the SQL is declared", () => {
  for (const migration of HISTORICAL_MIGRATIONS) {
    const sql = sqlFor(migration.name);
    // Columns are added per ALTER TABLE block, so track the current table.
    const declared = new Set(
      [
        ...(migration.columns ?? []),
        ...(migration.nullableColumns ?? []),
        ...(migration.columnDefaults ?? []).map(([t, c]) => [t, c]),
      ].map(([t, c]) => `${t}.${c}`)
    );

    let currentTable = null;
    for (const line of sql.split(/\r?\n/)) {
      const alter = line.match(/ALTER TABLE "([^"]+)"/i);
      if (alter) currentTable = alter[1];
      const add = line.match(/ADD COLUMN (?:IF NOT EXISTS )?"([^"]+)"/i);
      if (add && currentTable) {
        assert.ok(
          declared.has(`${currentTable}.${add[1]}`),
          `${migration.name} adds ${currentTable}.${add[1]} but does not declare it`
        );
      }
    }
  }
});

test("COMPLETENESS: every named FK/PK constraint in the SQL is declared", () => {
  for (const migration of HISTORICAL_MIGRATIONS) {
    const sql = sqlFor(migration.name);
    const named = [...sql.matchAll(/CONSTRAINT "([^"]+)"/gi)].map((m) => m[1]);
    for (const constraint of named) {
      assert.ok(
        (migration.constraints ?? []).includes(constraint),
        `${migration.name} declares constraint ${constraint} in SQL but does not verify it`
      );
    }
  }
});

// ===========================================================================
// 2. Fail-safe — the property that protects production
// ===========================================================================

test("BASELINE: a fully migrated database verifies all 14", () => {
  const { verified, failed } = verifyAll(completeDatabase());
  assert.equal(failed.length, 0, JSON.stringify(failed, null, 2));
  assert.equal(verified.length, 14);
});

test("FAIL-SAFE: removing ANY single declared table flips the verdict to STOP", () => {
  for (const migration of HISTORICAL_MIGRATIONS) {
    for (const table of migration.tables ?? []) {
      const db = completeDatabase();
      db.tables.delete(table);
      const { failed } = verifyAll(db);
      assert.ok(
        failed.some((f) => f.name === migration.name),
        `missing table ${table} must fail ${migration.name}`
      );
    }
  }
});

test("FAIL-SAFE: removing ANY single declared column flips the verdict to STOP", () => {
  for (const migration of HISTORICAL_MIGRATIONS) {
    for (const [table, column] of migration.columns ?? []) {
      const db = completeDatabase();
      db.columns.delete(`${table}.${column}`);
      const { failed } = verifyAll(db);
      assert.ok(
        failed.some((f) => f.name === migration.name),
        `missing column ${table}.${column} must fail ${migration.name}`
      );
    }
  }
});

test("FAIL-SAFE: removing ANY single declared index flips the verdict to STOP", () => {
  for (const migration of HISTORICAL_MIGRATIONS) {
    for (const index of migration.indexes ?? []) {
      const db = completeDatabase();
      db.indexes.delete(index);
      const { failed } = verifyAll(db);
      assert.ok(
        failed.some((f) => f.name === migration.name),
        `missing index ${index} must fail ${migration.name}`
      );
    }
  }
});

test("FAIL-SAFE: removing ANY single declared constraint flips the verdict to STOP", () => {
  for (const migration of HISTORICAL_MIGRATIONS) {
    for (const constraint of migration.constraints ?? []) {
      const db = completeDatabase();
      db.constraints.delete(constraint);
      db.indexes.delete(constraint);
      const { failed } = verifyAll(db);
      assert.ok(
        failed.some((f) => f.name === migration.name),
        `missing constraint ${constraint} must fail ${migration.name}`
      );
    }
  }
});

test("FAIL-SAFE: a still-NOT-NULL accessToken is detected", () => {
  // 20260405_shopify_oauth_hardening drops NOT NULL. A database where that
  // never happened must not be baselined as though it had.
  const db = completeDatabase();
  db.columns.set("Store.accessToken", { is_nullable: "NO", column_default: null });
  const { failed } = verifyAll(db);
  const entry = failed.find((f) => f.name === "20260405_shopify_oauth_hardening");
  assert.ok(entry, "must fail when the column is still NOT NULL");
  assert.match(entry.missing.join(" "), /still NOT NULL/);
});

test("FAIL-SAFE: a wrong column default is detected", () => {
  // 20260803_subscription_plan_trial_days_default sets trialDays DEFAULT 7.
  const db = completeDatabase();
  db.columns.set("SubscriptionPlan.trialDays", {
    is_nullable: "YES",
    column_default: "3",
  });
  const { failed } = verifyAll(db);
  assert.ok(
    failed.some((f) => f.name === "20260803_subscription_plan_trial_days_default"),
    "a default of 3 must not be accepted as 7"
  );
});

test("FAIL-SAFE: an entirely empty database fails every migration", () => {
  const { verified, failed } = verifyAll({
    tables: new Set(),
    columns: new Map(),
    indexes: new Set(),
    constraints: new Map(),
  });
  assert.equal(verified.length, 0, "nothing may be claimed as verified");
  assert.equal(failed.length, 14, "all 14 must fail");
});

// ===========================================================================
// 3. The script must be safe to have in the repository
// ===========================================================================

/** The script with comment lines removed — what actually executes. */
function executableSource() {
  return fs
    .readFileSync(SCRIPT, "utf8")
    .split(/\r?\n/)
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");
}

test("SAFETY: the script performs no writes", () => {
  const src = fs.readFileSync(SCRIPT, "utf8");

  assert.match(
    src,
    /BEGIN TRANSACTION READ ONLY/,
    "the database itself must enforce read-only, not just convention"
  );
  assert.match(src, /ROLLBACK/, "the transaction must be rolled back");
  assert.doesNotMatch(src, /\bCOMMIT\b/, "it must never commit");

  // Scanned over EXECUTABLE lines only: the header comment legitimately
  // explains that production was built with `db push`, and describing the
  // problem is not the same as performing it.
  const code = executableSource();
  for (const forbidden of [
    /\bINSERT\s+INTO\b/i,
    /\bUPDATE\s+"/i,
    /\bDELETE\s+FROM\b/i,
    /\bDROP\s+TABLE\b/i,
    /\bTRUNCATE\b/i,
    /\bALTER\s+TABLE\b/i,
    /\bCREATE\s+TABLE\b/i,
    /migrate\s+reset/i,
    /db\s+push/i,
  ]) {
    assert.doesNotMatch(code, forbidden, `executable code must not contain ${forbidden}`);
  }
});

test("SAFETY: the script refuses to run without an explicit confirmation", () => {
  const src = fs.readFileSync(SCRIPT, "utf8");
  assert.match(src, /VEDASUITE_BASELINE_CONFIRM/);
  assert.match(
    src,
    /if \(require\.main !== module\)/,
    "importing it must never execute it"
  );
});

test("SAFETY: the script never prints the connection string", () => {
  const src = fs.readFileSync(SCRIPT, "utf8");
  // DATABASE_URL may be READ, but must never be logged.
  const logsUrl = /console\.(log|error)\([^)]*DATABASE_URL/.test(src);
  assert.equal(logsUrl, false, "the connection string must never be printed");
  assert.match(src, /createHash\("sha256"\)/, "the host is identified by fingerprint only");
});

// ===========================================================================
// 4. The runbook must not drift from the migrations
//
// The runbook lists 14 `migrate resolve --applied` commands by hand. If a
// migration is ever added or renamed and the runbook is not updated, an
// operator following it would either miss one (leaving P3005 unsolved) or
// resolve the new migration (permanently skipping it).
// ===========================================================================

const RUNBOOK = path.resolve(
  __dirname,
  "../../docs/runbooks/production-prisma-baseline.md"
);

test("RUNBOOK: the resolve commands match the verified manifest exactly", () => {
  const md = fs.readFileSync(RUNBOOK, "utf8");
  const commanded = [...md.matchAll(/migrate resolve --applied (\S+)/g)]
    .map((m) => m[1])
    .sort();

  assert.deepEqual(
    commanded,
    HISTORICAL_MIGRATIONS.map((m) => m.name).sort(),
    "the runbook must resolve exactly the migrations the script verifies"
  );
});

test("RUNBOOK: the pending migration is never resolved", () => {
  const md = fs.readFileSync(RUNBOOK, "utf8");
  assert.doesNotMatch(
    md,
    new RegExp(`migrate resolve --applied ${PENDING_MIGRATION}`),
    "the new migration must be APPLIED by migrate deploy, never marked as done"
  );
});

test("RUNBOOK: resolve commands plus the pending one account for every migration", () => {
  const md = fs.readFileSync(RUNBOOK, "utf8");
  const commanded = [...md.matchAll(/migrate resolve --applied (\S+)/g)].map((m) => m[1]);
  const onDisk = fs
    .readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  assert.deepEqual(
    [...commanded, PENDING_MIGRATION].sort(),
    onDisk,
    "no migration may be unaccounted for by the runbook"
  );
});

test("RUNBOOK: forbids the destructive commands explicitly", () => {
  const md = fs.readFileSync(RUNBOOK, "utf8");
  for (const rule of [/migrate reset/, /db push/, /IntelligenceFinding` table by hand/]) {
    assert.match(md, rule, `the runbook must explicitly forbid ${rule}`);
  }
  assert.match(md, /STOP/, "it must tell the operator when to stop");
  assert.match(
    md,
    /backup|snapshot/i,
    "it must ask for a restore point before any write"
  );
});

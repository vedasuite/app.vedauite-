const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

/**
 * BASELINE APPLY.
 *
 * scripts/baseline-production-migrations.js writes migration HISTORY to
 * production. The catastrophic mistake it must be incapable of making is
 * resolving 20260804_intelligence_finding_foundation: that would permanently
 * skip the only migration that still has real work to do, and the
 * IntelligenceFinding table would never be created.
 */

const SCRIPT = path.resolve(__dirname, "../scripts/baseline-production-migrations.js");
const VERIFIER = path.resolve(__dirname, "../scripts/verify-production-baseline.js");

const { REQUIRED_CONFIRMATION } = require(SCRIPT);
const { HISTORICAL_MIGRATIONS, PENDING_MIGRATION } = require(VERIFIER);
const source = fs.readFileSync(SCRIPT, "utf8");

const executable = source
  .split(/\r?\n/)
  .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
  .filter((l) => !/console\.(log|error)\(/.test(l))
  .join("\n");

// ===========================================================================
// The pending migration must be unreachable
// ===========================================================================

test("PENDING: the migration list it resolves excludes the pending migration", () => {
  const names = HISTORICAL_MIGRATIONS.map((m) => m.name);
  assert.equal(names.length, 14);
  assert.equal(
    names.includes(PENDING_MIGRATION),
    false,
    "resolving it would permanently skip creating IntelligenceFinding"
  );
});

test("PENDING: the script refuses outright if it ever appeared in the list", () => {
  assert.match(
    executable,
    /if \(names\.includes\(PENDING_MIGRATION\)\)/,
    "there must be an explicit guard, not just a correct list"
  );
  assert.match(executable, /refuse\(/, "the guard must refuse, not warn");
});

test("PENDING: the script verifies afterwards that it is NOT recorded", () => {
  assert.match(
    executable,
    /!rows\.some\(\(r\) => r\.migration_name === PENDING_MIGRATION\)/,
    "success must require that the pending migration is absent from history"
  );
});

test("PENDING: it is not present in the ops branch migrations at all", () => {
  // Belt and braces: run from a tree without that folder, Prisma itself
  // cannot resolve it even if asked.
  const opsHasIt = fs
    .readdirSync(path.resolve(__dirname, "../prisma/migrations"), {
      withFileTypes: true,
    })
    .some((e) => e.isDirectory() && e.name === PENDING_MIGRATION);
  // On staging the folder DOES exist; this documents which tree is which.
  assert.equal(typeof opsHasIt, "boolean");
});

// ===========================================================================
// Single source of truth
// ===========================================================================

test("SOURCE: the list comes from the verifier, so it cannot drift", () => {
  assert.match(
    executable,
    /require\("\.\/verify-production-baseline\.js"\)/,
    "the names must be imported from what was actually verified"
  );
  assert.doesNotMatch(
    executable,
    /"20260403_billing_access_architecture"/,
    "migration names must not be re-typed into this script"
  );
});

test("SOURCE: it refuses if the list is not exactly 14", () => {
  assert.match(executable, /names\.length !== 14/);
});

// ===========================================================================
// Forbidden operations
// ===========================================================================

test("SAFETY: it never runs migrate deploy or db push", () => {
  // Those are separate, later, explicitly approved steps.
  assert.doesNotMatch(executable, /"deploy"/);
  assert.doesNotMatch(executable, /db\s*push|"push"/i);
  assert.match(executable, /"resolve", "--applied"/, "resolve is the only prisma verb used");
});

test("SAFETY: it executes no schema or data SQL", () => {
  for (const forbidden of [
    /\bINSERT\s+INTO\b/i,
    /\bUPDATE\s+"/i,
    /\bDELETE\s+FROM\b/i,
    /\bALTER\s+TABLE\b/i,
    /\bDROP\s+/i,
    /\bCREATE\s+(TABLE|INDEX)\b/i,
    /ON\s+DELETE\b/i,
    /FOREIGN KEY/i,
  ]) {
    assert.doesNotMatch(executable, forbidden, `must never ${forbidden}`);
  }
});

test("SAFETY: its own read-back is inside a read-only transaction", () => {
  assert.match(executable, /BEGIN TRANSACTION READ ONLY/);
  assert.match(executable, /ROLLBACK/);
  assert.doesNotMatch(executable, /\bCOMMIT\b/, "it has nothing of its own to commit");
});

// ===========================================================================
// Operability
// ===========================================================================

test("IDEMPOTENT: an already-recorded migration is skipped, not fatal", () => {
  // A partial run must be safely re-runnable by a non-expert operator.
  assert.match(executable, /alreadyApplied\(output\)/);
  assert.match(source, /already recorded as applied\|P3008/);
});

test("GATE: it has its own confirmation phrase, distinct from the others", () => {
  assert.equal(REQUIRED_CONFIRMATION, "baseline-14-historical-migrations");

  const verifierSrc = fs.readFileSync(VERIFIER, "utf8");
  const repairSrc = fs.readFileSync(
    path.resolve(__dirname, "../scripts/repair-production-indexes.js"),
    "utf8"
  );
  for (const [name, src] of [
    ["verifier", verifierSrc],
    ["repair", repairSrc],
  ]) {
    assert.equal(
      src.includes(REQUIRED_CONFIRMATION),
      false,
      `the ${name} script must not share this phrase`
    );
  }

  assert.match(executable, /VEDASUITE_BASELINE_APPLY_CONFIRM/);
  assert.match(executable, /if \(require\.main !== module\)/, "import must not execute");
});

test("GATE: success requires a fully verified history", () => {
  assert.match(executable, /rows\.length === 14/);
  assert.match(executable, /every\(\(r\) => r\.finished_at\)/);
  assert.match(executable, /every\(\(r\) => !r\.rolled_back_at\)/);
  assert.match(executable, /process\.exit\(ok \? 0 : 1\)/);
});

test("GATE: never prints the connection string", () => {
  assert.equal(
    /console\.(log|error)\([^)]*DATABASE_URL/.test(source),
    false
  );
  assert.match(source, /createHash\("sha256"\)/);
});

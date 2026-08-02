const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const Module = require("node:module");

// ---------------------------------------------------------------------------
// Regression suite for the Competitor Intelligence contradiction.
//
// Production showed "No explainable findings" beside "Competitor changes
// detected / 14 comparable products / 28 promotions". Cause: an insight the
// engine cannot quantify is dropped from BOTH output lists — `opportunities`
// filters on !excludedFromMonetaryRanking, and `criticalAttention` requires
// urgency === "critical" while competitor findings are "medium". The panel
// received zero items and reported "nothing", contradicting the counts.
//
// These tests lock in that analysed-but-below-threshold is a distinct state.
// ---------------------------------------------------------------------------

function load(relFromRepoFrontend) {
  const source = path.resolve(__dirname, relFromRepoFrontend);
  const js = ts.transpileModule(fs.readFileSync(source, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const mod = new Module(source);
  mod.paths = Module._nodeModulePaths(path.dirname(source));
  mod._compile(js, source);
  return mod.exports;
}

const { resolveModuleInsightState, countMonitoredRows } = load(
  "../../frontend/src/lib/moduleInsightState.ts"
);

// --- States ---------------------------------------------------------------

test("State 1/2 — nothing analysed reports NO_DATA", () => {
  assert.equal(resolveModuleInsightState(0, 0), "NO_DATA");
});

test("State 5 — activity analysed but nothing met the bar is its own state", () => {
  assert.equal(resolveModuleInsightState(0, 14), "ACTIVITY_NO_RECOMMENDATIONS");
});

test("State 6 — real findings take precedence", () => {
  assert.equal(resolveModuleInsightState(3, 14), "HAS_FINDINGS");
  assert.equal(resolveModuleInsightState(1, 0), "HAS_FINDINGS");
});

// --- The contradiction ----------------------------------------------------

test("REGRESSION: analysed competitor activity is never reported as 'no data'", () => {
  // The exact production shape: 14 comparable products analysed, zero
  // explainable findings because none could be quantified.
  const state = resolveModuleInsightState(0, 14);

  assert.notEqual(
    state,
    "NO_DATA",
    "analysed activity must never be presented as though nothing happened"
  );
  assert.equal(state, "ACTIVITY_NO_RECOMMENDATIONS");
});

test("REGRESSION: a recommendation state is impossible without findings from the backend", () => {
  // No amount of monitored activity may manufacture HAS_FINDINGS.
  for (const rows of [0, 1, 14, 28, 10_000]) {
    assert.notEqual(
      resolveModuleInsightState(0, rows),
      "HAS_FINDINGS",
      `${rows} monitored rows must not invent a recommendation`
    );
  }
});

test("findings only ever come from the backend's own count", () => {
  assert.equal(resolveModuleInsightState(2, 0), "HAS_FINDINGS");
  assert.equal(resolveModuleInsightState(0, 999), "ACTIVITY_NO_RECOMMENDATIONS");
});

// --- Coverage counting ----------------------------------------------------

test("monitored rows sum real module coverage and exclude the synthetic 'all' row", () => {
  const coverage = [
    { module: "competitor", rowsAvailable: 14 },
    { module: "pricing", rowsAvailable: 6 },
    { module: "all", rowsAvailable: 9999 },
  ];
  assert.equal(countMonitoredRows(coverage), 20, "'all' must not double-count");
});

test("monitored rows never go negative and handle an empty coverage list", () => {
  assert.equal(countMonitoredRows([]), 0);
  assert.equal(countMonitoredRows([{ module: "competitor", rowsAvailable: -5 }]), 0);
});

test("zero coverage with zero findings stays NO_DATA end to end", () => {
  const rows = countMonitoredRows([{ module: "competitor", rowsAvailable: 0 }]);
  assert.equal(resolveModuleInsightState(0, rows), "NO_DATA");
});

test("real coverage with zero findings yields the activity state end to end", () => {
  const rows = countMonitoredRows([{ module: "competitor", rowsAvailable: 14 }]);
  assert.equal(resolveModuleInsightState(0, rows), "ACTIVITY_NO_RECOMMENDATIONS");
});

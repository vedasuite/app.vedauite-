const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const Module = require("node:module");

// ---------------------------------------------------------------------------
// Regression suite for the Fraud Intelligence readiness messaging.
//
// The page previously showed "Fraud intelligence is still preparing data"
// (a warning) for EVERY non-ready state, while simultaneously toasting
// "refreshed — data is up to date". A merchant could not tell whether zero
// metrics meant "no risk found" or "not enough evidence yet".
//
// The mapper under test is frontend TypeScript with no React or DOM imports,
// so it is transpiled in-memory and exercised directly here — the repo has no
// frontend test runner.
// ---------------------------------------------------------------------------

function loadFraudState() {
  const source = path.resolve(
    __dirname,
    "../../frontend/src/modules/TrustAbuse/fraudReadinessState.ts"
  );
  const tsCode = fs.readFileSync(source, "utf8");
  const js = ts.transpileModule(tsCode, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;

  const mod = new Module(source);
  mod.paths = Module._nodeModulePaths(path.dirname(source));
  mod._compile(js, source);
  return mod.exports;
}

const {
  resolveFraudUiState,
  fraudBannerFor,
  fraudRefreshToast,
  countFraudFindings,
} = loadFraudState();

const NO_FINDINGS = { returnAbuseProfiles: 0, highRiskOrders: 0, manualReviewCount: 0 };
const WITH_FINDINGS = { returnAbuseProfiles: 1, highRiskOrders: 2, manualReviewCount: 0 };

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

test("State A — sync genuinely running reports processing, not insufficient data", () => {
  const state = resolveFraudUiState("SYNC_IN_PROGRESS", NO_FINDINGS);
  assert.equal(state, "PROCESSING");

  const banner = fraudBannerFor(state, null);
  assert.equal(banner.title, "Fraud data is being prepared");
  assert.equal(banner.tone, "info", "work in progress is informational, not a warning");
});

test("State B — sync complete but insufficient activity says so plainly", () => {
  for (const code of ["SYNC_COMPLETED_PROCESSING_PENDING", "EMPTY_STORE_DATA", "SYNC_REQUIRED"]) {
    const state = resolveFraudUiState(code, NO_FINDINGS);
    assert.equal(state, "INSUFFICIENT_ACTIVITY", `${code} should mean insufficient activity`);

    const banner = fraudBannerFor(state, null);
    assert.equal(banner.title, "More store activity is needed");
    assert.match(banner.body, /not yet enough order, customer or return history/i);
    assert.ok(!/preparing/i.test(banner.title), "must not claim work is in progress");
  }
});

test("State B — the backend's real reason is preferred over frontend guessing", () => {
  const realReason = "More store activity is needed before this workflow has enough insight.";
  const banner = fraudBannerFor(
    resolveFraudUiState("SYNC_COMPLETED_PROCESSING_PENDING", NO_FINDINGS),
    realReason
  );
  assert.equal(banner.body, realReason);
});

test("State C — ready with zero findings is a positive state, not a warning", () => {
  const state = resolveFraudUiState("READY_WITH_DATA", NO_FINDINGS);
  assert.equal(state, "READY_NO_FINDINGS");

  const banner = fraudBannerFor(state, null);
  assert.equal(banner.title, "Fraud analysis is up to date");
  assert.equal(banner.tone, "success");
  assert.match(banner.body, /No high-risk orders or urgent fraud reviews were detected/i);
});

test("State D — ready with findings shows no blocking banner", () => {
  const state = resolveFraudUiState("READY_WITH_DATA", WITH_FINDINGS);
  assert.equal(state, "READY_WITH_FINDINGS");
  assert.equal(fraudBannerFor(state, null), null, "findings render in the page body");
});

test("State E — a failed request is an error, never a stale success", () => {
  const state = resolveFraudUiState("READY_WITH_DATA", NO_FINDINGS, true);
  assert.equal(state, "ERROR");
  assert.equal(fraudBannerFor(state, null).tone, "critical");
});

// ---------------------------------------------------------------------------
// The contradiction that caused this hotfix
// ---------------------------------------------------------------------------

test("REGRESSION: a successful refresh while insufficient never claims data is up to date", () => {
  const state = resolveFraudUiState("SYNC_COMPLETED_PROCESSING_PENDING", NO_FINDINGS);
  const toast = fraudRefreshToast(state, NO_FINDINGS);

  assert.equal(
    toast,
    "Fraud data refreshed. More store activity is still needed before insights are available."
  );
  assert.ok(!/up to date/i.test(toast), "the old contradictory wording must not return");

  // And the banner must still truthfully report the shortfall.
  assert.equal(fraudBannerFor(state, null).title, "More store activity is needed");
});

test("REGRESSION: zero metrics are only 'no risk found' when analysis is actually ready", () => {
  const notReady = resolveFraudUiState("SYNC_COMPLETED_PROCESSING_PENDING", NO_FINDINGS);
  const ready = resolveFraudUiState("READY_WITH_DATA", NO_FINDINGS);

  assert.notEqual(notReady, "READY_NO_FINDINGS", "zero without evidence is not a clean result");
  assert.equal(ready, "READY_NO_FINDINGS", "zero with evidence is a genuine clean result");
});

test("an unknown readiness code is never optimistically treated as ready", () => {
  assert.equal(resolveFraudUiState("SOMETHING_NEW", NO_FINDINGS), "INSUFFICIENT_ACTIVITY");
  assert.equal(resolveFraudUiState(undefined, NO_FINDINGS), "INSUFFICIENT_ACTIVITY");
});

// ---------------------------------------------------------------------------
// Refresh toasts
// ---------------------------------------------------------------------------

test("refresh toast — processing", () => {
  assert.equal(
    fraudRefreshToast(resolveFraudUiState("SYNC_IN_PROGRESS", NO_FINDINGS), NO_FINDINGS),
    "Fraud data refresh requested. Processing is still in progress."
  );
});

test("refresh toast — ready with no findings", () => {
  assert.equal(
    fraudRefreshToast(resolveFraudUiState("READY_WITH_DATA", NO_FINDINGS), NO_FINDINGS),
    "Fraud intelligence refreshed — no urgent risks were detected."
  );
});

test("refresh toast — findings are counted, with correct singular/plural", () => {
  const one = { returnAbuseProfiles: 1, highRiskOrders: 0, manualReviewCount: 0 };
  assert.equal(
    fraudRefreshToast(resolveFraudUiState("READY_WITH_DATA", one), one),
    "Fraud intelligence refreshed — 1 item needs attention."
  );
  assert.equal(
    fraudRefreshToast(resolveFraudUiState("READY_WITH_DATA", WITH_FINDINGS), WITH_FINDINGS),
    "Fraud intelligence refreshed — 3 items need attention."
  );
});

test("a failed refresh never produces a success toast", () => {
  const toast = fraudRefreshToast(resolveFraudUiState("READY_WITH_DATA", NO_FINDINGS, true), NO_FINDINGS);
  assert.match(toast, /could not be refreshed/i);
  assert.ok(!/refreshed —/.test(toast));
});

test("finding counts are summed and never negative", () => {
  assert.equal(countFraudFindings(NO_FINDINGS), 0);
  assert.equal(countFraudFindings(WITH_FINDINGS), 3);
  assert.equal(
    countFraudFindings({ returnAbuseProfiles: -5, highRiskOrders: 2, manualReviewCount: 0 }),
    2
  );
});

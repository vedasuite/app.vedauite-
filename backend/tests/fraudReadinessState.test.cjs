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
  assert.equal(banner.title, "Customer loss analysis is running");
  assert.equal(banner.tone, "info", "work in progress is informational, not a warning");
  // The module is Customer Loss; fraud detection is one engine underneath it.
  // "Fraud data is being prepared" made a fraud verdict the whole subject.
  assert.doesNotMatch(banner.title, /\bfraud\b/i);
});

test("State B — sync complete but insufficient activity says so plainly", () => {
  for (const code of ["SYNC_COMPLETED_PROCESSING_PENDING", "EMPTY_STORE_DATA", "SYNC_REQUIRED"]) {
    const state = resolveFraudUiState(code, NO_FINDINGS);
    assert.equal(state, "INSUFFICIENT_ACTIVITY", `${code} should mean insufficient activity`);

    const banner = fraudBannerFor(state, null);
    assert.equal(banner.title, "Not enough history to establish a loss pattern yet");
    assert.ok(!/preparing/i.test(banner.title), "must not claim work is in progress");

    // An empty state must answer what was checked, why there is no finding,
    // and what is missing. The old "More store activity is needed" answered
    // none of those: a merchant could not tell whether VedaSuite wanted more
    // orders, more refunds, or simply more time.
    assert.match(banner.body, /checked your synced orders, refunds and customer records/i);
    assert.match(banner.body, /enough order and refund history/i);
    assert.match(banner.body, /a single refund is not evidence/i);
    assert.doesNotMatch(
      banner.title,
      /^More store activity is needed$/,
      "the generic placeholder must not come back"
    );
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
  assert.equal(banner.title, "No repeated customer loss found");
  assert.equal(banner.tone, "success");
  // States what was analysed, so "nothing found" reads as a result rather than
  // as an absence of work.
  assert.match(banner.body, /analysed your refunds, returns and order-risk signals/i);
  assert.match(banner.body, /evidence bar/i);
  // "No urgent fraud reviews are open" told a merchant with ordinary refund
  // leakage that the module had nothing for them — they were reading a fraud
  // verdict where a loss verdict belonged.
  assert.doesNotMatch(banner.body, /urgent fraud reviews/i);
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
    "Refreshed. Still not enough order and refund history to establish a loss pattern."
  );
  assert.ok(!/up to date/i.test(toast), "the old contradictory wording must not return");
  // The toast must name what is missing, not just that something is.
  assert.match(toast, /order and refund history/i);

  // And the banner must still truthfully report the shortfall.
  assert.equal(
    fraudBannerFor(state, null).title,
    "Not enough history to establish a loss pattern yet"
  );
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
    "Refresh requested. Customer loss analysis is still running."
  );
});

test("refresh toast — ready with no findings", () => {
  assert.equal(
    fraudRefreshToast(resolveFraudUiState("READY_WITH_DATA", NO_FINDINGS), NO_FINDINGS),
    "Refreshed — no repeated customer loss pattern was found."
  );
});

test("refresh toast — findings are counted, with correct singular/plural", () => {
  const one = { returnAbuseProfiles: 1, highRiskOrders: 0, manualReviewCount: 0 };
  assert.equal(
    fraudRefreshToast(resolveFraudUiState("READY_WITH_DATA", one), one),
    "Refreshed — 1 customer loss item needs attention."
  );
  assert.equal(
    fraudRefreshToast(resolveFraudUiState("READY_WITH_DATA", WITH_FINDINGS), WITH_FINDINGS),
    "Refreshed — 3 customer loss items need attention."
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

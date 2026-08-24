const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

process.env.SHOPIFY_API_KEY ||= "test-key";
process.env.SHOPIFY_API_SECRET ||= "test-secret";
process.env.SHOPIFY_APP_URL ||= "https://app.vedasuite.in";
process.env.DATABASE_URL ||= "postgresql://example:example@localhost:5432/example";

/**
 * PART 3 — Operational Problem Intelligence (pure calculations).
 *
 * The properties that matter: small stores are protected, thresholds are two-
 * sided so noise cannot trip a detector, and nothing is claimed about systems
 * VedaSuite has no integration with.
 */

const calc = require(path.resolve(__dirname, "../dist/services/operationalProblemCalc.js"));
const { OPERATIONAL } = calc;

const NOW = "2026-08-22T00:00:00.000Z";
const DAY = 86_400_000;
const daysAgo = (n) => new Date(new Date(NOW).getTime() - n * DAY).toISOString();

// ===========================================================================
// O1. Refund-rate shift
// ===========================================================================

/** Builds n orders in a window with a given refund count. */
function orders({ n, refunded, ageDays, prefix }) {
  return Array.from({ length: n }, (_, i) => ({
    id: `${prefix}-${i}`,
    status: "paid",
    refunded: i < refunded,
    totalAmount: 100,
    createdAtIso: daysAgo(ageDays),
  }));
}

function refundShift({ recentN = 40, recentRefunds = 12, baseN = 40, baseRefunds = 2 } = {}) {
  return calc.detectRefundRateShift({
    nowIso: NOW,
    currency: "USD",
    orders: [
      ...orders({ n: recentN, refunded: recentRefunds, ageDays: 5, prefix: "r" }),
      ...orders({ n: baseN, refunded: baseRefunds, ageDays: 50, prefix: "b" }),
    ],
  });
}

test("O1: an abrupt refund-rate rise is detected with both rates reported", () => {
  const r = refundShift(); // 30% recent vs 5% baseline
  assert.ok(r);
  assert.equal(r.detector, "refund_rate_shift");
  const ev = Object.fromEntries(r.evidence.map((e) => [e.label, e.value]));
  assert.equal(ev["Refund rate (recent window)"], "30.0%");
  assert.equal(ev["Refund rate (baseline window)"], "5.0%");
  assert.equal(ev["Refund rate change"], "+25.0 pts");
});

test("O1: the window is explicit and matches the documented recent window", () => {
  const r = refundShift();
  assert.equal(r.window.days, OPERATIONAL.refundShift.recentDays);
  assert.equal(r.window.toIso, NOW);
  assert.ok(new Date(r.window.fromIso) < new Date(r.window.toIso));
});

test("O1: SMALL-DATA protection — a new store with thin windows never fires", () => {
  assert.equal(refundShift({ recentN: 5, recentRefunds: 5, baseN: 40, baseRefunds: 0 }), null);
  assert.equal(refundShift({ recentN: 40, recentRefunds: 20, baseN: 5, baseRefunds: 0 }), null);
  assert.equal(
    calc.detectRefundRateShift({ nowIso: NOW, currency: "USD", orders: [] }),
    null,
    "no orders at all"
  );
});

test("O1: FALSE POSITIVE — a high but STABLE refund rate does not fire", () => {
  // 30% recent vs 28% baseline: absolute rise is only 2 points.
  assert.equal(refundShift({ recentRefunds: 12, baseRefunds: 11 }), null);
});

test("O1: FALSE POSITIVE — a small absolute rise on a tiny baseline does not fire", () => {
  // 0% -> 5%: passes any relative multiple, fails the absolute gate.
  assert.equal(refundShift({ recentRefunds: 2, baseRefunds: 0 }), null);
});

test("O1: both gates are required — absolute AND relative", () => {
  // 20% recent vs 15% baseline: +5 pts absolute (below 10), 1.33x (below 1.5).
  assert.equal(refundShift({ recentRefunds: 8, baseRefunds: 6 }), null);
  // 25% vs 5%: +20 pts and 5x — fires.
  assert.ok(refundShift({ recentRefunds: 10, baseRefunds: 2 }));
});

test("O1: non-eligible statuses and duplicate ids cannot distort the rates", () => {
  const base = [
    ...orders({ n: 40, refunded: 12, ageDays: 5, prefix: "r" }),
    ...orders({ n: 40, refunded: 2, ageDays: 50, prefix: "b" }),
  ];
  const polluted = [
    ...base,
    ...base.slice(0, 10), // duplicate ids
    { id: "v1", status: "voided", refunded: true, totalAmount: 9999, createdAtIso: daysAgo(3) },
    { id: "c1", status: "cancelled", refunded: true, totalAmount: 9999, createdAtIso: daysAgo(3) },
  ];

  const clean = calc.detectRefundRateShift({ nowIso: NOW, currency: "USD", orders: base });
  const dirty = calc.detectRefundRateShift({ nowIso: NOW, currency: "USD", orders: polluted });
  assert.deepEqual(dirty.evidence, clean.evidence, "identical rates despite noise rows");
});

test("O1: refunded value is an upper bound, and mixed currency refuses a figure", () => {
  const r = refundShift();
  assert.equal(r.impact.status, "quantified");
  assert.match(r.impact.basis, /upper bound/i);
  assert.match(r.impact.basis, /refund amounts are not stored/i);

  const noCurrency = calc.detectRefundRateShift({
    nowIso: NOW,
    currency: null,
    orders: [
      ...orders({ n: 40, refunded: 12, ageDays: 5, prefix: "r" }),
      ...orders({ n: 40, refunded: 2, ageDays: 50, prefix: "b" }),
    ],
  });
  assert.equal(noCurrency.impact.status, "impact_not_quantifiable");
});

// ===========================================================================
// O2. High-risk order backlog
// ===========================================================================

function backlog({ open = 5, oldestDays = 10, storeOrders = 100 } = {}) {
  const rows = Array.from({ length: open }, (_, i) => ({
    id: `h-${i}`,
    status: "manual_review",
    refunded: false,
    fraudRiskLevel: "High",
    totalAmount: 200,
    createdAtIso: daysAgo(i === 0 ? oldestDays : 1),
  }));
  return calc.detectHighRiskBacklog({
    nowIso: NOW,
    orders: rows,
    openExposure: {
      status: "quantified",
      min: 0,
      max: 200 * open,
      currency: "USD",
      period: "current_open_exposure",
      basis: "reused from computeHighRiskOpenExposure",
      isEstimate: true,
    },
    openOrderCount: open,
    storeEligibleOrderCount: storeOrders,
  });
}

test("O2: an aging backlog is detected and escalated", () => {
  const r = backlog({ open: 5, oldestDays: 10 });
  assert.ok(r);
  assert.equal(r.detector, "high_risk_order_backlog");
  assert.equal(r.severity, "high", "aging past the threshold escalates");
  const ev = Object.fromEntries(r.evidence.map((e) => [e.label, e.value]));
  assert.equal(ev["Open high-risk orders"], "5");
  assert.equal(ev["Oldest open high-risk order (days)"], "10");
});

test("O2: a fresh backlog is medium, not high", () => {
  const r = backlog({ open: 5, oldestDays: 1 });
  assert.equal(r.severity, "medium");
});

test("O2: SMALL-DATA protection — too few open orders or too little store history", () => {
  assert.equal(backlog({ open: 1 }), null, "below minOpenOrders");
  assert.equal(backlog({ open: 5, storeOrders: 5 }), null, "below minStoreOrders");
});

test("O2: exposure is REUSED from the existing calculation, not recomputed", () => {
  const r = backlog({ open: 4 });
  assert.equal(r.impact.status, "quantified");
  assert.match(r.impact.basis, /computeHighRiskOpenExposure/);
});

test("O2: chargeback status is declared unknowable", () => {
  const r = backlog();
  assert.ok(r.completeness.missingInputs.includes("chargeback_events"));
  assert.match(r.completeness.note, /no chargeback data/i);
});

// ===========================================================================
// O3. Sync / connection health
// ===========================================================================

function syncJob(status, ageDays, id = `s-${Math.random()}`) {
  return {
    id,
    jobType: "shopify_sync",
    status,
    finishedAtIso: daysAgo(ageDays),
    createdAtIso: daysAgo(ageDays),
  };
}

function syncHealth(overrides = {}) {
  return calc.detectSyncHealth({
    nowIso: NOW,
    syncJobs: [syncJob("READY_WITH_DATA", 1)],
    lastSyncAtIso: daysAgo(1),
    lastConnectionStatus: "OK",
    lastWebhookRegistrationStatus: "OK",
    accessTokenExpiresAtIso: null,
    ...overrides,
  });
}

test("O3: a healthy store produces nothing", () => {
  assert.equal(syncHealth(), null);
});

test("O3: consecutive sync failures are detected as high severity", () => {
  const r = syncHealth({
    syncJobs: [syncJob("FAILED", 1, "a"), syncJob("FAILED", 2, "b"), syncJob("READY_WITH_DATA", 9, "c")],
    lastSyncAtIso: daysAgo(9),
  });
  assert.ok(r);
  assert.equal(r.severity, "high");
  const ev = Object.fromEntries(r.evidence.map((e) => [e.label, e.value]));
  assert.equal(ev["Consecutive sync failures"], "2");
});

test("O3: a single failure after a success is NOT a degradation", () => {
  const r = syncHealth({
    syncJobs: [syncJob("FAILED", 1, "a"), syncJob("READY_WITH_DATA", 2, "b")],
    lastSyncAtIso: daysAgo(2),
  });
  assert.equal(r, null, "one failure is noise, not a streak");
});

test("O3: a broken connection and an expiring token are CRITICAL", () => {
  assert.equal(syncHealth({ lastConnectionStatus: "SHOPIFY_RECONNECT_REQUIRED" }).severity, "critical");
  assert.equal(
    syncHealth({ accessTokenExpiresAtIso: new Date(new Date(NOW).getTime() + DAY).toISOString() })
      .severity,
    "critical"
  );
});

test("O3: a token expiring far in the future does not fire", () => {
  assert.equal(
    syncHealth({ accessTokenExpiresAtIso: new Date(new Date(NOW).getTime() + 60 * DAY).toISOString() }),
    null
  );
});

test("O3: a stale successful sync is detected at medium", () => {
  const r = syncHealth({ syncJobs: [syncJob("READY_WITH_DATA", 20)], lastSyncAtIso: daysAgo(20) });
  assert.ok(r);
  assert.equal(r.severity, "medium");
});

test("O3: NEW-STORE protection — never synced, healthy connection, no alert", () => {
  const r = syncHealth({ syncJobs: [], lastSyncAtIso: null });
  assert.equal(r, null, "a store that has never synced is onboarding, not degraded");
});

test("O3: failed webhook registration is reported", () => {
  const r = syncHealth({ lastWebhookRegistrationStatus: "FAILED" });
  assert.ok(r);
  assert.match(r.what, /webhook registration failed/i);
});

test("O3: no monetary impact is invented for a data-delivery problem", () => {
  const r = syncHealth({ lastConnectionStatus: "MISSING_ACCESS_TOKEN" });
  assert.equal(r.impact.status, "impact_not_quantifiable");
  assert.match(r.impact.reason, /no directly attributable monetary value/i);
});

// ===========================================================================
// O4. Data coverage
// ===========================================================================

function coverage(overrides = {}) {
  return calc.detectDataCoverage({
    nowIso: NOW,
    totalProducts: 100,
    productsWithUsableCost: 90,
    totalOrders: 200,
    ordersWithCustomer: 200,
    distinctOrderCurrencies: 1,
    ...overrides,
  });
}

test("O4: full coverage produces nothing", () => {
  assert.equal(coverage(), null);
});

test("O4: low cost coverage is reported with the exact ratio", () => {
  const r = coverage({ productsWithUsableCost: 20 });
  assert.ok(r);
  assert.equal(r.detector, "data_coverage_low");
  assert.match(r.what, /20% of products have usable cost data/);
  assert.equal(r.severity, "low", "a coverage gap is informational, not an incident");
});

test("O4: weak customer linkage and mixed currencies are both reported", () => {
  const r = coverage({ ordersWithCustomer: 100, distinctOrderCurrencies: 3 });
  assert.match(r.what, /50% of orders are linked to a customer/);
  assert.match(r.what, /3 currencies/);
});

test("O4: SMALL-DATA protection — a nearly empty store is never warned", () => {
  assert.equal(coverage({ totalProducts: 3, productsWithUsableCost: 0 }), null);
  assert.equal(coverage({ totalOrders: 5, ordersWithCustomer: 0 }), null);
});

test("O4: coverage explains that it limits accuracy, not that the store is broken", () => {
  const r = coverage({ productsWithUsableCost: 10 });
  assert.match(r.why, /not themselves a store problem/i);
  assert.equal(r.impact.status, "impact_not_quantifiable");
});

// ===========================================================================
// Cross-cutting guarantees
// ===========================================================================

test("every detector states what happened, why it matters, and a manual action", () => {
  const results = [
    refundShift(),
    backlog(),
    syncHealth({ lastConnectionStatus: "SHOPIFY_AUTH_REQUIRED" }),
    coverage({ productsWithUsableCost: 10 }),
  ];

  for (const r of results) {
    assert.ok(r.what && r.what.length > 10, `${r.detector} must say what happened`);
    assert.ok(r.why && r.why.length > 10, `${r.detector} must say why it matters`);
    assert.ok(r.window.days > 0, `${r.detector} must state a window`);
    assert.match(
      r.recommendedAction,
      /No automatic action was taken/i,
      `${r.detector} must be merchant-controlled`
    );
    assert.ok(["critical", "high", "medium", "low"].includes(r.severity));
    assert.ok(["high", "medium", "low", "insufficient_data"].includes(r.confidence));
    assert.ok(r.subjectKey, `${r.detector} needs a stable dedupe subject`);
  }
});

test("no detector claims a supplier, carrier, advertising, marketplace, ERP or WMS problem", () => {
  const results = [
    refundShift(),
    backlog(),
    syncHealth({ lastConnectionStatus: "SHOPIFY_AUTH_REQUIRED" }),
    coverage({ productsWithUsableCost: 10 }),
  ];
  const text = JSON.stringify(results).toLowerCase();

  for (const forbidden of [
    "supplier",
    "carrier",
    "3pl",
    "warehouse",
    "wms",
    "erp",
    "marketplace",
    "advertising",
    "ad spend",
    "product feed",
    "stockout",
    "out of stock",
    "inventory",
    "shipping delay",
  ]) {
    assert.equal(
      text.includes(forbidden),
      false,
      `must never claim "${forbidden}" — no integration supplies that evidence`
    );
  }
});

test("the source module documents the rejected detectors and proves the data gap", () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, "../src/services/operationalProblemCalc.ts"),
    "utf8"
  );
  assert.match(src, /DELIBERATELY NOT BUILT/);
  for (const rejected of ["supplier", "carrier", "ERP", "WMS", "marketplace", "chargeback"]) {
    assert.ok(src.includes(rejected), `${rejected} must be explicitly documented as not built`);
  }
});

test("evidence carries only allowlisted aggregates, never identifiers or PII", () => {
  const results = [refundShift(), backlog(), coverage({ productsWithUsableCost: 10 })];
  for (const r of results) {
    const serialized = JSON.stringify(r.evidence);
    assert.doesNotMatch(serialized, /@/, "no email");
    assert.doesNotMatch(serialized, /\b(h-\d|r-\d|b-\d)\b/, "no order ids");
    for (const item of r.evidence) {
      assert.equal(typeof item.label, "string");
      assert.equal(typeof item.value, "string");
    }
  }
});

test("thresholds are exported so they are documented in one place", () => {
  assert.equal(OPERATIONAL.refundShift.recentDays, 14);
  assert.equal(OPERATIONAL.refundShift.minOrdersPerWindow, 20);
  assert.equal(OPERATIONAL.refundShift.minAbsoluteRise, 0.1);
  assert.equal(OPERATIONAL.refundShift.minRelativeMultiple, 1.5);
  assert.equal(OPERATIONAL.highRiskBacklog.minOpenOrders, 3);
  assert.equal(OPERATIONAL.syncHealth.failureStreak, 2);
  assert.equal(OPERATIONAL.coverage.minCostCoverage, 0.5);
});

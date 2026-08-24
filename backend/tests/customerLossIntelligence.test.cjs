const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

process.env.SHOPIFY_API_KEY ||= "test-key";
process.env.SHOPIFY_API_SECRET ||= "test-secret";
process.env.SHOPIFY_APP_URL ||= "https://app.vedasuite.in";
process.env.DATABASE_URL ||= "postgresql://example:example@localhost:5432/example";

/**
 * PART 2A — Customer Loss Intelligence (pure calculation).
 *
 * The properties that matter most here are the honesty properties: observed
 * loss is never mixed with future risk, mixed currencies are refused rather
 * than summed, and no figure is produced from data VedaSuite does not hold.
 */

const { computeCustomerLoss, CUSTOMER_LOSS } = require(
  path.resolve(__dirname, "../dist/services/customerLossCalc.js")
);

const NOW = "2026-08-22T00:00:00.000Z";
const DAY = 86_400_000;

function daysAgo(n) {
  return new Date(new Date(NOW).getTime() - n * DAY).toISOString();
}

function order(overrides = {}) {
  return {
    id: `o-${Math.random().toString(36).slice(2, 10)}`,
    status: "paid",
    refunded: false,
    totalAmount: 100,
    currency: "USD",
    createdAtIso: daysAgo(10),
    ...overrides,
  };
}

/** A store with plenty of baseline history and a low baseline refund rate. */
const HEALTHY_STORE = {
  storeEligibleOrderCount: 500,
  storeRefundedEligibleCount: 25, // 5% baseline
};

function run(customerOrders, extra = {}) {
  return computeCustomerLoss({
    nowIso: NOW,
    customerOrders,
    riskSignalCount: 0,
    ...HEALTHY_STORE,
    ...extra,
  });
}

// ===========================================================================
// 1. The core pattern
// ===========================================================================

test("repeated refunds across multiple orders produce an observed-loss finding", () => {
  const result = run([
    order({ id: "a", refunded: true, totalAmount: 200, createdAtIso: daysAgo(60) }),
    order({ id: "b", refunded: true, totalAmount: 150, createdAtIso: daysAgo(30) }),
    order({ id: "c", refunded: false, totalAmount: 100, createdAtIso: daysAgo(10) }),
    order({ id: "d", refunded: false, totalAmount: 50, createdAtIso: daysAgo(5) }),
  ]);

  assert.equal(result.pattern, "repeated_refund_loss");
  assert.equal(result.observed.eligibleOrders, 4);
  assert.equal(result.observed.refundedOrders, 2);
  assert.equal(result.observed.eligibleOrderValue, 500);
  assert.equal(result.observed.refundedOrderValue, 350);
  assert.equal(result.observed.lossRatio, 0.7);
  assert.equal(result.observed.currency, "USD");
  assert.equal(result.observedImpact.status, "quantified");
  assert.equal(result.observedImpact.max, 350);
});

test("the observed window reports exact first and last order dates", () => {
  const result = run([
    order({ id: "a", refunded: true, totalAmount: 200, createdAtIso: daysAgo(200) }),
    order({ id: "b", refunded: true, totalAmount: 200, createdAtIso: daysAgo(100) }),
    order({ id: "c", totalAmount: 100, createdAtIso: daysAgo(3) }),
  ]);

  assert.equal(result.observed.firstOrderIso, daysAgo(200));
  assert.equal(result.observed.lastOrderIso, daysAgo(3));
  assert.equal(result.observed.windowDays, CUSTOMER_LOSS.observedWindowDays);
});

// ===========================================================================
// 2. OBSERVED loss is never mixed with FUTURE RISK
// ===========================================================================

test("observed loss and future risk are separate fields and are never summed", () => {
  const result = run([
    order({ id: "a", refunded: true, totalAmount: 300, createdAtIso: daysAgo(20) }),
    order({ id: "b", refunded: true, totalAmount: 300, createdAtIso: daysAgo(15) }),
    order({ id: "c", refunded: true, totalAmount: 200, createdAtIso: daysAgo(10) }),
    order({ id: "d", totalAmount: 100, createdAtIso: daysAgo(5) }),
    order({ id: "e", totalAmount: 100, createdAtIso: daysAgo(2) }),
  ]);

  assert.equal(result.observedImpact.status, "quantified");
  // Two distinct properties, each with its own basis/period.
  assert.ok("futureRisk" in result);
  assert.notEqual(result.observedImpact, result.futureRisk);
  if (result.futureRisk.status === "quantified") {
    assert.notEqual(
      result.futureRisk.period,
      result.observedImpact.period,
      "different periods keep the two figures from being conflated"
    );
  }
  // The observed max is exactly the refunded order value — nothing added.
  assert.equal(result.observedImpact.max, 800);
});

test("observed impact discloses that it is an upper bound, not an exact refund total", () => {
  const result = run([
    order({ id: "a", refunded: true, totalAmount: 200, createdAtIso: daysAgo(20) }),
    order({ id: "b", refunded: true, totalAmount: 200, createdAtIso: daysAgo(15) }),
    order({ id: "c", totalAmount: 100, createdAtIso: daysAgo(5) }),
  ]);

  assert.match(result.observedImpact.basis, /upper bound/i);
  assert.match(result.observedImpact.basis, /refund amounts are not stored/i);
  assert.match(result.observedImpact.basis, /[Cc]hargebacks and discounts are not included/);
  assert.equal(result.observedImpact.min, 0, "a range, not a point estimate");
});

test("structurally unavailable inputs are always declared", () => {
  const result = run([
    order({ id: "a", refunded: true, totalAmount: 200, createdAtIso: daysAgo(20) }),
    order({ id: "b", refunded: true, totalAmount: 200, createdAtIso: daysAgo(15) }),
    order({ id: "c", totalAmount: 100, createdAtIso: daysAgo(5) }),
  ]);

  for (const missing of [
    "refund_amount_per_order",
    "chargebacks",
    "discount_amounts",
    "return_records",
    "order_line_items",
  ]) {
    assert.ok(
      result.completeness.missingInputs.includes(missing),
      `${missing} must be declared missing`
    );
  }
  assert.notEqual(result.completeness.level, "complete", "can never be complete");
});

// ===========================================================================
// 3. Noise / false-positive protection
// ===========================================================================

test("a single refunded order never produces a finding", () => {
  const result = run([
    order({ id: "a", refunded: true, totalAmount: 500, createdAtIso: daysAgo(10) }),
    order({ id: "b", totalAmount: 100, createdAtIso: daysAgo(5) }),
    order({ id: "c", totalAmount: 100, createdAtIso: daysAgo(2) }),
  ]);

  assert.equal(result.pattern, null);
  assert.equal(result.observedImpact.status, "impact_not_quantifiable");
  assert.match(result.observedImpact.reason, /repeated pattern/i);
});

test("fewer than the minimum eligible orders never produces a finding", () => {
  const result = run([
    order({ id: "a", refunded: true, totalAmount: 500 }),
    order({ id: "b", refunded: true, totalAmount: 500 }),
  ]);

  assert.equal(result.pattern, null);
  assert.match(result.observedImpact.reason, /Fewer than 3 eligible orders/i);
});

test("a store with too little history never produces a finding", () => {
  const result = run(
    [
      order({ id: "a", refunded: true, totalAmount: 200 }),
      order({ id: "b", refunded: true, totalAmount: 200 }),
      order({ id: "c", totalAmount: 100 }),
    ],
    { storeEligibleOrderCount: 10, storeRefundedEligibleCount: 1 }
  );

  assert.equal(result.pattern, null);
  assert.match(result.observedImpact.reason, /fewer than 50 eligible orders/i);
});

test("a loss ratio below the threshold reports observed values but no finding", () => {
  // 2 refunds but only 10% of order value — repeated, yet immaterial.
  const result = run([
    order({ id: "a", refunded: true, totalAmount: 50, createdAtIso: daysAgo(30) }),
    order({ id: "b", refunded: true, totalAmount: 50, createdAtIso: daysAgo(20) }),
    order({ id: "c", totalAmount: 450, createdAtIso: daysAgo(10) }),
    order({ id: "d", totalAmount: 450, createdAtIso: daysAgo(5) }),
  ]);

  assert.equal(result.pattern, null);
  assert.equal(result.observed.lossRatio, 0.1);
  assert.match(result.observedImpact.reason, /below the 30% threshold/i);
  assert.equal(result.evidence.length, 0, "no evidence emitted for a non-finding");
});

test("non-eligible order statuses are excluded from both numerator and denominator", () => {
  const result = run([
    order({ id: "a", refunded: true, totalAmount: 200, createdAtIso: daysAgo(20) }),
    order({ id: "b", refunded: true, totalAmount: 200, createdAtIso: daysAgo(15) }),
    order({ id: "c", totalAmount: 100, createdAtIso: daysAgo(5) }),
    order({ id: "x", status: "voided", refunded: true, totalAmount: 9999 }),
    order({ id: "y", status: "cancelled", totalAmount: 9999 }),
  ]);

  assert.equal(result.observed.eligibleOrders, 3, "voided/cancelled excluded");
  assert.equal(result.observed.eligibleOrderValue, 500);
  assert.equal(result.observed.refundedOrderValue, 400);
});

test("orders outside the observation window are excluded", () => {
  const result = run([
    order({ id: "old1", refunded: true, totalAmount: 5000, createdAtIso: daysAgo(400) }),
    order({ id: "a", refunded: true, totalAmount: 200, createdAtIso: daysAgo(20) }),
    order({ id: "b", refunded: true, totalAmount: 200, createdAtIso: daysAgo(15) }),
    order({ id: "c", totalAmount: 100, createdAtIso: daysAgo(5) }),
  ]);

  assert.equal(result.observed.eligibleOrders, 3, "the 400-day-old order is outside the window");
  assert.equal(result.observed.refundedOrderValue, 400);
});

test("duplicate order rows cannot inflate the observed loss", () => {
  const dup = order({ id: "same", refunded: true, totalAmount: 300, createdAtIso: daysAgo(20) });
  const result = run([
    dup,
    { ...dup },
    { ...dup },
    order({ id: "b", refunded: true, totalAmount: 300, createdAtIso: daysAgo(15) }),
    order({ id: "c", totalAmount: 100, createdAtIso: daysAgo(5) }),
  ]);

  assert.equal(result.observed.eligibleOrders, 3, "the repeated id is counted once");
  assert.equal(result.observed.refundedOrderValue, 600);
});

// ===========================================================================
// 4. Currency correctness
// ===========================================================================

test("mixed currencies are REFUSED rather than summed", () => {
  const result = run([
    order({ id: "a", refunded: true, totalAmount: 200, currency: "USD", createdAtIso: daysAgo(20) }),
    order({ id: "b", refunded: true, totalAmount: 200, currency: "EUR", createdAtIso: daysAgo(15) }),
    order({ id: "c", totalAmount: 100, currency: "USD", createdAtIso: daysAgo(5) }),
  ]);

  assert.equal(result.pattern, null);
  assert.equal(result.observed, null, "no observed figure is produced at all");
  assert.match(result.observedImpact.reason, /multiple currencies/i);
  assert.ok(result.completeness.missingInputs.includes("single_order_currency"));
});

test("currency is normalised and carried through", () => {
  const result = run([
    order({ id: "a", refunded: true, totalAmount: 200, currency: "gbp", createdAtIso: daysAgo(20) }),
    order({ id: "b", refunded: true, totalAmount: 200, currency: "GBP", createdAtIso: daysAgo(15) }),
    order({ id: "c", totalAmount: 100, currency: "Gbp", createdAtIso: daysAgo(5) }),
  ]);

  assert.equal(result.observed.currency, "GBP");
  assert.equal(result.observedImpact.currency, "GBP");
});

// ===========================================================================
// 5. Edge cases / partial data
// ===========================================================================

test("no eligible orders at all is handled safely", () => {
  const result = run([order({ status: "voided" }), order({ status: "cancelled" })]);
  assert.equal(result.pattern, null);
  assert.equal(result.confidence, "insufficient_data");
  assert.match(result.observedImpact.reason, /no eligible orders with a currency/i);
});

test("an empty order list is handled safely", () => {
  const result = run([]);
  assert.equal(result.pattern, null);
  assert.equal(result.observed, null);
  assert.equal(result.evidence.length, 0);
});

test("negative and non-finite amounts are excluded, never treated as loss", () => {
  const result = run([
    order({ id: "a", refunded: true, totalAmount: 200, createdAtIso: daysAgo(20) }),
    order({ id: "b", refunded: true, totalAmount: 200, createdAtIso: daysAgo(15) }),
    order({ id: "c", totalAmount: 100, createdAtIso: daysAgo(5) }),
    order({ id: "bad1", refunded: true, totalAmount: -500, createdAtIso: daysAgo(10) }),
    order({ id: "bad2", refunded: true, totalAmount: Number.NaN, createdAtIso: daysAgo(10) }),
  ]);

  assert.equal(result.observed.eligibleOrders, 3);
  assert.equal(result.observed.refundedOrderValue, 400, "bad rows contribute nothing");
});

test("rounding is applied to two decimal places", () => {
  const result = run([
    order({ id: "a", refunded: true, totalAmount: 33.333, createdAtIso: daysAgo(20) }),
    order({ id: "b", refunded: true, totalAmount: 33.333, createdAtIso: daysAgo(15) }),
    order({ id: "c", totalAmount: 33.334, createdAtIso: daysAgo(5) }),
  ]);

  assert.equal(result.observed.refundedOrderValue, 66.67);
  assert.equal(result.observed.eligibleOrderValue, 100);
  assert.equal(String(result.observed.lossRatio).length <= 5, true);
});

// ===========================================================================
// 6. Confidence grading
// ===========================================================================

test("confidence rises with volume, repetition and corroborating risk signals", () => {
  const many = [
    order({ id: "r1", refunded: true, totalAmount: 200, createdAtIso: daysAgo(60) }),
    order({ id: "r2", refunded: true, totalAmount: 200, createdAtIso: daysAgo(50) }),
    order({ id: "r3", refunded: true, totalAmount: 200, createdAtIso: daysAgo(40) }),
    order({ id: "n1", totalAmount: 100, createdAtIso: daysAgo(30) }),
    order({ id: "n2", totalAmount: 100, createdAtIso: daysAgo(20) }),
    order({ id: "n3", totalAmount: 100, createdAtIso: daysAgo(10) }),
  ];

  assert.equal(run(many, { riskSignalCount: 3 }).confidence, "high");
  assert.equal(run(many, { riskSignalCount: 0 }).confidence, "medium");

  const minimal = [
    order({ id: "a", refunded: true, totalAmount: 200, createdAtIso: daysAgo(20) }),
    order({ id: "b", refunded: true, totalAmount: 200, createdAtIso: daysAgo(15) }),
    order({ id: "c", totalAmount: 100, createdAtIso: daysAgo(5) }),
  ];
  assert.equal(run(minimal, { riskSignalCount: 0 }).confidence, "low");
});

// ===========================================================================
// 7. Evidence hygiene — no PII can escape
// ===========================================================================

test("evidence contains only allowlisted aggregates, never customer identity", () => {
  const result = run([
    order({ id: "a", refunded: true, totalAmount: 200, createdAtIso: daysAgo(20) }),
    order({ id: "b", refunded: true, totalAmount: 200, createdAtIso: daysAgo(15) }),
    order({ id: "c", totalAmount: 100, createdAtIso: daysAgo(5) }),
  ]);

  const serialized = JSON.stringify(result.evidence);
  assert.doesNotMatch(serialized, /@/, "no email");
  assert.ok(result.evidence.length > 0);
  for (const item of result.evidence) {
    assert.equal(typeof item.label, "string");
    assert.equal(typeof item.value, "string");
  }
  // Order ids are internal identifiers and must not leak into evidence.
  assert.doesNotMatch(serialized, /"o-|"a"|"b"|"c"/);
});

test("the finding never instructs an automatic customer or store change", () => {
  const result = run([
    order({ id: "a", refunded: true, totalAmount: 200, createdAtIso: daysAgo(20) }),
    order({ id: "b", refunded: true, totalAmount: 200, createdAtIso: daysAgo(15) }),
    order({ id: "c", totalAmount: 100, createdAtIso: daysAgo(5) }),
  ]);

  const text = result.reasons.join(" ");
  assert.doesNotMatch(text, /\bblock(ed|ing)?\b|\bban(ned)?\b|automatically/i);
  assert.match(
    result.reasons.join(" "),
    /future risk is reported separately/i,
    "the separation is stated to the merchant, not just in the data"
  );
});

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

process.env.SHOPIFY_API_KEY ||= "test-key";
process.env.SHOPIFY_API_SECRET ||= "test-secret";
process.env.SHOPIFY_APP_URL ||= "https://app.vedasuite.in";
process.env.DATABASE_URL ||= "postgresql://example:example@localhost:5432/example";

/**
 * PART 2B — Product Profit Intelligence (pure calculation).
 *
 * The load-bearing property: a missing or zero cost must NEVER become a profit
 * claim, and no result may be labelled true profit.
 */

const { computeProductProfit, PRODUCT_PROFIT } = require(
  path.resolve(__dirname, "../dist/services/productProfitCalc.js")
);

function input(overrides = {}) {
  return {
    productHandle: "widget",
    productTitle: "Widget",
    currency: "USD",
    sellingPrice: 100,
    productCost: 60,
    shippingCost: 10,
    returnRate: 0.1,
    salesVelocity: 5,
    dataAsOfIso: "2026-08-20T00:00:00.000Z",
    ...overrides,
  };
}

// ===========================================================================
// 1. Core calculation
// ===========================================================================

test("retained unit economics are computed from price, cost, shipping and return rate", () => {
  // 100 - 60 - 10 = 30 before returns; 30 * (1 - 0.10) = 27 after returns.
  const r = computeProductProfit(input());

  assert.equal(r.unitEconomics.retainedBeforeReturns, 30);
  assert.equal(r.unitEconomics.retainedAfterReturns, 27);
  assert.equal(r.unitEconomics.retainedMarginRatio, 0.27);
  assert.equal(r.unitEconomics.currency, "USD");
  assert.equal(r.completeness.level, "complete");
  assert.equal(r.pattern, null, "27% retained is healthy, above the 15% threshold");
});

test("a weakened retained margin is flagged at or below the documented threshold", () => {
  // 100 - 80 - 8 = 12 -> 12% of price, under the 15% threshold.
  const r = computeProductProfit(input({ productCost: 80, shippingCost: 8, returnRate: 0 }));

  assert.equal(r.pattern, "weakened_retained_margin");
  assert.equal(r.unitEconomics.retainedMarginRatio, 0.12);
  assert.equal(r.financialImpact.status, "quantified");
  assert.equal(r.financialImpact.period, "per_order");
  assert.equal(r.financialImpact.max, 12);
});

test("negative retained economics are flagged distinctly and signed correctly", () => {
  // 100 - 95 - 20 = -15
  const r = computeProductProfit(input({ productCost: 95, shippingCost: 20, returnRate: 0 }));

  assert.equal(r.pattern, "negative_retained_margin");
  assert.equal(r.unitEconomics.retainedBeforeReturns, -15);
  assert.equal(r.financialImpact.status, "quantified");
  assert.equal(r.financialImpact.min, -15, "the loss is the lower bound");
  assert.equal(r.financialImpact.max, 0);
});

test("the threshold boundary is inclusive as documented", () => {
  // exactly 15% retained
  const r = computeProductProfit(input({ productCost: 85, shippingCost: 0, returnRate: 0 }));
  assert.equal(r.unitEconomics.retainedMarginRatio, PRODUCT_PROFIT.weakenedMarginRatio);
  assert.equal(r.pattern, "weakened_retained_margin", "<= threshold is weakened");
});

// ===========================================================================
// 2. NEVER invent costs — the central guarantee
// ===========================================================================

test("a missing product cost yields no figure and is not called profit", () => {
  const r = computeProductProfit(input({ productCost: null }));

  assert.equal(r.pattern, null);
  assert.equal(r.unitEconomics, null);
  assert.equal(r.financialImpact.status, "impact_not_quantifiable");
  assert.equal(r.completeness.level, "insufficient");
  assert.ok(r.completeness.missingInputs.includes("product_cost"));
  assert.match(r.financialImpact.reason, /not a profit figure/i);
});

test("a ZERO product cost is treated as MISSING data, never as a free product", () => {
  // The critical guard: cost 0 would otherwise imply a 100% margin.
  for (const cost of [0, -5]) {
    const r = computeProductProfit(input({ productCost: cost }));
    assert.equal(r.unitEconomics, null, `cost ${cost} must not produce economics`);
    assert.ok(
      r.completeness.missingInputs.includes("product_cost"),
      `cost ${cost} must be reported as missing`
    );
    assert.equal(r.financialImpact.status, "impact_not_quantifiable");
  }
});

test("a missing selling price yields no figure", () => {
  const r = computeProductProfit(input({ sellingPrice: null }));
  assert.equal(r.unitEconomics, null);
  assert.ok(r.completeness.missingInputs.includes("selling_price"));
});

test("no result anywhere CLAIMS true profit — every mention is a disclaimer", () => {
  const cases = [
    input(),
    input({ productCost: 80, shippingCost: 8, returnRate: 0 }),
    input({ productCost: 95, shippingCost: 20, returnRate: 0 }),
    input({ productCost: null }),
    input({ shippingCost: null, returnRate: null }),
  ];

  for (const c of cases) {
    const r = computeProductProfit(c);
    const text = JSON.stringify(r);

    // The label a merchant sees must always be "retained", never "profit".
    assert.match(r.completeness.label, /retained/i);
    assert.doesNotMatch(r.completeness.label, /\bprofit\b/i);

    // Every mention of profit as a RESULT must be negated (not / never).
    // "Not a realised profit figure" is exactly the disclaimer we want; a bare
    // "realised profit of 12 USD" is what must never appear.
    const claimPhrases = /.{0,28}((true|actual|realised|realized|net|gross) profit)/gi;
    for (const match of text.matchAll(claimPhrases)) {
      assert.match(
        match[0],
        /\b(not|never|isn'?t)\b/i,
        `"${match[0].trim()}" must be a disclaimer, not a claim`
      );
    }

    // And nothing may state a profit amount.
    assert.doesNotMatch(text, /profit of \d/i);
    assert.doesNotMatch(text, /profit[^"]{0,12}:\s*\d/i);
  }
});

// ===========================================================================
// 3. Partial data — shipping and returns are never silently zero
// ===========================================================================

test("a missing shipping cost is NOT defaulted to zero and the label says so", () => {
  const r = computeProductProfit(input({ shippingCost: null }));

  assert.equal(r.unitEconomics.shippingCost, null, "never coerced to 0");
  assert.equal(r.completeness.level, "partial");
  assert.ok(r.completeness.missingInputs.includes("shipping_cost"));
  assert.match(r.completeness.label, /before shipping/i);
});

test("a missing return rate is reported and the label says before returns", () => {
  const r = computeProductProfit(input({ returnRate: null }));

  assert.equal(r.unitEconomics.returnRate, null);
  assert.equal(r.unitEconomics.retainedAfterReturns, null);
  assert.equal(r.completeness.level, "partial");
  assert.ok(r.completeness.missingInputs.includes("return_rate"));
  assert.match(r.completeness.label, /before returns/i);
});

test("both erosion inputs missing produces a combined label and partial completeness", () => {
  const r = computeProductProfit(input({ shippingCost: null, returnRate: null }));

  assert.equal(r.completeness.level, "partial");
  assert.match(r.completeness.label, /before shipping and before returns/i);
  assert.ok(r.completeness.missingInputs.includes("shipping_cost"));
  assert.ok(r.completeness.missingInputs.includes("return_rate"));
});

test("an out-of-range return rate is treated as absent, not clamped into a result", () => {
  for (const bad of [-0.5, 1.5, Number.NaN]) {
    const r = computeProductProfit(input({ returnRate: bad }));
    assert.equal(r.unitEconomics.returnRate, null, `${bad} must be rejected`);
    assert.ok(r.completeness.missingInputs.includes("return_rate"));
  }
});

test("completeness is only 'complete' when every erosion input is present", () => {
  assert.equal(computeProductProfit(input()).completeness.level, "complete");
  assert.equal(computeProductProfit(input({ shippingCost: null })).completeness.level, "partial");
  assert.equal(computeProductProfit(input({ returnRate: null })).completeness.level, "partial");
});

test("structurally unavailable inputs are always declared", () => {
  const r = computeProductProfit(input({ productCost: 80, shippingCost: 8, returnRate: 0 }));
  for (const missing of [
    "order_line_items",
    "per_product_realised_sales",
    "chargebacks",
    "discount_amounts",
  ]) {
    assert.ok(r.completeness.missingInputs.includes(missing), `${missing} must be declared`);
  }
});

// ===========================================================================
// 4. Currency and rounding
// ===========================================================================

test("a missing currency refuses to state a monetary result", () => {
  for (const bad of [null, "", "   "]) {
    const r = computeProductProfit(input({ currency: bad }));
    assert.equal(r.unitEconomics, null);
    assert.ok(r.completeness.missingInputs.includes("product_currency"));
  }
});

test("currency is normalised to upper case", () => {
  const r = computeProductProfit(input({ currency: "eur" }));
  assert.equal(r.unitEconomics.currency, "EUR");
});

test("monetary values are rounded to two decimals", () => {
  // 19.999 - 12.333 - 1.111 = 6.555 -> 6.56 (round2 on the subtraction)
  const r = computeProductProfit(
    input({ sellingPrice: 19.999, productCost: 12.333, shippingCost: 1.111, returnRate: 0 })
  );
  assert.equal(r.unitEconomics.retainedBeforeReturns, 6.56);
  assert.equal(r.unitEconomics.shippingCost, 1.11);
});

test("a selling price below the minimum is refused", () => {
  const r = computeProductProfit(input({ sellingPrice: 0.001 }));
  assert.equal(r.unitEconomics, null);
  assert.match(r.financialImpact.reason, /not meaningful/i);
});

// ===========================================================================
// 5. Impact is never extrapolated beyond what the data supports
// ===========================================================================

test("impact stays per-unit and states why it is not extrapolated", () => {
  const r = computeProductProfit(input({ productCost: 80, shippingCost: 8, returnRate: 0 }));

  assert.equal(r.financialImpact.period, "per_order", "per unit only");
  assert.match(r.financialImpact.basis, /[Nn]ot extrapolated to a period/);
  assert.match(r.financialImpact.basis, /order line items are not stored/i);
  assert.match(r.financialImpact.basis, /[Cc]hargebacks and discounts are not included/);
});

test("drivers explain what moved the number", () => {
  const r = computeProductProfit(input({ productCost: 80, shippingCost: 8, returnRate: 0.2 }));

  const drivers = r.drivers.join(" ");
  assert.match(drivers, /selling price/i);
  assert.match(drivers, /unit cost/i);
  assert.match(drivers, /shipping/i);
  assert.match(drivers, /return rate/i);
});

test("no ProfitOptimizationData at all is handled safely", () => {
  const r = computeProductProfit({
    productHandle: "orphan",
    productTitle: null,
    currency: "USD",
    sellingPrice: null,
    productCost: null,
    shippingCost: null,
    returnRate: null,
    salesVelocity: null,
    dataAsOfIso: null,
  });

  assert.equal(r.pattern, null);
  assert.equal(r.unitEconomics, null);
  assert.equal(r.confidence, "insufficient_data");
  assert.equal(r.evidence.length, 0);
});

// ===========================================================================
// 6. Evidence hygiene and confidence
// ===========================================================================

test("evidence reports completeness and missing inputs, and carries no PII", () => {
  const r = computeProductProfit(input({ productCost: 80, shippingCost: null, returnRate: 0 }));
  const labels = r.evidence.map((e) => e.label);

  assert.ok(labels.includes("Data completeness"));
  assert.ok(labels.includes("Missing inputs"));
  assert.doesNotMatch(JSON.stringify(r.evidence), /@/);
});

test("confidence never exceeds medium, and drops to low on partial data", () => {
  assert.equal(
    computeProductProfit(input({ productCost: 80, shippingCost: 8, returnRate: 0 })).confidence,
    "medium"
  );
  assert.equal(
    computeProductProfit(input({ productCost: 80, shippingCost: null, returnRate: 0 })).confidence,
    "low"
  );
});

test("the finding never instructs an automatic price or store change", () => {
  const r = computeProductProfit(input({ productCost: 95, shippingCost: 20, returnRate: 0 }));
  const text = JSON.stringify(r);
  assert.doesNotMatch(text, /automatically (change|update|set|apply)/i);
});

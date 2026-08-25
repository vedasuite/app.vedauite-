const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

/**
 * DASHBOARD / PRICING EVIDENCE INTEGRITY.
 *
 * PRODUCTION CONTRADICTION: the Dashboard headline showed
 *   Potential revenue $5,641 · Expected return $680 · AI confidence 60%
 * while Pricing, for the same underlying opportunity, correctly showed
 *   Profit opportunities 0 · Projected gain "Not enough data yet".
 *
 * Both trace to ProfitOptimizationData, whose profit inputs are assumptions:
 *   productCost   = ?? currentPrice * 0.58
 *   salesVelocity = ?? max(4, orders / products)
 *   shippingCost  = ?? currentPrice * 0.06
 *   advertising   = ?? currentPrice * 0.10
 * The fallbacks are PERSISTED, so a later `salesVelocity != null` check passes
 * and a guess is laundered into "observed data".
 */

const ELIG = path.resolve(__dirname, "../dist/services/evidenceEligibility.js");
const elig = require(ELIG);

const SERVICE_SRC = fs.readFileSync(
  path.resolve(__dirname, "../src/services/explainabilityService.ts"),
  "utf8"
);
const CORE_SRC = fs.readFileSync(
  path.resolve(__dirname, "../src/services/coreEngineService.ts"),
  "utf8"
);

// ===========================================================================
// 1. Assumed cost + fallback velocity must not create a revenue estimate
// ===========================================================================

test("PROD REPRO: assumed cost + fallback velocity yields NO monetary claim", () => {
  const v = elig.classifyMonetaryClaim({
    salesVelocityObserved: false,
    productCostObserved: false,
  });
  assert.equal(v.allowed, false, "$5,641 and $680 must not be permitted");
  assert.equal(v.confidence, "insufficient_data");
  assert.deepEqual(v.missing, [
    "how many units each product actually sells",
    "what each product costs you",
  ]);
});

test("PROD REPRO: the merchant is told WHY, in plain language", () => {
  const v = elig.classifyMonetaryClaim({
    salesVelocityObserved: false,
    productCostObserved: false,
  });
  assert.match(v.explanation, /order line items/i, "must name the real limitation");
  assert.match(v.explanation, /Shopify does not share product cost/i);
  assert.ok(v.explanation.length > 80, "must explain, not just refuse");
});

// ===========================================================================
// 2. A persisted fallback must never pass an "observed" check
// ===========================================================================

test("PROD REPRO: a stored ProfitOptimizationData value is never 'observed'", () => {
  // The original bug: `pd.salesVelocity != null` passed because the fallback
  // had been written to the row.
  assert.equal(
    elig.storedProfitValueIsObserved(),
    false,
    "a non-null persisted field is not evidence"
  );
});

test("PROD REPRO: neither profit input is observable with the current data model", () => {
  // Not a provenance problem: there is nothing to distinguish, because these
  // cannot be measured at all today.
  assert.equal(elig.PROFIT_INPUTS.salesVelocity.observable, false);
  assert.equal(elig.PROFIT_INPUTS.productCost.observable, false);
  assert.match(elig.PROFIT_INPUTS.salesVelocity.reason, /line items/i);
  assert.match(elig.PROFIT_INPUTS.productCost.reason, /cost/i);
});

test("WIRING: the Dashboard upside path calls the shared gate", () => {
  assert.match(
    SERVICE_SRC,
    /classifyMonetaryClaim\(\{/,
    "the Dashboard must ask the same question Pricing asks"
  );
  assert.match(
    SERVICE_SRC,
    /salesVelocityObserved: storedProfitValueIsObserved\(\)/,
    "it must not treat a persisted fallback as observed"
  );
});

// ===========================================================================
// 3. Confidence must vary with evidence, never be a constant
// ===========================================================================

test("PROD REPRO: 'AI confidence 60%' cannot be produced from no evidence", () => {
  // 60% came from a hardcoded confidence: "medium" (weight 0.6).
  const none = elig.classifyMonetaryClaim({
    salesVelocityObserved: false,
    productCostObserved: false,
  });
  assert.notEqual(none.confidence, "medium", "medium == 60% == the hardcoded value");
  assert.equal(none.confidence, "insufficient_data");
});

test("CONFIDENCE: varies with the evidence actually present", () => {
  const marginOnly = elig.classifyMonetaryClaim({
    salesVelocityObserved: true,
    productCostObserved: true,
  });
  const corroborated = elig.classifyMonetaryClaim({
    salesVelocityObserved: true,
    productCostObserved: true,
    competitorPriceObserved: true,
  });
  assert.equal(marginOnly.confidence, "medium");
  assert.equal(corroborated.confidence, "high", "competitor corroboration raises it");
  assert.notEqual(marginOnly.confidence, corroborated.confidence, "it must vary");
});

test("WIRING: the insight's confidence comes from the verdict, not a literal", () => {
  assert.match(SERVICE_SRC, /confidence: verdict\.confidence/);
  assert.doesNotMatch(
    SERVICE_SRC,
    /financialImpact: impact, confidence: "medium"/,
    "the hardcoded medium must not return"
  );
});

// ===========================================================================
// 4. Pricing says "not enough data" => Dashboard must agree
// ===========================================================================

test("CROSS-SCREEN: one gate, so the two surfaces cannot disagree", () => {
  // Same inputs, same answer, by construction: both call classifyMonetaryClaim.
  const dashboard = elig.classifyMonetaryClaim({
    salesVelocityObserved: false,
    productCostObserved: false,
  });
  const pricing = elig.classifyMonetaryClaim({
    salesVelocityObserved: false,
    productCostObserved: false,
  });
  assert.deepEqual(dashboard, pricing);
  assert.equal(dashboard.allowed, false);
});

test("CROSS-SCREEN: a refused claim contributes NOTHING to the leak groups", () => {
  // It must not be pushed as max: 0 either - a zero row still widens a range
  // and inflates the "opportunities" count.
  assert.match(
    SERVICE_SRC,
    /if \(impact\.status === "quantified"\) \{\s*\n\s*upsideItems\.push/,
    "only a permitted figure may enter the revenue-leak groups"
  );
});

test("CROSS-SCREEN: a refused claim still surfaces the opportunity honestly", () => {
  assert.match(
    SERVICE_SRC,
    /A higher price may be possible for this product/,
    "direction is still useful; only the figure is withheld"
  );
  assert.match(SERVICE_SRC, /cannot size the opportunity/i);
});

// ===========================================================================
// 5. The magic constants that caused this
// ===========================================================================

test("PROVENANCE: the assumed ratios that produced $5,641 are documented", () => {
  // The ratios still exist as INTERNAL ranking heuristics, but they are now
  // explicitly named as assumed and are never persisted, so a later reader
  // cannot mistake them for merchant data.
  assert.match(CORE_SRC, /assumedProductCost = roundMoney\(currentPrice \* 0\.58\)/);
  assert.match(CORE_SRC, /assumedSalesVelocity = Math\.max\(4,/);
});

test("PROVENANCE: only OBSERVED values are persisted — unknown stays unknown", () => {
  // The core of the fix: the fallback is no longer written into the row, so
  // `salesVelocity != null` can never again pass on a laundered guess.
  assert.match(CORE_SRC, /productCost: observedProductCost/);
  assert.match(CORE_SRC, /salesVelocity: observedSalesVelocity/);
  assert.match(CORE_SRC, /costSource: costObserved \? "observed" : "assumed"/);
  assert.match(CORE_SRC, /velocitySource: velocityObserved \? "observed" : "assumed"/);
  assert.match(
    CORE_SRC,
    /advertisingSpend: latestProfit\?\.advertisingSpend \?\? null/,
    "assumed shipping/ads are left NULL rather than persisted as fact"
  );
});

test("PROVENANCE: the row-level reader honours the recorded source", () => {
  assert.equal(
    elig.profitRowProvenance({ productCost: 10, costSource: "assumed" }).costObserved,
    false,
    "an assumed value must not count however non-null it is"
  );
  assert.equal(
    elig.profitRowProvenance({ productCost: 10, costSource: "observed" }).costObserved,
    true
  );
  assert.equal(
    elig.profitRowProvenance({ productCost: null, costSource: "observed" }).costObserved,
    false,
    "observed but null is still unknown"
  );
  assert.equal(elig.profitRowProvenance(null).velocityObserved, false);
});

test("SAFETY: the placeholder wording is the agreed one", () => {
  assert.equal(elig.NOT_ENOUGH_DATA, "Not enough data yet");
});

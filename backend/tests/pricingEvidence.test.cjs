const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

/**
 * PRICING EVIDENCE CLASSIFICATION.
 *
 * PRODUCTION REGRESSION: the AI Pricing Engine showed 42 recommendations with
 * exact targets such as "$2629.95 -> $2735.15", labelled "AI-generated", while
 * Profit opportunities read 0 and Projected gain read "Not enough data yet".
 *
 * Those targets came from a fixed formula whose only live terms, with no
 * competitor and no profit data, were a store-wide slider percentage and a
 * constant derived from an ASSUMED sales velocity of 8. Nothing about the
 * product's real performance was involved. Two decimal places implied an
 * analysis that had not happened.
 */

const calc = require(
  path.resolve(__dirname, "../dist/services/pricingEvidenceCalc.js")
);

/** The exact production situation: no competitor rows, no profit rows. */
const PRODUCTION_CASE = {
  competitorReady: false,
  competitorAveragePrice: null,
  profitReady: false,
  salesVelocityObserved: false,
};

test("PRODUCTION REPRO: no competitor and no profit data => insufficient evidence", () => {
  const e = calc.classifyPricingEvidence(PRODUCTION_CASE);
  assert.equal(e.basis, "insufficient_evidence");
  assert.equal(e.showExactTarget, false, "an exact target implies analysis that did not happen");
  assert.equal(e.showProjectedGain, false, "a projected gain here would be invented");
});

test("PRODUCTION REPRO: the label never claims AI for deterministic arithmetic", () => {
  for (const input of [
    PRODUCTION_CASE,
    { ...PRODUCTION_CASE, competitorReady: true, competitorAveragePrice: 100 },
    {
      competitorReady: true,
      competitorAveragePrice: 100,
      profitReady: true,
      salesVelocityObserved: true,
    },
  ]) {
    const e = calc.classifyPricingEvidence(input);
    assert.doesNotMatch(e.label, /\bAI\b/i, `label must not claim AI: ${e.label}`);
    assert.doesNotMatch(e.whatWouldHelp, /\bAI\b/i);
  }
});

test("PRODUCTION REPRO: the merchant is told exactly what is missing", () => {
  const e = calc.classifyPricingEvidence(PRODUCTION_CASE);
  assert.deepEqual(e.missingInputs, [
    "competitor pricing for this product",
    "product cost or margin data",
    "observed sales velocity",
  ]);
  assert.match(e.whatWouldHelp, /competitor pricing/);
  assert.match(e.whatWouldHelp, /cost or margin/);
  assert.ok(e.whatWouldHelp.length > 40, "must explain, not just label");
});

// ===========================================================================
// The four states must be distinguishable
// ===========================================================================

test("STATES: profit data with observed velocity is the strongest basis", () => {
  const e = calc.classifyPricingEvidence({
    competitorReady: true,
    competitorAveragePrice: 120,
    profitReady: true,
    salesVelocityObserved: true,
  });
  assert.equal(e.basis, "profit_informed");
  assert.equal(e.label, "Profit-informed");
  assert.equal(e.showExactTarget, true);
  assert.equal(e.showProjectedGain, true);
  assert.deepEqual(e.missingInputs, []);
});

test("STATES: competitor data alone permits a target but NOT a monetary projection", () => {
  const e = calc.classifyPricingEvidence({
    competitorReady: true,
    competitorAveragePrice: 120,
    profitReady: false,
    salesVelocityObserved: false,
  });
  assert.equal(e.basis, "competitor_informed");
  assert.equal(e.showExactTarget, true, "a competitor price is a real external reason");
  assert.equal(
    e.showProjectedGain,
    false,
    "without observed velocity any monetary projection is invented"
  );
  assert.deepEqual(e.missingInputs, ["observed sales velocity"]);
});

test("STATES: a catalog example is never presented as evidence-backed", () => {
  const e = calc.classifyPricingEvidence({
    competitorReady: true,
    competitorAveragePrice: 120,
    profitReady: true,
    salesVelocityObserved: true,
    isCatalogExample: true,
  });
  assert.equal(e.basis, "insufficient_evidence");
  assert.equal(e.showExactTarget, false);
});

test("STATES: a competitor flag with no actual price is not competitor-informed", () => {
  // competitorReady can be true store-wide while THIS product has no match.
  for (const price of [null, undefined, NaN, Infinity]) {
    const e = calc.classifyPricingEvidence({
      competitorReady: true,
      competitorAveragePrice: price,
      profitReady: false,
      salesVelocityObserved: false,
    });
    assert.equal(
      e.basis,
      "insufficient_evidence",
      `competitorAveragePrice=${String(price)} must not count as evidence`
    );
  }
});

test("STATES: profit data WITHOUT observed velocity does not reach profit_informed", () => {
  const e = calc.classifyPricingEvidence({
    competitorReady: false,
    competitorAveragePrice: null,
    profitReady: true,
    salesVelocityObserved: false,
  });
  assert.notEqual(e.basis, "profit_informed", "an assumed velocity is not evidence");
});

// ===========================================================================
// No invented certainty
// ===========================================================================

test("SAFETY: a projected gain is never permitted without observed velocity", () => {
  // expectedProfitGain multiplies the price delta by salesVelocity (default 8)
  // and a constant 6. With an assumed velocity that product is fiction.
  for (const profitReady of [true, false]) {
    for (const competitorReady of [true, false]) {
      const e = calc.classifyPricingEvidence({
        competitorReady,
        competitorAveragePrice: competitorReady ? 100 : null,
        profitReady,
        salesVelocityObserved: false,
      });
      assert.equal(
        e.showProjectedGain,
        false,
        `profitReady=${profitReady} competitorReady=${competitorReady} must not project money`
      );
    }
  }
});

test("SAFETY: the directional hint carries no false precision", () => {
  const up = calc.directionalHint(2629.95, 2735.15);
  assert.match(up, /room to increase/i);
  assert.doesNotMatch(up, /2735|2629/, "must not restate the unfounded target");

  const down = calc.directionalHint(100, 80);
  assert.match(down, /above the market/i);

  assert.match(calc.directionalHint(100, 100.2), /No change indicated/i);
  assert.match(calc.directionalHint(100, 100.4), /No change indicated/i, "sub-1% is noise");
});

test("SAFETY: a zero or negative current price cannot divide by zero", () => {
  assert.equal(typeof calc.directionalHint(0, 10), "string");
  assert.doesNotThrow(() => calc.directionalHint(0, 0));
});

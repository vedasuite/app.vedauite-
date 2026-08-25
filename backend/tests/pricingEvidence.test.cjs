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

// ===========================================================================
// WIRING — the exact production screenshot case, end to end
//
// Screenshot: "Recommendations ready: 42", "Profit opportunities: 0",
// "Projected gain: Not enough data yet", cards showing
// "$2629.95 -> $2735.15" labelled "Baseline estimate" under a page banner
// reading "AI-generated recommendations".
// ===========================================================================

const fs = require("node:fs");

const SERVICE = path.resolve(__dirname, "../src/services/pricingProfitService.ts");
const PAGE = path.resolve(
  __dirname,
  "../../frontend/src/modules/PricingProfit/PricingProfitPage.tsx"
);
const serviceSrc = fs.readFileSync(SERVICE, "utf8");
const pageSrc = fs.readFileSync(PAGE, "utf8");

test("WIRING: the service classifies every recommendation before shaping a card", () => {
  assert.match(serviceSrc, /classifyPricingEvidence\(\{/, "the classifier must be called");
  assert.match(
    serviceSrc,
    /recommendedPrice: evidence\.showExactTarget \? item\.recommendedPrice : null/,
    "an exact target must be gated on evidence"
  );
});

test("WIRING: a projected gain requires evidence.showProjectedGain", () => {
  assert.match(
    serviceSrc,
    /!evidence\.showProjectedGain\s*\n?\s*\?\s*directionalHint/,
    "without a permitted projection the card must fall back to a direction"
  );
});

test("WIRING: salesVelocityObserved comes from PROVENANCE, not from a derived score", () => {
  // This used to assert `Number.isFinite(item.demandScore)`. That check was the
  // defect: a non-null demandScore is a guess about where a number came from,
  // not proof that velocity was observed — and production proved it wrong.
  // Price-history rows written before the engine was fixed still carry a
  // demandScore derived from an ASSUMED velocity, so competitor-informed cards
  // showed "Projected monthly gain of $100" while the page header correctly
  // said "Projected gain — Not enough data yet".
  const block = serviceSrc.match(/const salesVelocityObserved =[\s\S]{0,200}/);
  assert.ok(block, "the observed-velocity check must exist");
  assert.doesNotMatch(block[0], /\?\?\s*8/, "the assumed default must not leak into evidence");
  assert.doesNotMatch(
    block[0],
    /demandScore/,
    "a derived score must never stand in for provenance"
  );
  assert.match(
    block[0],
    /velocityObservedByHandle/,
    "it must read the persisted velocitySource provenance"
  );
  // And that map must be built through the shared classifier, so this surface
  // cannot drift from every other one.
  assert.match(serviceSrc, /profitRowProvenance\(row\)\.velocityObserved/);
  // A handle with no provenance recorded must default to NOT observed.
  assert.match(serviceSrc, /velocityObservedByHandle\.get\([^)]*\) \?\? false/);
});

test("WIRING: store-wide competitor readiness alone is not product evidence", () => {
  assert.match(
    serviceSrc,
    /hasProductCompetitorSignal:\s*\n?\s*competitorReady && item\.competitorPressure !== "not_available"/,
    "the product itself must have a competitor match"
  );
});

test("WIRING: 'Recommendations ready' counts only evidence-backed rows", () => {
  assert.match(
    serviceSrc,
    /prioritizedRecommendationCount: actionableRecommendationCount/,
    "the headline counter must not count evidence-insufficient rows"
  );
  assert.match(
    serviceSrc,
    /evidenceBasis !== "insufficient_evidence"/,
    "the counter must filter on the evidence basis"
  );
  assert.match(serviceSrc, /needsMoreDataCount/, "the remainder must be surfaced, not hidden");
});

test("WIRING: the frontend never prints an exact target when there is none", () => {
  assert.match(
    pageSrc,
    /item\.recommendedPrice === null/,
    "the card must branch on a missing target"
  );
  assert.match(
    pageSrc,
    /Current price \$\$\{item\.currentPrice\.toFixed\(2\)\}/,
    "it should show the current price alone instead of a fabricated arrow"
  );
});

test("WIRING: the frontend tells the merchant what data is missing", () => {
  assert.match(pageSrc, /item\.whatWouldHelp/, "guidance must be rendered, not just returned");
});

test("SCREENSHOT CASE: a $2629.95 product with no competitor and no profit data", () => {
  // Exactly the production row. It must produce no target and no projection.
  const e = calc.classifyPricingEvidence({
    competitorReady: false,
    competitorAveragePrice: null,
    hasProductCompetitorSignal: false,
    profitReady: false,
    salesVelocityObserved: false,
  });

  assert.equal(e.basis, "insufficient_evidence");
  assert.equal(e.showExactTarget, false, "no $2735.15 may be shown");
  assert.equal(e.showProjectedGain, false, "no projected gain may be shown");
  assert.doesNotMatch(e.label, /\bAI\b/i, "and it must not be called AI-generated");

  // The merchant still gets something useful and honest.
  const hint = calc.directionalHint(2629.95, 2735.15);
  assert.match(hint, /room to increase/i);
  assert.doesNotMatch(hint, /2735/, "without restating the unfounded figure");
});

test("SCREENSHOT CASE: a competitor-matched product may show a target but no gain", () => {
  const e = calc.classifyPricingEvidence({
    competitorReady: true,
    competitorAveragePrice: null,
    hasProductCompetitorSignal: true,
    profitReady: false,
    salesVelocityObserved: false,
  });
  assert.equal(e.basis, "competitor_informed");
  assert.equal(e.showExactTarget, true);
  assert.equal(e.showProjectedGain, false, "no observed velocity means no money claim");
});

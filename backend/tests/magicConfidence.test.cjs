const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

/**
 * PHASE B — no arbitrary constant may become a merchant-facing claim.
 *
 * Every site below produced a confidence percentage, a price or a score that a
 * merchant reads as measured, from a hardcoded floor or default.
 */

const read = (f) =>
  fs.readFileSync(path.resolve(__dirname, "../src/services", f), "utf8");

const CORE = read("coreEngineService.ts");
const COMPETITOR = read("competitorService.ts");
const FRAUD = read("fraudService.ts");
const TRUST = read("trustAbuseService.ts");
const DECISION = read("decisionCenterService.ts");

/** Executable lines only — comments legitimately name what was removed. */
const code = (src) =>
  src
    .split(/\r?\n/)
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");

test("PHASE B: no fabricated base price", () => {
  assert.doesNotMatch(code(CORE), /\?\? 49/, "the invented $49 base price is gone");
  assert.match(
    CORE,
    /if \(observedCurrentPrice == null\) \{\s*\n\s*continue;/,
    "a product with no real price is skipped, not invented"
  );
});

test("PHASE B: no assumed velocity reaches a recommendation or projection", () => {
  assert.doesNotMatch(code(CORE), /salesVelocity: latestProfit\?\.salesVelocity \?\? 8/);
  assert.doesNotMatch(code(CORE), /\(latestProfit\?\.salesVelocity \?\? 8\)/);
  assert.match(
    CORE,
    /salesVelocity: observedSalesVelocity/,
    "only an observed velocity is passed"
  );
  assert.match(
    CORE,
    /const expectedProfitGain = velocityObserved/,
    "the profit projection is null without observed velocity"
  );
});

test("PHASE B: the velocity term is omitted, not defaulted, in the formula", () => {
  assert.match(
    CORE,
    /args\.salesVelocity != null && Number\.isFinite\(args\.salesVelocity\)/,
    "no observed velocity means no velocity term at all"
  );
});

test("PHASE B: demandScore is null when velocity was never observed", () => {
  // This one mattered twice: downstream code treats a non-null demandScore as
  // proof of observed demand, so the old always-non-null value laundered the
  // assumption into an evidence signal.
  assert.match(CORE, /demandScore: velocityObserved/);
  assert.match(CORE, /demandTrend: !velocityObserved\s*\n?\s*\? "insufficient history"/);
});

test("PHASE B: competitor confidences carry no floor", () => {
  assert.doesNotMatch(code(COMPETITOR), /Math\.max\(62, Math\.min\(88/);
  assert.doesNotMatch(code(COMPETITOR), /Math\.max\(35, Math\.min\(80/);
  assert.match(code(COMPETITOR), /confidenceScore: Math\.max\(0, Math\.min\(100/);
  assert.match(code(COMPETITOR), /confidence: Math\.max\(0, Math\.min\(100/);
});

test("PHASE B: fraud confidence requires actual reasons", () => {
  assert.doesNotMatch(code(FRAUD), /Math\.max\(48, Math\.min\(95/);
  assert.match(
    code(FRAUD),
    /reasons\.length === 0 \? 0 :/,
    "no reasons means no confidence, not 48%"
  );
});

test("PHASE B: an unknown trust score is null, not 60", () => {
  assert.match(
    TRUST,
    /: null,/,
    "the invented 60 baseline is replaced by null"
  );
  assert.match(
    TRUST,
    /No trust score recorded for this shopper yet/,
    "and consumers say so rather than treating unknown as mid-range"
  );
});

test("PHASE B: decision-center confidences are derived, not constants", () => {
  assert.doesNotMatch(code(DECISION), /Math\.max\(52, Math\.min\(97/);
  assert.doesNotMatch(code(DECISION), /Math\.max\(\s*48,/);
  assert.doesNotMatch(code(DECISION), /promotion \? 82 : 68/);
  assert.match(
    code(DECISION),
    /competitorSignal\.price != null \? 100 : 0/,
    "confidence is asserted only when a real price backs it"
  );
});

test("PHASE B: internal heuristics remain, explicitly named as assumed", () => {
  // They are allowed for ranking. The requirement is that they are visibly
  // internal and never persisted or shown.
  assert.match(CORE, /assumedProductCost = roundMoney\(currentPrice \* 0\.58\)/);
  assert.match(CORE, /assumedSalesVelocity = Math\.max\(4,/);
  assert.match(CORE, /never qualify a monetary claim as evidence-backed/);
});

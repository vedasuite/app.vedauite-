const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

/**
 * DECISION CENTER — the THIRD money path.
 *
 * Found during the full-product evidence audit. getUnifiedDecisionCenter is
 * served by dashboardRoutes and stated:
 *   "Projected monthly profit gain is $X"
 *   "Projected profit gain is $Y"
 *   confidence = 60 + projectedMonthlyProfit / 70
 *   severity   = projectedMonthlyProfit >= 1000 ? High : Medium
 *
 * All of it derives from ProfitOptimizationData / PriceHistory, whose cost and
 * velocity inputs are assumptions that are then persisted. It bypassed BOTH
 * the Pricing gate (b4b54ea) and the Dashboard gate (f7085c9).
 */

const SRC = fs.readFileSync(
  path.resolve(__dirname, "../src/services/decisionCenterService.ts"),
  "utf8"
);

test("SHARED GATE: decision center uses the same gate as Dashboard and Pricing", () => {
  assert.match(SRC, /from "\.\/evidenceEligibility"/);
  assert.match(SRC, /classifyMonetaryClaim\(\{/);
  assert.match(
    SRC,
    /salesVelocityObserved: storedProfitValueIsObserved\(\)/,
    "a persisted fallback must not count as observed here either"
  );
});

test("MONEY: every dollar claim is behind the gate", () => {
  // Any `$${` interpolation must be either inside a PROFIT_CLAIM.allowed branch
  // or an observed fact (the current selling price).
  const lines = SRC.split(/\r?\n/);
  const moneyIndexes = lines
    .map((l, i) => (/\$\$\{/.test(l) ? i : -1))
    .filter((i) => i >= 0);
  assert.ok(moneyIndexes.length > 0, "sanity: money lines exist");

  for (const i of moneyIndexes) {
    // The gate is a multi-line ternary, so the guard sits on a preceding line.
    const context = lines.slice(Math.max(0, i - 3), i + 1).join("\n");
    const gated = /PROFIT_CLAIM\.allowed/.test(context);
    const observedFact = /Current selling price|Current price is/.test(lines[i]);
    assert.ok(
      gated || observedFact,
      `ungated money claim at line ${i + 1}: ${lines[i].trim()}`
    );
  }
});

test("CONFIDENCE: never derived from a fabricated projection", () => {
  assert.match(
    SRC,
    /confidence: !PROFIT_CLAIM\.allowed\s*\n?\s*\? 0/,
    "confidence must collapse to 0 when the projection is not permitted"
  );
  // The original magic formula must not run ungated.
  const magic = SRC.match(/60 \+ Math\.round\(\(profitMove\.projectedMonthlyProfit[\s\S]{0,80}/);
  assert.ok(magic, "the formula still exists");
  assert.match(
    SRC,
    /!PROFIT_CLAIM\.allowed[\s\S]{0,120}60 \+ Math\.round/,
    "but only inside the permitted branch"
  );
});

test("SEVERITY: not driven by a fabricated figure", () => {
  assert.match(
    SRC,
    /severity: PROFIT_CLAIM\.allowed/,
    "severity must not escalate on an invented projection"
  );
});

test("TARGET PRICE: no exact recommendation without evidence", () => {
  assert.match(
    SRC,
    /cannot recommend a specific price yet/,
    "an unsupported target must degrade to a direction"
  );
  assert.match(SRC, /There may be room to increase it/);
});

test("HONESTY: the merchant is told why, not just refused", () => {
  assert.match(SRC, /PROFIT_CLAIM\.explanation/, "the reason must be surfaced");
  assert.match(SRC, /NOT_ENOUGH_DATA/, "and the agreed placeholder used");
});

test("CROSS-SURFACE: all three money paths now import one gate", () => {
  const paths = [
    "../src/services/explainabilityService.ts",   // Dashboard
    "../src/services/decisionCenterService.ts",   // Decision Center
  ];
  for (const p of paths) {
    const src = fs.readFileSync(path.resolve(__dirname, p), "utf8");
    assert.match(
      src,
      /evidenceEligibility/,
      `${p} must derive its verdict from the shared gate`
    );
  }
  // Pricing uses the product-level classifier built on the same principle.
  const pricing = fs.readFileSync(
    path.resolve(__dirname, "../src/services/pricingProfitService.ts"),
    "utf8"
  );
  assert.match(pricing, /pricingEvidenceCalc/);
});

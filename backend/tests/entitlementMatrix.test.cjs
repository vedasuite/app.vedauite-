const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

process.env.SHOPIFY_API_KEY ||= "test-key";
process.env.SHOPIFY_API_SECRET ||= "test-secret";
process.env.SHOPIFY_APP_URL ||= "https://app.vedasuite.in";
process.env.DATABASE_URL ||= "postgresql://example:example@localhost:5432/example";

const capabilitiesPath = path.resolve(__dirname, "../dist/billing/capabilities.js");
const { resolveEntitlements, buildCapabilities, normalizeStarterModule } =
  require(capabilitiesPath);

const ALL_MODULES = ["fraud", "competitor", "pricing", "profit"];

function entitlementsFor(plan, starterModule, trialActive) {
  return resolveEntitlements({
    plan,
    billingStatus: "ACTIVE",
    starterModule: starterModule ?? null,
    trialActive: trialActive ?? false,
  });
}

// ---------------------------------------------------------------------------
// 7-day full-access trial
// ---------------------------------------------------------------------------

test("active trial grants every implemented module regardless of selected plan", () => {
  for (const selectedPlan of ["STARTER", "GROWTH", "PRO"]) {
    const result = entitlementsFor(selectedPlan, "fraud", true);
    assert.deepEqual(
      [...result.enabledModules].sort(),
      [...ALL_MODULES].sort(),
      `${selectedPlan} trial should unlock every module`
    );
    assert.equal(result.lockedModules.length, 0, `${selectedPlan} trial should lock nothing`);
  }
});

test("active trial grants Pro-equivalent features, including full profit optimization", () => {
  const trial = entitlementsFor("STARTER", "fraud", true);
  const pro = entitlementsFor("PRO", null, false);

  assert.equal(trial.featureAccess.fullProfitEngine, true);
  assert.deepEqual(
    trial.featureAccess,
    pro.featureAccess,
    "every feature flag must match Pro during the trial"
  );

  // Every capability must match Pro except the two billing-surface flags that
  // legitimately reflect the merchant's own selection rather than their access.
  const BILLING_SURFACE = ["billing.moduleSelectionStarter", "billing.trialActive"];
  for (const key of Object.keys(pro.capabilities)) {
    if (BILLING_SURFACE.includes(key)) continue;
    assert.equal(
      trial.capabilities[key],
      pro.capabilities[key],
      `capability ${key} should match Pro during the trial`
    );
  }
});

test("trial exposes billing.trialActive so the UI can hide Upgrade badges", () => {
  const trial = entitlementsFor("GROWTH", null, true);
  const paid = entitlementsFor("GROWTH", null, false);

  assert.equal(trial.capabilities["billing.trialActive"], true);
  assert.equal(paid.capabilities["billing.trialActive"], false);
  // Nothing is locked during the trial, so no module can render an upgrade badge.
  assert.equal(trial.lockedModules.length, 0);
});

test("trial retains the merchant's selected post-trial plan and Starter module", () => {
  const result = entitlementsFor("STARTER", "competitor", true);
  assert.equal(result.plan, "STARTER", "selected plan must survive the trial");
  assert.equal(result.starterModule, "competitor", "Starter selection must survive the trial");
  assert.equal(
    result.capabilities["billing.moduleSelectionStarter"],
    true,
    "a trialing Starter merchant can still choose their module"
  );
});

// ---------------------------------------------------------------------------
// Expiry
// ---------------------------------------------------------------------------

test("expired trial with no valid paid subscription blocks every paid module", () => {
  const result = resolveEntitlements({
    plan: "NONE",
    billingStatus: "INACTIVE",
    starterModule: null,
    trialActive: false,
  });
  assert.deepEqual(result.enabledModules, []);
  assert.deepEqual([...result.lockedModules].sort(), [...ALL_MODULES].sort());
});

test("a legacy standalone TRIAL plan grants nothing once its window closes", () => {
  const open = entitlementsFor("TRIAL", null, true);
  const closed = entitlementsFor("TRIAL", null, false);

  assert.equal(open.enabledModules.length, 4, "open trial window unlocks everything");
  assert.deepEqual(closed.enabledModules, [], "no indefinite free TRIAL plan is possible");
});

test("expired trial with an active paid subscription receives exactly that plan's access", () => {
  const growth = entitlementsFor("GROWTH", null, false);
  assert.deepEqual([...growth.enabledModules].sort(), ["competitor", "fraud", "pricing"]);
  assert.equal(growth.moduleAccess.profit, false, "Growth never includes full profit");

  const starter = entitlementsFor("STARTER", "fraud", false);
  assert.deepEqual(starter.enabledModules, ["fraud"]);
});

// ---------------------------------------------------------------------------
// Paid plan packaging
// ---------------------------------------------------------------------------

test("Starter receives only its selected core module", () => {
  for (const [selected, expected] of [
    ["fraud", "fraud"],
    ["competitor", "competitor"],
    ["pricing", "pricing"],
  ]) {
    const result = entitlementsFor("STARTER", selected, false);
    assert.deepEqual(
      result.enabledModules,
      [expected],
      `Starter/${selected} should enable only ${expected}`
    );
    assert.equal(result.moduleAccess.profit, false, "Starter never includes profit");
    assert.equal(
      result.featureAccess.fullProfitEngine,
      false,
      "Starter never includes the full profit engine"
    );
  }
});

test("Starter does not receive the other core modules' intelligence", () => {
  const starterFraud = entitlementsFor("STARTER", "fraud", false);
  assert.equal(starterFraud.moduleAccess.competitor, false);
  assert.equal(starterFraud.moduleAccess.pricing, false);
  assert.equal(starterFraud.capabilities["competitor.moveFeed"], false);
  assert.equal(starterFraud.capabilities["pricing.basicRecommendations"], false);
});

test("Growth receives fraud, competitor and pricing but not full profit", () => {
  const growth = entitlementsFor("GROWTH", null, false);
  assert.equal(growth.moduleAccess.fraud, true);
  assert.equal(growth.moduleAccess.competitor, true);
  assert.equal(growth.moduleAccess.pricing, true);
  assert.equal(growth.moduleAccess.profit, false);
  assert.equal(growth.featureAccess.fullProfitEngine, false);
});

test("Pro receives every implemented module and the full profit engine", () => {
  const pro = entitlementsFor("PRO", null, false);
  assert.deepEqual([...pro.enabledModules].sort(), [...ALL_MODULES].sort());
  assert.equal(pro.featureAccess.fullProfitEngine, true);
  assert.equal(pro.capabilities["pricing.profitLeakDetector"], true);
  assert.equal(pro.capabilities["pricing.scenarioSimulator"], true);
});

test("pricing is accepted as a Starter module alongside fraud and competitor", () => {
  assert.equal(normalizeStarterModule("pricing"), "pricing");
  assert.equal(normalizeStarterModule("pricingProfit"), "pricing");
  assert.equal(normalizeStarterModule("fraud"), "fraud");
  assert.equal(normalizeStarterModule("competitor"), "competitor");
  assert.equal(normalizeStarterModule("nonsense"), null);
});

test("buildCapabilities defaults to no trial when the flag is omitted", () => {
  // Guards against a caller silently getting free Pro access by forgetting
  // to pass trialActive.
  const caps = buildCapabilities("STARTER", "fraud");
  assert.equal(caps["module.pricingProfit"], false);
  assert.equal(caps["billing.trialActive"], false);
});

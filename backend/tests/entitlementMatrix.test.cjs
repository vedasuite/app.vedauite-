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
// Plan-selected trial model (2026-08-03 product decision): the trial only
// starts once a plan is approved in Shopify, and grants exactly THAT plan's
// entitlements — never every module. Shopify simply doesn't bill for them
// yet. STARTER and GROWTH merchants still see Upgrade badges on modules
// outside their plan during the trial; only PRO unlocks everything.
// ---------------------------------------------------------------------------

test("a STARTER trial unlocks only the selected Starter module, nothing else", () => {
  const result = entitlementsFor("STARTER", "fraud", true);
  assert.deepEqual(result.enabledModules, ["fraud"], "STARTER trial unlocks only its selected module");
  assert.deepEqual(
    [...result.lockedModules].sort(),
    ["competitor", "pricing", "profit"],
    "STARTER trial still locks everything outside the plan"
  );
});

test("a GROWTH trial unlocks fraud, competitor and pricing but not full profit", () => {
  const result = entitlementsFor("GROWTH", null, true);
  assert.deepEqual([...result.enabledModules].sort(), ["competitor", "fraud", "pricing"]);
  assert.equal(result.lockedModules.length, 1);
  assert.deepEqual(result.lockedModules, ["profit"], "Growth never includes full Profit Optimization, trial or not");
});

test("a PRO trial unlocks every implemented module, including full profit optimization", () => {
  const result = entitlementsFor("PRO", null, true);
  assert.deepEqual(
    [...result.enabledModules].sort(),
    [...ALL_MODULES].sort(),
    "PRO trial unlocks everything, because PRO's own entitlements already are everything"
  );
  assert.equal(result.lockedModules.length, 0);
  assert.equal(result.featureAccess.fullProfitEngine, true);
});

test("trial entitlements exactly match paying for the same plan (no Pro-equivalent widening)", () => {
  for (const [plan, starterModule] of [["STARTER", "fraud"], ["GROWTH", null], ["PRO", null]]) {
    const trialing = entitlementsFor(plan, starterModule, true);
    const paid = entitlementsFor(plan, starterModule, false);

    assert.deepEqual(trialing.enabledModules, paid.enabledModules, `${plan}: enabled modules must match paid access`);
    assert.deepEqual(trialing.featureAccess, paid.featureAccess, `${plan}: feature access must match paid access`);

    // Only the billing-surface trialActive flag itself should differ.
    for (const key of Object.keys(paid.capabilities)) {
      if (key === "billing.trialActive") continue;
      assert.equal(
        trialing.capabilities[key],
        paid.capabilities[key],
        `${plan}: capability ${key} must match paid access during the trial`
      );
    }
  }
});

test("trial exposes billing.trialActive for UI copy, without widening which modules are locked", () => {
  const trial = entitlementsFor("GROWTH", null, true);
  const paid = entitlementsFor("GROWTH", null, false);

  assert.equal(trial.capabilities["billing.trialActive"], true);
  assert.equal(paid.capabilities["billing.trialActive"], false);
  // Growth still locks "profit" whether trialing or paid — an Upgrade badge
  // on Profit Optimization is correct during a Growth trial, not a bug.
  assert.deepEqual(trial.lockedModules, paid.lockedModules);
});

test("no plan selected: trialActive alone never grants access, even if somehow set", () => {
  // Defensive: under the plan-selected model this combination should not
  // arise in practice (trial dates aren't set until a plan is approved), but
  // the entitlement resolver itself must still refuse to manufacture access
  // from a date with no selected plan.
  const result = entitlementsFor("NONE", null, true);
  assert.deepEqual(result.enabledModules, []);
  assert.deepEqual([...result.lockedModules].sort(), [...ALL_MODULES].sort());
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

test("a legacy standalone TRIAL plan grants nothing, open or closed", () => {
  // "TRIAL" as a stored plan name predates the plan-selected model and never
  // maps to a real chargeable plan — it always collapses to NONE now,
  // regardless of trialActive, since there is no way to know which real
  // plan (STARTER/GROWTH/PRO) it should represent.
  const open = entitlementsFor("TRIAL", null, true);
  const closed = entitlementsFor("TRIAL", null, false);

  assert.deepEqual(open.enabledModules, [], "a legacy TRIAL plan name never unlocks anything on its own");
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

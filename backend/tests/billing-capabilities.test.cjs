const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const capabilitiesPath = path.resolve(
  __dirname,
  "../dist/billing/capabilities.js"
);

test("starter plan enables exactly one selected module plus shared settings and reports", async () => {
  const {
    buildCapabilities,
    buildModuleAccessFromCapabilities,
    buildFeatureAccessFromCapabilities,
  } = require(capabilitiesPath);

  const capabilities = buildCapabilities("STARTER", "fraud");
  const modules = buildModuleAccessFromCapabilities(capabilities);
  const features = buildFeatureAccessFromCapabilities(capabilities);

  assert.equal(modules.fraud, true);
  assert.equal(modules.trustAbuse, true);
  assert.equal(modules.competitor, false);
  assert.equal(modules.pricing, false);
  assert.equal(modules.pricingProfit, false);
  assert.equal(modules.reports, false);
  assert.equal(modules.settings, true);
  assert.equal(capabilities["billing.moduleSelectionStarter"], true);
  assert.equal(features.returnAbuseIntelligence, true);
  assert.equal(features.weeklyCompetitorReports, false);
  assert.equal(features.fullProfitEngine, false);
});

test("starter competitor plan enables competitor only", async () => {
  const {
    buildCapabilities,
    buildModuleAccessFromCapabilities,
    normalizeStarterModule,
    resolveEntitlements,
  } = require(capabilitiesPath);

  const capabilities = buildCapabilities("STARTER", "competitor");
  const modules = buildModuleAccessFromCapabilities(capabilities);
  const aliasCompetitor = normalizeStarterModule("competitorIntelligence");
  const aliasFraud = normalizeStarterModule("trustAbuse");
  const entitlements = resolveEntitlements({
    plan: "STARTER",
    billingStatus: "ACTIVE",
    starterModule: "competitorIntelligence",
  });

  assert.equal(modules.fraud, false);
  assert.equal(modules.competitor, true);
  assert.equal(modules.pricing, false);
  assert.equal(modules.profit, false);
  assert.equal(aliasCompetitor, "competitor");
  assert.equal(aliasFraud, "fraud");
  assert.deepEqual(entitlements.enabledModules, ["competitor"]);
  assert.ok(entitlements.lockedModules.includes("fraud"));
  assert.ok(entitlements.lockedModules.includes("pricing"));
  assert.ok(entitlements.lockedModules.includes("profit"));
});

test("switching starter modules swaps enabled modules immediately", async () => {
  const { resolveEntitlements } = require(capabilitiesPath);

  const fraudStarter = resolveEntitlements({
    plan: "STARTER",
    billingStatus: "ACTIVE",
    starterModule: "fraud",
  });
  const competitorStarter = resolveEntitlements({
    plan: "STARTER",
    billingStatus: "ACTIVE",
    starterModule: "competitor",
  });

  assert.deepEqual(fraudStarter.enabledModules, ["fraud"]);
  assert.ok(fraudStarter.lockedModules.includes("competitor"));

  assert.deepEqual(competitorStarter.enabledModules, ["competitor"]);
  assert.ok(competitorStarter.lockedModules.includes("fraud"));
});

test("trial and none plans keep paid modules locked until Shopify billing is approved", async () => {
  const { resolveEntitlements } = require(capabilitiesPath);

  const nonePlan = resolveEntitlements({
    plan: "NONE",
    billingStatus: "INACTIVE",
    starterModule: null,
  });
  const trialPlan = resolveEntitlements({
    plan: "TRIAL",
    billingStatus: null,
    starterModule: null,
  });

  assert.deepEqual(nonePlan.enabledModules, []);
  assert.deepEqual(trialPlan.enabledModules, []);
  assert.ok(nonePlan.lockedModules.includes("fraud"));
  assert.ok(trialPlan.lockedModules.includes("competitor"));
});

test("growth and pro capabilities separate baseline access from premium access", async () => {
  const {
    buildCapabilities,
    buildFeatureAccessFromCapabilities,
  } = require(capabilitiesPath);

  const growthFeatures = buildFeatureAccessFromCapabilities(
    buildCapabilities("GROWTH", null)
  );
  const proFeatures = buildFeatureAccessFromCapabilities(
    buildCapabilities("PRO", null)
  );

  assert.equal(growthFeatures.pricingRecommendations, true);
  assert.equal(growthFeatures.fullProfitEngine, false);
  assert.equal(growthFeatures.scenarioSimulator, false);

  assert.equal(proFeatures.pricingRecommendations, true);
  assert.equal(proFeatures.fullProfitEngine, true);
  assert.equal(proFeatures.scenarioSimulator, true);
  assert.equal(proFeatures.evidencePackExport, true);
});

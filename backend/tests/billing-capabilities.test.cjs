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
  } = require(capabilitiesPath);

  const capabilities = buildCapabilities("STARTER", "competitor");
  const modules = buildModuleAccessFromCapabilities(capabilities);

  assert.equal(modules.fraud, false);
  assert.equal(modules.competitor, true);
  assert.equal(modules.pricing, false);
  assert.equal(modules.profit, false);
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

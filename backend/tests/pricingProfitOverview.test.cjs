const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

function resetModule(modulePath) {
  const resolved = require.resolve(modulePath);
  delete require.cache[resolved];
}

test("pricing overview does not expose projected gain when profit data is unavailable", async () => {
  const prismaPath = path.resolve(__dirname, "../dist/db/prismaClient.js");
  const competitorPath = path.resolve(
    __dirname,
    "../dist/services/competitorService.js"
  );
  const pricingPath = path.resolve(
    __dirname,
    "../dist/services/pricingService.js"
  );
  const profitPath = path.resolve(__dirname, "../dist/services/profitService.js");
  const subscriptionPath = path.resolve(
    __dirname,
    "../dist/services/subscriptionService.js"
  );
  const operationalPath = path.resolve(
    __dirname,
    "../dist/services/storeOperationalStateService.js"
  );
  const pricingStatePath = path.resolve(
    __dirname,
    "../dist/services/pricingEngineStateService.js"
  );
  const observabilityPath = path.resolve(
    __dirname,
    "../dist/services/observabilityService.js"
  );
  const overviewPath = path.resolve(
    __dirname,
    "../dist/services/pricingProfitService.js"
  );

  [
    prismaPath,
    competitorPath,
    pricingPath,
    profitPath,
    subscriptionPath,
    operationalPath,
    pricingStatePath,
    observabilityPath,
    overviewPath,
  ].forEach(resetModule);

  const prismaModule = require(prismaPath);
  prismaModule.prisma.store.findUnique = async () => ({
    id: "store-1",
  });

  require(competitorPath).getCompetitorResponseEngine = async () => ({
    summary: {
      responseMode: "Awaiting monitored competitor data",
      topPressureCount: 0,
      automationReadiness: "Competitor-informed pricing is not ready yet.",
    },
    responsePlans: [],
  });

  require(pricingPath).getPricingRecommendations = async () => [
    {
      id: "rec-1",
      productHandle: "alpha-shirt",
      currentPrice: 20,
      recommendedPrice: 24,
      demandSignals: ["Baseline recommendation from store data."],
      demandScore: 52,
      demandTrend: "stable",
      expectedMarginDelta: 4,
      expectedProfitGain: 220,
      competitorPressure: "not_available",
      approvalConfidence: 61,
      autoApprovalCandidate: false,
    },
  ];
  require(pricingPath).simulatePricingChange = async () => ({
    projectedMonthlyProfitGain: 220,
    expectedMarginImprovement: 4,
    actionQueue: "Baseline simulation only",
  });

  require(profitPath).getProfitOpportunities = async () => [];

  require(subscriptionPath).getCurrentSubscription = async () => ({
    featureAccess: {
      fullProfitEngine: false,
    },
    capabilities: {
      "pricing.advancedModes": true,
      "pricing.scenarioSimulator": true,
      "pricing.dailyActionBoard": false,
      "pricing.marginAtRisk": false,
      "pricing.profitLeakDetector": false,
      "pricing.explainableRecommendations": true,
      "pricing.basicRecommendations": true,
    },
  });

  require(operationalPath).getStoreOperationalSnapshot = async () => ({
    store: {
      lastConnectionStatus: "OK",
      lastSyncStatus: "READY_WITH_DATA",
      lastConnectionError: null,
      lastSyncAt: new Date("2026-05-02T08:00:00.000Z"),
    },
    counts: {
      products: 10,
      orders: 5,
      customers: 2,
      pricingRows: 1,
      profitRows: 0,
      timelineEvents: 3,
      competitorRows: 0,
    },
    latestSyncJob: {
      status: "SUCCEEDED",
      startedAt: new Date("2026-05-02T08:00:00.000Z"),
      finishedAt: new Date("2026-05-02T08:05:00.000Z"),
    },
    latestCompetitorIngestJob: null,
    latestProcessingAt: new Date("2026-05-02T08:06:00.000Z"),
    latestCompetitorAt: null,
  });
  require(operationalPath).deriveSyncStatus = () => ({
    status: "READY_WITH_DATA",
    reason: "Shopify data and derived module outputs are available.",
  });
  require(operationalPath).deriveModuleReadiness = () => ({
    readinessState: "READY",
    reason: "Pricing rows are available.",
  });

  require(pricingStatePath).derivePricingEngineViewState = ({ moduleState }) => ({
    status: "ready",
    title: moduleState.title,
    description: moduleState.description,
    nextAction: "Review pricing insights",
    processingSummary: {
      catalogProducts: 10,
      salesOrders: 5,
      competitorInputs: 0,
      pricingRows: 1,
      profitRows: 0,
      recommendations: 1,
    },
    lastSuccessfulRunAt: "2026-05-02T08:06:00.000Z",
  });

  require(observabilityPath).logEvent = () => {};

  const { getPricingProfitOverview } = require(overviewPath);
  const overview = await getPricingProfitOverview("test-shop.myshopify.com");

  assert.equal(overview.pricingState.projectedGainStatus, "not_available");
  assert.equal(overview.pricingState.projectedGainValue, 0);
  assert.equal(overview.summary.profitOpportunityCount, 0);
});

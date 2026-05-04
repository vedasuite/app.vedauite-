const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

function resetModule(modulePath) {
  const resolved = require.resolve(modulePath);
  delete require.cache[resolved];
}

test("dashboard metrics stay consistent with persisted pricing and profit data", async () => {
  const prismaPath = path.resolve(__dirname, "../dist/db/prismaClient.js");
  const onboardingPath = path.resolve(
    __dirname,
    "../dist/services/onboardingService.js"
  );
  const trustAbusePath = path.resolve(
    __dirname,
    "../dist/services/trustAbuseService.js"
  );
  const competitorPath = path.resolve(
    __dirname,
    "../dist/services/competitorService.js"
  );
  const pricingProfitPath = path.resolve(
    __dirname,
    "../dist/services/pricingProfitService.js"
  );
  const readinessPath = path.resolve(
    __dirname,
    "../dist/services/readinessEngineService.js"
  );
  const operationalPath = path.resolve(
    __dirname,
    "../dist/services/storeOperationalStateService.js"
  );
  const dashboardPath = path.resolve(
    __dirname,
    "../dist/services/dashboardService.js"
  );

  resetModule(prismaPath);
  resetModule(onboardingPath);
  resetModule(trustAbusePath);
  resetModule(competitorPath);
  resetModule(pricingProfitPath);
  resetModule(readinessPath);
  resetModule(operationalPath);
  resetModule(dashboardPath);

  const prismaModule = require(prismaPath);
  prismaModule.prisma.store.findUnique = async () => ({
    id: "store-1",
    shop: "test-shop.myshopify.com",
    lastSyncAt: new Date("2026-05-02T08:00:00.000Z"),
    syncJobs: [
      {
        status: "SUCCEEDED",
        finishedAt: new Date("2026-05-02T08:10:00.000Z"),
      },
    ],
    timelineEvents: [
      {
        id: "evt-1",
        title: "Pricing insight updated",
        detail: "Recommendation queue refreshed.",
        severity: "info",
        category: "pricing",
        createdAt: new Date("2026-05-02T08:12:00.000Z"),
      },
    ],
  });
  prismaModule.prisma.customer.count = async () => 2;
  require(trustAbusePath).getTrustAbuseOverview = async () => ({
    summary: {
      highRiskOrders: 3,
      manualReviewCount: 2,
    },
  });
  require(competitorPath).getCompetitorOverview = async () => ({
    competitorState: {
      detectedPriceChangesCount: 3,
      detectedPromotionChangesCount: 2,
    },
  });
  require(pricingProfitPath).getPricingProfitOverview = async () => ({
    summary: {
      recommendationCount: 7,
      profitOpportunityCount: 4,
    },
  });

  require(onboardingPath).getOnboardingState = async () => ({
    complete: false,
  });
  require(readinessPath).getUnifiedReadinessState = async () => ({
    initialSync: {
      syncStatus: "READY_WITH_DATA",
    },
    setup: {
      summaryTitle: "Store data and module outputs are ready",
      summaryDescription: "Dashboard data is consistent with synced module outputs.",
    },
    modules: {
      fraud: { state: "ready", description: "Fraud outputs are ready." },
      competitor: { state: "ready", description: "Competitor outputs are ready." },
      pricing: { state: "ready", description: "Pricing outputs are ready." },
    },
    moduleStates: {
      fraud: { dataStatus: "ready", title: "Fraud ready", description: "Fraud data ready." },
      competitor: { dataStatus: "ready", title: "Competitor ready", description: "Competitor data ready." },
      pricing: { dataStatus: "ready", title: "Pricing ready", description: "Pricing data ready." },
    },
    quickAccess: {
      fraud: { status: "Ready", freshnessAt: "2026-05-02T08:10:00.000Z", reason: "Fraud data ready." },
      competitor: { status: "Ready", freshnessAt: "2026-05-02T08:10:00.000Z", reason: "Competitor data ready." },
      pricing: { status: "Ready", freshnessAt: "2026-05-02T08:10:00.000Z", reason: "Pricing data ready." },
    },
  });
  require(operationalPath).getStoreOperationalSnapshot = async () => ({
    store: {
      lastConnectionStatus: "OK",
      lastSyncStatus: "READY_WITH_DATA",
      lastSyncAt: new Date("2026-05-02T08:00:00.000Z"),
    },
    counts: {
      products: 10,
      orders: 5,
      customers: 2,
      pricingRows: 7,
      profitRows: 4,
      timelineEvents: 1,
      competitorDomains: 2,
      competitorRows: 5,
    },
    latestSyncJob: {
      status: "SUCCEEDED",
      startedAt: new Date("2026-05-02T08:00:00.000Z"),
      finishedAt: new Date("2026-05-02T08:10:00.000Z"),
    },
    latestCompetitorAt: new Date("2026-05-02T08:09:00.000Z"),
    latestProcessingAt: new Date("2026-05-02T08:11:00.000Z"),
  });
  require(operationalPath).deriveSyncStatus = () => ({
    status: "READY_WITH_DATA",
    reason: "Shopify data and derived module outputs are available.",
  });

  const { getDashboardMetrics } = require(dashboardPath);
  const metrics = await getDashboardMetrics("test-shop.myshopify.com");

  assert.equal(metrics.aiPricingSuggestions, 7);
  assert.equal(metrics.profitOptimizationOpportunities, 4);
  assert.equal(metrics.competitorPriceChanges, 5);
  assert.equal(metrics.highRiskOrders, 3);
  assert.equal(metrics.dashboardState.kpis.pricingOpportunities, 7);
  assert.equal(metrics.dashboardState.kpis.profitOpportunities, 4);
  assert.equal(metrics.dashboardState.recentInsights.length, 1);
  assert.equal(metrics.dashboardState.recentInsights[0].title, "Pricing insight updated");
  assert.doesNotMatch(metrics.dashboardState.recentInsights[0].title, /shopper/i);
  assert.equal(metrics.dashboardState.syncHealth.status, "READY_WITH_DATA");
});

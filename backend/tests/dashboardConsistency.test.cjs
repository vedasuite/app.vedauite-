const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

/**
 * DASHBOARD <-> ACTION CENTER CONSISTENCY (Phase F).
 *
 * WHAT THIS TEST USED TO ASSERT
 * -----------------------------
 * It asserted that `metrics.aiPricingSuggestions === 7` because
 * `getPricingProfitOverview().summary.recommendationCount` returned 7 — i.e. it
 * asserted the PARALLEL calculation, and would have passed happily while the
 * Dashboard contradicted the Action Center. The mock returned 7 pricing
 * recommendations, 4 profit opportunities, 5 competitor changes and 3 high-risk
 * orders, and the Dashboard reported all four regardless of whether a single
 * one of them was an open finding.
 *
 * That is precisely the defect Phase F removes, so the assertions are inverted
 * rather than deleted: the module overviews may return whatever they like, and
 * the Dashboard must ignore them entirely.
 */

function resetModule(modulePath) {
  const resolved = require.resolve(modulePath);
  delete require.cache[resolved];
}

const PATHS = {
  // env is reset with the rest because the config object is built once at
  // import time from process.env. Without this, flipping the persistence flag
  // between tests would silently have no effect and the "persistence off" case
  // would pass for the wrong reason.
  env: "../dist/config/env.js",
  prisma: "../dist/db/prismaClient.js",
  onboarding: "../dist/services/onboardingService.js",
  trustAbuse: "../dist/services/trustAbuseService.js",
  competitor: "../dist/services/competitorService.js",
  pricingProfit: "../dist/services/pricingProfitService.js",
  readiness: "../dist/services/readinessEngineService.js",
  operational: "../dist/services/storeOperationalStateService.js",
  actionCenter: "../dist/services/actionCenterService.js",
  subscription: "../dist/services/subscriptionService.js",
  dashboard: "../dist/services/dashboardService.js",
};

function resolved(key) {
  return path.resolve(__dirname, PATHS[key]);
}

/**
 * Rebuilds the dashboard module graph with controllable dependencies.
 *
 * `actionCards` is what the Action Center would show. Everything the module
 * overview services return is deliberately set to loud, wrong numbers: if any
 * of them leaks into the Dashboard, the assertions below fail immediately.
 */
function loadDashboardWith(actionCards) {
  for (const key of Object.keys(PATHS)) {
    resetModule(resolved(key));
  }

  const prismaModule = require(resolved("prisma"));
  prismaModule.prisma.store.findUnique = async () => ({
    id: "store-1",
    shop: "test-shop.myshopify.com",
    lastSyncAt: new Date("2026-05-02T08:00:00.000Z"),
    syncJobs: [
      { status: "SUCCEEDED", finishedAt: new Date("2026-05-02T08:10:00.000Z") },
    ],
    timelineEvents: [
      {
        id: "evt-1",
        title: "Pricing insight updated",
        detail: "Recommendation queue refreshed.",
        severity: "critical",
        category: "pricing",
        eventType: "price_change_detected",
        metadataJson: null,
        createdAt: new Date("2026-05-02T08:12:00.000Z"),
      },
    ],
  });
  prismaModule.prisma.customer.count = async () => 2;

  // POISONED PARALLEL PATHS. Every one of these numbers is a number the
  // Dashboard must no longer be capable of showing.
  require(resolved("trustAbuse")).getTrustAbuseOverview = async () => ({
    summary: { highRiskOrders: 3, manualReviewCount: 2 },
  });
  require(resolved("competitor")).getCompetitorOverview = async () => ({
    competitorState: {
      detectedPriceChangesCount: 3,
      detectedPromotionChangesCount: 2,
    },
  });
  require(resolved("pricingProfit")).getPricingProfitOverview = async () => ({
    summary: { recommendationCount: 7, profitOpportunityCount: 4 },
  });

  require(resolved("onboarding")).getOnboardingState = async () => ({
    complete: false,
  });
  require(resolved("readiness")).getUnifiedReadinessState = async () => ({
    initialSync: { syncStatus: "READY_WITH_DATA" },
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
  require(resolved("operational")).getStoreOperationalSnapshot = async () => ({
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
  require(resolved("operational")).deriveSyncStatus = () => ({
    status: "READY_WITH_DATA",
    reason: "Shopify data and derived module outputs are available.",
  });

  require(resolved("subscription")).resolveEntitlements = async () => ({
    enabledModules: ["fraud", "competitor", "pricing", "profit"],
  });

  const actionCenter = require(resolved("actionCenter"));
  const realBuildSummary = actionCenter.buildSummary;
  actionCenter.getActionCenter = async () => ({
    cards: actionCards,
    summary: realBuildSummary(actionCards, new Date("2026-05-02T09:00:00.000Z")),
  });

  return {
    getDashboardMetrics: require(resolved("dashboard")).getDashboardMetrics,
    actionCenter,
    realBuildSummary,
  };
}

function actionCard(over = {}) {
  return {
    id: over.id ?? "f1",
    findingType: over.findingType ?? "pricing_opportunity",
    module: over.module ?? "pricing",
    capability: null,
    status: over.status ?? "new",
    severity: over.severity ?? "high",
    confidence: "medium",
    title: over.title ?? "A verified finding",
    whatHappened: over.whatHappened ?? "Something measurable happened.",
    whyItMatters: "It matters.",
    evidence: [],
    methodology: null,
    dataComplete: true,
    degraded: false,
    impact: { status: "impact_not_quantifiable", reason: "Not enough data yet" },
    recommendedAction: "Review it.",
    route: over.route ?? "/app/ai-pricing-engine",
    firstDetectedAt: "2026-05-02T08:00:00.000Z",
    lastSeenAt: over.lastSeenAt ?? "2026-05-02T08:30:00.000Z",
    detectionCount: 1,
    isStale: false,
    rank: {
      score: over.score ?? 50,
      weights: {},
      components: {
        severity: 0,
        confidence: 0,
        freshness: 0,
        impact: 0,
        completeness: 0,
      },
    },
  };
}

// ===========================================================================

test("PHASE F: the Dashboard reports findings, not module overview counts", async () => {
  process.env.ENABLE_INTELLIGENCE_FINDING_PERSISTENCE = "true";

  const { getDashboardMetrics } = loadDashboardWith([
    actionCard({ id: "p1", module: "pricing" }),
    actionCard({ id: "c1", module: "competitor" }),
  ]);

  const metrics = await getDashboardMetrics("test-shop.myshopify.com");

  // The poisoned overviews said 7 / 4 / 5 / 3. Not one of them survives.
  assert.equal(metrics.dashboardState.kpis.pricingOpportunities, 1);
  assert.equal(metrics.dashboardState.kpis.competitorChanges, 1);
  assert.equal(metrics.dashboardState.kpis.profitOpportunities, 0);
  assert.equal(metrics.dashboardState.kpis.fraudAlerts, 0);

  // The legacy top-level fields are a COPY of the same projection, not a second
  // calculation. If they had stayed on the overview services, the frontend's
  // `dashboardState?.kpis.x ?? metrics.y` fallback would have restored the
  // contradiction the moment dashboardState was missing.
  assert.equal(metrics.aiPricingSuggestions, 1);
  assert.equal(metrics.profitOptimizationOpportunities, 0);
  assert.equal(metrics.competitorPriceChanges, 1);
  assert.equal(metrics.highRiskOrders, 0);
  assert.equal(metrics.fraudAlertsToday, 0);

  assert.equal(metrics.dashboardState.findings.totalOpen, 2);
  assert.equal(metrics.dashboardState.syncHealth.status, "READY_WITH_DATA");
});

test("PHASE F: resolving every finding empties the Dashboard too", async () => {
  process.env.ENABLE_INTELLIGENCE_FINDING_PERSISTENCE = "true";

  const { getDashboardMetrics } = loadDashboardWith([
    actionCard({ id: "p1", module: "pricing", status: "resolved" }),
    actionCard({ id: "c1", module: "competitor", status: "dismissed" }),
  ]);

  const metrics = await getDashboardMetrics("test-shop.myshopify.com");

  assert.equal(metrics.dashboardState.findings.totalOpen, 0);
  assert.equal(metrics.dashboardState.kpis.pricingOpportunities, 0);
  assert.equal(metrics.aiPricingSuggestions, 0);
  assert.match(
    metrics.dashboardState.findings.attentionTitle,
    /Nothing needs your attention/i
  );
});

test("REGRESSION: a critical TimelineEvent no longer becomes a Dashboard insight", async () => {
  process.env.ENABLE_INTELLIGENCE_FINDING_PERSISTENCE = "true";

  // The store mock carries a critical pricing TimelineEvent. Under the old
  // path it was formatted into "Recent insights" with no lifecycle behind it,
  // so it would have outlived any resolution. With no open findings, the
  // Dashboard must show nothing.
  const { getDashboardMetrics } = loadDashboardWith([]);
  const metrics = await getDashboardMetrics("test-shop.myshopify.com");

  assert.equal(metrics.dashboardState.recentInsights.length, 0);
  assert.equal(metrics.recentInsights.length, 0);
  // The timeline itself is untouched — it is still recorded and still readable
  // in the module workspaces. It simply is not a second insight source here.
  assert.equal(metrics.timelineEventsGenerated, 1);
});

test("PHASE F: the Dashboard preview matches Action Center's own ordering", async () => {
  process.env.ENABLE_INTELLIGENCE_FINDING_PERSISTENCE = "true";

  const { getDashboardMetrics } = loadDashboardWith([
    actionCard({ id: "low", score: 10, title: "Least important" }),
    actionCard({ id: "top", score: 99, title: "Most important" }),
  ]);

  const metrics = await getDashboardMetrics("test-shop.myshopify.com");
  assert.deepEqual(
    metrics.dashboardState.recentInsights.map((i) => i.title),
    ["Most important", "Least important"]
  );
});

test("SAFETY: with persistence off the Dashboard says so instead of showing zeros", async () => {
  process.env.ENABLE_INTELLIGENCE_FINDING_PERSISTENCE = "false";

  const { getDashboardMetrics } = loadDashboardWith([]);
  const metrics = await getDashboardMetrics("test-shop.myshopify.com");

  assert.equal(metrics.dashboardState.findings.available, false);
  assert.match(
    metrics.dashboardState.findings.unavailableReason,
    /not currently recording findings/i
  );

  process.env.ENABLE_INTELLIGENCE_FINDING_PERSISTENCE = "true";
});

test("SAFETY: a findings read failure degrades honestly, it does not claim zero problems", async () => {
  process.env.ENABLE_INTELLIGENCE_FINDING_PERSISTENCE = "true";

  const { getDashboardMetrics, actionCenter } = loadDashboardWith([]);
  actionCenter.getActionCenter = async () => {
    throw new Error("database unavailable");
  };

  const metrics = await getDashboardMetrics("test-shop.myshopify.com");

  // The page still renders — a Dashboard that 500s would be worse than one that
  // explains itself — but it never presents the failure as good news.
  assert.equal(metrics.dashboardState.findings.available, false);
  assert.match(
    metrics.dashboardState.findings.attentionDetail,
    /temporary read problem, not a statement about your store/i
  );
});

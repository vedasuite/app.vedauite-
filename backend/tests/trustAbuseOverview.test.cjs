const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

function resetModule(modulePath) {
  const resolved = require.resolve(modulePath);
  delete require.cache[resolved];
}

test("trust abuse overview does not expose internal fallback order ids", async () => {
  const prismaPath = path.resolve(__dirname, "../dist/db/prismaClient.js");
  const creditScorePath = path.resolve(
    __dirname,
    "../dist/services/creditScoreService.js"
  );
  const fraudPath = path.resolve(__dirname, "../dist/services/fraudService.js");
  const subscriptionPath = path.resolve(
    __dirname,
    "../dist/services/subscriptionService.js"
  );
  const operationalPath = path.resolve(
    __dirname,
    "../dist/services/storeOperationalStateService.js"
  );
  const overviewPath = path.resolve(
    __dirname,
    "../dist/services/trustAbuseService.js"
  );

  [
    prismaPath,
    creditScorePath,
    fraudPath,
    subscriptionPath,
    operationalPath,
    overviewPath,
  ].forEach(resetModule);

  const prismaModule = require(prismaPath);
  prismaModule.prisma.store.findUnique = async () => ({
    id: "store-1",
    timelineEvents: [],
  });

  require(subscriptionPath).getCurrentSubscription = async () => ({
    featureAccess: {
      supportCopilot: false,
      evidencePackExport: false,
    },
  });

  require(fraudPath).getFraudIntelligenceOverview = async () => ({
    summary: {
      returnAbuseProfiles: 0,
      highRiskOrders: 1,
      manualReviewCount: 1,
      sharedFraudNetworkEnabled: false,
      automationReadiness: "Needs review",
    },
    scoreBands: { low: "0-30", medium: "31-70", high: "71-100" },
    returnAbuseSignals: [],
    wardrobingSignals: [],
    networkMatches: [
      {
        id: "network-1",
        orderLabel: "Order pending sync",
        customerId: "customer-1",
        riskLevel: "High",
        repeatSignals: 2,
        email: "cu***",
        confidence: 78,
        recommendedAction: "Manual review",
        reasons: ["Fingerprint repeated."],
        automationPosture: "Monitor",
      },
    ],
    chargebackCandidates: [],
    automationRules: [],
  });
  require(fraudPath).listRecentFraudOrders = async () => [
    {
      id: "order-1",
      shopifyOrderId: "vedasuite-ai.myshopify.com-order-1002",
      orderName: null,
      shopifyLegacyOrderId: null,
      fraudScore: 88,
      fraudRiskLevel: "High",
      status: "manual_review",
      refundRequested: true,
      createdAt: new Date("2026-05-02T08:00:00.000Z"),
    },
  ];

  require(creditScorePath).getTrustOperatingLayer = async () => ({
    segments: { trusted: 0, normal: 0, risky: 1 },
    policyRecommendations: [],
    automationRules: [],
  });
  require(creditScorePath).listCustomerScores = async () => [];

  require(operationalPath).getStoreOperationalSnapshot = async () => ({
    store: {
      lastConnectionStatus: "OK",
      lastSyncStatus: "READY_WITH_DATA",
      lastConnectionError: null,
    },
    counts: {
      products: 1,
      orders: 1,
      customers: 1,
      pricingRows: 0,
      profitRows: 0,
      timelineEvents: 1,
    },
    latestProcessingAt: new Date("2026-05-02T08:00:00.000Z"),
    latestSyncJob: {
      status: "SUCCEEDED",
    },
  });
  require(operationalPath).deriveSyncStatus = () => ({
    status: "READY_WITH_DATA",
    reason: "ready",
  });
  require(operationalPath).deriveModuleReadiness = () => ({
    readinessState: "READY",
    reason: "ready",
  });

  const { getTrustAbuseOverview } = require(overviewPath);
  const overview = await getTrustAbuseOverview("test-shop.myshopify.com");

  assert.equal(overview.fraudReviewQueue.length, 0);
  assert.equal(overview.networkMatches.length, 0);
});

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

process.env.SHOPIFY_API_KEY ||= "test-key";
process.env.SHOPIFY_API_SECRET ||= "test-secret";
process.env.SHOPIFY_APP_URL ||= "https://app.vedasuite.in";
process.env.DATABASE_URL ||= "postgresql://example:example@localhost:5432/example";

function mockModule(relPath, exports) {
  const abs = require.resolve(path.resolve(__dirname, relPath));
  require.cache[abs] = { id: abs, filename: abs, loaded: true, exports };
}

// ---------------------------------------------------------------------------
// Regression suite for the "Step 5 of 4" / "Dashboard available after
// onboarding" mismatch.
//
// Onboarding completion must be defined by exactly the four visible steps.
// It must never depend on a condition the merchant cannot see or act on —
// previously `readiness.setup.minimumComplete` also required the selected
// module to have finished processing data, which is a background outcome, so a
// store could show 4/4 complete while the dashboard stayed blocked.
// ---------------------------------------------------------------------------

const state = {
  connectionReady: true,
  syncReady: true,
  billingReady: true,
  selectedModule: "pricing",
  firstInsightViewedAt: new Date("2026-08-01T00:00:00Z"),
  planConfirmedAt: new Date("2026-08-01T00:00:00Z"),
  /** The hidden condition: selected module finished processing. */
  selectedModuleReady: true,
  planName: "PRO",
};

function resetState(overrides = {}) {
  Object.assign(state, {
    connectionReady: true,
    syncReady: true,
    billingReady: true,
    selectedModule: "pricing",
    firstInsightViewedAt: new Date("2026-08-01T00:00:00Z"),
    planConfirmedAt: new Date("2026-08-01T00:00:00Z"),
    selectedModuleReady: true,
    planName: "PRO",
  }, overrides);
}

const moduleReadiness = (ready) => ({
  state: ready ? "ready" : "collecting_data",
  status: ready ? "ready" : "collecting",
  title: "Module",
  description: ready ? "Ready." : "Still collecting data.",
  ready,
});

mockModule("../dist/db/prismaClient.js", {
  prisma: {
    store: {
      findUnique: async () => ({
        id: "store-1",
        shop: "test-shop.myshopify.com",
        onboardingSelectedModule: state.selectedModule,
        onboardingFirstInsightViewedAt: state.firstInsightViewedAt,
        onboardingPlanConfirmedAt: state.planConfirmedAt,
        onboardingCompletedAt: null,
        onboardingDismissedAt: null,
      }),
      update: async () => ({ id: "store-1" }),
    },
  },
});
mockModule("../dist/services/observabilityService.js", { logEvent: () => {} });

mockModule("../dist/services/readinessEngineService.js", {
  getUnifiedReadinessState: async () => ({
    connection: { ready: state.connectionReady, healthy: state.connectionReady, description: "", code: "OK", state: "ready", status: "ready", title: "" },
    initialSync: { ready: state.syncReady, state: state.syncReady ? "ready" : "collecting_data", status: "ready", title: "", description: "", syncStatus: "READY_WITH_DATA", hasRawData: true, hasProcessedData: true },
    billing: { ready: state.billingReady, state: "ready", status: "ready", title: "", description: "", lifecycle: "active", planName: state.planName, accessActive: true, verified: true },
    modules: {
      fraud: moduleReadiness(true),
      competitor: moduleReadiness(true),
      pricing: moduleReadiness(state.selectedModuleReady),
    },
    setup: {
      // The hidden condition lives here: it also requires the selected module
      // to be "ready". Kept faithful to production so the test proves
      // completion no longer depends on it.
      minimumComplete:
        state.connectionReady && state.syncReady && state.billingReady && state.selectedModuleReady,
      allCoreModulesReady: true,
      blockers: [],
      nextAction: { label: "Open dashboard", route: "/app/dashboard" },
      percent: 100,
      summaryTitle: "",
      summaryDescription: "",
    },
    quickAccess: {},
  }),
  resolveEntitledModule: (stored) => stored ?? null,
});

mockModule("../dist/services/subscriptionService.js", {
  getCurrentSubscription: async () => ({
    planName: state.planName,
    starterModule: null,
    enabledModules: { fraud: true, competitor: true, pricing: true, profit: true, reports: true, settings: true },
  }),
  resolveBillingState: async () => ({ planName: state.planName, accessActive: true }),
});
mockModule("../dist/services/storeOperationalStateService.js", {
  getStoreOperationalSnapshot: async () => ({
    counts: { orders: 10, products: 10, competitorDomains: 1, competitorRows: 1, pricingRows: 1, profitRows: 1 },
    store: { onboardingSelectedModule: state.selectedModule },
  }),
  deriveSyncStatus: () => (state.syncReady ? "READY_WITH_DATA" : "PROCESSING_PENDING"),
});
mockModule("../dist/services/shopifyConnectionService.js", {
  getConnectionHealth: async () => ({
    healthy: state.connectionReady,
    code: state.connectionReady ? "OK" : "SHOPIFY_RECONNECT_REQUIRED",
    message: "",
  }),
});

const onboardingPath = path.resolve(__dirname, "../dist/services/onboardingService.js");
const { getOnboardingState } = require(onboardingPath);

async function progressOf() {
  const result = await getOnboardingState("test-shop.myshopify.com");
  const completed = result.steps.filter((s) => s.complete).length;
  return {
    total: result.progress.totalSteps,
    completed: result.progress.completedSteps,
    canAccessDashboard: result.canAccessDashboard,
    stepCount: result.steps.length,
    completedFromSteps: completed,
    // Mirrors the badge the UI renders, including its clamp.
    badgeStep: Math.min(Math.max(completed + 1, 1), result.progress.totalSteps),
  };
}

test("there are exactly four visible onboarding steps", async () => {
  resetState();
  const p = await progressOf();
  assert.equal(p.stepCount, 4);
  assert.equal(p.total, 4);
});

test("zero complete: step 1 of 4, dashboard blocked", async () => {
  resetState({ syncReady: false, selectedModule: null, firstInsightViewedAt: null, planConfirmedAt: null, billingReady: false });
  const p = await progressOf();
  assert.equal(p.completed, 0);
  assert.equal(p.badgeStep, 1);
  assert.equal(p.canAccessDashboard, false);
});

test("three of four complete: step 4 of 4, dashboard still blocked", async () => {
  resetState({ planConfirmedAt: null, billingReady: false });
  const p = await progressOf();
  assert.equal(p.completed, 3);
  assert.equal(p.badgeStep, 4);
  assert.equal(p.canAccessDashboard, false);
});

test("four of four complete: 4/4, no Step 5 of 4, dashboard available", async () => {
  resetState();
  const p = await progressOf();
  assert.equal(p.completed, 4);
  assert.equal(p.total, 4);
  assert.equal(p.badgeStep, 4, "the badge must never read Step 5 of 4");
  assert.ok(p.badgeStep <= p.total);
  assert.equal(p.canAccessDashboard, true, "dashboard must unblock when all visible steps are complete");
});

test("REGRESSION: a hidden condition cannot leave 4/4 complete but dashboard blocked", async () => {
  // The exact production state: every visible step complete, plan confirmed,
  // but the selected module has not finished processing data.
  resetState({ selectedModuleReady: false });
  const p = await progressOf();

  assert.equal(p.completed, 4, "all four visible steps are complete");
  assert.equal(p.badgeStep, 4);
  assert.equal(
    p.canAccessDashboard,
    true,
    "a condition with no visible step must not block the dashboard"
  );
});

test("current step is clamped: never below 1, never above the total", async () => {
  for (const overrides of [
    { syncReady: false, selectedModule: null, firstInsightViewedAt: null, planConfirmedAt: null, billingReady: false },
    { planConfirmedAt: null, billingReady: false },
    {},
    { selectedModuleReady: false },
  ]) {
    resetState(overrides);
    const p = await progressOf();
    assert.ok(p.badgeStep >= 1, "step must never be below 1");
    assert.ok(p.badgeStep <= p.total, `step ${p.badgeStep} must never exceed total ${p.total}`);
  }
});

test("an unhealthy Shopify connection still blocks the dashboard", async () => {
  // Connection health is a real, merchant-actionable requirement (Step 1's CTA
  // becomes "Reconnect Shopify"), so it must NOT be relaxed by this fix.
  resetState({ connectionReady: false });
  const p = await progressOf();
  assert.equal(p.canAccessDashboard, false);
});

test("plan confirmation is still genuinely required", async () => {
  resetState({ planConfirmedAt: null });
  const p = await progressOf();
  assert.equal(p.canAccessDashboard, false, "an unconfirmed plan must still block");
});

test("opening the first feature is still genuinely required", async () => {
  resetState({ firstInsightViewedAt: null });
  const p = await progressOf();
  assert.equal(p.canAccessDashboard, false);
});

test("Starter, Growth and Pro all complete onboarding identically", async () => {
  for (const planName of ["STARTER", "GROWTH", "PRO"]) {
    resetState({ planName });
    const p = await progressOf();
    assert.equal(p.completed, 4, `${planName} should complete all four steps`);
    assert.equal(p.canAccessDashboard, true, `${planName} should reach the dashboard`);
    assert.equal(p.badgeStep, 4);
  }
});

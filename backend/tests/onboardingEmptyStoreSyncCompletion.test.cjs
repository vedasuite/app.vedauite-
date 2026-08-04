const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

process.env.SHOPIFY_API_KEY ||= "test-key";
process.env.SHOPIFY_API_SECRET ||= "test-secret";
process.env.SHOPIFY_APP_URL ||= "https://app.vedasuite.in";
process.env.DATABASE_URL ||= "postgresql://example:example@localhost:5432/example";

/**
 * PRODUCTION REGRESSION — a brand-new Shopify development store installed the
 * app, approved PRO, pressed "Sync Data", and the sync SUCCEEDED, yet
 * Onboarding Step 1 stayed at "0 / 4 · Current · Sync Data" and every later step
 * remained locked. The merchant could not continue.
 *
 * Cause: Step 1 completion read `readiness.initialSync.ready`, which is true
 * only for the READY_WITH_DATA state. deriveSyncStatus only reaches that when
 * products+orders+customers > 0 AND processed rows > 0. An empty store has
 * neither, so a perfectly successful sync lands on EMPTY_STORE_DATA ->
 * "setup_needed" -> ready === false. Step 1 therefore measured store
 * *emptiness*, not sync success.
 *
 * Step 1 must now be driven by whether a sync actually ran and succeeded, while
 * insights/readiness continue to reflect the (genuinely limited) data.
 */

function mockModule(relPath, exports) {
  const abs = require.resolve(path.resolve(__dirname, relPath));
  require.cache[abs] = { id: abs, filename: abs, loaded: true, exports };
}

const state = {
  /** Terminal status of the latest shopify_sync job, or null for "never synced". */
  latestSyncJobStatus: "SUCCEEDED_NO_DATA",
  /** The canonical sync state the readiness engine derives for an empty store. */
  initialSyncReady: false,
  initialSyncStatus: "EMPTY_STORE_DATA",
  counts: { products: 0, orders: 0, customers: 0, competitorDomains: 0, competitorRows: 0, pricingRows: 0, profitRows: 0, timelineEvents: 0 },
  selectedModule: null,
  firstInsightViewedAt: null,
  planConfirmedAt: null,
  billingReady: true,
  connectionReady: true,
};

function resetState(overrides = {}) {
  Object.assign(
    state,
    {
      latestSyncJobStatus: "SUCCEEDED_NO_DATA",
      initialSyncReady: false,
      initialSyncStatus: "EMPTY_STORE_DATA",
      counts: { products: 0, orders: 0, customers: 0, competitorDomains: 0, competitorRows: 0, pricingRows: 0, profitRows: 0, timelineEvents: 0 },
      selectedModule: null,
      firstInsightViewedAt: null,
      planConfirmedAt: null,
      billingReady: true,
      connectionReady: true,
    },
    overrides
  );
}

const moduleReadiness = (ready) => ({
  state: ready ? "ready" : "collecting_data",
  status: ready ? "ready" : "collecting",
  title: "Module",
  description: ready ? "Ready." : "More Shopify activity is needed before insights appear.",
  ready,
});

mockModule("../dist/db/prismaClient.js", {
  prisma: {
    store: {
      findUnique: async () => ({
        id: "store-1",
        shop: "new-store.myshopify.com",
        installedAt: new Date("2026-08-04T00:00:00Z"),
        webhooksRegisteredAt: new Date("2026-08-04T00:00:00Z"),
        lastWebhookRegistrationStatus: "OK",
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
    // Faithful to production for an empty store after a successful sync:
    // ready === false because the state is EMPTY_STORE_DATA, not READY_WITH_DATA.
    initialSync: {
      ready: state.initialSyncReady,
      state: state.initialSyncReady ? "ready" : "setup_needed",
      status: state.initialSyncReady ? "ready" : "setup_needed",
      title: "Update store insights",
      description:
        "More Shopify product, order, or customer activity is needed before insights appear.",
      syncStatus: state.initialSyncStatus,
      hasRawData: false,
      hasProcessedData: false,
    },
    billing: { ready: state.billingReady, state: "ready", status: "ready", title: "", description: "", lifecycle: "active", planName: "PRO", accessActive: true, verified: true },
    modules: {
      fraud: moduleReadiness(false),
      competitor: moduleReadiness(false),
      pricing: moduleReadiness(false),
    },
    setup: {
      minimumComplete: false,
      allCoreModulesReady: false,
      blockers: [],
      nextAction: { label: "Continue setup", route: "/app/onboarding" },
      percent: 0,
      summaryTitle: "",
      summaryDescription: "",
    },
    quickAccess: {},
  }),
  resolveEntitledModule: (stored) => stored ?? null,
});

mockModule("../dist/services/subscriptionService.js", {
  getCurrentSubscription: async () => ({
    planName: "PRO",
    starterModule: null,
    enabledModules: { fraud: true, competitor: true, pricing: true, profit: true, reports: true, settings: true },
  }),
  resolveBillingState: async () => ({ planName: "PRO", accessActive: true }),
});

mockModule("../dist/services/storeOperationalStateService.js", {
  getStoreOperationalSnapshot: async () => ({
    counts: state.counts,
    store: {
      onboardingSelectedModule: state.selectedModule,
      lastConnectionStatus: "OK",
      lastSyncStatus: state.latestSyncJobStatus === null ? null : state.initialSyncStatus,
      lastSyncAt: state.latestSyncJobStatus === null ? null : new Date("2026-08-04T01:00:00Z"),
    },
    // The signal that distinguishes "synced successfully, store is empty" from
    // "never synced at all" — both of which look identical in the counts.
    latestSyncJob:
      state.latestSyncJobStatus === null
        ? null
        : { status: state.latestSyncJobStatus, startedAt: new Date("2026-08-04T00:59:00Z"), finishedAt: new Date("2026-08-04T01:00:00Z") },
    latestCompetitorIngestJob: null,
    latestProcessingAt: null,
    latestCompetitorAt: null,
  }),
  deriveSyncStatus: () => ({
    status: state.initialSyncStatus,
    reason: "More Shopify product, order, or customer activity is needed before insights appear.",
  }),
});

mockModule("../dist/services/shopifyConnectionService.js", {
  getConnectionHealth: async () => ({
    healthy: state.connectionReady,
    code: state.connectionReady ? "OK" : "SHOPIFY_RECONNECT_REQUIRED",
    message: "",
  }),
});

const { getOnboardingState } = require(
  path.resolve(__dirname, "../dist/services/onboardingService.js")
);

async function onboarding() {
  const result = await getOnboardingState("new-store.myshopify.com");
  const byKey = Object.fromEntries(result.steps.map((step) => [step.key, step]));
  return {
    result,
    steps: byKey,
    completed: result.progress.completedSteps,
    total: result.progress.totalSteps,
    canAccessDashboard: result.canAccessDashboard,
    stage: result.stage,
  };
}

// ===========================================================================
// THE BUG: a successful sync on an empty store must complete Step 1.
// ===========================================================================

test("empty store + successful sync: Step 1 is COMPLETE even with zero products, orders and customers", async () => {
  resetState();
  const o = await onboarding();

  assert.equal(
    o.steps.DATA_SYNC.complete,
    true,
    "a successful sync must complete Step 1 regardless of how little history exists"
  );
  assert.equal(o.completed, 1, "progress must read 1 / 4, not 0 / 4");
  assert.equal(o.total, 4);
});

test("empty store + successful sync: the merchant can continue — Step 2 is unlocked and active", async () => {
  resetState();
  const o = await onboarding();

  assert.equal(o.steps.MODULE_SELECTION.locked, false, "Step 2 must not stay locked");
  assert.equal(o.steps.MODULE_SELECTION.active, true, "Step 2 becomes the current step");
  assert.equal(o.steps.DATA_SYNC.active, false, "Step 1 is no longer the current step");
  assert.equal(o.stage, "MODULE_SELECTION");
});

test("empty store + successful sync: Step 2's helper no longer tells the merchant to finish syncing", async () => {
  resetState();
  const o = await onboarding();

  assert.doesNotMatch(
    o.steps.MODULE_SELECTION.helper,
    /finish syncing/i,
    "the sync is finished — the helper must not claim otherwise"
  );
});

test("a sync that succeeded with processing still pending also completes Step 1 (no insights yet is fine)", async () => {
  resetState({
    latestSyncJobStatus: "SUCCEEDED_PROCESSING_PENDING",
    initialSyncStatus: "SYNC_COMPLETED_PROCESSING_PENDING",
  });
  const o = await onboarding();

  assert.equal(o.steps.DATA_SYNC.complete, true);
});

test("a store WITH data and a fully ready sync is unaffected", async () => {
  resetState({
    latestSyncJobStatus: "READY_WITH_DATA",
    initialSyncReady: true,
    initialSyncStatus: "READY_WITH_DATA",
    counts: { products: 12, orders: 30, customers: 8, competitorDomains: 1, competitorRows: 5, pricingRows: 5, profitRows: 5, timelineEvents: 5 },
  });
  const o = await onboarding();

  assert.equal(o.steps.DATA_SYNC.complete, true);
});

// ===========================================================================
// Guard rails: Step 1 must NOT complete without a successful sync.
// ===========================================================================

test("fresh install, never synced: Step 1 is NOT complete — it must not self-tick before the merchant syncs", async () => {
  // The critical distinction. An empty store that has never synced produces
  // EMPTY_STORE_DATA too, so eligibility cannot key off that status alone.
  resetState({ latestSyncJobStatus: null });
  const o = await onboarding();

  assert.equal(
    o.steps.DATA_SYNC.complete,
    false,
    "no sync has run, so Step 1 must remain incomplete"
  );
  assert.equal(o.completed, 0, "progress must read 0 / 4");
  assert.equal(o.steps.DATA_SYNC.active, true, "Sync Data is the current step");
});

test("a FAILED sync leaves Step 1 incomplete", async () => {
  resetState({ latestSyncJobStatus: "FAILED" });
  const o = await onboarding();

  assert.equal(o.steps.DATA_SYNC.complete, false);
  assert.equal(o.completed, 0);
});

test("a sync still running leaves Step 1 incomplete", async () => {
  resetState({ latestSyncJobStatus: "SYNC_IN_PROGRESS" });
  const o = await onboarding();

  assert.equal(o.steps.DATA_SYNC.complete, false);
});

test("a queued (PENDING) sync leaves Step 1 incomplete", async () => {
  resetState({ latestSyncJobStatus: "PENDING" });
  const o = await onboarding();

  assert.equal(o.steps.DATA_SYNC.complete, false);
});

// ===========================================================================
// Later steps must NOT be auto-completed by the fix.
// ===========================================================================

test("completing Step 1 does not auto-complete any later step", async () => {
  resetState(); // successful sync, but no module picked, nothing opened, no plan confirmed
  const o = await onboarding();

  assert.equal(o.steps.DATA_SYNC.complete, true);
  assert.equal(o.steps.MODULE_SELECTION.complete, false, "Step 2 still requires picking a feature");
  assert.equal(o.steps.FIRST_INSIGHT_VIEW.complete, false, "Step 3 still requires opening it");
  assert.equal(o.completed, 1, "exactly one step completed");
  assert.equal(o.canAccessDashboard, false, "the dashboard is still gated on the remaining steps");
});

test("Step 2 completes only once a feature is actually selected", async () => {
  resetState({ selectedModule: "fraud" });
  const o = await onboarding();

  assert.equal(o.steps.DATA_SYNC.complete, true);
  assert.equal(o.steps.MODULE_SELECTION.complete, true);
  assert.equal(o.steps.FIRST_INSIGHT_VIEW.complete, false, "Step 3 is not implied by Step 2");
  assert.equal(o.completed, 2);
});

test("an empty store can reach a fully complete onboarding once it finishes the visible steps", async () => {
  // The end-to-end point of the fix: zero orders, zero customers, no insights,
  // yet the merchant is not trapped.
  resetState({
    selectedModule: "fraud",
    firstInsightViewedAt: new Date("2026-08-04T02:00:00Z"),
    planConfirmedAt: new Date("2026-08-04T02:00:00Z"),
  });
  const o = await onboarding();

  assert.equal(o.completed, 4, "all four visible steps complete on an empty store");
  assert.equal(o.canAccessDashboard, true, "the merchant is no longer blocked");
});

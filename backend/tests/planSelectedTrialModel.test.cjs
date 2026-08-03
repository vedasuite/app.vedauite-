const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

process.env.SHOPIFY_API_KEY ||= "test-key";
process.env.SHOPIFY_API_SECRET ||= "test-secret";
process.env.SHOPIFY_APP_URL ||= "https://app.vedasuite.in";
process.env.DATABASE_URL ||= "postgresql://example:example@localhost:5432/example";
process.env.SHOPIFY_BILLING_TEST_MODE ||= "true";

/**
 * Plan-selected trial model (2026-08-03 product decision):
 *   - The merchant must select and approve STARTER/GROWTH/PRO in Shopify
 *     BEFORE any trial exists at all.
 *   - The trial grants exactly the approved plan's own entitlements — never
 *     "every module".
 *   - Shopify does not charge until the local 7-day trial ends.
 *   - The previously-fixed protections (active StoreSubscription must not
 *     suppress an unexpired trial; one-trial-per-shop; no write-on-read; no
 *     new trial on reinstall/cancellation/reconnect) all still hold.
 */

function resetModule(modulePath) {
  const resolved = require.resolve(modulePath);
  delete require.cache[resolved];
}

function freshServices() {
  const prismaPath = path.resolve(__dirname, "../dist/db/prismaClient.js");
  const observabilityPath = path.resolve(__dirname, "../dist/services/observabilityService.js");
  const shopifyAdminServicePath = path.resolve(__dirname, "../dist/services/shopifyAdminService.js");
  const subscriptionServicePath = path.resolve(__dirname, "../dist/services/subscriptionService.js");
  const billingManagementServicePath = path.resolve(__dirname, "../dist/services/billingManagementService.js");
  const trialEligibilityServicePath = path.resolve(__dirname, "../dist/services/trialEligibilityService.js");
  const appStateServicePath = path.resolve(__dirname, "../dist/services/appStateService.js");
  const shopifyConnectionServicePath = path.resolve(__dirname, "../dist/services/shopifyConnectionService.js");
  const onboardingServicePath = path.resolve(__dirname, "../dist/services/onboardingService.js");
  const dashboardServicePath = path.resolve(__dirname, "../dist/services/dashboardService.js");
  const readinessEngineServicePath = path.resolve(__dirname, "../dist/services/readinessEngineService.js");
  // storeReadinessService is left REAL (not mocked) — it internally calls
  // the real resolveEntitlements(), which is exactly what this suite needs
  // appState.entitlements.* to reflect accurately per scenario. Only its own
  // DB-touching dependency (operational snapshot) is stubbed.
  const storeOperationalStateServicePath = path.resolve(__dirname, "../dist/services/storeOperationalStateService.js");

  [
    prismaPath,
    observabilityPath,
    shopifyAdminServicePath,
    subscriptionServicePath,
    billingManagementServicePath,
    trialEligibilityServicePath,
    appStateServicePath,
    shopifyConnectionServicePath,
    onboardingServicePath,
    dashboardServicePath,
    readinessEngineServicePath,
    storeOperationalStateServicePath,
  ].forEach(resetModule);

  const prisma = require(prismaPath).prisma;
  require(observabilityPath).logEvent = () => {};

  const shopifyAdminService = require(shopifyAdminServicePath);
  shopifyAdminService.getActiveAppSubscription = async () => null;
  shopifyAdminService.cancelAppSubscription = async () => ({});
  shopifyAdminService.createAppSubscription = async () => ({
    confirmationUrl: "https://shopify.test/confirm",
    appSubscription: { id: "gid://shopify/AppSubscription/1" },
  });

  const subscriptionService = require(subscriptionServicePath);
  const billingManagementService = require(billingManagementServicePath);

  const shopifyConnectionService = require(shopifyConnectionServicePath);
  shopifyConnectionService.getConnectionHealth = async () => ({ code: "OK", healthy: true, message: "OK" });
  const onboardingService = require(onboardingServicePath);
  onboardingService.getOnboardingState = async () => ({ canAccessDashboard: true, steps: [] });
  const dashboardService = require(dashboardServicePath);
  dashboardService.getDashboardMetrics = async () => ({
    dashboardState: { syncHealth: { status: "READY", title: "Synced", reason: "" } },
    lastRefreshedAt: new Date("2026-08-02T00:00:00.000Z").toISOString(),
  });
  const readinessEngineService = require(readinessEngineServicePath);
  readinessEngineService.getUnifiedReadinessState = async () => ({
    connection: { state: "ready", status: "ready", title: "", description: "", ready: true, healthy: true, code: "OK" },
    initialSync: { state: "ready", status: "ready", title: "", description: "", ready: true, syncStatus: "READY", hasRawData: true, hasProcessedData: true },
    billing: { state: "ready", status: "ready", title: "", description: "", ready: true, lifecycle: "active", planName: "NONE", accessActive: false, verified: true },
    modules: {
      fraud: { state: "ready", status: "ready", title: "", description: "", ready: true },
      competitor: { state: "ready", status: "ready", title: "", description: "", ready: true },
      pricing: { state: "ready", status: "ready", title: "", description: "", ready: true },
    },
    setup: { minimumComplete: true, allCoreModulesReady: true, blockers: [], nextAction: { label: "", route: "" }, percent: 100, summaryTitle: "", summaryDescription: "" },
    quickAccess: {
      fraud: { state: "ready", status: "ready", freshnessAt: null, reason: "" },
      competitor: { state: "ready", status: "ready", freshnessAt: null, reason: "" },
      pricing: { state: "ready", status: "ready", freshnessAt: null, reason: "" },
    },
    moduleStates: null,
  });
  const storeOperationalStateService = require(storeOperationalStateServicePath);
  storeOperationalStateService.getStoreOperationalSnapshot = async () => ({
    counts: { orders: 1, products: 1, competitorDomains: 1, competitorRows: 1, pricingRows: 1, profitRows: 1 },
  });

  const appStateService = require(appStateServicePath);
  const trialEligibilityService = require(trialEligibilityServicePath);

  return { prisma, subscriptionService, billingManagementService, appStateService, trialEligibilityService, shopifyAdminService };
}

function buildStore(overrides = {}) {
  return {
    id: "store-1",
    shop: "test-shop.myshopify.com",
    uninstalledAt: null,
    trialStartedAt: null,
    trialEndsAt: null,
    subscription: null,
    billingPlanIntents: [],
    ...overrides,
  };
}

function activeStoreSubscription(planName, overrides = {}) {
  return {
    id: "subscription-1",
    storeId: "store-1",
    starterModule: planName === "STARTER" ? "fraud" : null,
    shopifyChargeId: "gid://shopify/AppSubscription/1",
    active: true,
    billingStatus: "ACTIVE",
    endsAt: null,
    lastBillingSyncAt: new Date("2026-08-01T00:00:00.000Z"),
    plan: { id: `plan-${planName.toLowerCase()}`, name: planName, trialDays: 7 },
    ...overrides,
  };
}

const OPEN_TRIAL = {
  trialStartedAt: new Date("2026-08-01T00:00:00.000Z"),
  trialEndsAt: new Date("2026-08-08T00:00:00.000Z"),
};
const EXPIRED_TRIAL = {
  trialStartedAt: new Date("2026-01-01T00:00:00.000Z"),
  trialEndsAt: new Date("2026-01-08T00:00:00.000Z"),
};

// ---------------------------------------------------------------------------
// 1. No subscription approved -> trial not presented as active (the REAL,
// common fresh-install state: no trial dates exist at all until approval).
// ---------------------------------------------------------------------------
test("fresh install with no plan approved: no trial dates exist, trial is not presented as active", async () => {
  const { prisma, subscriptionService } = freshServices();
  prisma.store.findUnique = async () => buildStore(); // no trial dates, no subscription

  const billing = await subscriptionService.resolveBillingState("test-shop.myshopify.com");

  assert.equal(billing.trialActive, false, "no trial dates yet means no trial is active");
  assert.equal(billing.showTrialDate, false);
  assert.equal(billing.trialDatesIncomplete, true);
  assert.equal(billing.selectedPlanName, "NONE");
  assert.equal(billing.lifecycle, "no_subscription");
  assert.match(billing.merchantTitle, /choose a plan/i, "prompts choosing a plan to start the trial");
  assert.match(billing.merchantDescription, /not.*charged/i, "explains no charge until trial ends");
});

// ---------------------------------------------------------------------------
// 2/3/4. STARTER / GROWTH / PRO trial, and trial expired with each plan.
// ---------------------------------------------------------------------------
for (const plan of ["STARTER", "GROWTH", "PRO"]) {
  test(`${plan} approved with an unexpired trial: trialActive=true, only ${plan}'s entitlements unlock`, async () => {
    const { prisma, subscriptionService } = freshServices();
    prisma.store.findUnique = async () =>
      buildStore({ ...OPEN_TRIAL, subscription: activeStoreSubscription(plan) });

    const billing = await subscriptionService.resolveBillingState("test-shop.myshopify.com");
    const subscription = await subscriptionService.getCurrentSubscription("test-shop.myshopify.com");

    assert.equal(billing.trialActive, true);
    assert.equal(billing.selectedPlanName, plan);
    assert.match(billing.merchantTitle, new RegExp(`${plan} trial active`, "i"));

    const expectedModules = {
      STARTER: { fraud: true, competitor: false, pricing: false, profit: false },
      GROWTH: { fraud: true, competitor: true, pricing: true, profit: false },
      PRO: { fraud: true, competitor: true, pricing: true, profit: true },
    }[plan];
    assert.equal(subscription.enabledModules.fraud, expectedModules.fraud);
    assert.equal(subscription.enabledModules.competitor, expectedModules.competitor);
    assert.equal(subscription.enabledModules.pricingProfit, expectedModules.pricing);
    assert.equal(subscription.enabledModules.profit, expectedModules.profit);
  });

  test(`${plan} with an expired trial: normal ${plan} entitlements apply, no trial copy`, async () => {
    const { prisma, subscriptionService } = freshServices();
    prisma.store.findUnique = async () =>
      buildStore({ ...EXPIRED_TRIAL, subscription: activeStoreSubscription(plan) });

    const billing = await subscriptionService.resolveBillingState("test-shop.myshopify.com");
    const subscription = await subscriptionService.getCurrentSubscription("test-shop.myshopify.com");

    assert.equal(billing.trialActive, false);
    assert.equal(billing.selectedPlanName, plan);
    assert.doesNotMatch(billing.merchantTitle, /trial/i, "no trial copy once expired");
    assert.equal(subscription.status, "active_paid");

    const expectedModules = {
      STARTER: { fraud: true, competitor: false, pricing: false, profit: false },
      GROWTH: { fraud: true, competitor: true, pricing: true, profit: false },
      PRO: { fraud: true, competitor: true, pricing: true, profit: true },
    }[plan];
    assert.equal(subscription.enabledModules.fraud, expectedModules.fraud);
    assert.equal(subscription.enabledModules.competitor, expectedModules.competitor);
    assert.equal(subscription.enabledModules.pricingProfit, expectedModules.pricing);
    assert.equal(subscription.enabledModules.profit, expectedModules.profit);
  });
}

// ---------------------------------------------------------------------------
// 6. Reinstall and cancellation abuse prevention, including switching plans
// after the trial closes — the exact gaming vector Shopify's own native
// trialDays parameter had to be guarded against.
// ---------------------------------------------------------------------------
test("cancelling a trialed plan and later approving a DIFFERENT plan does not grant a second trial", async () => {
  const { prisma, subscriptionService, billingManagementService, trialEligibilityService, shopifyAdminService } =
    freshServices();

  // Shop already used its one trial on STARTER, now expired.
  prisma.shopTrialHistory.findUnique = async () => ({
    shop: "test-shop.myshopify.com",
    firstInstalledAt: EXPIRED_TRIAL.trialStartedAt,
    trialStartedAt: EXPIRED_TRIAL.trialStartedAt,
    trialEndsAt: EXPIRED_TRIAL.trialEndsAt,
  });

  // Pre-approval guard: Shopify must not be offered a fresh native trial for
  // a shop that already has durable history — otherwise switching plans
  // would buy another free Shopify-side billing window indefinitely.
  const alreadyUsed = await trialEligibilityService.hasExistingTrialHistory("test-shop.myshopify.com");
  assert.equal(alreadyUsed, true);

  let capturedTrialDays = null;
  shopifyAdminService.createAppSubscription = async (params) => {
    capturedTrialDays = params.trialDays;
    return { confirmationUrl: "https://shopify.test/confirm", appSubscription: { id: "gid://shopify/AppSubscription/2" } };
  };

  const store = buildStore({
    ...EXPIRED_TRIAL,
    subscription: null, // cancelled — no active StoreSubscription anymore
    billingPlanIntents: [],
  });
  prisma.store.findUnique = async () => store;
  prisma.subscriptionPlan.findUnique = async () => null;
  prisma.subscriptionPlan.create = async ({ data }) => ({ id: "plan-growth", ...data });
  prisma.billingPlanIntent.findFirst = async () => null;
  let storedIntent = null;
  prisma.billingPlanIntent.create = async ({ data }) => {
    storedIntent = { id: "intent-1", ...data, createdAt: new Date(), updatedAt: new Date(), confirmedAt: null, cancelledAt: null };
    return storedIntent;
  };
  prisma.billingPlanIntent.update = async ({ data }) => {
    storedIntent = { ...storedIntent, ...data, updatedAt: new Date() };
    return storedIntent;
  };
  prisma.billingPlanIntent.updateMany = async () => ({ count: 0 });
  prisma.billingAuditLog.create = async () => ({ id: "audit-1" });

  await billingManagementService.requestBillingPlanChange({
    shopDomain: "test-shop.myshopify.com",
    requestedPlan: "GROWTH",
    starterModule: null,
    host: null,
    returnPath: "/app/billing",
  });

  assert.equal(
    capturedTrialDays,
    0,
    "a shop that already used its trial must be offered trialDays:0 for a new plan — never another free Shopify-side window"
  );

  // Approving GROWTH must reuse the SAME historical (already-expired) window,
  // never grant a new one.
  const billing = await subscriptionService.resolveBillingState("test-shop.myshopify.com");
  assert.equal(billing.trialActive, false, "the historical trial is already expired — approving a new plan does not revive it");
});

test("a genuinely first-time shop is offered Shopify's native trialDays for its one approval", async () => {
  const { prisma, trialEligibilityService, shopifyAdminService, billingManagementService } = freshServices();
  prisma.shopTrialHistory.findUnique = async () => null;

  const alreadyUsed = await trialEligibilityService.hasExistingTrialHistory("new-shop.myshopify.com");
  assert.equal(alreadyUsed, false);

  let capturedTrialDays = null;
  shopifyAdminService.createAppSubscription = async (params) => {
    capturedTrialDays = params.trialDays;
    return { confirmationUrl: "https://shopify.test/confirm", appSubscription: { id: "gid://shopify/AppSubscription/3" } };
  };

  const store = buildStore({ shop: "new-shop.myshopify.com" });
  prisma.store.findUnique = async () => store;
  prisma.subscriptionPlan.findUnique = async () => null;
  prisma.subscriptionPlan.create = async ({ data }) => ({ id: "plan-pro", ...data });
  prisma.billingPlanIntent.findFirst = async () => null;
  let storedIntent = null;
  prisma.billingPlanIntent.create = async ({ data }) => {
    storedIntent = { id: "intent-1", ...data, createdAt: new Date(), updatedAt: new Date(), confirmedAt: null, cancelledAt: null };
    return storedIntent;
  };
  prisma.billingPlanIntent.update = async ({ data }) => {
    storedIntent = { ...storedIntent, ...data, updatedAt: new Date() };
    return storedIntent;
  };
  prisma.billingPlanIntent.updateMany = async () => ({ count: 0 });
  prisma.billingAuditLog.create = async () => ({ id: "audit-1" });

  await billingManagementService.requestBillingPlanChange({
    shopDomain: "new-shop.myshopify.com",
    requestedPlan: "PRO",
    starterModule: null,
    host: null,
    returnPath: "/app/billing",
  });

  assert.equal(capturedTrialDays, 7, "a genuinely first-time shop gets Shopify's own 7-day trial so it is not charged yet");
});

// ---------------------------------------------------------------------------
// 7. Sidebar Upgrade badge consistency — the exact three nav modules
// AppFrame.tsx keys its "Upgrade" badge off (fraud/competitor/pricing).
// ---------------------------------------------------------------------------
test("sidebar Upgrade badge inputs are consistent with the plan-selected trial model", async () => {
  const { prisma, subscriptionService } = freshServices();

  // PRO trial: no Upgrade badge should appear on any of the three nav items.
  prisma.store.findUnique = async () =>
    buildStore({ ...OPEN_TRIAL, subscription: activeStoreSubscription("PRO") });
  const pro = await subscriptionService.getCurrentSubscription("test-shop.myshopify.com");
  assert.equal(pro.enabledModules.fraud, true, "PRO trial: no Upgrade badge on Fraud Intelligence");
  assert.equal(pro.enabledModules.competitor, true, "PRO trial: no Upgrade badge on Competitor Intelligence");
  assert.equal(pro.enabledModules.pricing, true, "PRO trial: no Upgrade badge on AI Pricing Engine");

  // STARTER trial (fraud selected): Upgrade badge correctly still appears on
  // Competitor Intelligence and AI Pricing Engine — this is NOT the bug; the
  // bug was the trial banner contradicting this correct locked state.
  const { prisma: prisma2, subscriptionService: subscriptionService2 } = freshServices();
  prisma2.store.findUnique = async () =>
    buildStore({ ...OPEN_TRIAL, subscription: activeStoreSubscription("STARTER") });
  const starter = await subscriptionService2.getCurrentSubscription("test-shop.myshopify.com");
  assert.equal(starter.enabledModules.fraud, true, "STARTER/fraud trial: no Upgrade badge on the selected module");
  assert.equal(starter.enabledModules.competitor, false, "STARTER trial: Upgrade badge correctly remains on Competitor Intelligence");
  assert.equal(starter.enabledModules.pricing, false, "STARTER trial: Upgrade badge correctly remains on AI Pricing Engine");
});

// ---------------------------------------------------------------------------
// 8. Onboarding, Dashboard, Billing and API consistency.
// ---------------------------------------------------------------------------
for (const plan of ["STARTER", "GROWTH", "PRO"]) {
  test(`onboarding (app-state), dashboard and billing (subscription-plan) agree exactly for a ${plan} trial`, async () => {
    const { prisma, subscriptionService, appStateService } = freshServices();
    prisma.store.findUnique = async () =>
      buildStore({ ...OPEN_TRIAL, subscription: activeStoreSubscription(plan) });

    // Onboarding + Dashboard both read appState.billing.*
    const appState = await appStateService.getMerchantAppState("test-shop.myshopify.com");
    // Billing reads subscription-plan's billingState + subscription + entitlements
    const billing = await subscriptionService.resolveBillingState("test-shop.myshopify.com");
    const subscription = await subscriptionService.getCurrentSubscription("test-shop.myshopify.com");
    const entitlements = await subscriptionService.resolveEntitlements("test-shop.myshopify.com");

    assert.equal(appState.billing.trialActive, billing.trialActive, `${plan}: app-state vs billing trialActive`);
    assert.equal(appState.billing.trialActive, subscription.trialActive, `${plan}: app-state vs subscription trialActive`);
    assert.equal(appState.billing.trialActive, entitlements.trialActive, `${plan}: app-state vs entitlements trialActive`);
    assert.equal(appState.billing.planName, subscription.planName, `${plan}: app-state vs subscription planName`);
    assert.equal(appState.billing.trialEndsAt, billing.trialEndsAt, `${plan}: app-state vs billing trialEndsAt`);

    // Module-level agreement — Dashboard's sidebar and Onboarding's module
    // gating must show the identical enabled/locked set as Billing does.
    assert.equal(appState.entitlements.fraud, subscription.enabledModules.fraud, `${plan}: fraud`);
    assert.equal(appState.entitlements.competitor, subscription.enabledModules.competitor, `${plan}: competitor`);
    assert.equal(appState.entitlements.pricing, subscription.enabledModules.pricingProfit, `${plan}: pricing`);
    assert.equal(appState.entitlements.profit, subscription.enabledModules.profit, `${plan}: profit`);
  });
}

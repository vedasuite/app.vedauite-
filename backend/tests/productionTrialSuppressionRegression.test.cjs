const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const express = require("express");

process.env.SHOPIFY_API_KEY ||= "test-key";
process.env.SHOPIFY_API_SECRET ||= "test-secret";
process.env.SHOPIFY_APP_URL ||= "https://app.vedasuite.in";
process.env.DATABASE_URL ||= "postgresql://example:example@localhost:5432/example";
process.env.SHOPIFY_BILLING_TEST_MODE ||= "true";

/**
 * Reproduces the EXACT reported production failure state and proves it
 * across every affected surface:
 *
 *   Store.trialEndsAt is in the future
 *   AND a StoreSubscription row exists
 *   AND StoreSubscription.active === true
 *   AND a paid plan (STARTER/GROWTH/PRO) has been selected/approved
 *
 * Before this fix, resolveBillingState()'s first branch
 * (`subscription?.plan && isPaidSubscriptionActive(subscription)`) matched
 * this exact state and returned unconditionally — planName=<paid plan>,
 * showTrialDate: false, no trial predicate evaluated at all. That branch no
 * longer exists; trial state is now computed independently of subscription
 * state in every case below.
 */

function resetModule(modulePath) {
  const resolved = require.resolve(modulePath);
  delete require.cache[resolved];
}

function httpGet(server, pathname) {
  const address = server.address();
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port: address.port, path: pathname, method: "GET" },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ statusCode: res.statusCode, body: JSON.parse(body) }));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

/** A StoreSubscription row that is genuinely `active: true` — not a bare
 * plan-name mock. `endsAt: null` plus `active: true` is exactly what
 * isPaidSubscriptionActive() treats as a live, unexpired paid subscription. */
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

const OPEN_TRIAL = {
  trialStartedAt: new Date("2026-08-01T00:00:00.000Z"),
  trialEndsAt: new Date("2026-08-08T00:00:00.000Z"),
};
const EXPIRED_TRIAL = {
  trialStartedAt: new Date("2026-01-01T00:00:00.000Z"),
  trialEndsAt: new Date("2026-01-08T00:00:00.000Z"),
};

function freshServices() {
  const prismaPath = path.resolve(__dirname, "../dist/db/prismaClient.js");
  const observabilityPath = path.resolve(__dirname, "../dist/services/observabilityService.js");
  const shopifyAdminServicePath = path.resolve(__dirname, "../dist/services/shopifyAdminService.js");
  const subscriptionServicePath = path.resolve(__dirname, "../dist/services/subscriptionService.js");
  const billingManagementServicePath = path.resolve(__dirname, "../dist/services/billingManagementService.js");
  const appStateServicePath = path.resolve(__dirname, "../dist/services/appStateService.js");
  const shopifyConnectionServicePath = path.resolve(__dirname, "../dist/services/shopifyConnectionService.js");
  const onboardingServicePath = path.resolve(__dirname, "../dist/services/onboardingService.js");
  const dashboardServicePath = path.resolve(__dirname, "../dist/services/dashboardService.js");
  const readinessEngineServicePath = path.resolve(__dirname, "../dist/services/readinessEngineService.js");
  const storeReadinessServicePath = path.resolve(__dirname, "../dist/services/storeReadinessService.js");

  [
    prismaPath,
    observabilityPath,
    shopifyAdminServicePath,
    subscriptionServicePath,
    billingManagementServicePath,
    appStateServicePath,
    shopifyConnectionServicePath,
    onboardingServicePath,
    dashboardServicePath,
    readinessEngineServicePath,
    storeReadinessServicePath,
  ].forEach(resetModule);

  const prisma = require(prismaPath).prisma;
  require(observabilityPath).logEvent = () => {};

  const shopifyAdminService = require(shopifyAdminServicePath);
  shopifyAdminService.getActiveAppSubscription = async () => null;
  shopifyAdminService.cancelAppSubscription = async () => ({});

  // subscriptionService and billingManagementService are left REAL — the
  // whole point of this suite is proving their actual logic, not a stub.
  const subscriptionService = require(subscriptionServicePath);
  const billingManagementService = require(billingManagementServicePath);

  // getMerchantAppState fans out to five sibling services besides
  // resolveBillingState. Only resolveBillingState (inside subscriptionService,
  // real) matters for this proof, so the other five are given minimal fixed
  // stand-ins — appStateService's billing.* fields are read directly from the
  // real resolveBillingState result, not from any of these.
  const shopifyConnectionService = require(shopifyConnectionServicePath);
  shopifyConnectionService.getConnectionHealth = async () => ({
    code: "OK",
    healthy: true,
    message: "Shopify connection is healthy.",
  });
  const onboardingService = require(onboardingServicePath);
  onboardingService.getOnboardingState = async () => ({
    canAccessDashboard: true,
    steps: [],
  });
  const dashboardService = require(dashboardServicePath);
  dashboardService.getDashboardMetrics = async () => ({
    dashboardState: { syncHealth: { status: "READY", title: "Synced", reason: "" } },
    lastRefreshedAt: new Date("2026-08-02T00:00:00.000Z").toISOString(),
  });
  const readinessEngineService = require(readinessEngineServicePath);
  readinessEngineService.getUnifiedReadinessState = async () => ({
    connection: { state: "ready", status: "ready", title: "", description: "", ready: true, healthy: true, code: "OK" },
    initialSync: { state: "ready", status: "ready", title: "", description: "", ready: true, syncStatus: "READY", hasRawData: true, hasProcessedData: true },
    billing: { state: "ready", status: "ready", title: "", description: "", ready: true, lifecycle: "active", planName: "PRO", accessActive: true, verified: true },
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
  const storeReadinessService = require(storeReadinessServicePath);
  storeReadinessService.getStoreReadinessState = async () => ({
    billing: { plan: "PRO", isActive: true, isTrial: false, trialActive: false, trialEndsAt: null, trialDaysRemaining: 0, starterModule: null, enabledModules: { fraud: true, competitor: true, pricing: true, profit: true, reports: true, settings: true } },
    onboarding: { complete: true, stepsRemaining: [] },
    data: { hasOrders: true, hasProducts: true, hasCompetitors: true, hasPricingData: true, hasProfitData: true },
    modules: { fraudReady: true, competitorReady: true, pricingReady: true, profitReady: true },
    guidedMode: false,
  });

  const appStateService = require(appStateServicePath);

  return { prisma, subscriptionService, billingManagementService, appStateService };
}

const PRODUCTION_FAILURE_MATRIX = [
  { label: "no paid subscription, trial open", trial: OPEN_TRIAL, subscription: null },
  { label: "STARTER active subscription, trial open", trial: OPEN_TRIAL, subscription: activeStoreSubscription("STARTER") },
  { label: "GROWTH active subscription, trial open", trial: OPEN_TRIAL, subscription: activeStoreSubscription("GROWTH") },
  { label: "PRO active subscription, trial open", trial: OPEN_TRIAL, subscription: activeStoreSubscription("PRO") },
  { label: "PRO active subscription, trial expired", trial: EXPIRED_TRIAL, subscription: activeStoreSubscription("PRO") },
];

// ---------------------------------------------------------------------------
// 1/2/3/5/6 (service layer): resolveBillingState + getCurrentSubscription +
// module/entitlement access, for every row of the production-failure matrix.
// ---------------------------------------------------------------------------
for (const scenario of PRODUCTION_FAILURE_MATRIX) {
  test(`service layer proof — ${scenario.label}`, async () => {
    const { prisma, subscriptionService } = freshServices();
    prisma.store.findUnique = async () =>
      buildStore({ ...scenario.trial, subscription: scenario.subscription });

    const billing = await subscriptionService.resolveBillingState("test-shop.myshopify.com");
    const subscription = await subscriptionService.getCurrentSubscription("test-shop.myshopify.com");
    const entitlements = await subscriptionService.resolveEntitlements("test-shop.myshopify.com");

    const trialShouldBeActive = scenario.trial === OPEN_TRIAL;
    const selectedPlan = scenario.subscription ? scenario.subscription.plan.name : "NONE";

    // trialActive / trialEndsAt
    assert.equal(billing.trialActive, trialShouldBeActive, "billing.trialActive");
    assert.equal(subscription.trialActive, trialShouldBeActive, "subscription.trialActive");
    assert.equal(entitlements.trialActive, trialShouldBeActive, "entitlements.trialActive");
    assert.equal(billing.trialEndsAt, scenario.trial.trialEndsAt.toISOString(), "billing.trialEndsAt");

    // selectedPlanName / current plan — an active paid subscription is
    // ALWAYS preserved for display, trial or not.
    assert.equal(billing.selectedPlanName, selectedPlan, "billing.selectedPlanName");
    assert.equal(subscription.planName, selectedPlan, "subscription.planName");

    // showTrialDate mirrors trialActive exactly.
    assert.equal(billing.showTrialDate, trialShouldBeActive, "billing.showTrialDate");

    // billing copy/status
    assert.equal(subscription.status, trialShouldBeActive ? "trial_active" : (selectedPlan === "NONE" ? "inactive" : "active_paid"));
    if (trialShouldBeActive && selectedPlan !== "NONE") {
      assert.match(billing.merchantTitle, /trial/i, "merchant copy must mention the trial");
      assert.match(billing.merchantTitle, new RegExp(selectedPlan, "i"), "merchant copy must name the selected plan");
    }

    // effective module access. Plan-selected trial model: the trial grants
    // exactly the SELECTED plan's own entitlements — never every module.
    // PRO's own entitlements already include everything, so a PRO trial (or
    // PRO paid) unlocks everything; STARTER/GROWTH trials unlock only their
    // own plan's modules, same as if already paying.
    if (trialShouldBeActive && selectedPlan === "PRO") {
      assert.equal(subscription.enabledModules.fraud, true);
      assert.equal(subscription.enabledModules.competitor, true);
      assert.equal(subscription.enabledModules.pricingProfit, true);
      assert.equal(subscription.enabledModules.profit, true, "PRO unlocks full Profit Optimization, trial or paid");
    } else if (trialShouldBeActive && selectedPlan === "GROWTH") {
      assert.equal(subscription.enabledModules.fraud, true);
      assert.equal(subscription.enabledModules.competitor, true);
      assert.equal(subscription.enabledModules.pricingProfit, true);
      assert.equal(subscription.enabledModules.profit, false, "Growth trial never includes full Profit Optimization");
    } else if (trialShouldBeActive && selectedPlan === "STARTER") {
      // buildSubscription("STARTER") selects the "fraud" Starter module.
      assert.equal(subscription.enabledModules.fraud, true);
      assert.equal(subscription.enabledModules.competitor, false, "STARTER trial unlocks only the selected Starter module");
      assert.equal(subscription.enabledModules.pricingProfit, false);
      assert.equal(subscription.enabledModules.profit, false);
    } else if (!trialShouldBeActive && selectedPlan === "PRO") {
      assert.equal(subscription.enabledModules.profit, true);
    } else if (selectedPlan === "NONE") {
      // No plan ever selected: modules stay locked regardless of trialActive
      // — this is the pre-existing "cannot infer access from a date alone"
      // guard, not something this fix touches. The raw trialActive/
      // showTrialDate flags above are still correctly true/date-based.
      assert.equal(subscription.enabledModules.fraud, false);
      assert.equal(subscription.enabledModules.competitor, false);
      assert.equal(subscription.enabledModules.pricingProfit, false);
    }

    // Consistency between app-state's source (resolveBillingState) and
    // subscription-plan's source (getCurrentSubscription + resolveBillingState)
    // — both come from the same call, must agree exactly.
    assert.equal(billing.trialActive, subscription.trialActive);
    assert.equal(billing.trialEndsAt, subscription.trialEndsAt);
  });
}

// ---------------------------------------------------------------------------
// 6 (route layer): GET /api/subscription/plan, hit as real HTTP, for the
// exact PRO-selected-during-open-trial production failure state.
// ---------------------------------------------------------------------------
test("route layer proof — GET /api/subscription/plan does not suppress an open trial for an active PRO subscription", async () => {
  const { prisma } = freshServices();
  prisma.store.findUnique = async () =>
    buildStore({ ...OPEN_TRIAL, subscription: activeStoreSubscription("PRO") });
  prisma.billingPlanIntent.findFirst = async () => null;

  const routePath = path.resolve(__dirname, "../dist/routes/subscriptionRoutes.js");
  resetModule(routePath);
  const { subscriptionRouter } = require(routePath);

  const app = express();
  app.use((req, _res, next) => {
    req.shopifySession = { shop: "test-shop.myshopify.com" };
    next();
  });
  app.use("/api/subscription", subscriptionRouter);
  const server = app.listen(0);

  try {
    const { statusCode, body } = await httpGet(server, "/api/subscription/plan?shop=test-shop.myshopify.com");
    assert.equal(statusCode, 200);
    assert.equal(body.subscription.trialActive, true, "HTTP response: subscription.trialActive");
    assert.equal(body.subscription.planName, "PRO", "HTTP response: selected plan preserved");
    assert.equal(body.billingState.trialActive, true, "HTTP response: billingState.trialActive");
    assert.equal(body.billingState.showTrialDate, true, "HTTP response: billingState.showTrialDate");
    // Plan-selected trial model: tier is the selected plan's own tier
    // ("pro"), not a generic "trial" tier — PRO's own entitlements already
    // include everything, so full access still follows from this tier alone.
    assert.equal(body.entitlements.tier, "pro", "HTTP response: entitlements.tier");
    assert.equal(body.entitlements.capabilities["billing.trialActive"], true, "HTTP response: trial flag still surfaced for UI copy");
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------------------
// 6 (service layer, GET /api/app-state's exact code path): getMerchantAppState.
// ---------------------------------------------------------------------------
for (const planName of ["STARTER", "GROWTH", "PRO"]) {
  test(`app-state service proof — ${planName} active subscription during an open trial reports trialActive=true`, async () => {
    const { prisma, appStateService, subscriptionService } = freshServices();
    prisma.store.findUnique = async () =>
      buildStore({ ...OPEN_TRIAL, subscription: activeStoreSubscription(planName) });

    const appState = await appStateService.getMerchantAppState("test-shop.myshopify.com");
    const billingDirect = await subscriptionService.resolveBillingState("test-shop.myshopify.com");

    assert.equal(appState.billing.trialActive, true, `appState.billing.trialActive for ${planName}`);
    assert.equal(appState.billing.trialEndsAt, OPEN_TRIAL.trialEndsAt.toISOString());
    assert.equal(appState.billing.planName, planName, "selected plan surfaced even while trialing");

    // GET /api/app-state and GET /api/subscription/plan must report the
    // identical trial status for the same persisted data — both are reading
    // the same resolveBillingState() call.
    assert.equal(appState.billing.trialActive, billingDirect.trialActive);
    assert.equal(appState.billing.trialEndsAt, billingDirect.trialEndsAt);
  });
}

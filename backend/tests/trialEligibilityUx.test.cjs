const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

process.env.SHOPIFY_API_KEY ||= "test-key";
process.env.SHOPIFY_API_SECRET ||= "test-secret";
process.env.SHOPIFY_APP_URL ||= "https://app.vedasuite.in";
process.env.DATABASE_URL ||= "postgresql://example:example@localhost:5432/example";
process.env.SHOPIFY_BILLING_TEST_MODE ||= "true";

/**
 * TRIAL-ELIGIBILITY UX.
 *
 * A shop gets exactly ONE trial. The backend already enforced that (trialDays=0
 * for a spent trial), but every "no plan yet" surface promised a "7-day free
 * trial" purely because planName === "NONE" / lifecycle === "no_subscription".
 * A returning merchant was therefore offered a trial the billing path would
 * refuse to grant.
 *
 * The fix is one authoritative field, `trialEligible`, sourced from
 * ShopTrialHistory and surfaced identically everywhere. These tests pin that
 * field's semantics, its fail-closed behaviour, and the copy each state shows.
 */

function resetModule(modulePath) {
  const resolved = require.resolve(modulePath);
  delete require.cache[resolved];
}

const PRISMA_PATH = path.resolve(__dirname, "../dist/db/prismaClient.js");
const OBSERVABILITY_PATH = path.resolve(__dirname, "../dist/services/observabilityService.js");
const SHOPIFY_ADMIN_PATH = path.resolve(__dirname, "../dist/services/shopifyAdminService.js");
const SUBSCRIPTION_SERVICE_PATH = path.resolve(__dirname, "../dist/services/subscriptionService.js");
const TRIAL_ELIGIBILITY_PATH = path.resolve(__dirname, "../dist/services/trialEligibilityService.js");
const APP_STATE_PATH = path.resolve(__dirname, "../dist/services/appStateService.js");
const SHOPIFY_CONNECTION_PATH = path.resolve(__dirname, "../dist/services/shopifyConnectionService.js");
const ONBOARDING_PATH = path.resolve(__dirname, "../dist/services/onboardingService.js");
const DASHBOARD_PATH = path.resolve(__dirname, "../dist/services/dashboardService.js");
const READINESS_PATH = path.resolve(__dirname, "../dist/services/readinessEngineService.js");
const OPERATIONAL_PATH = path.resolve(__dirname, "../dist/services/storeOperationalStateService.js");

const SHOP = "test-shop.myshopify.com";
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const OPEN_TRIAL = {
  trialStartedAt: new Date(Date.now() - 2 * MS_PER_DAY),
  trialEndsAt: new Date(Date.now() + 5 * MS_PER_DAY),
};
const EXPIRED_TRIAL = {
  trialStartedAt: new Date("2026-01-01T00:00:00.000Z"),
  trialEndsAt: new Date("2026-01-08T00:00:00.000Z"),
};

/**
 * @param historyRow  the ShopTrialHistory row, or null for "never trialled".
 * @param historyError when set, the eligibility lookup throws (DB failure).
 */
function freshServices({ historyRow = null, historyError = null } = {}) {
  [
    PRISMA_PATH,
    OBSERVABILITY_PATH,
    SHOPIFY_ADMIN_PATH,
    SUBSCRIPTION_SERVICE_PATH,
    TRIAL_ELIGIBILITY_PATH,
    APP_STATE_PATH,
    SHOPIFY_CONNECTION_PATH,
    ONBOARDING_PATH,
    DASHBOARD_PATH,
    READINESS_PATH,
    OPERATIONAL_PATH,
  ].forEach(resetModule);

  const prisma = require(PRISMA_PATH).prisma;
  const loggedEvents = [];
  require(OBSERVABILITY_PATH).logEvent = (level, event, details) => {
    loggedEvents.push({ level, event, details });
  };

  const shopifyAdminService = require(SHOPIFY_ADMIN_PATH);
  shopifyAdminService.getActiveAppSubscription = async () => null;
  shopifyAdminService.cancelAppSubscription = async () => ({});

  prisma.shopTrialHistory.findUnique = async () => {
    if (historyError) {
      throw historyError;
    }
    return historyRow;
  };

  const subscriptionService = require(SUBSCRIPTION_SERVICE_PATH);

  // Minimal stubs so getMerchantAppState can run without a database.
  const shopifyConnectionService = require(SHOPIFY_CONNECTION_PATH);
  shopifyConnectionService.getConnectionHealth = async () => ({
    code: "OK",
    healthy: true,
    message: "OK",
  });
  require(ONBOARDING_PATH).getOnboardingState = async () => ({
    canAccessDashboard: true,
    steps: [],
  });
  require(DASHBOARD_PATH).getDashboardMetrics = async () => ({
    dashboardState: { syncHealth: { status: "READY", title: "Synced", reason: "" } },
    lastRefreshedAt: new Date("2026-08-02T00:00:00.000Z").toISOString(),
  });
  require(READINESS_PATH).getUnifiedReadinessState = async () => ({
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
  require(OPERATIONAL_PATH).getStoreOperationalSnapshot = async () => ({
    counts: { orders: 1, products: 1, competitorDomains: 1, competitorRows: 1, pricingRows: 1, profitRows: 1 },
  });

  const appStateService = require(APP_STATE_PATH);
  return { prisma, subscriptionService, appStateService, loggedEvents };
}

function buildStore(overrides = {}) {
  return {
    id: "store-1",
    shop: SHOP,
    uninstalledAt: null,
    trialStartedAt: null,
    trialEndsAt: null,
    subscription: null,
    billingPlanIntents: [],
    ...overrides,
  };
}

function activeSubscription(planName, overrides = {}) {
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

function historyFor(window) {
  return { shop: SHOP, firstInstalledAt: window.trialStartedAt, ...window };
}

/**
 * Asserts copy never OFFERS a trial.
 *
 * Note the distinction: "Your free trial has already been used" mentions a free
 * trial but promises nothing, and is the correct ineligible wording. What must
 * never appear is an offer — a duration, a "start your trial" invitation, or the
 * "you will not be charged until the trial ends" reassurance.
 */
function assertNoTrialPromise(text, label) {
  assert.doesNotMatch(text, /7-day/i, `${label} must not advertise a trial duration`);
  assert.doesNotMatch(
    text,
    /start (your |a )?(\d+-day )?free trial/i,
    `${label} must not invite the merchant to start a trial`
  );
  assert.doesNotMatch(
    text,
    /not be charged until the trial ends/i,
    `${label} must not promise "not be charged until the trial ends"`
  );
  if (/free trial/i.test(text)) {
    assert.match(
      text,
      /free trial has already been used/i,
      `${label} may only reference a free trial to say it is already used`
    );
  }
}

// ===========================================================================
// 1. No ShopTrialHistory + no plan -> eligible, free-trial copy.
// ===========================================================================

test("no ShopTrialHistory + no plan: trialEligible=true and the free-trial copy is shown", async () => {
  const { prisma, subscriptionService } = freshServices({ historyRow: null });
  prisma.store.findUnique = async () => buildStore();

  const billing = await subscriptionService.resolveBillingState(SHOP);

  assert.equal(billing.trialEligible, true);
  assert.equal(billing.trialActive, false);
  assert.equal(billing.selectedPlanName, "NONE");
  assert.equal(billing.lifecycle, "no_subscription");
  assert.equal(billing.merchantTitle, "Choose a plan to start your 7-day free trial");
  assert.match(billing.merchantDescription, /not be charged until the trial ends/i);
});

// ===========================================================================
// 2. Expired ShopTrialHistory + no plan -> ineligible, no promise, View plans.
// ===========================================================================

test("expired ShopTrialHistory + no plan: trialEligible=false, no free-trial promise", async () => {
  const { prisma, subscriptionService } = freshServices({
    historyRow: historyFor(EXPIRED_TRIAL),
  });
  prisma.store.findUnique = async () => buildStore();

  const billing = await subscriptionService.resolveBillingState(SHOP);

  assert.equal(billing.trialEligible, false, "a spent trial makes the shop ineligible");
  assert.equal(billing.lifecycle, "no_subscription");
  assert.equal(billing.merchantTitle, "Choose a plan to activate VedaSuite");
  assert.equal(
    billing.merchantDescription,
    "Your free trial has already been used. Select a plan to continue using VedaSuite."
  );
  assertNoTrialPromise(billing.merchantTitle, "ineligible title");
});

// ===========================================================================
// 3. Active ShopTrialHistory + no plan -> ineligible (handled via trialActive).
// ===========================================================================

test("open ShopTrialHistory window: trialEligible=false — an in-flight trial is not a new one", async () => {
  const { prisma, subscriptionService } = freshServices({
    historyRow: historyFor(OPEN_TRIAL),
  });
  prisma.store.findUnique = async () => buildStore({ ...OPEN_TRIAL });

  const billing = await subscriptionService.resolveBillingState(SHOP);

  assert.equal(billing.trialEligible, false);
  assert.equal(billing.trialActive, true, "the running trial is reported via trialActive");
});

// ===========================================================================
// 4. Active STARTER/GROWTH/PRO trial -> ineligible + plan-specific trial copy.
// ===========================================================================

for (const plan of ["STARTER", "GROWTH", "PRO"]) {
  test(`active ${plan} trial: trialEligible=false and the ${plan} trial banner is shown`, async () => {
    const { prisma, subscriptionService } = freshServices({
      historyRow: historyFor(OPEN_TRIAL),
    });
    prisma.store.findUnique = async () =>
      buildStore({ ...OPEN_TRIAL, subscription: activeSubscription(plan) });

    const billing = await subscriptionService.resolveBillingState(SHOP);

    assert.equal(billing.trialEligible, false);
    assert.equal(billing.trialActive, true);
    assert.equal(billing.selectedPlanName, plan);
    const label = plan.charAt(0) + plan.slice(1).toLowerCase();
    assert.equal(billing.merchantTitle, `${label} trial active`);
    assert.equal(billing.showTrialDate, true);
    assert.ok(billing.trialDaysRemaining > 0);
  });
}

// ===========================================================================
// 5. Trial expired + active paid plan -> paid state, no trial copy.
// ===========================================================================

test("expired trial with an active paid plan: paid-plan state, no trial copy", async () => {
  const { prisma, subscriptionService } = freshServices({
    historyRow: historyFor(EXPIRED_TRIAL),
  });
  prisma.store.findUnique = async () =>
    buildStore({ ...EXPIRED_TRIAL, subscription: activeSubscription("PRO") });

  const billing = await subscriptionService.resolveBillingState(SHOP);

  assert.equal(billing.trialEligible, false);
  assert.equal(billing.trialActive, false);
  assert.equal(billing.selectedPlanName, "PRO");
  assert.equal(billing.accessActive, true);
  assert.equal(billing.merchantTitle, "PRO plan is active");
  assertNoTrialPromise(billing.merchantTitle, "paid-plan title");
  assertNoTrialPromise(billing.merchantDescription, "paid-plan description");
});

// ===========================================================================
// 6. Trial used + cancelled / no subscription -> no free-trial promise.
// ===========================================================================

test("trial used and subscription cancelled with access lapsed: no free-trial promise", async () => {
  const { prisma, subscriptionService } = freshServices({
    historyRow: historyFor(EXPIRED_TRIAL),
  });
  prisma.store.findUnique = async () =>
    buildStore({
      ...EXPIRED_TRIAL,
      subscription: activeSubscription("PRO", {
        active: false,
        billingStatus: "CANCELLED",
        endsAt: new Date("2026-02-01T00:00:00.000Z"),
      }),
    });

  const billing = await subscriptionService.resolveBillingState(SHOP);

  assert.equal(billing.trialEligible, false);
  assert.equal(billing.accessActive, false);
  assertNoTrialPromise(billing.merchantDescription, "cancelled description");
});

test("trial used and no subscription row at all: no free-trial promise", async () => {
  const { prisma, subscriptionService } = freshServices({
    historyRow: historyFor(EXPIRED_TRIAL),
  });
  prisma.store.findUnique = async () => buildStore({ ...EXPIRED_TRIAL });

  const billing = await subscriptionService.resolveBillingState(SHOP);

  assert.equal(billing.trialEligible, false);
  assertNoTrialPromise(billing.merchantTitle, "title");
  assertNoTrialPromise(billing.merchantDescription, "description");
});

// ===========================================================================
// 7. Reinstall after trial -> still ineligible (durable across Store deletion).
// ===========================================================================

test("reinstall after a trial: Store row is brand new but ShopTrialHistory survives, so trialEligible=false", async () => {
  // Models shop/redact-then-reinstall: ShopTrialHistory has no FK to Store, so
  // it outlives the purge. The fresh Store row has no trial dates at all —
  // exactly the state that previously produced a second trial offer.
  const { prisma, subscriptionService } = freshServices({
    historyRow: historyFor(EXPIRED_TRIAL),
  });
  prisma.store.findUnique = async () =>
    buildStore({ trialStartedAt: null, trialEndsAt: null, subscription: null });

  const billing = await subscriptionService.resolveBillingState(SHOP);

  assert.equal(
    billing.trialEligible,
    false,
    "a reinstall must not resurrect eligibility just because Store dates are gone"
  );
  assert.equal(billing.trialDatesIncomplete, true, "the fresh Store row genuinely has no dates");
  assert.equal(billing.merchantTitle, "Choose a plan to activate VedaSuite");
});

// ===========================================================================
// 8. Cross-surface consistency.
// ===========================================================================

for (const scenario of [
  { label: "eligible", historyRow: null, expected: true },
  { label: "ineligible", historyRow: historyFor(EXPIRED_TRIAL), expected: false },
]) {
  test(`cross-surface (${scenario.label}): resolveBillingState, getCurrentSubscription and app-state agree on trialEligible`, async () => {
    const { prisma, subscriptionService, appStateService } = freshServices({
      historyRow: scenario.historyRow,
    });
    prisma.store.findUnique = async () => buildStore();

    const billing = await subscriptionService.resolveBillingState(SHOP);
    const plan = await subscriptionService.getCurrentSubscription(SHOP);
    const appState = await appStateService.getMerchantAppState(SHOP);

    assert.equal(billing.trialEligible, scenario.expected);
    assert.equal(
      plan.trialEligible,
      scenario.expected,
      "/api/subscription/plan must carry the same value"
    );
    assert.equal(
      appState.billing.trialEligible,
      scenario.expected,
      "/api/app-state must carry the same value"
    );

    // And the copy the two surfaces render must agree too.
    assert.equal(appState.billing.title, billing.merchantTitle);
    assert.equal(appState.billing.description, billing.merchantDescription);
  });
}

// ===========================================================================
// 9. DB failure must never expose trialEligible=true.
// ===========================================================================

test("a ShopTrialHistory lookup failure fails CLOSED: trialEligible=false, never true, and is logged", async () => {
  const { prisma, subscriptionService, loggedEvents } = freshServices({
    historyError: new Error("Can't reach database server"),
  });
  prisma.store.findUnique = async () => buildStore();

  const billing = await subscriptionService.resolveBillingState(SHOP);

  assert.equal(
    billing.trialEligible,
    false,
    "a DB error must never be reported as eligible — that would promise a trial billing would refuse"
  );
  assertNoTrialPromise(billing.merchantTitle, "fail-closed title");
  assert.ok(
    loggedEvents.some((entry) => entry.event === "billing.trial_eligibility_check_failed"),
    "the eligibility lookup failure is logged"
  );
});

test("a ShopTrialHistory lookup failure does not throw the whole billing read", async () => {
  const { prisma, subscriptionService } = freshServices({
    historyError: new Error("Can't reach database server"),
  });
  prisma.store.findUnique = async () => buildStore({ subscription: activeSubscription("PRO") });

  // Billing must still resolve — an eligibility hiccup cannot break the page.
  const billing = await subscriptionService.resolveBillingState(SHOP);
  assert.equal(billing.selectedPlanName, "PRO");
  assert.equal(billing.trialEligible, false);
});

// ===========================================================================
// 10. Frontend copy contract.
//
// No frontend test runner is configured in frontend/package.json (scripts are
// dev/build/preview only, and there is no vitest/jest dependency), so these are
// the "equivalent assertions": they pin the exact rendered strings and, more
// importantly, that the components take eligibility as an input rather than
// re-deriving it from planName/trialActive — the inference that caused the bug.
// ===========================================================================

const FRONTEND = path.resolve(__dirname, "../../frontend/src");
const readFrontend = (relativePath) =>
  fs.readFileSync(path.join(FRONTEND, relativePath), "utf8");

test("frontend: the eligible choose-plan copy matches the specification exactly", () => {
  const source = readFrontend("components/billing/TrialStatus.tsx");

  assert.match(source, /title: "Choose a plan to start your 7-day free trial"/);
  assert.match(
    source,
    /body:\s*"Select STARTER, GROWTH or PRO and approve it in Shopify\. You will not be charged until the trial ends\."/
  );
  assert.match(source, /cta: "View plans \/ Start free trial"/);
});

test("frontend: the ineligible choose-plan copy matches the specification exactly", () => {
  const source = readFrontend("components/billing/TrialStatus.tsx");

  assert.match(source, /title: "Choose a plan to activate VedaSuite"/);
  assert.match(
    source,
    /body:\s*"Your free trial has already been used\. Select a plan to continue using VedaSuite\."/
  );
  assert.match(source, /cta: "View plans"/);
});

test("frontend: the ineligible branch contains no trial promise", () => {
  const source = readFrontend("components/billing/TrialStatus.tsx");

  // Isolate the ineligible return block: everything after the eligible branch's
  // closing brace inside choosePlanCopy.
  const start = source.indexOf('title: "Choose a plan to activate VedaSuite"');
  assert.ok(start > -1, "the ineligible branch exists");
  const block = source.slice(start, start + 400);

  assert.doesNotMatch(block, /7-day/i);
  assert.doesNotMatch(block, /Start free trial/i);
  assert.doesNotMatch(block, /not be charged until the trial ends/i);
});

test("frontend: choose-plan copy is driven by trialEligible only — gated on === true", () => {
  const source = readFrontend("components/billing/TrialStatus.tsx");

  // An explicit `=== true` check means undefined (stale/partial payload) falls
  // through to the ineligible copy rather than promising a trial.
  assert.match(
    source,
    /if \(trialEligible === true\)/,
    "eligibility must be an explicit true check, so undefined is treated as ineligible"
  );
  assert.match(source, /export function ChoosePlanCard\(\{[\s\S]{0,200}trialEligible/);
  assert.match(source, /export function ChoosePlanBanner\(\{[\s\S]{0,200}trialEligible/);
});

test("frontend: Onboarding and Dashboard pass the server-resolved trialEligible through", () => {
  for (const file of [
    "modules/Onboarding/OnboardingPage.tsx",
    "modules/Dashboard/DashboardPage.tsx",
  ]) {
    const source = readFrontend(file);
    assert.match(
      source,
      /trialEligible=\{appState\?\.billing\?\.trialEligible\}/,
      `${file} must pass billing.trialEligible straight through`
    );
  }
});

test("frontend: the active-trial copy still names the selected plan and its end date", () => {
  const source = readFrontend("components/billing/TrialStatus.tsx");

  assert.match(source, /\$\{plan\} trial active/, "plan-specific trial title is preserved");
  assert.match(source, /Trial ends \$\{formattedDate\}/, "the exact trial end date is preserved");
});

test("frontend: no surface promises a trial from planName/lifecycle alone", () => {
  // Every remaining "7-day"/"free trial" mention in the frontend must live in
  // TrialStatus.tsx's eligibility-gated resolver, not in a page that infers it.
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      const relative = path.relative(FRONTEND, full).replace(/\\/g, "/");
      if (relative === "components/billing/TrialStatus.tsx") continue;
      const source = fs.readFileSync(full, "utf8");
      for (const line of source.split(/\r?\n/)) {
        if (/7-day free trial|Start free trial/i.test(line)) {
          offenders.push(`${relative}: ${line.trim()}`);
        }
      }
    }
  };
  walk(FRONTEND);

  assert.deepEqual(
    offenders,
    [],
    `trial promises must live only in the eligibility-gated resolver:\n${offenders.join("\n")}`
  );
});

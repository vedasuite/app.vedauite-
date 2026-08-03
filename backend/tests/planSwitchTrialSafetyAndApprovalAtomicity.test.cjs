const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

process.env.SHOPIFY_API_KEY ||= "test-key";
process.env.SHOPIFY_API_SECRET ||= "test-secret";
process.env.SHOPIFY_APP_URL ||= "https://app.vedasuite.in";
process.env.DATABASE_URL ||= "postgresql://example:example@localhost:5432/example";
process.env.SHOPIFY_BILLING_TEST_MODE ||= "true";

/**
 * ISSUE 1 — plan changes during an active trial must never grant a fresh
 * trial NOR charge before the original trialEndsAt. Fixed by computing
 * Shopify's own trialDays for a replacement subscription from the WHOLE
 * remaining days of the shop's one durable trial window, not a flat 0.
 *
 * ISSUE 2 — Store.trialStartedAt/trialEndsAt/ShopTrialHistory must be
 * written only after Shopify confirms a genuinely approved (ACTIVE/ACCEPTED)
 * subscription — never on appSubscriptionCreate, confirmation-URL
 * generation, decline, or a still-PENDING status — and must be redirect-
 * independent (the webhook path alone must be able to grant it).
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

  [
    prismaPath,
    observabilityPath,
    shopifyAdminServicePath,
    subscriptionServicePath,
    billingManagementServicePath,
    trialEligibilityServicePath,
  ].forEach(resetModule);

  const prisma = require(prismaPath).prisma;
  const loggedEvents = [];
  require(observabilityPath).logEvent = (level, event, details) => {
    loggedEvents.push({ level, event, details });
  };

  const shopifyAdminService = require(shopifyAdminServicePath);
  shopifyAdminService.cancelAppSubscription = async () => ({});

  const subscriptionService = require(subscriptionServicePath);
  const billingManagementService = require(billingManagementServicePath);
  const trialEligibilityService = require(trialEligibilityServicePath);

  return { prisma, subscriptionService, billingManagementService, trialEligibilityService, shopifyAdminService, loggedEvents };
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

function mockIntentPlumbing(prisma) {
  let storedIntent = null;
  prisma.billingPlanIntent.findFirst = async () => null;
  prisma.subscriptionPlan.findUnique = async () => null;
  prisma.subscriptionPlan.create = async ({ data }) => ({ id: `plan-${data.name.toLowerCase()}`, ...data });
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
}

const TRIAL_START = new Date("2026-08-01T00:00:00.000Z");
const TRIAL_END = new Date("2026-08-08T00:00:00.000Z"); // 7 days

function historyFixture() {
  return {
    shop: "test-shop.myshopify.com",
    firstInstalledAt: TRIAL_START,
    trialStartedAt: TRIAL_START,
    trialEndsAt: TRIAL_END,
  };
}

// ---------------------------------------------------------------------------
// ISSUE 1 — plan-switch trialDays computation.
// ---------------------------------------------------------------------------

async function captureTrialDaysForSwitch({ requestedPlan, now, historyRow }) {
  const { prisma, billingManagementService, shopifyAdminService } = freshServices();
  prisma.shopTrialHistory.findUnique = async () => historyRow;
  mockIntentPlumbing(prisma);
  prisma.store.findUnique = async () =>
    buildStore({
      trialStartedAt: historyRow ? historyRow.trialStartedAt : null,
      trialEndsAt: historyRow ? historyRow.trialEndsAt : null,
      subscription: activeStoreSubscription(requestedPlan === "STARTER" ? "GROWTH" : "STARTER"),
    });

  let capturedTrialDays = null;
  shopifyAdminService.createAppSubscription = async (params) => {
    capturedTrialDays = params.trialDays;
    return { confirmationUrl: "https://shopify.test/confirm", appSubscription: { id: "gid://shopify/AppSubscription/new" } };
  };

  const originalNow = Date;
  // The route/service code never calls Date.now()/new Date() directly for
  // this computation except inside computeTrialState's default parameter —
  // pass `now` isn't wired through requestBillingPlanChange, so we rely on
  // the fact that this test runs "now" in real time. To make the day-N
  // scenarios deterministic regardless of the actual test-run date, we
  // instead vary the STORED trialEndsAt relative to the real current time.
  void originalNow;
  void now;

  await billingManagementService.requestBillingPlanChange({
    shopDomain: "test-shop.myshopify.com",
    requestedPlan,
    starterModule: requestedPlan === "STARTER" ? "fraud" : null,
    host: null,
    returnPath: "/app/billing",
  });

  return capturedTrialDays;
}

test("STARTER -> GROWTH on day 2 of a 7-day trial: replacement gets the whole remaining days, not 0", async () => {
  const now = Date.now();
  const historyRow = {
    shop: "test-shop.myshopify.com",
    firstInstalledAt: new Date(now - 2 * 24 * 60 * 60 * 1000),
    trialStartedAt: new Date(now - 2 * 24 * 60 * 60 * 1000), // started 2 days ago
    trialEndsAt: new Date(now + 5 * 24 * 60 * 60 * 1000), // 5 days left
  };
  const trialDays = await captureTrialDaysForSwitch({ requestedPlan: "GROWTH", historyRow });
  assert.equal(trialDays, 5, "must defer billing for exactly the whole remaining days, never a flat 0 or a fresh 7");
});

test("STARTER -> PRO on day 2 of a 7-day trial: same remaining days as any other destination plan", async () => {
  const now = Date.now();
  const historyRow = {
    shop: "test-shop.myshopify.com",
    firstInstalledAt: new Date(now - 2 * 24 * 60 * 60 * 1000),
    trialStartedAt: new Date(now - 2 * 24 * 60 * 60 * 1000),
    trialEndsAt: new Date(now + 5 * 24 * 60 * 60 * 1000),
  };
  const trialDays = await captureTrialDaysForSwitch({ requestedPlan: "PRO", historyRow });
  assert.equal(trialDays, 5, "the remaining-days computation is plan-independent — tied to the shop's history, not the destination plan");
});

test("PRO -> STARTER on day 2 of a 7-day trial: same remaining days, downgrading does not change the trial math", async () => {
  const now = Date.now();
  const historyRow = {
    shop: "test-shop.myshopify.com",
    firstInstalledAt: new Date(now - 2 * 24 * 60 * 60 * 1000),
    trialStartedAt: new Date(now - 2 * 24 * 60 * 60 * 1000),
    trialEndsAt: new Date(now + 5 * 24 * 60 * 60 * 1000),
  };
  const trialDays = await captureTrialDaysForSwitch({ requestedPlan: "STARTER", historyRow });
  assert.equal(trialDays, 5);
});

test("plan change on day 1 (a few hours in): remaining rounds up to the full 7, never charges early", async () => {
  const now = Date.now();
  const historyRow = {
    shop: "test-shop.myshopify.com",
    firstInstalledAt: new Date(now - 3 * 60 * 60 * 1000),
    trialStartedAt: new Date(now - 3 * 60 * 60 * 1000), // started 3 hours ago
    trialEndsAt: new Date(now + (7 * 24 - 3) * 60 * 60 * 1000), // ~6d21h remaining
  };
  const trialDays = await captureTrialDaysForSwitch({ requestedPlan: "GROWTH", historyRow });
  assert.equal(trialDays, 7, "ceil of ~6.9 remaining days is 7 — rounds UP, so Shopify defers at least as long as truly remains");
});

test("plan change on day 6 (a few hours before expiry): remaining rounds up to 1, never 0", async () => {
  const now = Date.now();
  const historyRow = {
    shop: "test-shop.myshopify.com",
    firstInstalledAt: new Date(now - 6 * 24 * 60 * 60 * 1000 - 21 * 60 * 60 * 1000),
    trialStartedAt: new Date(now - 6 * 24 * 60 * 60 * 1000 - 21 * 60 * 60 * 1000),
    trialEndsAt: new Date(now + 3 * 60 * 60 * 1000), // ~3 hours remaining
  };
  const trialDays = await captureTrialDaysForSwitch({ requestedPlan: "PRO", historyRow });
  assert.equal(trialDays, 1, "even a few hours remaining must round UP to 1 whole day, never down to 0 (which would charge immediately)");
});

test("plan change after the trial has already expired: bills immediately (0), no trial revival", async () => {
  const now = Date.now();
  const historyRow = {
    shop: "test-shop.myshopify.com",
    firstInstalledAt: new Date(now - 30 * 24 * 60 * 60 * 1000),
    trialStartedAt: new Date(now - 30 * 24 * 60 * 60 * 1000),
    trialEndsAt: new Date(now - 23 * 24 * 60 * 60 * 1000), // expired 23 days ago
  };
  const trialDays = await captureTrialDaysForSwitch({ requestedPlan: "GROWTH", historyRow });
  assert.equal(trialDays, 0);
});

test("a genuinely first-ever approval (no history at all) gets the full configured trialDays", async () => {
  const trialDays = await captureTrialDaysForSwitch({ requestedPlan: "STARTER", historyRow: null });
  assert.equal(trialDays, 7);
});

test("repeated switching cannot accumulate trial days — history is read-only during a plan switch, never extended", async () => {
  const now = Date.now();
  const historyRow = {
    shop: "test-shop.myshopify.com",
    firstInstalledAt: new Date(now - 2 * 24 * 60 * 60 * 1000),
    trialStartedAt: new Date(now - 2 * 24 * 60 * 60 * 1000),
    trialEndsAt: new Date(now + 5 * 24 * 60 * 60 * 1000),
  };
  const { prisma, billingManagementService, shopifyAdminService } = freshServices();
  let historyWriteAttempted = false;
  prisma.shopTrialHistory.findUnique = async () => historyRow;
  prisma.shopTrialHistory.create = async () => {
    historyWriteAttempted = true;
    throw new Error("requestBillingPlanChange must never write ShopTrialHistory");
  };
  mockIntentPlumbing(prisma);
  prisma.store.findUnique = async () =>
    buildStore({
      trialStartedAt: historyRow.trialStartedAt,
      trialEndsAt: historyRow.trialEndsAt,
      subscription: activeStoreSubscription("STARTER"),
    });

  const capturedTrialDaysCalls = [];
  shopifyAdminService.createAppSubscription = async (params) => {
    capturedTrialDaysCalls.push(params.trialDays);
    return { confirmationUrl: "https://shopify.test/confirm", appSubscription: { id: "gid://shopify/AppSubscription/x" } };
  };

  // Switch three times in a row. The store mock's "current plan" is fixed at
  // STARTER throughout (this test only cares about the trialDays computed
  // for each NEW request, not the actual plan-transition bookkeeping), so
  // every target here is deliberately something other than STARTER —
  // requesting the already-current plan would short-circuit as a NOOP
  // before ever calling createAppSubscription.
  for (const plan of ["GROWTH", "PRO", "GROWTH"]) {
    await billingManagementService.requestBillingPlanChange({
      shopDomain: "test-shop.myshopify.com",
      requestedPlan: plan,
      starterModule: null,
      host: null,
      returnPath: "/app/billing",
    });
  }

  assert.equal(historyWriteAttempted, false, "no switch may ever write trial history");
  assert.deepEqual(
    capturedTrialDaysCalls,
    [5, 5, 5],
    "every switch reads the SAME unmodified remaining-days figure — none can accumulate or extend it"
  );
});

// ---------------------------------------------------------------------------
// ISSUE 1 (continued) — the original trialEndsAt is never touched by a switch.
// ---------------------------------------------------------------------------
test("a plan switch mid-trial never writes Store.trialStartedAt/trialEndsAt or ShopTrialHistory", async () => {
  const now = Date.now();
  const historyRow = {
    shop: "test-shop.myshopify.com",
    firstInstalledAt: new Date(now - 2 * 24 * 60 * 60 * 1000),
    trialStartedAt: new Date(now - 2 * 24 * 60 * 60 * 1000),
    trialEndsAt: new Date(now + 5 * 24 * 60 * 60 * 1000),
  };
  const { prisma, billingManagementService, shopifyAdminService } = freshServices();
  prisma.shopTrialHistory.findUnique = async () => historyRow;
  prisma.shopTrialHistory.create = async () => {
    throw new Error("must not write history during a plan switch");
  };
  mockIntentPlumbing(prisma);
  const store = buildStore({
    trialStartedAt: historyRow.trialStartedAt,
    trialEndsAt: historyRow.trialEndsAt,
    subscription: activeStoreSubscription("STARTER"),
  });
  prisma.store.findUnique = async () => store;
  prisma.store.update = async () => {
    throw new Error("must not write Store trial fields during a plan switch");
  };
  shopifyAdminService.createAppSubscription = async () => ({
    confirmationUrl: "https://shopify.test/confirm",
    appSubscription: { id: "gid://shopify/AppSubscription/y" },
  });

  await billingManagementService.requestBillingPlanChange({
    shopDomain: "test-shop.myshopify.com",
    requestedPlan: "GROWTH",
    starterModule: null,
    host: null,
    returnPath: "/app/billing",
  });
  // No assertion needed beyond "did not throw" — the mocks above throw if
  // either write is attempted at all.
});

// ---------------------------------------------------------------------------
// ISSUE 2 — approval/trial-history atomicity.
// ---------------------------------------------------------------------------

test("appSubscriptionCreate / confirmation URL generation alone never writes trial dates", async () => {
  const { prisma, billingManagementService, shopifyAdminService } = freshServices();
  prisma.shopTrialHistory.findUnique = async () => null;
  prisma.shopTrialHistory.create = async () => {
    throw new Error("must not be called merely from requesting a plan change");
  };
  mockIntentPlumbing(prisma);
  const store = buildStore();
  prisma.store.findUnique = async () => store;
  prisma.store.update = async () => {
    throw new Error("must not write trial dates merely from requesting a plan change");
  };
  shopifyAdminService.createAppSubscription = async () => ({
    confirmationUrl: "https://shopify.test/confirm",
    appSubscription: { id: "gid://shopify/AppSubscription/z" },
  });

  const result = await billingManagementService.requestBillingPlanChange({
    shopDomain: "test-shop.myshopify.com",
    requestedPlan: "PRO",
    starterModule: null,
    host: null,
    returnPath: "/app/billing",
  });

  assert.equal(result.outcome, "REDIRECT_REQUIRED");
});

test("merchant declines approval: no trial dates written, no subscription reconciled", async () => {
  const { prisma, billingManagementService, shopifyAdminService } = freshServices();
  const store = buildStore();
  prisma.store.findUnique = async () => store;
  prisma.billingPlanIntent.findFirst = async () => null;
  prisma.store.update = async () => {
    throw new Error("decline must never write trial dates");
  };
  prisma.storeSubscription.upsert = async () => {
    throw new Error("decline must never reconcile a subscription");
  };
  shopifyAdminService.getActiveAppSubscription = async () => null; // declined/nothing approved

  await assert.rejects(
    () => billingManagementService.confirmBillingApprovalReturn({ shopDomain: "test-shop.myshopify.com", intentId: null }),
    /not approved/i
  );
});

test("a PENDING Shopify subscription status is not treated as approved — no trial, no reconciliation as active", async () => {
  const { prisma, billingManagementService, shopifyAdminService } = freshServices();
  const store = buildStore();
  prisma.store.findUnique = async () => store;
  prisma.billingPlanIntent.findFirst = async () => null;
  prisma.store.update = async () => {
    throw new Error("a merely-pending subscription must never write trial dates");
  };
  shopifyAdminService.getActiveAppSubscription = async () => ({
    id: "gid://shopify/AppSubscription/pending-1",
    name: "VedaSuite AI - PRO",
    status: "PENDING",
    currentPeriodEnd: null,
  });

  await assert.rejects(
    () => billingManagementService.confirmBillingApprovalReturn({ shopDomain: "test-shop.myshopify.com", intentId: null }),
    /not finished confirming/i
  );
});

test("reconcileStoreSubscriptionFromWebhook with status=PENDING never writes trial dates directly either", async () => {
  const { prisma, subscriptionService } = freshServices();
  const store = buildStore({ subscription: null });
  prisma.store.findUnique = async () => store;
  prisma.subscriptionPlan.findUnique = async () => null;
  prisma.subscriptionPlan.create = async ({ data }) => ({ id: "plan-pro", ...data });
  prisma.storeSubscription.upsert = async ({ create }) => ({ id: "subscription-new", ...create, plan: { name: "PRO" } });
  prisma.billingAuditLog.create = async () => ({ id: "audit-1" });
  let storeUpdateCalls = 0;
  prisma.store.update = async () => {
    storeUpdateCalls += 1;
    throw new Error("PENDING must never trigger a trial grant");
  };

  await subscriptionService.reconcileStoreSubscriptionFromWebhook({
    shopDomain: "test-shop.myshopify.com",
    shopifyChargeId: "gid://shopify/AppSubscription/pending-1",
    planName: "VedaSuite AI - PRO",
    status: "PENDING",
    currentPeriodEnd: null,
  });

  assert.equal(storeUpdateCalls, 0, "no trial-granting write may be attempted for a PENDING status");
});

test("approval succeeds but the return redirect is never completed: the webhook ALONE grants the trial", async () => {
  const { prisma, subscriptionService } = freshServices();
  const store = buildStore({ subscription: null }); // merchant never came back — nothing reconciled yet
  prisma.store.findUnique = async () => store;
  prisma.subscriptionPlan.findUnique = async () => null;
  prisma.subscriptionPlan.create = async ({ data }) => ({ id: "plan-pro", ...data });
  prisma.storeSubscription.upsert = async ({ create }) => ({ id: "subscription-new", ...create, plan: { name: "PRO" } });
  prisma.billingAuditLog.create = async () => ({ id: "audit-1" });
  prisma.shopTrialHistory.findUnique = async () => null;
  let grantedHistory = null;
  prisma.shopTrialHistory.create = async ({ data }) => {
    grantedHistory = { ...data };
    return grantedHistory;
  };
  let updatedTrialDates = null;
  prisma.store.update = async ({ data }) => {
    updatedTrialDates = data;
    return { ...store, ...data };
  };

  // This is EXACTLY what the app_subscriptions_update webhook handler calls
  // — no browser redirect (confirmBillingApprovalReturn) involved at all.
  await subscriptionService.reconcileStoreSubscriptionFromWebhook({
    shopDomain: "test-shop.myshopify.com",
    shopifyChargeId: "gid://shopify/AppSubscription/webhook-only",
    planName: "VedaSuite AI - PRO",
    status: "ACTIVE",
    currentPeriodEnd: null,
  });

  assert.ok(grantedHistory, "the trial must be granted from the webhook path alone");
  assert.ok(updatedTrialDates?.trialStartedAt);
  assert.ok(updatedTrialDates?.trialEndsAt);
});

test("duplicate return callbacks (same approval confirmed twice) do not create a second trial", async () => {
  const { prisma, subscriptionService } = freshServices();
  const store = buildStore({ subscription: null });
  prisma.store.findUnique = async () => store;
  prisma.subscriptionPlan.findUnique = async () => null;
  prisma.subscriptionPlan.create = async ({ data }) => ({ id: "plan-pro", ...data });
  prisma.storeSubscription.upsert = async ({ create }) => ({ id: "subscription-new", ...create, plan: { name: "PRO" } });
  prisma.billingAuditLog.create = async () => ({ id: "audit-1" });

  let historyRow = null;
  let createCalls = 0;
  prisma.shopTrialHistory.findUnique = async () => historyRow;
  prisma.shopTrialHistory.create = async ({ data }) => {
    createCalls += 1;
    historyRow = { ...data };
    return historyRow;
  };
  prisma.store.update = async ({ data }) => {
    Object.assign(store, data);
    return store;
  };

  const callback = () =>
    subscriptionService.reconcileStoreSubscriptionFromWebhook({
      shopDomain: "test-shop.myshopify.com",
      shopifyChargeId: "gid://shopify/AppSubscription/dup",
      planName: "VedaSuite AI - PRO",
      status: "ACTIVE",
      currentPeriodEnd: null,
    });

  await callback(); // first callback
  await callback(); // duplicate/replayed callback

  assert.equal(createCalls, 1, "history is created exactly once even when the confirmation fires twice");
});

test("two near-simultaneous approval confirmations (webhook and redirect racing) converge on one trial window", async () => {
  const { prisma, subscriptionService } = freshServices();
  const store = buildStore({ subscription: null });
  prisma.store.findUnique = async () => store;
  prisma.subscriptionPlan.findUnique = async () => null;
  prisma.subscriptionPlan.create = async ({ data }) => ({ id: "plan-pro", ...data });
  prisma.storeSubscription.upsert = async ({ create }) => ({ id: "subscription-new", ...create, plan: { name: "PRO" } });
  prisma.billingAuditLog.create = async () => ({ id: "audit-1" });

  let created = false;
  let winningWindow = null;
  prisma.shopTrialHistory.findUnique = async () => (created ? winningWindow : null);
  prisma.shopTrialHistory.create = async ({ data }) => {
    if (created) {
      const err = new Error("unique constraint");
      err.code = "P2002";
      throw err;
    }
    created = true;
    winningWindow = { ...data };
    return winningWindow;
  };
  prisma.store.update = async ({ data }) => {
    Object.assign(store, data);
    return store;
  };

  const call = () =>
    subscriptionService.reconcileStoreSubscriptionFromWebhook({
      shopDomain: "test-shop.myshopify.com",
      shopifyChargeId: "gid://shopify/AppSubscription/race",
      planName: "VedaSuite AI - PRO",
      status: "ACTIVE",
      currentPeriodEnd: null,
    });

  await Promise.all([call(), call()]);

  assert.ok(winningWindow, "exactly one window won the race");
});

/**
 * Builds a reconciliation harness whose trial-persistence layer fails the
 * first N times and then succeeds, so a failure followed by a Shopify
 * webhook REDELIVERY can be asserted end to end.
 */
function buildRetryHarness({ failMode, failTimes }) {
  const { prisma, subscriptionService, loggedEvents } = freshServices();
  const store = buildStore({ subscription: null });
  const upsertedSubscriptionIds = [];
  let historyRow = null;
  let historyCreateCalls = 0;
  let historyFailuresRemaining = failMode === "history" ? failTimes : 0;
  let storeUpdateFailuresRemaining = failMode === "storeDates" ? failTimes : 0;

  prisma.store.findUnique = async () => store;
  prisma.subscriptionPlan.findUnique = async () => null;
  prisma.subscriptionPlan.create = async ({ data }) => ({ id: "plan-pro", ...data });
  prisma.billingAuditLog.create = async () => ({ id: "audit-1" });

  // Idempotent upsert: one subscription row per store, re-applied on retry.
  prisma.storeSubscription.upsert = async ({ create }) => {
    upsertedSubscriptionIds.push("subscription-1");
    store.subscription = { id: "subscription-1", ...create, plan: { name: "PRO" } };
    return store.subscription;
  };

  prisma.shopTrialHistory.findUnique = async () => historyRow;
  prisma.shopTrialHistory.create = async ({ data }) => {
    if (historyFailuresRemaining > 0) {
      historyFailuresRemaining -= 1;
      throw new Error("simulated transient DB failure writing ShopTrialHistory");
    }
    historyCreateCalls += 1;
    historyRow = { ...data };
    return historyRow;
  };

  prisma.store.update = async ({ data }) => {
    if (storeUpdateFailuresRemaining > 0) {
      storeUpdateFailuresRemaining -= 1;
      throw new Error("simulated transient DB failure writing Store trial dates");
    }
    Object.assign(store, data);
    return store;
  };

  const deliverWebhook = () =>
    subscriptionService.reconcileStoreSubscriptionFromWebhook({
      shopDomain: "test-shop.myshopify.com",
      shopifyChargeId: "gid://shopify/AppSubscription/retry",
      planName: "VedaSuite AI - PRO",
      status: "ACTIVE",
      currentPeriodEnd: null,
    });

  return {
    deliverWebhook,
    store,
    loggedEvents,
    upsertedSubscriptionIds,
    getHistoryRow: () => historyRow,
    getHistoryCreateCalls: () => historyCreateCalls,
  };
}

test("ShopTrialHistory write fails once: the delivery FAILS (so Shopify retries) and the retry succeeds", async () => {
  const h = buildRetryHarness({ failMode: "history", failTimes: 1 });

  // First delivery must reject — a resolved (200) response here would tell
  // Shopify never to redeliver, permanently losing the merchant's trial.
  await assert.rejects(h.deliverWebhook, /ShopTrialHistory/);
  assert.equal(h.getHistoryRow(), null, "no trial recorded yet after the failure");
  assert.equal(h.store.trialStartedAt, null);

  // Shopify redelivers.
  const retried = await h.deliverWebhook();

  assert.equal(retried.id, "subscription-1", "retry reconciles the subscription");
  assert.ok(h.getHistoryRow(), "the trial is granted on retry");
  assert.ok(h.store.trialStartedAt, "Store trial dates persisted on retry");
  assert.ok(h.store.trialEndsAt);
  assert.equal(h.getHistoryCreateCalls(), 1, "granted exactly once across the failure + retry");
});

test("Store trial-date write fails once: the delivery FAILS (so Shopify retries) and the retry succeeds", async () => {
  const h = buildRetryHarness({ failMode: "storeDates", failTimes: 1 });

  await assert.rejects(h.deliverWebhook, /Store trial dates/);
  assert.equal(h.store.trialStartedAt, null, "Store trial dates not persisted after the failure");

  const retried = await h.deliverWebhook();

  assert.equal(retried.id, "subscription-1");
  assert.ok(h.store.trialStartedAt, "Store trial dates persisted on retry");
  assert.ok(h.store.trialEndsAt);
});

test("the subscription upsert stays idempotent across a failed delivery and its retry", async () => {
  const h = buildRetryHarness({ failMode: "history", failTimes: 1 });

  await assert.rejects(h.deliverWebhook);
  await h.deliverWebhook();

  // Upserted on both deliveries, but always converging on ONE row.
  assert.equal(h.upsertedSubscriptionIds.length, 2, "the upsert runs on both deliveries");
  assert.deepEqual(
    [...new Set(h.upsertedSubscriptionIds)],
    ["subscription-1"],
    "and always converges on a single subscription row — no duplicate subscriptions"
  );
});

test("trial is granted exactly once and trialEndsAt is never extended across many retries", async () => {
  const h = buildRetryHarness({ failMode: "history", failTimes: 1 });

  await assert.rejects(h.deliverWebhook);
  await h.deliverWebhook(); // grants
  const grantedEndsAt = h.store.trialEndsAt;

  // Several more redeliveries (Shopify can deliver the same event repeatedly).
  await h.deliverWebhook();
  await h.deliverWebhook();
  await h.deliverWebhook();

  assert.equal(h.getHistoryCreateCalls(), 1, "exactly one trial grant, ever");
  assert.equal(
    h.store.trialEndsAt.getTime(),
    grantedEndsAt.getTime(),
    "trialEndsAt is never extended by a repeated delivery"
  );
});

test("a permanently failing trial write keeps failing visibly — it is never silently accepted", async () => {
  const h = buildRetryHarness({ failMode: "history", failTimes: Number.MAX_SAFE_INTEGER });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await assert.rejects(h.deliverWebhook, /ShopTrialHistory/, `attempt ${attempt + 1} must still reject`);
  }

  assert.equal(h.getHistoryRow(), null, "no trial is ever fabricated");
  assert.ok(
    h.loggedEvents.some((e) => e.level === "error" && e.event === "billing.trial_grant_after_approval_failed"),
    "the failure is logged at error level for operator visibility"
  );
  assert.ok(
    h.loggedEvents.some(
      (e) => e.event === "billing.trial_grant_after_approval_failed" && e.details?.retryable === true
    ),
    "and is explicitly marked retryable so it is not mistaken for a terminal, accepted state"
  );
});

test("a Shopify lookup failure during the return callback propagates cleanly with nothing written", async () => {
  const { prisma, billingManagementService, shopifyAdminService } = freshServices();
  const store = buildStore();
  prisma.store.findUnique = async () => store;
  prisma.billingPlanIntent.findFirst = async () => null;
  let subscriptionUpsertCalls = 0;
  prisma.storeSubscription.upsert = async () => {
    subscriptionUpsertCalls += 1;
    return {};
  };
  shopifyAdminService.getActiveAppSubscription = async () => {
    throw new Error("Shopify API unreachable");
  };

  await assert.rejects(
    () => billingManagementService.confirmBillingApprovalReturn({ shopDomain: "test-shop.myshopify.com", intentId: null }),
    /unreachable/i
  );
  assert.equal(subscriptionUpsertCalls, 0, "a lookup failure must not reconcile anything");
});

test("forged/replayed callback parameters cannot fabricate an approval — only the live Shopify lookup counts", async () => {
  const { prisma, billingManagementService, shopifyAdminService } = freshServices();
  const store = buildStore();
  prisma.store.findUnique = async () => store;
  // A forged/mismatched intentId that doesn't correspond to any real intent.
  prisma.billingPlanIntent.findFirst = async () => null;
  prisma.storeSubscription.upsert = async ({ create }) => ({ id: "subscription-new", ...create, plan: { name: "PRO" } });
  prisma.subscriptionPlan.findUnique = async () => null;
  prisma.subscriptionPlan.create = async ({ data }) => ({ id: "plan-pro", ...data });
  prisma.billingAuditLog.create = async () => ({ id: "audit-1" });
  prisma.shopTrialHistory.findUnique = async () => null;
  prisma.shopTrialHistory.create = async ({ data }) => ({ ...data });
  prisma.store.update = async ({ data }) => ({ ...store, ...data });

  // The live, server-authenticated Shopify lookup is the ONLY source of
  // truth — it ignores whatever the (attacker-controlled) intentId/query
  // params claim, and ACTUALLY reflects what Shopify has approved.
  shopifyAdminService.getActiveAppSubscription = async () => ({
    id: "gid://shopify/AppSubscription/genuine",
    name: "VedaSuite AI - PRO",
    status: "ACTIVE",
    currentPeriodEnd: null,
  });

  const state = await billingManagementService.confirmBillingApprovalReturn({
    shopDomain: "test-shop.myshopify.com",
    intentId: "forged-or-nonexistent-intent-id",
  });

  // Reconciliation proceeds based on the live lookup, not the forged param.
  assert.ok(state);
});

test("the stored Shopify subscription ID is the exact approved/active one, never a merely-pending or declined one", async () => {
  const { prisma, subscriptionService } = freshServices();
  const store = buildStore({ subscription: null });
  prisma.store.findUnique = async () => store;
  prisma.subscriptionPlan.findUnique = async () => null;
  prisma.subscriptionPlan.create = async ({ data }) => ({ id: "plan-pro", ...data });
  let upsertedChargeId = null;
  prisma.storeSubscription.upsert = async ({ create }) => {
    upsertedChargeId = create.shopifyChargeId;
    return { id: "subscription-new", ...create, plan: { name: "PRO" } };
  };
  prisma.billingAuditLog.create = async () => ({ id: "audit-1" });
  prisma.shopTrialHistory.findUnique = async () => null;
  prisma.shopTrialHistory.create = async ({ data }) => ({ ...data });
  prisma.store.update = async () => ({});

  await subscriptionService.reconcileStoreSubscriptionFromWebhook({
    shopDomain: "test-shop.myshopify.com",
    shopifyChargeId: "gid://shopify/AppSubscription/the-approved-one",
    planName: "VedaSuite AI - PRO",
    status: "ACTIVE",
    currentPeriodEnd: null,
  });

  assert.equal(upsertedChargeId, "gid://shopify/AppSubscription/the-approved-one");
});

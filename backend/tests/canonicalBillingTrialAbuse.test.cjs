const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

process.env.SHOPIFY_API_KEY ||= "test-key";
process.env.SHOPIFY_API_SECRET ||= "test-secret";
process.env.SHOPIFY_APP_URL ||= "https://app.vedasuite.in";
process.env.DATABASE_URL ||= "postgresql://example:example@localhost:5432/example";
process.env.SHOPIFY_BILLING_TEST_MODE ||= "true";

function resetModule(modulePath) {
  const resolved = require.resolve(modulePath);
  delete require.cache[resolved];
}

function freshSubscriptionService() {
  const prismaPath = path.resolve(__dirname, "../dist/db/prismaClient.js");
  const observabilityPath = path.resolve(__dirname, "../dist/services/observabilityService.js");
  const shopifyAdminServicePath = path.resolve(__dirname, "../dist/services/shopifyAdminService.js");
  const servicePath = path.resolve(__dirname, "../dist/services/subscriptionService.js");

  resetModule(prismaPath);
  resetModule(observabilityPath);
  resetModule(shopifyAdminServicePath);
  resetModule(servicePath);

  const prisma = require(prismaPath).prisma;
  require(observabilityPath).logEvent = () => {};
  const shopifyAdminService = require(shopifyAdminServicePath);
  // Default: no live Shopify subscription to reconcile — most tests care
  // about persisted DB state, not the Shopify-reconciliation branch.
  shopifyAdminService.getActiveAppSubscription = async () => null;
  shopifyAdminService.cancelAppSubscription = async () => ({});

  const service = require(servicePath);
  return { prisma, service, shopifyAdminService };
}

/** Builds a fake Store row (with the shape storeWithSubscriptionArgs expects). */
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

function buildSubscription(planName, overrides = {}) {
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
const NOW_DURING_TRIAL = new Date("2026-08-03T00:00:00.000Z");

// ---------------------------------------------------------------------------
// 1. No subscription + trial open. Under the plan-selected model this
// shouldn't arise from any live code path (trial dates aren't set until a
// plan is approved) — it's tested defensively for legacy/edge-case data.
// The raw trialActive flag is still date-only and true, but with no plan
// selected there is nothing to grant access to.
// ---------------------------------------------------------------------------
test("no subscription + trial open: trialActive=true (date-only), but no plan means no access tier granted", async () => {
  const { prisma, service } = freshSubscriptionService();
  prisma.store.findUnique = async () => buildStore({ ...OPEN_TRIAL });

  const billing = await service.resolveBillingState("test-shop.myshopify.com");

  assert.equal(billing.trialActive, true);
  assert.equal(billing.showTrialDate, true);
  assert.equal(billing.selectedPlanName, "NONE");
  assert.equal(billing.accessTier, "none", "no plan selected means no tier is granted, even with an open trial date");

  // accessActive alone (date-only OR-condition) does not itself unlock any
  // core module — buildCanonicalEntitlements separately refuses to grant
  // access without a selected plan (see entitlementMatrix.test.cjs).
  // ("settings" is always true regardless of plan, so it's excluded here.)
  const subscription = await service.getCurrentSubscription("test-shop.myshopify.com");
  assert.equal(subscription.enabledModules.fraud, false);
  assert.equal(subscription.enabledModules.competitor, false);
  assert.equal(subscription.enabledModules.pricingProfit, false);
  assert.equal(subscription.enabledModules.profit, false);
});

// ---------------------------------------------------------------------------
// 2. STARTER/GROWTH/PRO active subscription + trial open — the fixed bug.
// ---------------------------------------------------------------------------
for (const plan of ["STARTER", "GROWTH", "PRO"]) {
  test(`${plan} selected, active Shopify subscription, trial still open: trialActive=true and showTrialDate=true (bug regression)`, async () => {
    const { prisma, service } = freshSubscriptionService();
    prisma.store.findUnique = async () =>
      buildStore({ ...OPEN_TRIAL, subscription: buildSubscription(plan) });

    const billing = await service.resolveBillingState("test-shop.myshopify.com");

    assert.equal(billing.trialActive, true, `${plan}: trial must still be reported active`);
    assert.equal(billing.showTrialDate, true, `${plan}: trial date must still be shown`);
    assert.equal(
      billing.selectedPlanName,
      plan,
      `${plan}: the selected paid plan must be preserved for display`
    );
    assert.equal(
      billing.accessTier,
      plan.toLowerCase(),
      `${plan}: access tier is the SELECTED plan's own tier — the trial does not widen it`
    );
    assert.match(billing.merchantTitle, /trial/i, `${plan}: merchant copy must mention the trial, not "plan is active"`);
    assert.match(billing.merchantTitle, new RegExp(plan, "i"), `${plan}: merchant copy must name the selected plan`);

    // The full end-to-end payload the frontend actually reads.
    const subscription = await service.getCurrentSubscription("test-shop.myshopify.com");
    assert.equal(subscription.trialActive, true);
    assert.equal(subscription.planName, plan);
    assert.equal(subscription.status, "trial_active");
    // Plan-selected trial model: only the SELECTED plan's modules unlock.
    if (plan === "PRO") {
      assert.equal(subscription.enabledModules.pricingProfit, true);
      assert.equal(subscription.enabledModules.profit, true);
    } else if (plan === "GROWTH") {
      assert.equal(subscription.enabledModules.pricingProfit, true);
      assert.equal(subscription.enabledModules.profit, false, "Growth trial never includes full Profit Optimization");
    } else {
      // STARTER trial unlocks only the selected Starter module (fraud, per buildSubscription).
      assert.equal(subscription.enabledModules.fraud, true);
      assert.equal(subscription.enabledModules.competitor, false);
      assert.equal(subscription.enabledModules.pricingProfit, false);
      assert.equal(subscription.enabledModules.profit, false);
    }
  });
}

// ---------------------------------------------------------------------------
// 3. Paid subscription + trial expired
// ---------------------------------------------------------------------------
test("paid subscription + trial expired: trialActive=false, normal plan entitlements apply", async () => {
  const { prisma, service } = freshSubscriptionService();
  prisma.store.findUnique = async () =>
    buildStore({ ...EXPIRED_TRIAL, subscription: buildSubscription("GROWTH") });

  const billing = await service.resolveBillingState("test-shop.myshopify.com");

  assert.equal(billing.trialActive, false);
  assert.equal(billing.showTrialDate, false);
  assert.equal(billing.selectedPlanName, "GROWTH");
  assert.equal(billing.accessTier, "growth");
  assert.equal(billing.accessActive, true);
});

// ---------------------------------------------------------------------------
// 4. No subscription + trial expired
// ---------------------------------------------------------------------------
test("no subscription + trial expired: trialActive=false, no_subscription/inactive", async () => {
  const { prisma, service } = freshSubscriptionService();
  prisma.store.findUnique = async () => buildStore({ ...EXPIRED_TRIAL });

  const billing = await service.resolveBillingState("test-shop.myshopify.com");

  assert.equal(billing.trialActive, false);
  assert.equal(billing.accessActive, false);
  assert.equal(billing.selectedPlanName, "NONE");
  assert.equal(billing.lifecycle, "no_subscription");
});

// ---------------------------------------------------------------------------
// GET paths are read-only — never write trial dates.
// ---------------------------------------------------------------------------
test("resolveBillingState and getCurrentSubscription never write to Store, even with missing trial dates", async () => {
  const { prisma, service } = freshSubscriptionService();
  let storeUpdateCalls = 0;
  prisma.store.findUnique = async () => buildStore(); // no trial dates at all
  prisma.store.update = async () => {
    storeUpdateCalls += 1;
    throw new Error("read paths must never call prisma.store.update");
  };

  const billing = await service.resolveBillingState("test-shop.myshopify.com");
  assert.equal(billing.trialActive, false);
  assert.equal(billing.trialDatesIncomplete, true);
  assert.equal(billing.trialStartedAt, null);
  assert.equal(billing.trialEndsAt, null);

  await service.getCurrentSubscription("test-shop.myshopify.com");
  await service.resolveEntitlements("test-shop.myshopify.com");

  assert.equal(storeUpdateCalls, 0, "no read path may write trial dates — missing dates must not become now+7");
});

// ---------------------------------------------------------------------------
// Dashboard / Onboarding / Billing parity — every surface reads the same
// canonical trial state.
// ---------------------------------------------------------------------------
test("resolveBillingState (Billing/app-state) and resolveEntitlements (Dashboard/Onboarding) agree on trial status for the same persisted data", async () => {
  const { prisma, service } = freshSubscriptionService();
  prisma.store.findUnique = async () =>
    buildStore({ ...OPEN_TRIAL, subscription: buildSubscription("PRO") });

  const billing = await service.resolveBillingState("test-shop.myshopify.com");
  const entitlements = await service.resolveEntitlements("test-shop.myshopify.com");

  assert.equal(billing.trialActive, entitlements.trialActive);
  assert.equal(billing.trialEndsAt, entitlements.trialEndsAt);
  assert.equal(billing.trialDaysRemaining, entitlements.trialDaysRemaining);
});

// ---------------------------------------------------------------------------
// Shopify reconciliation failure must not create/extend/reactivate anything.
// ---------------------------------------------------------------------------
test("a Shopify reconciliation failure leaves persisted trial and subscription state untouched", async () => {
  const { prisma, service, shopifyAdminService } = freshSubscriptionService();
  prisma.store.findUnique = async () => buildStore({ ...OPEN_TRIAL }); // no active DB subscription
  shopifyAdminService.getActiveAppSubscription = async () => {
    throw new Error("Shopify API unreachable");
  };
  let storeUpdateCalls = 0;
  prisma.store.update = async () => {
    storeUpdateCalls += 1;
    throw new Error("must not write on a reconciliation failure");
  };
  let subscriptionUpsertCalls = 0;
  prisma.storeSubscription.upsert = async () => {
    subscriptionUpsertCalls += 1;
    throw new Error("must not create/extend a subscription on reconciliation failure");
  };

  const billing = await service.resolveBillingState("test-shop.myshopify.com");

  assert.equal(storeUpdateCalls, 0);
  assert.equal(subscriptionUpsertCalls, 0);
  // Trial state is completely unaffected by the reconciliation failure —
  // it is derived purely from persisted dates.
  assert.equal(billing.trialActive, true);
  assert.equal(billing.selectedPlanName, "NONE");
});

// ---------------------------------------------------------------------------
// Plan downgrade/cancellation must not grant a new trial.
// ---------------------------------------------------------------------------
test("downgradeToTrial cancels the paid plan but never resets or grants trial dates", async () => {
  const { prisma, service } = freshSubscriptionService();
  const store = buildStore({ ...EXPIRED_TRIAL, subscription: buildSubscription("GROWTH", { shopifyChargeId: null }) });
  prisma.store.findUnique = async () => store;
  // Reflects the real Prisma behavior: once the subscription row is deleted,
  // a subsequent findUnique for this store returns subscription: null.
  prisma.storeSubscription.delete = async () => {
    store.subscription = null;
    return {};
  };
  prisma.billingAuditLog.create = async () => ({ id: "audit-1" });

  let storeUpdateCalls = 0;
  prisma.store.update = async (args) => {
    storeUpdateCalls += 1;
    if (args?.data && ("trialStartedAt" in args.data || "trialEndsAt" in args.data)) {
      throw new Error("downgrade must never write trial dates");
    }
    return store;
  };

  const result = await service.downgradeToTrial("test-shop.myshopify.com");

  assert.equal(storeUpdateCalls, 0, "downgrade must not touch the Store row's trial fields at all");
  assert.equal(result.trialActive, false, "the already-expired trial stays expired — no new trial granted");
  assert.equal(result.planName, "NONE");
});

test("downgradeToTrial during a still-open trial correctly leaves the open trial visible (not reset, not extended)", async () => {
  const { prisma, service } = freshSubscriptionService();
  const store = buildStore({ ...OPEN_TRIAL, subscription: buildSubscription("STARTER", { shopifyChargeId: null }) });
  prisma.store.findUnique = async () => store;
  prisma.storeSubscription.delete = async () => {
    store.subscription = null;
    return {};
  };
  prisma.billingAuditLog.create = async () => ({ id: "audit-1" });
  prisma.store.update = async () => {
    throw new Error("must never write trial dates on downgrade");
  };

  const result = await service.downgradeToTrial("test-shop.myshopify.com");

  assert.equal(result.trialActive, true, "the pre-existing open trial window is untouched, not reset");
  assert.equal(result.trialEndsAt, OPEN_TRIAL.trialEndsAt.toISOString());
});

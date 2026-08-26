const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

process.env.SHOPIFY_API_KEY ||= "test-key";
process.env.SHOPIFY_API_SECRET ||= "test-secret";
process.env.SHOPIFY_APP_URL ||= "https://app.vedasuite.in";
process.env.DATABASE_URL ||= "postgresql://example:example@localhost:5432/example";
process.env.SHOPIFY_BILLING_TEST_MODE ||= "true";

/**
 * UNINSTALL -> REINSTALL, ON THE SAME SHOP.
 *
 * TWO OBSERVED BEHAVIOURS, ONE BUG AND ONE POLICY.
 *
 * 1. BUG. Onboarding said "Trial active" and "Your selected features are
 *    active" while the sidebar showed Upgrade on every module.
 *
 *    The uninstall webhook deactivates StoreSubscription — the Shopify
 *    subscription really is cancelled — but deliberately leaves
 *    `trialStartedAt`/`trialEndsAt` alone, because a reinstall must never mint
 *    a second trial. Reinstall clears `uninstalledAt`. The shop is then left
 *    with an OPEN TRIAL WINDOW and `selectedPlanName: "NONE"`.
 *
 *    `trialActive` is a DATE-ONLY fact by design, and stays true — that is what
 *    makes re-approval resume the remaining days. `accessActive` means "inside
 *    a paid-or-trial window" and also stays true. Neither is wrong.
 *
 *    What was wrong: the UI built a claim about FEATURES out of those facts.
 *    `trialPlanSentence` answered the no-plan case with "Your selected features
 *    are active", and the trial card/banner gated on `trialActive` alone while
 *    their own comments assumed it implied an approved plan.
 *
 * 2. POLICY, NOT A BUG. Reconciliation history survived the reinstall. Uninstall
 *    is deliberately not a deletion event: Shopify's shop/redact (~48h later)
 *    erases the Store row and everything cascading from it, and a retention
 *    sweep is the backstop if that webhook never arrives. These tests pin that
 *    policy down so it cannot be eroded by accident, and prove the retained data
 *    is bound to exactly one Shopify shop.
 */

const d = (p) => path.resolve(__dirname, `../dist/${p}`);
const src = (p) => fs.readFileSync(path.resolve(__dirname, `../src/${p}`), "utf8");
const SCHEMA = fs.readFileSync(
  path.resolve(__dirname, "../prisma/schema.prisma"),
  "utf8"
);

function resetModule(modulePath) {
  delete require.cache[require.resolve(modulePath)];
}

function freshSubscriptionService() {
  const prismaPath = d("db/prismaClient.js");
  const observabilityPath = d("services/observabilityService.js");
  const shopifyAdminServicePath = d("services/shopifyAdminService.js");
  const servicePath = d("services/subscriptionService.js");

  [prismaPath, observabilityPath, shopifyAdminServicePath, servicePath].forEach(resetModule);

  const prisma = require(prismaPath).prisma;
  require(observabilityPath).logEvent = () => {};

  prisma.shopTrialHistory.findUnique = async () => {
    const store = await prisma.store.findUnique({
      where: { shop: "test-shop.myshopify.com" },
    });
    if (!store?.trialStartedAt || !store?.trialEndsAt) return null;
    return {
      shop: store.shop,
      firstInstalledAt: store.trialStartedAt,
      trialStartedAt: store.trialStartedAt,
      trialEndsAt: store.trialEndsAt,
    };
  };

  const shopifyAdminService = require(shopifyAdminServicePath);
  shopifyAdminService.getActiveAppSubscription = async () => null;
  shopifyAdminService.cancelAppSubscription = async () => ({});

  return { prisma, service: require(servicePath) };
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
/** Day 3 of 7 — open, and far from both edges. */
const OPEN_TRIAL = {
  trialStartedAt: new Date(NOW - 2 * MS_PER_DAY),
  trialEndsAt: new Date(NOW + 5 * MS_PER_DAY),
};

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

/**
 * The subscription row exactly as the uninstall webhook leaves it: the plan is
 * still recorded, but it is cancelled and no longer active.
 */
function uninstalledSubscription(planName = "GROWTH") {
  return {
    id: "subscription-1",
    storeId: "store-1",
    starterModule: null,
    shopifyChargeId: "gid://shopify/AppSubscription/1",
    active: false,
    billingStatus: "UNINSTALLED",
    cancelledAt: new Date(NOW - MS_PER_DAY),
    endsAt: null,
    lastBillingSyncAt: new Date(NOW - MS_PER_DAY),
    plan: { id: "plan-growth", name: planName, trialDays: 7 },
  };
}

function activeSubscription(planName = "GROWTH") {
  return {
    id: "subscription-1",
    storeId: "store-1",
    starterModule: planName === "STARTER" ? "fraud" : null,
    shopifyChargeId: "gid://shopify/AppSubscription/1",
    active: true,
    billingStatus: "ACTIVE",
    endsAt: null,
    lastBillingSyncAt: new Date(NOW - MS_PER_DAY),
    plan: { id: `plan-${planName.toLowerCase()}`, name: planName, trialDays: 7 },
  };
}

// ===========================================================================
// A. THE TRIAL / UPGRADE CONTRADICTION
// ===========================================================================

test("REGRESSION: after reinstall, featuresActive is false while the trial window is open", async () => {
  const { prisma, service } = freshSubscriptionService();
  // Exactly the post-reinstall state: uninstalledAt cleared, trial dates kept,
  // subscription cancelled by the uninstall webhook.
  prisma.store.findUnique = async () =>
    buildStore({ ...OPEN_TRIAL, uninstalledAt: null, subscription: uninstalledSubscription() });

  const billing = await service.resolveBillingState("test-shop.myshopify.com");

  // The date-only facts are unchanged — that contract is deliberate and is what
  // stops a reinstall minting a second trial.
  assert.equal(billing.trialActive, true, "the window really is still open");
  assert.equal(billing.selectedPlanName, "NONE", "the Shopify subscription is gone");

  // The new fact, and the one any claim about features must be built from.
  assert.equal(
    billing.featuresActive,
    false,
    "no plan is attached, so no feature is usable"
  );

  const subscription = await service.getCurrentSubscription("test-shop.myshopify.com");
  assert.equal(subscription.enabledModules.fraud, false);
  assert.equal(subscription.enabledModules.competitor, false);
  assert.equal(subscription.enabledModules.pricingProfit, false);
  assert.equal(subscription.enabledModules.profit, false);
});

test("featuresActive is true exactly when a plan really is active", async () => {
  for (const plan of ["STARTER", "GROWTH", "PRO"]) {
    const { prisma, service } = freshSubscriptionService();
    prisma.store.findUnique = async () =>
      buildStore({ ...OPEN_TRIAL, subscription: activeSubscription(plan) });

    const billing = await service.resolveBillingState("test-shop.myshopify.com");
    assert.equal(billing.featuresActive, true, `${plan}: features must be usable`);
    assert.equal(billing.trialActive, true, `${plan}: trial still reported active`);
    assert.equal(billing.selectedPlanName, plan);
  }
});

test("INVARIANT: featuresActive is never true while every module is locked", async () => {
  const cases = [
    { name: "reinstall, trial open, no plan", store: { ...OPEN_TRIAL, subscription: uninstalledSubscription() } },
    { name: "no trial, no plan", store: {} },
    { name: "trial open, no subscription row at all", store: { ...OPEN_TRIAL } },
    { name: "active plan", store: { ...OPEN_TRIAL, subscription: activeSubscription("GROWTH") } },
  ];

  for (const c of cases) {
    const { prisma, service } = freshSubscriptionService();
    prisma.store.findUnique = async () => buildStore(c.store);

    const billing = await service.resolveBillingState("test-shop.myshopify.com");
    const subscription = await service.getCurrentSubscription("test-shop.myshopify.com");
    // `enabledModules.settings` is true on every plan, so it is not evidence
    // that anything paid is unlocked. Only the core modules answer that.
    const anyModule = ["fraud", "competitor", "pricingProfit", "profit"].some(
      (key) => subscription.enabledModules[key] === true
    );

    assert.equal(
      billing.featuresActive,
      anyModule,
      `${c.name}: featuresActive must track whether anything is actually unlocked`
    );
  }
});

test("plan NONE can never unlock a module", () => {
  const caps = require(d("billing/capabilities.js"));
  for (const trialActive of [true, false]) {
    const resolved = caps.resolveEntitlements({
      plan: "NONE",
      billingStatus: "UNINSTALLED",
      starterModule: null,
      trialActive,
    });
    assert.deepEqual(
      resolved.enabledModules,
      [],
      `trialActive=${trialActive}: NONE must unlock nothing`
    );
  }
});

test("no surface claims active features without a plan", () => {
  // Both the Onboarding/Dashboard trial copy and the Billing page carried the
  // same fallback. Strip comments first: this file's own explanation of the old
  // copy is not a rendering of it.
  const withoutComments = (text) =>
    text
      .split("\n")
      .filter((line) => {
        const t = line.trim();
        return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
      })
      .join("\n");

  for (const file of [
    "../../frontend/src/components/billing/TrialStatus.tsx",
    "../../frontend/src/modules/SubscriptionPlans/PricingPage.tsx",
  ]) {
    const ui = withoutComments(src(file));
    assert.ok(
      !/Your selected features are active/.test(ui),
      `${file}: the no-plan branch must not claim features are active`
    );
    assert.match(
      ui,
      /Choose a plan to activate your features/,
      `${file}: must tell the merchant what to do instead`
    );
  }
});

test("the trial card and banner require a real plan, not just an open window", () => {
  const ui = src("../../frontend/src/components/billing/TrialStatus.tsx");
  // Both components gate on trialActive; each must ALSO require a plan, because
  // trialActive is date-only and outlives the plan after an uninstall.
  const guards = ui.match(/if \(!selectedPaidPlan\(data\.planName\)\) return null;/g) ?? [];
  assert.equal(
    guards.length,
    2,
    "TrialStatusCard and TrialStatusBanner must each require a real plan"
  );
});

// ===========================================================================
// B. THE RETENTION POLICY — INTENDED, AND BOUND TO ONE SHOP
// ===========================================================================

test("POLICY: uninstall revokes Shopify access", () => {
  const webhook = src("routes/shopifyWebhookRoutes.ts");
  // Tokens are destroyed, not merely marked stale.
  assert.match(webhook, /accessToken: null/);
  assert.match(webhook, /refreshToken: null/);
  assert.match(webhook, /uninstalledAt: new Date\(\)/);

  // And the connection resolver refuses to act on an uninstalled store even if
  // a token somehow survived.
  const conn = src("services/shopifyConnectionService.ts");
  assert.match(conn, /if \(installation\.uninstalledAt\) \{[\s\S]{0,200}?"UNINSTALLED"/);
  assert.match(conn, /if \(!installation\.accessToken\) \{[\s\S]{0,200}?"MISSING_OFFLINE_TOKEN"/);
});

test("POLICY: uninstall preserves trial dates, so reinstall cannot mint a second trial", () => {
  const webhook = src("routes/shopifyWebhookRoutes.ts");
  const uninstallBlock = webhook.slice(webhook.indexOf("await tx.store.update("));

  for (const field of ["trialStartedAt", "trialEndsAt"]) {
    assert.ok(
      !uninstallBlock.slice(0, 1200).includes(field),
      `uninstall must not clear ${field} — that is what stops a second trial`
    );
  }

  // The install path preserves them explicitly rather than by omission.
  const auth = src("routes/authRoutes.ts");
  assert.match(auth, /const trialStartedAt = existingStore\?\.trialStartedAt \?\? null;/);
  assert.match(auth, /const trialEndsAt = existingStore\?\.trialEndsAt \?\? null;/);
});

test("POLICY: uninstall is not a deletion event", () => {
  const webhook = src("routes/shopifyWebhookRoutes.ts");
  const uninstallBlock = webhook.slice(
    webhook.indexOf("async function handleAppUninstalled"),
    webhook.indexOf("async function handleCustomersDataRequest")
  );

  // Merchant data must survive: deletion happens on shop/redact, or via the
  // retention sweep if that webhook never arrives.
  for (const model of [
    "reconciliationSource",
    "reconciliationRun",
    "reconciliationDiscrepancy",
    "intelligenceFinding",
    "order",
    "customer",
  ]) {
    assert.ok(
      !new RegExp(`${model}\\.delete`).test(uninstallBlock),
      `uninstall must not delete ${model} — retention is governed by shop/redact`
    );
  }
});

test("POLICY: shop/redact erases retained data through the Store cascade", () => {
  // deleteStoreCompletely removes the Store row; everything merchant-owned must
  // cascade from it, or a redact would leave orphans behind.
  const privacy = src("services/privacyService.ts");
  assert.match(privacy, /prisma\.store\.deleteMany\(/);
  assert.match(privacy, /deleteStoreCompletely\(store\.id, "shop_redact"\)/);

  for (const model of [
    "ReconciliationSource",
    "ReconciliationRun",
    "ReconciliationDiscrepancy",
    "ReconciliationRecord",
    "IntelligenceFinding",
  ]) {
    const block = SCHEMA.slice(SCHEMA.indexOf(`model ${model} {`));
    const body = block.slice(0, block.indexOf("\n}"));
    assert.match(
      body,
      /onDelete: Cascade/,
      `${model} must cascade from Store so shop/redact really erases it`
    );
  }
});

test("POLICY: retained data is bound to exactly one Shopify shop", () => {
  // A shop domain is unique, and reinstall matches on it. A different store is
  // a different Store row and therefore a different storeId.
  const storeBlock = SCHEMA.slice(SCHEMA.indexOf("model Store {"));
  assert.match(
    storeBlock.slice(0, storeBlock.indexOf("\n}")),
    /shop\s+String\s+@unique/,
    "Store.shop must be unique — it is the reinstall identity"
  );

  const auth = src("routes/authRoutes.ts");
  assert.match(
    auth,
    /prisma\.store\.upsert\(\{\s*where: \{ shop: params\.shop \}/,
    "reinstall must match the existing store by shop domain"
  );

  // Every reconciliation table carries a denormalized storeId, so no query has
  // to rely on a join to stay inside one merchant.
  for (const model of [
    "ReconciliationSource",
    "ReconciliationRun",
    "ReconciliationDiscrepancy",
    "ReconciliationRecord",
  ]) {
    const block = SCHEMA.slice(SCHEMA.indexOf(`model ${model} {`));
    const body = block.slice(0, block.indexOf("\n}"));
    assert.match(body, /storeId\s+String/, `${model} must carry its own storeId`);
  }
});

test("POLICY: reinstall performs a fresh authorization and a fresh sync", () => {
  const auth = src("routes/authRoutes.ts");
  const update = auth.slice(auth.indexOf("    update: {"), auth.indexOf("  });", auth.indexOf("    update: {")));

  // A brand new token from the OAuth exchange, and the uninstall flag cleared.
  assert.match(update, /accessToken: params\.accessToken/);
  assert.match(update, /grantedScopes: params\.grantedScopes/);
  assert.match(update, /uninstalledAt: null/);
  assert.match(update, /reauthorizedAt: params\.reauthorizedAt/);

  // Webhooks re-registered and a sync re-run — the uninstall webhook had set
  // both to UNINSTALLED, and a stale value there would suppress the fresh work.
  assert.match(update, /lastWebhookRegistrationStatus: "PENDING"/);
  assert.match(update, /lastSyncStatus: "PENDING"/);

  // Onboarding restarts, so a returning merchant is walked through setup again.
  assert.match(update, /onboardingCompletedAt: null/);
});

test("POLICY: the retention sweep never touches a live install", () => {
  const retention = src("services/dataRetentionService.ts");
  // Only uninstalled stores are candidates...
  assert.match(retention, /uninstalledAt: \{ not: null, lt: cutoff \}/);
  // ...and the deletion path re-checks, so a store that reinstalled between the
  // scan and the delete is skipped rather than erased.
  const privacy = src("services/privacyService.ts");
  assert.match(privacy, /skipped_active_install/);
});

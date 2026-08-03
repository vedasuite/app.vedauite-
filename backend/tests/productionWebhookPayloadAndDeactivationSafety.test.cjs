const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const crypto = require("node:crypto");
const express = require("express");

process.env.SHOPIFY_API_KEY ||= "test-key";
process.env.SHOPIFY_API_SECRET ||= "test-secret";
process.env.SHOPIFY_APP_URL ||= "https://app.vedasuite.in";
process.env.DATABASE_URL ||= "postgresql://example:example@localhost:5432/example";
process.env.SHOPIFY_BILLING_TEST_MODE ||= "true";

/**
 * PRODUCTION REGRESSION — a fresh merchant approved PRO, PRO briefly appeared
 * active, then the trial vanished and the plan fell back to NONE.
 *
 * Two defects combined:
 *
 *   1. PARSER. Shopify nests every app_subscriptions/update field under an
 *      "app_subscription" key. The handler read admin_graphql_api_id / name /
 *      status from the TOP level, so all three were undefined on every real
 *      delivery (matching the production log: subscriptionId=null, status=null,
 *      planName=null).
 *
 *   2. UNSAFE FALLBACK. A missing status defaulted to "INACTIVE", and an
 *      inactive event that could not be matched to the stored subscription
 *      deactivated it "anyway" — wiping the just-approved PRO to NONE.
 *
 * These tests pin both the real payload shape and the rule that an
 * unverifiable or incomplete webhook may never mutate billing state.
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
const ROUTE_PATH = path.resolve(__dirname, "../dist/routes/shopifyWebhookRoutes.js");

const CHARGE_PRO = "gid://shopify/AppSubscription/pro-2";
const CHARGE_OTHER = "gid://shopify/AppSubscription/starter-1";
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function activeProSubscription(chargeId = CHARGE_PRO) {
  return {
    id: "subscription-1",
    storeId: "store-1",
    planId: "plan-pro",
    starterModule: null,
    shopifyChargeId: chargeId,
    active: true,
    billingStatus: "ACTIVE",
    endsAt: null,
    lastBillingSyncAt: new Date("2026-08-01T00:00:00.000Z"),
    plan: { id: "plan-pro", name: "PRO", trialDays: 7 },
  };
}

/**
 * Mutable in-memory world. `liveShopifySubscription` is what the Shopify Admin
 * API reports for the shop — the authoritative source the recovery path reads.
 */
function buildWorld({
  existingSubscription = null,
  trialDates = null,
  liveShopifySubscription = null,
  shopifyLookupError = null,
} = {}) {
  [
    PRISMA_PATH,
    OBSERVABILITY_PATH,
    SHOPIFY_ADMIN_PATH,
    SUBSCRIPTION_SERVICE_PATH,
    TRIAL_ELIGIBILITY_PATH,
  ].forEach(resetModule);

  const prisma = require(PRISMA_PATH).prisma;
  const loggedEvents = [];
  require(OBSERVABILITY_PATH).logEvent = (level, event, details) => {
    loggedEvents.push({ level, event, details });
  };

  const shopifyAdminService = require(SHOPIFY_ADMIN_PATH);
  let shopifyLookupCalls = 0;
  shopifyAdminService.getActiveAppSubscription = async () => {
    shopifyLookupCalls += 1;
    if (shopifyLookupError) {
      throw shopifyLookupError;
    }
    return liveShopifySubscription;
  };
  shopifyAdminService.cancelAppSubscription = async () => ({});

  const subscriptionService = require(SUBSCRIPTION_SERVICE_PATH);

  const store = {
    id: "store-1",
    shop: "test-shop.myshopify.com",
    uninstalledAt: null,
    trialStartedAt: trialDates?.trialStartedAt ?? null,
    trialEndsAt: trialDates?.trialEndsAt ?? null,
    subscription: existingSubscription,
    billingPlanIntents: [],
  };

  const storeUpdates = [];
  prisma.store.findUnique = async () => store;
  prisma.store.update = async ({ data }) => {
    storeUpdates.push(data);
    Object.assign(store, data);
    return store;
  };
  prisma.subscriptionPlan.findUnique = async ({ where }) => ({
    id: `plan-${where.name.toLowerCase()}`,
    name: where.name,
    trialDays: 7,
  });
  prisma.billingAuditLog.create = async () => ({ id: "audit-1" });

  let historyRow = trialDates
    ? { shop: store.shop, firstInstalledAt: trialDates.trialStartedAt, ...trialDates }
    : null;
  prisma.shopTrialHistory.findUnique = async () => historyRow;
  prisma.shopTrialHistory.create = async ({ data }) => {
    historyRow = { ...data };
    return historyRow;
  };

  const subscriptionWrites = [];
  prisma.storeSubscription.upsert = async ({ update, create }) => {
    subscriptionWrites.push({ kind: "upsert", data: store.subscription ? update : create });
    const base = store.subscription
      ? { ...store.subscription, ...update }
      : { id: "subscription-1", ...create };
    store.subscription = {
      ...base,
      plan: {
        id: base.planId,
        name: base.planId.replace("plan-", "").toUpperCase(),
        trialDays: 7,
      },
    };
    return store.subscription;
  };
  prisma.storeSubscription.update = async ({ data }) => {
    subscriptionWrites.push({ kind: "update", data });
    store.subscription = { ...store.subscription, ...data };
    return store.subscription;
  };

  const deliver = (input) =>
    subscriptionService.reconcileStoreSubscriptionFromWebhook({
      shopDomain: store.shop,
      shopifyChargeId: input.chargeId ?? null,
      planName: input.planName ?? null,
      status: input.status ?? null,
      currentPeriodEnd: input.currentPeriodEnd ?? null,
    });

  return {
    store,
    deliver,
    loggedEvents,
    subscriptionWrites,
    storeUpdates,
    subscriptionService,
    getHistoryRow: () => historyRow,
    getShopifyLookupCalls: () => shopifyLookupCalls,
    hasEvent: (name) => loggedEvents.some((entry) => entry.event === name),
  };
}

// ===========================================================================
// THE ROOT CAUSE: the real nested Shopify payload must be parsed correctly.
// ===========================================================================

function buildWebhookHmac(rawBody, secret) {
  return crypto.createHmac("sha256", secret).update(rawBody).digest("base64");
}

function httpPost(server, pathname, { body, headers }) {
  const address = server.address();
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port: address.port, path: pathname, method: "POST", headers },
      (res) => {
        let responseBody = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (responseBody += chunk));
        res.on("end", () => resolve({ statusCode: res.statusCode, body: responseBody }));
      }
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function signedDelivery(payload) {
  const rawBody = JSON.stringify(payload);
  return {
    body: rawBody,
    headers: {
      "Content-Type": "application/json",
      "x-shopify-shop-domain": "test-shop.myshopify.com",
      "x-shopify-hmac-sha256": buildWebhookHmac(rawBody, process.env.SHOPIFY_API_SECRET),
    },
  };
}

/** Route server whose reconcile call is captured, to inspect what was parsed. */
async function buildCapturingServer() {
  resetModule(SUBSCRIPTION_SERVICE_PATH);
  const captured = [];
  require(SUBSCRIPTION_SERVICE_PATH).reconcileStoreSubscriptionFromWebhook = async (input) => {
    captured.push(input);
    return { id: "subscription-1" };
  };

  resetModule(ROUTE_PATH);
  const { shopifyWebhookRouter } = require(ROUTE_PATH);

  const app = express();
  app.use("/webhooks/shopify", express.raw({ type: "application/json" }));
  app.use("/webhooks/shopify", shopifyWebhookRouter);
  return { server: app.listen(0), captured };
}

/**
 * The exact documented app_subscriptions/update payload shape.
 * https://shopify.dev/docs/api/webhooks — every field nested under
 * "app_subscription".
 */
function realShopifyPayload({ status = "ACTIVE", name = "VedaSuite AI - PRO", id = CHARGE_PRO } = {}) {
  return {
    app_subscription: {
      admin_graphql_api_id: id,
      name,
      status,
      admin_graphql_api_shop_id: "gid://shopify/Shop/548380009",
      created_at: "2026-08-03T19:00:00-05:00",
      updated_at: "2026-08-03T19:00:00-05:00",
      currency: "USD",
      capped_amount: "20.0",
    },
  };
}

test("REGRESSION: the real nested app_subscription payload yields a non-null id, status and plan name", async () => {
  // This is the defect that caused the outage. Before the fix these three were
  // read from the top level and every one arrived as null.
  const { server, captured } = await buildCapturingServer();

  try {
    const response = await httpPost(
      server,
      "/webhooks/shopify/app_subscriptions_update",
      signedDelivery(realShopifyPayload({ status: "ACTIVE" }))
    );

    assert.equal(response.statusCode, 200);
    assert.equal(captured.length, 1);
    assert.equal(
      captured[0].shopifyChargeId,
      CHARGE_PRO,
      "the subscription GID must be read from the nested app_subscription object"
    );
    assert.equal(captured[0].status, "ACTIVE", "status must not be null");
    assert.equal(captured[0].planName, "VedaSuite AI - PRO", "plan name must not be null");
  } finally {
    server.close();
  }
});

test("a flat (non-nested) payload still parses, so no delivery shape regresses to null", async () => {
  const { server, captured } = await buildCapturingServer();

  try {
    await httpPost(
      server,
      "/webhooks/shopify/app_subscriptions_update",
      signedDelivery({
        admin_graphql_api_id: CHARGE_PRO,
        name: "VedaSuite AI - PRO",
        status: "ACTIVE",
      })
    );

    assert.equal(captured[0].shopifyChargeId, CHARGE_PRO);
    assert.equal(captured[0].status, "ACTIVE");
    assert.equal(captured[0].planName, "VedaSuite AI - PRO");
  } finally {
    server.close();
  }
});

test("the safe diagnostic log records payload keys and detected fields, never the raw payload", async () => {
  // Rebuild the route against a world so logEvent is captured.
  const world = buildWorld();
  resetModule(ROUTE_PATH);
  const { shopifyWebhookRouter } = require(ROUTE_PATH);
  const app = express();
  app.use("/webhooks/shopify", express.raw({ type: "application/json" }));
  app.use("/webhooks/shopify", shopifyWebhookRouter);
  const server = app.listen(0);

  try {
    await httpPost(
      server,
      "/webhooks/shopify/app_subscriptions_update",
      signedDelivery(realShopifyPayload({ status: "ACTIVE" }))
    );

    const diagnostic = world.loggedEvents.find(
      (entry) => entry.event === "webhook.app_subscription_payload_parsed"
    );
    assert.ok(diagnostic, "a safe diagnostic log is emitted");
    assert.deepEqual(diagnostic.details.topLevelKeys, ["app_subscription"]);
    assert.ok(diagnostic.details.nestedKeys.includes("admin_graphql_api_id"));
    assert.equal(diagnostic.details.usedNestedObject, true);
    assert.equal(diagnostic.details.detectedSubscriptionId, CHARGE_PRO);
    assert.equal(diagnostic.details.detectedStatus, "ACTIVE");
    assert.equal(diagnostic.details.detectedPlanName, "VedaSuite AI - PRO");

    // Only keys and the three detected billing fields — no raw payload blob.
    assert.deepEqual(
      Object.keys(diagnostic.details).sort(),
      [
        "detectedPlanName",
        "detectedStatus",
        "detectedSubscriptionId",
        "nestedKeys",
        "shop",
        "topLevelKeys",
        "usedNestedObject",
      ],
      "the diagnostic must not carry the complete payload"
    );
  } finally {
    server.close();
  }
});

test("END TO END: the production scenario — approving PRO saves PRO and creates the 7-day trial", async () => {
  // Real route -> real reconcile -> mocked prisma, with the real nested payload.
  const world = buildWorld();

  resetModule(ROUTE_PATH);
  const { shopifyWebhookRouter } = require(ROUTE_PATH);
  const app = express();
  app.use("/webhooks/shopify", express.raw({ type: "application/json" }));
  app.use("/webhooks/shopify", shopifyWebhookRouter);
  const server = app.listen(0);

  try {
    const response = await httpPost(
      server,
      "/webhooks/shopify/app_subscriptions_update",
      signedDelivery(realShopifyPayload({ status: "ACTIVE" }))
    );

    assert.equal(response.statusCode, 200);
    assert.equal(world.store.subscription.plan.name, "PRO", "PRO is saved, not NONE");
    assert.equal(world.store.subscription.active, true);
    assert.equal(world.store.subscription.billingStatus, "ACTIVE");

    assert.ok(world.store.trialStartedAt, "the trial window is created");
    assert.ok(world.store.trialEndsAt, "trialEndsAt is set, not left unset");
    const days = Math.round(
      (world.store.trialEndsAt.getTime() - world.store.trialStartedAt.getTime()) / MS_PER_DAY
    );
    assert.equal(days, 7, "exactly a 7-day window");

    const billing = await world.subscriptionService.resolveBillingState("test-shop.myshopify.com");
    assert.equal(billing.selectedPlanName, "PRO");
    assert.equal(billing.trialActive, true, "the trial is visible, not disappeared");
    assert.equal(billing.accessActive, true);
  } finally {
    server.close();
  }
});

// ===========================================================================
// DEACTIVATION SAFETY — the required decision matrix.
// ===========================================================================

test("existing PRO ACTIVE + inactive webhook with a null charge id: PRO remains active", async () => {
  const world = buildWorld({
    existingSubscription: activeProSubscription(),
    liveShopifySubscription: null,
  });

  await world.deliver({ status: "CANCELLED", planName: "VedaSuite AI - PRO", chargeId: null });

  assert.equal(world.store.subscription.active, true, "must not deactivate on an unverifiable match");
  assert.equal(world.store.subscription.plan.name, "PRO");
  assert.equal(world.store.subscription.billingStatus, "ACTIVE");
  assert.ok(
    world.hasEvent("billing.webhook_inactive_ignored_unverifiable"),
    "the refusal is logged under the required event name"
  );
  assert.equal(
    world.hasEvent("billing.webhook_inactive_unverified_charge"),
    false,
    "the old deactivate-anyway event must no longer be emitted"
  );
  assert.equal(
    world.subscriptionWrites.length,
    0,
    "no subscription write occurs for an unverifiable inactive webhook"
  );
});

test("existing PRO ACTIVE + all-null webhook (id, status, plan): no billing-state mutation at all", async () => {
  // This is the exact production payload after the parser defect.
  const world = buildWorld({
    existingSubscription: activeProSubscription(),
    liveShopifySubscription: null,
  });

  await world.deliver({ status: null, planName: null, chargeId: null });

  assert.equal(world.store.subscription.active, true);
  assert.equal(world.store.subscription.plan.name, "PRO");
  assert.equal(world.subscriptionWrites.length, 0, "nothing is written");
  assert.equal(world.storeUpdates.length, 0, "Store is not touched either");
  assert.ok(
    world.hasEvent("billing.webhook_incomplete_ignored"),
    "a missing status is reported as incomplete, never inferred as INACTIVE"
  );
});

test("an incomplete webhook must never save plan NONE", async () => {
  const world = buildWorld({
    existingSubscription: activeProSubscription(),
    liveShopifySubscription: null,
  });

  await world.deliver({ status: null, planName: null, chargeId: null });

  const savedNone = world.loggedEvents.some(
    (entry) => entry.event === "billing.subscription_saved" && entry.details?.savedPlan === "NONE"
  );
  assert.equal(savedNone, false, "billing.subscription_saved with NONE must never be emitted");
  assert.notEqual(world.store.subscription.plan.name, "NONE");
});

test("existing PRO ACTIVE + stale CANCELLED webhook for a different charge id: PRO remains active", async () => {
  const world = buildWorld({ existingSubscription: activeProSubscription(CHARGE_PRO) });

  await world.deliver({
    status: "CANCELLED",
    planName: "VedaSuite AI - STARTER",
    chargeId: CHARGE_OTHER,
  });

  assert.equal(world.store.subscription.active, true);
  assert.equal(world.store.subscription.plan.name, "PRO");
  assert.ok(world.hasEvent("billing.webhook_inactive_ignored_stale_charge"));
  assert.equal(world.subscriptionWrites.length, 0);
});

test("existing PRO ACTIVE + MATCHING CANCELLED webhook: only then is it deactivated", async () => {
  const world = buildWorld({ existingSubscription: activeProSubscription(CHARGE_PRO) });

  await world.deliver({
    status: "CANCELLED",
    planName: "VedaSuite AI - PRO",
    chargeId: CHARGE_PRO,
  });

  assert.equal(world.store.subscription.active, false, "a positively matched cancel does deactivate");
  assert.equal(world.store.subscription.billingStatus, "CANCELLED");
  assert.ok(
    world.subscriptionWrites.some((write) => write.kind === "update"),
    "the deactivating write happened"
  );
});

test("a matching CANCELLED webhook with a future period end keeps access until that date", async () => {
  const world = buildWorld({ existingSubscription: activeProSubscription(CHARGE_PRO) });
  const futureEnd = new Date(Date.now() + 10 * MS_PER_DAY);

  await world.deliver({
    status: "CANCELLED",
    planName: "VedaSuite AI - PRO",
    chargeId: CHARGE_PRO,
    currentPeriodEnd: futureEnd.toISOString(),
  });

  assert.equal(
    world.store.subscription.active,
    true,
    "a cancellation with a paid-through date retains access until it lapses"
  );
});

// ===========================================================================
// LIVE SHOPIFY RECOVERY — requirement 8.
// ===========================================================================

test("incomplete webhook + live Shopify lookup reporting ACTIVE PRO: PRO stays active and the trial is preserved", async () => {
  const trialStartedAt = new Date(Date.now() - 2 * MS_PER_DAY);
  const trialEndsAt = new Date(Date.now() + 5 * MS_PER_DAY);

  const world = buildWorld({
    existingSubscription: activeProSubscription(),
    trialDates: { trialStartedAt, trialEndsAt },
    liveShopifySubscription: {
      id: CHARGE_PRO,
      name: "VedaSuite AI - PRO",
      status: "ACTIVE",
      createdAt: "2026-08-03T00:00:00.000Z",
      currentPeriodEnd: null,
    },
  });

  await world.deliver({ status: null, planName: null, chargeId: null });

  assert.equal(world.getShopifyLookupCalls(), 1, "the live authoritative lookup ran");
  assert.ok(world.hasEvent("billing.webhook_live_reconciliation_applied"));
  assert.equal(world.store.subscription.active, true);
  assert.equal(world.store.subscription.plan.name, "PRO");

  // The original window is preserved exactly — never restarted or extended.
  assert.equal(world.store.trialStartedAt.getTime(), trialStartedAt.getTime());
  assert.equal(world.store.trialEndsAt.getTime(), trialEndsAt.getTime());

  const billing = await world.subscriptionService.resolveBillingState("test-shop.myshopify.com");
  assert.equal(billing.selectedPlanName, "PRO");
  assert.equal(billing.trialActive, true);
});

test("incomplete webhook + live lookup reporting PENDING: nothing is activated", async () => {
  const world = buildWorld({
    liveShopifySubscription: {
      id: CHARGE_PRO,
      name: "VedaSuite AI - PRO",
      status: "PENDING",
      createdAt: "2026-08-03T00:00:00.000Z",
      currentPeriodEnd: null,
    },
  });

  await world.deliver({ status: null, planName: null, chargeId: null });

  assert.equal(world.store.subscription, null, "a PENDING live subscription never activates");
  assert.equal(world.getHistoryRow(), null, "and never grants a trial");
});

test("incomplete webhook + unreachable Shopify: local state is left untouched, not corrupted", async () => {
  const world = buildWorld({
    existingSubscription: activeProSubscription(),
    shopifyLookupError: new Error("Shopify unreachable"),
  });

  await world.deliver({ status: null, planName: null, chargeId: null });

  assert.equal(world.store.subscription.active, true, "a failed lookup must not deactivate anything");
  assert.equal(world.store.subscription.plan.name, "PRO");
  assert.ok(world.hasEvent("billing.webhook_live_reconciliation_failed"));
  assert.equal(world.subscriptionWrites.length, 0);
});

test("an APPROVED webhook whose plan name cannot be resolved recovers from Shopify instead of leaving PRO unattributed", async () => {
  const world = buildWorld({
    existingSubscription: activeProSubscription(),
    liveShopifySubscription: {
      id: CHARGE_PRO,
      name: "VedaSuite AI - PRO",
      status: "ACTIVE",
      createdAt: "2026-08-03T00:00:00.000Z",
      currentPeriodEnd: null,
    },
  });

  await world.deliver({ status: "ACTIVE", planName: "Some Unrecognised Name", chargeId: CHARGE_PRO });

  assert.ok(world.hasEvent("billing.webhook_approved_unresolved_plan"));
  assert.equal(world.getShopifyLookupCalls(), 1);
  assert.equal(world.store.subscription.active, true);
  assert.equal(world.store.subscription.plan.name, "PRO");
});

// ===========================================================================
// IDEMPOTENCY
// ===========================================================================

test("duplicate ACTIVE deliveries remain idempotent: one plan, one trial, unchanged trialEndsAt", async () => {
  const world = buildWorld();

  await world.deliver({ status: "ACTIVE", planName: "VedaSuite AI - PRO", chargeId: CHARGE_PRO });
  const firstEndsAt = world.store.trialEndsAt.getTime();

  for (let i = 0; i < 3; i += 1) {
    await world.deliver({ status: "ACTIVE", planName: "VedaSuite AI - PRO", chargeId: CHARGE_PRO });
  }

  assert.equal(world.store.subscription.plan.name, "PRO");
  assert.equal(world.store.subscription.active, true);
  assert.equal(
    world.store.trialEndsAt.getTime(),
    firstEndsAt,
    "redelivery must never extend the trial"
  );
});

test("duplicate unverifiable inactive deliveries converge on 'no change'", async () => {
  const world = buildWorld({
    existingSubscription: activeProSubscription(),
    liveShopifySubscription: null,
  });

  for (let i = 0; i < 3; i += 1) {
    await world.deliver({ status: "EXPIRED", planName: null, chargeId: null });
  }

  assert.equal(world.store.subscription.active, true);
  assert.equal(world.store.subscription.plan.name, "PRO");
  assert.equal(world.subscriptionWrites.length, 0);
});

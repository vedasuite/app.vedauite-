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
 * ISSUE 2 — a PENDING Shopify subscription (created, but not yet approved by
 * the merchant) must never become locally active, and an inactive event for an
 * OLD subscription must never deactivate the newer one that replaced it.
 *
 * Also covers the webhook route contract that makes ISSUE 1's recovery real:
 * the app_subscriptions_update delivery answers 200 only when reconciliation
 * genuinely succeeded, and 500 (so Shopify redelivers) when it did not.
 */

function resetModule(modulePath) {
  const resolved = require.resolve(modulePath);
  delete require.cache[resolved];
}

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

function freshServices() {
  const prismaPath = path.resolve(__dirname, "../dist/db/prismaClient.js");
  const observabilityPath = path.resolve(__dirname, "../dist/services/observabilityService.js");
  const shopifyAdminServicePath = path.resolve(__dirname, "../dist/services/shopifyAdminService.js");
  const subscriptionServicePath = path.resolve(__dirname, "../dist/services/subscriptionService.js");
  const trialEligibilityServicePath = path.resolve(__dirname, "../dist/services/trialEligibilityService.js");

  [
    prismaPath,
    observabilityPath,
    shopifyAdminServicePath,
    subscriptionServicePath,
    trialEligibilityServicePath,
  ].forEach(resetModule);

  const prisma = require(prismaPath).prisma;
  const loggedEvents = [];
  const realLogEvent = require(observabilityPath).logEvent;
  require(observabilityPath).logEvent = (level, event, details) => {
    loggedEvents.push({ level, event, details });
  };
  void realLogEvent;

  const shopifyAdminService = require(shopifyAdminServicePath);
  shopifyAdminService.getActiveAppSubscription = async () => null;
  shopifyAdminService.cancelAppSubscription = async () => ({});

  const subscriptionService = require(subscriptionServicePath);
  return { prisma, subscriptionService, shopifyAdminService, loggedEvents };
}

const CHARGE_STARTER = "gid://shopify/AppSubscription/starter-1";
const CHARGE_PRO = "gid://shopify/AppSubscription/pro-2";

/**
 * A mutable in-memory store + subscription, so a sequence of webhook
 * deliveries can be replayed against evolving state the way production does.
 */
function buildWorld({ existingSubscription = null, trialDates = null } = {}) {
  const { prisma, subscriptionService, loggedEvents } = freshServices();

  const store = {
    id: "store-1",
    shop: "test-shop.myshopify.com",
    uninstalledAt: null,
    trialStartedAt: trialDates?.trialStartedAt ?? null,
    trialEndsAt: trialDates?.trialEndsAt ?? null,
    subscription: existingSubscription,
    billingPlanIntents: [],
  };

  prisma.store.findUnique = async () => store;
  prisma.store.update = async ({ data }) => {
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

  prisma.storeSubscription.upsert = async ({ update, create }) => {
    const base = store.subscription
      ? { ...store.subscription, ...update }
      : { id: "subscription-1", ...create };
    store.subscription = {
      ...base,
      plan: { id: base.planId, name: base.planId.replace("plan-", "").toUpperCase(), trialDays: 7 },
    };
    return store.subscription;
  };
  prisma.storeSubscription.update = async ({ data }) => {
    store.subscription = { ...store.subscription, ...data };
    return store.subscription;
  };

  const deliver = ({ status, planName, chargeId, currentPeriodEnd = null }) =>
    subscriptionService.reconcileStoreSubscriptionFromWebhook({
      shopDomain: store.shop,
      shopifyChargeId: chargeId,
      planName,
      status,
      currentPeriodEnd,
    });

  return { store, deliver, loggedEvents, getHistoryRow: () => historyRow, subscriptionService };
}

function activeSubscriptionRow(planName, chargeId) {
  return {
    id: "subscription-1",
    storeId: "store-1",
    planId: `plan-${planName.toLowerCase()}`,
    starterModule: planName === "STARTER" ? "fraud" : null,
    shopifyChargeId: chargeId,
    active: true,
    billingStatus: "ACTIVE",
    endsAt: null,
    lastBillingSyncAt: new Date("2026-08-01T00:00:00.000Z"),
    plan: { id: `plan-${planName.toLowerCase()}`, name: planName, trialDays: 7 },
  };
}

// ---------------------------------------------------------------------------
// Case: no existing subscription + PENDING
// ---------------------------------------------------------------------------
test("no existing subscription + PENDING: nothing is stored, no trial, choose-plan state preserved", async () => {
  const world = buildWorld();

  const result = await world.deliver({
    status: "PENDING",
    planName: "VedaSuite AI - PRO",
    chargeId: CHARGE_PRO,
  });

  assert.equal(result, null, "no subscription row is created for a PENDING subscription");
  assert.equal(world.store.subscription, null);
  assert.equal(world.getHistoryRow(), null, "PENDING never grants a trial");
  assert.equal(world.store.trialStartedAt, null, "PENDING never writes Store trial dates");
  assert.ok(
    world.loggedEvents.some((e) => e.event === "billing.webhook_pending_ignored"),
    "the ignored PENDING delivery is logged"
  );

  // Choose-plan state: with no active subscription and no trial, the canonical
  // billing state must still prompt the merchant to choose a plan.
  const billing = await world.subscriptionService.resolveBillingState("test-shop.myshopify.com");
  assert.equal(billing.selectedPlanName, "NONE");
  assert.equal(billing.trialActive, false);
  assert.equal(billing.lifecycle, "no_subscription");
  assert.match(billing.merchantTitle, /choose a plan/i);
});

// ---------------------------------------------------------------------------
// Case: existing STARTER ACTIVE + new PRO PENDING
// ---------------------------------------------------------------------------
test("existing STARTER ACTIVE + new PRO PENDING: STARTER stays the current active plan, untouched", async () => {
  const world = buildWorld({ existingSubscription: activeSubscriptionRow("STARTER", CHARGE_STARTER) });

  await world.deliver({ status: "PENDING", planName: "VedaSuite AI - PRO", chargeId: CHARGE_PRO });

  assert.equal(world.store.subscription.plan.name, "STARTER", "the pending PRO must not overwrite the active STARTER");
  assert.equal(world.store.subscription.shopifyChargeId, CHARGE_STARTER, "the stored charge id is still STARTER's");
  assert.equal(world.store.subscription.active, true, "STARTER remains active");
  assert.equal(world.store.subscription.billingStatus, "ACTIVE", "STARTER's status is not downgraded to PENDING");

  const billing = await world.subscriptionService.resolveBillingState("test-shop.myshopify.com");
  assert.equal(billing.selectedPlanName, "STARTER", "the current paid plan is still STARTER, not the pending PRO");
});

// ---------------------------------------------------------------------------
// Case: PRO PENDING then PRO ACTIVE
// ---------------------------------------------------------------------------
test("PRO PENDING then PRO ACTIVE: only the ACTIVE delivery activates and grants the trial", async () => {
  const world = buildWorld();

  await world.deliver({ status: "PENDING", planName: "VedaSuite AI - PRO", chargeId: CHARGE_PRO });
  assert.equal(world.store.subscription, null, "still nothing after PENDING");
  assert.equal(world.getHistoryRow(), null);

  await world.deliver({ status: "ACTIVE", planName: "VedaSuite AI - PRO", chargeId: CHARGE_PRO });

  assert.equal(world.store.subscription.active, true, "the ACTIVE delivery activates it");
  assert.equal(world.store.subscription.billingStatus, "ACTIVE");
  assert.equal(world.store.subscription.plan.name, "PRO");
  assert.ok(world.getHistoryRow(), "the trial is granted only once approval is genuine");
  assert.ok(world.store.trialStartedAt);
});

// ---------------------------------------------------------------------------
// Case: old STARTER CANCELLED arriving after PRO ACTIVE
// ---------------------------------------------------------------------------
test("a delayed STARTER CANCELLED arriving after PRO ACTIVE must not deactivate the newer PRO", async () => {
  const world = buildWorld();

  // Merchant switches STARTER -> PRO; PRO is approved and reconciled.
  await world.deliver({ status: "ACTIVE", planName: "VedaSuite AI - PRO", chargeId: CHARGE_PRO });
  assert.equal(world.store.subscription.active, true);
  assert.equal(world.store.subscription.shopifyChargeId, CHARGE_PRO);

  // Shopify's cancellation event for the OLD, replaced STARTER arrives late.
  await world.deliver({ status: "CANCELLED", planName: "VedaSuite AI - STARTER", chargeId: CHARGE_STARTER });

  assert.equal(world.store.subscription.active, true, "the newer PRO subscription must remain active");
  assert.equal(world.store.subscription.shopifyChargeId, CHARGE_PRO);
  assert.equal(world.store.subscription.billingStatus, "ACTIVE", "and its status must not be flipped to CANCELLED");
  assert.ok(
    world.loggedEvents.some((e) => e.event === "billing.webhook_inactive_ignored_stale_charge"),
    "the stale cancellation is explicitly logged as ignored"
  );

  const billing = await world.subscriptionService.resolveBillingState("test-shop.myshopify.com");
  assert.equal(billing.selectedPlanName, "PRO");
  assert.equal(billing.accessActive, true);
});

// ---------------------------------------------------------------------------
// Case: duplicate ACTIVE webhook
// ---------------------------------------------------------------------------
test("duplicate ACTIVE webhook: idempotent — one subscription, one trial, unchanged trialEndsAt", async () => {
  const world = buildWorld();

  await world.deliver({ status: "ACTIVE", planName: "VedaSuite AI - PRO", chargeId: CHARGE_PRO });
  const firstEndsAt = world.store.trialEndsAt;
  const firstSubscriptionId = world.store.subscription.id;

  await world.deliver({ status: "ACTIVE", planName: "VedaSuite AI - PRO", chargeId: CHARGE_PRO });
  await world.deliver({ status: "ACTIVE", planName: "VedaSuite AI - PRO", chargeId: CHARGE_PRO });

  assert.equal(world.store.subscription.id, firstSubscriptionId, "still one subscription row");
  assert.equal(world.store.subscription.active, true);
  assert.equal(
    world.store.trialEndsAt.getTime(),
    firstEndsAt.getTime(),
    "trialEndsAt is never extended by duplicate ACTIVE deliveries"
  );
});

// ---------------------------------------------------------------------------
// Case: duplicate CANCELLED webhook
// ---------------------------------------------------------------------------
test("duplicate CANCELLED webhook: converges on the same deactivated state", async () => {
  const world = buildWorld({ existingSubscription: activeSubscriptionRow("PRO", CHARGE_PRO) });

  await world.deliver({ status: "CANCELLED", planName: "VedaSuite AI - PRO", chargeId: CHARGE_PRO });
  assert.equal(world.store.subscription.active, false);
  assert.equal(world.store.subscription.billingStatus, "CANCELLED");

  await world.deliver({ status: "CANCELLED", planName: "VedaSuite AI - PRO", chargeId: CHARGE_PRO });
  assert.equal(world.store.subscription.active, false, "still deactivated, no flapping");
  assert.equal(world.store.subscription.billingStatus, "CANCELLED");
});

// ---------------------------------------------------------------------------
// Case: webhook with unknown/mismatched subscription ID
// ---------------------------------------------------------------------------
test("an inactive webhook with an unknown subscription id does not deactivate the current subscription", async () => {
  const world = buildWorld({ existingSubscription: activeSubscriptionRow("PRO", CHARGE_PRO) });

  await world.deliver({
    status: "EXPIRED",
    planName: "VedaSuite AI - PRO",
    chargeId: "gid://shopify/AppSubscription/completely-unknown",
  });

  assert.equal(world.store.subscription.active, true, "an unrecognised subscription id must not deactivate anything");
  assert.equal(world.store.subscription.billingStatus, "ACTIVE");
});

test("an ACTIVE webhook with a new subscription id legitimately replaces the stored one", async () => {
  // The mirror case: for an APPROVED status, Shopify is telling us what is now
  // live, so a new charge id is a genuine replacement and must be adopted.
  const world = buildWorld({ existingSubscription: activeSubscriptionRow("STARTER", CHARGE_STARTER) });

  await world.deliver({ status: "ACTIVE", planName: "VedaSuite AI - PRO", chargeId: CHARGE_PRO });

  assert.equal(world.store.subscription.shopifyChargeId, CHARGE_PRO);
  assert.equal(world.store.subscription.plan.name, "PRO");
  assert.equal(world.store.subscription.active, true);
});

// ---------------------------------------------------------------------------
// ACCEPTED is treated as approved; only ACTIVE/ACCEPTED ever set active=true.
// ---------------------------------------------------------------------------
test("only ACTIVE and ACCEPTED ever set StoreSubscription.active=true", async () => {
  for (const status of ["ACTIVE", "ACCEPTED"]) {
    const world = buildWorld();
    await world.deliver({ status, planName: "VedaSuite AI - PRO", chargeId: CHARGE_PRO });
    assert.equal(world.store.subscription?.active, true, `${status} must activate`);
  }

  for (const status of ["PENDING", "DECLINED", "CANCELLED", "EXPIRED", "FROZEN"]) {
    const world = buildWorld();
    await world.deliver({ status, planName: "VedaSuite AI - PRO", chargeId: CHARGE_PRO });
    assert.notEqual(
      world.store.subscription?.active,
      true,
      `${status} must never create an active subscription from nothing`
    );
  }
});

// ---------------------------------------------------------------------------
// Defense in depth: a legacy row with active=true + billingStatus=PENDING
// (only producible by the pre-fix code) is not treated as the current paid plan.
// ---------------------------------------------------------------------------
test("a legacy active=true + PENDING row is not treated as an active paid plan", async () => {
  const world = buildWorld({
    existingSubscription: {
      ...activeSubscriptionRow("PRO", CHARGE_PRO),
      billingStatus: "PENDING",
    },
  });

  const billing = await world.subscriptionService.resolveBillingState("test-shop.myshopify.com");

  assert.equal(billing.selectedPlanName, "NONE", "a PENDING billingStatus is never the current paid plan");
  assert.equal(billing.accessActive, false);
  assert.match(billing.merchantTitle, /choose a plan/i, "the choose-plan state is not suppressed");
});

// ---------------------------------------------------------------------------
// Route contract that makes ISSUE 1's recovery real.
// ---------------------------------------------------------------------------
async function buildWebhookServer({ reconcileImpl }) {
  const subscriptionServicePath = path.resolve(__dirname, "../dist/services/subscriptionService.js");
  const routePath = path.resolve(__dirname, "../dist/routes/shopifyWebhookRoutes.js");

  resetModule(subscriptionServicePath);
  require(subscriptionServicePath).reconcileStoreSubscriptionFromWebhook = reconcileImpl;

  resetModule(routePath);
  const { shopifyWebhookRouter } = require(routePath);

  const app = express();
  app.use("/webhooks/shopify", express.raw({ type: "application/json" }));
  app.use("/webhooks/shopify", shopifyWebhookRouter);
  return app.listen(0);
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

test("app_subscriptions_update answers 200 only when reconciliation genuinely succeeded", async () => {
  let called = 0;
  const server = await buildWebhookServer({
    reconcileImpl: async () => {
      called += 1;
      return { id: "subscription-1" };
    },
  });

  try {
    const response = await httpPost(
      server,
      "/webhooks/shopify/app_subscriptions_update",
      signedDelivery({
        admin_graphql_api_id: CHARGE_PRO,
        name: "VedaSuite AI - PRO",
        status: "ACTIVE",
      })
    );
    assert.equal(response.statusCode, 200);
    assert.equal(called, 1, "reconciliation ran synchronously before the response was sent");
  } finally {
    server.close();
  }
});

test("app_subscriptions_update answers 500 when reconciliation fails, so Shopify redelivers", async () => {
  const server = await buildWebhookServer({
    reconcileImpl: async () => {
      throw new Error("simulated trial persistence failure");
    },
  });

  try {
    const response = await httpPost(
      server,
      "/webhooks/shopify/app_subscriptions_update",
      signedDelivery({
        admin_graphql_api_id: CHARGE_PRO,
        name: "VedaSuite AI - PRO",
        status: "ACTIVE",
      })
    );
    assert.equal(
      response.statusCode,
      500,
      "a failed reconciliation must NOT be acknowledged with 200 — that would stop Shopify retrying and permanently lose the trial"
    );
  } finally {
    server.close();
  }
});

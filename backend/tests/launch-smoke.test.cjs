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
// /launch/audit and /launch/sanity are deliberately hidden behind a shared
// token (added in 9a1bddc) and answer 404 — not 401/403 — when it is absent or
// wrong, so the endpoints are not discoverable. Tests must supply it.
process.env.LAUNCH_DIAGNOSTICS_TOKEN ||= "test-launch-diagnostics-token";
const LAUNCH_TOKEN = process.env.LAUNCH_DIAGNOSTICS_TOKEN;

function resetModule(modulePath) {
  const resolved = require.resolve(modulePath);
  delete require.cache[resolved];
}

function request(server, pathname, options = {}) {
  const address = server.address();

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: address.port,
        path: pathname,
        method: options.method ?? "GET",
        headers: options.headers ?? {},
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          resolve({ statusCode: res.statusCode, headers: res.headers, body });
        });
      }
    );
    req.on("error", reject);
    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

function buildWebhookHmac(rawBody, secret) {
  return crypto.createHmac("sha256", secret).update(rawBody).digest("base64");
}

test("launch endpoints expose factual production checks and public policy routes", async () => {
  const appModulePath = path.resolve(__dirname, "../dist/app.js");
  resetModule(appModulePath);
  const { createApp } = require(appModulePath);

  const app = createApp();
  const server = app.listen(0);

  try {
    const privacy = await request(server, "/legal/privacy");
    assert.equal(privacy.statusCode, 200);
    assert.match(privacy.body, /Privacy Policy/);

    const support = await request(server, "/support");
    assert.equal(support.statusCode, 200);
    assert.match(support.body, /Screenshot or screen recording/);

    const audit = await request(server, `/launch/audit?token=${LAUNCH_TOKEN}`);
    assert.equal(audit.statusCode, 200);
    assert.match(audit.body, /application_url_matches_production/);
    assert.match(audit.body, /webhook_routes_match_backend/);
    assert.match(audit.body, /requested_scopes_minimized/);

    const sanity = await request(server, `/launch/sanity?token=${LAUNCH_TOKEN}`);
    assert.equal(sanity.statusCode, 200);
    assert.match(sanity.body, /protected_customer_data_declaration_reminder/);
    assert.match(sanity.body, /diagnosticsHint/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("launch diagnostics stay hidden without a valid token", async () => {
  const appModulePath = path.resolve(__dirname, "../dist/app.js");
  resetModule(appModulePath);
  const { createApp } = require(appModulePath);

  const app = createApp();
  const server = app.listen(0);

  try {
    for (const route of ["/launch/audit", "/launch/sanity"]) {
      // No token at all.
      const missing = await request(server, route);
      assert.equal(missing.statusCode, 404, `${route} must 404 without a token`);

      // Wrong token.
      const wrong = await request(server, `${route}?token=not-the-real-token`);
      assert.equal(wrong.statusCode, 404, `${route} must 404 with a wrong token`);

      // 404 rather than 401/403 keeps the endpoint undiscoverable, and the
      // body must not leak diagnostics content.
      assert.doesNotMatch(missing.body, /application_url_matches_production/);
      assert.doesNotMatch(wrong.body, /application_url_matches_production/);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("webhook signature validation rejects invalid requests", async () => {
  const routesPath = path.resolve(
    __dirname,
    "../dist/routes/shopifyWebhookRoutes.js"
  );
  resetModule(routesPath);
  const { shopifyWebhookRouter } = require(routesPath);

  const app = express();
  app.use("/webhooks/shopify", express.raw({ type: "application/json" }));
  app.use("/webhooks/shopify", shopifyWebhookRouter);
  const server = app.listen(0);

  try {
    const body = JSON.stringify({ id: "evt-1" });
    const response = await request(server, "/webhooks/shopify/orders_create", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-shopify-shop-domain": "test-shop.myshopify.com",
        "x-shopify-hmac-sha256": "invalid-signature",
      },
      body,
    });
    assert.equal(response.statusCode, 401);
    assert.match(response.body, /Invalid webhook signature/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("app uninstall webhook marks installation as inactive instead of deleting store history", async () => {
  const prismaPath = path.resolve(__dirname, "../dist/db/prismaClient.js");
  const routesPath = path.resolve(
    __dirname,
    "../dist/routes/shopifyWebhookRoutes.js"
  );

  resetModule(prismaPath);
  const prismaModule = require(prismaPath);
  const transactionCalls = [];

  prismaModule.prisma.store.findUnique = async () => ({
    id: "store-1",
    shop: "test-shop.myshopify.com",
    subscription: {
      id: "subscription-1",
    },
  });
  prismaModule.prisma.$transaction = async (callback) =>
    callback({
      storeSubscription: {
        update: async (payload) => transactionCalls.push(["subscription", payload]),
      },
      store: {
        update: async (payload) => transactionCalls.push(["store", payload]),
      },
      // The uninstall handler also cancels pending billing intents inside the
      // same transaction. Without this the mock transaction object is missing
      // the delegate and the handler throws.
      billingPlanIntent: {
        updateMany: async (payload) => {
          transactionCalls.push(["billingPlanIntent", payload]);
          return { count: 0 };
        },
      },
    });

  resetModule(routesPath);
  const { shopifyWebhookRouter } = require(routesPath);
  const app = express();
  app.use("/webhooks/shopify", express.raw({ type: "application/json" }));
  app.use("/webhooks/shopify", shopifyWebhookRouter);
  const server = app.listen(0);

  try {
    const rawBody = Buffer.from(JSON.stringify({ app_id: 1 }));
    const signature = buildWebhookHmac(rawBody, process.env.SHOPIFY_API_SECRET);

    const response = await request(server, "/webhooks/shopify/app_uninstalled", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-shopify-shop-domain": "test-shop.myshopify.com",
        "x-shopify-hmac-sha256": signature,
      },
      body: rawBody,
    });

    assert.equal(response.statusCode, 200);
    // Uninstall does three things in one transaction: deactivate the
    // subscription, clear the store's credentials, and cancel pending billing
    // intents. The store row itself is never deleted.
    assert.equal(transactionCalls.length, 3);
    // Looked up by model rather than by index: the assertion is about what the
    // transaction does, not the incidental order of the statements.
    const payloadFor = (model) => transactionCalls.find(([name]) => name === model)?.[1];
    assert.deepEqual(
      [...transactionCalls.map(([model]) => model)].sort(),
      ["billingPlanIntent", "store", "subscription"]
    );

    const storeUpdate = payloadFor("store");
    assert.ok(storeUpdate, "the store row must be updated, not deleted");
    assert.equal(storeUpdate.data.accessToken, null);
    assert.equal(storeUpdate.data.lastWebhookRegistrationStatus, "UNINSTALLED");

    // Pending intents are cancelled so they cannot resurface after reinstall.
    const intentUpdate = payloadFor("billingPlanIntent");
    assert.deepEqual(intentUpdate.where.status, { in: ["CREATING", "PENDING_APPROVAL"] });
    assert.equal(intentUpdate.data.status, "CANCELLED");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("app subscription update webhook is accepted and routed to billing reconciliation", async () => {
  const subscriptionServicePath = path.resolve(
    __dirname,
    "../dist/services/subscriptionService.js"
  );
  const routesPath = path.resolve(
    __dirname,
    "../dist/routes/shopifyWebhookRoutes.js"
  );

  resetModule(subscriptionServicePath);
  let reconcilePayload = null;
  require(subscriptionServicePath).reconcileStoreSubscriptionFromWebhook = async (
    payload
  ) => {
    reconcilePayload = payload;
    return { id: "subscription-1" };
  };

  resetModule(routesPath);
  const { shopifyWebhookRouter } = require(routesPath);
  const app = express();
  app.use("/webhooks/shopify", express.raw({ type: "application/json" }));
  app.use("/webhooks/shopify", shopifyWebhookRouter);
  const server = app.listen(0);

  try {
    const rawBody = Buffer.from(
      JSON.stringify({
        admin_graphql_api_id: "gid://shopify/AppSubscription/123",
        name: "PRO",
        status: "ACTIVE",
        current_period_end: "2026-05-06T00:00:00.000Z",
      })
    );
    const signature = buildWebhookHmac(rawBody, process.env.SHOPIFY_API_SECRET);

    const response = await request(
      server,
      "/webhooks/shopify/app_subscriptions_update",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-shopify-shop-domain": "test-shop.myshopify.com",
          "x-shopify-hmac-sha256": signature,
        },
        body: rawBody,
      }
    );

    assert.equal(response.statusCode, 200);
    assert.ok(reconcilePayload);
    assert.equal(reconcilePayload.shopDomain, "test-shop.myshopify.com");
    assert.equal(
      reconcilePayload.shopifyChargeId,
      "gid://shopify/AppSubscription/123"
    );
    assert.equal(reconcilePayload.planName, "PRO");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

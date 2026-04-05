const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const express = require("express");

process.env.SHOPIFY_API_KEY ||= "test-key";
process.env.SHOPIFY_API_SECRET ||= "test-secret";
process.env.SHOPIFY_APP_URL ||= "https://app.vedasuite.in";
process.env.DATABASE_URL ||= "postgresql://example:example@localhost:5432/example";

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

test("sync route returns structured missing-offline-token failure", async () => {
  const connectionServicePath = path.resolve(
    __dirname,
    "../dist/services/shopifyConnectionService.js"
  );
  const routesPath = path.resolve(__dirname, "../dist/routes/shopifyRoutes.js");

  resetModule(connectionServicePath);
  const connectionService = require(connectionServicePath);
  connectionService.getConnectionHealth = async () => ({
    shop: "test-shop.myshopify.com",
    code: "MISSING_OFFLINE_TOKEN",
    healthy: false,
    installationFound: true,
    hasOfflineToken: false,
    webhooksRegistered: false,
    lastWebhookRegistrationStatus: null,
    lastSyncStatus: null,
    lastSyncAt: null,
    lastConnectionCheckAt: null,
    lastConnectionStatus: "MISSING_OFFLINE_TOKEN",
    authErrorCode: "MISSING_OFFLINE_TOKEN",
    authErrorMessage: "The stored Shopify offline access token is missing.",
    reauthRequired: true,
    message: "The stored Shopify offline access token is missing.",
    reauthorizeUrl:
      "https://app.vedasuite.in/auth/reconnect?shop=test-shop.myshopify.com",
  });

  resetModule(routesPath);
  const { shopifyRouter } = require(routesPath);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.shopifySession = { shop: "test-shop.myshopify.com" };
    next();
  });
  app.use("/shopify", shopifyRouter);
  const server = app.listen(0);

  try {
    const response = await request(server, "/shopify/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(response.statusCode, 401);
    assert.match(response.body, /MISSING_OFFLINE_TOKEN/);
    assert.match(response.body, /reauthorizeUrl/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("webhook registration succeeds through authenticated reconnect path", async () => {
  const connectionServicePath = path.resolve(
    __dirname,
    "../dist/services/shopifyConnectionService.js"
  );
  const adminServicePath = path.resolve(
    __dirname,
    "../dist/services/shopifyAdminService.js"
  );
  const routesPath = path.resolve(__dirname, "../dist/routes/shopifyRoutes.js");

  resetModule(connectionServicePath);
  resetModule(adminServicePath);
  const connectionService = require(connectionServicePath);
  const adminService = require(adminServicePath);

  connectionService.getConnectionHealth = async () => ({
    shop: "test-shop.myshopify.com",
    code: "OK",
    healthy: true,
    installationFound: true,
    hasOfflineToken: true,
    webhooksRegistered: true,
    lastWebhookRegistrationStatus: "SUCCEEDED",
    lastSyncStatus: "SUCCEEDED",
    lastSyncAt: "2026-04-06T00:00:00.000Z",
    lastConnectionCheckAt: "2026-04-06T00:00:00.000Z",
    lastConnectionStatus: "OK",
    authErrorCode: null,
    authErrorMessage: null,
    reauthRequired: false,
    message: "Shopify connection is healthy.",
  });

  adminService.registerSyncWebhooks = async () => ({
    created: ["ORDERS_CREATE", "APP_UNINSTALLED"],
    totalTracked: 6,
  });

  resetModule(routesPath);
  const { shopifyRouter } = require(routesPath);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.shopifySession = { shop: "test-shop.myshopify.com" };
    next();
  });
  app.use("/shopify", shopifyRouter);
  const server = app.listen(0);

  try {
    const response = await request(server, "/shopify/register-webhooks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ host: "embedded-host", returnTo: "/" }),
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.body, /ORDERS_CREATE/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("diagnostics route reports installation, webhook, sync, and billing state", async () => {
  const prismaPath = path.resolve(__dirname, "../dist/db/prismaClient.js");
  const connectionServicePath = path.resolve(
    __dirname,
    "../dist/services/shopifyConnectionService.js"
  );
  const syncJobServicePath = path.resolve(
    __dirname,
    "../dist/services/syncJobService.js"
  );
  const adminServicePath = path.resolve(
    __dirname,
    "../dist/services/shopifyAdminService.js"
  );
  const subscriptionServicePath = path.resolve(
    __dirname,
    "../dist/services/subscriptionService.js"
  );
  const routesPath = path.resolve(__dirname, "../dist/routes/shopifyRoutes.js");

  resetModule(prismaPath);
  resetModule(connectionServicePath);
  resetModule(syncJobServicePath);
  resetModule(adminServicePath);
  resetModule(subscriptionServicePath);

  require(prismaPath).prisma.store.findUnique = async () => ({
    shop: "test-shop.myshopify.com",
    installedAt: new Date("2026-04-06T00:00:00.000Z"),
    reauthorizedAt: new Date("2026-04-06T01:00:00.000Z"),
    uninstalledAt: null,
    grantedScopes: "read_orders,read_products",
    isOffline: true,
    accessToken: "offline-token",
    webhooksRegisteredAt: new Date("2026-04-06T01:30:00.000Z"),
    lastWebhookRegistrationStatus: "SUCCEEDED",
    lastSyncAt: new Date("2026-04-06T02:00:00.000Z"),
    lastSyncStatus: "SUCCEEDED",
    lastConnectionCheckAt: new Date("2026-04-06T02:05:00.000Z"),
    lastConnectionStatus: "OK",
    authErrorCode: null,
    authErrorMessage: null,
  });
  require(connectionServicePath).getConnectionHealth = async () => ({
    shop: "test-shop.myshopify.com",
    code: "OK",
    healthy: true,
    installationFound: true,
    hasOfflineToken: true,
    webhooksRegistered: true,
    lastWebhookRegistrationStatus: "SUCCEEDED",
    lastSyncStatus: "SUCCEEDED",
    lastSyncAt: "2026-04-06T02:00:00.000Z",
    lastConnectionCheckAt: "2026-04-06T02:05:00.000Z",
    lastConnectionStatus: "OK",
    authErrorCode: null,
    authErrorMessage: null,
    reauthRequired: false,
    message: "Shopify connection is healthy.",
  });
  require(syncJobServicePath).getLatestSyncJob = async () => ({
    id: "job-1",
    status: "SUCCEEDED",
  });
  require(adminServicePath).getSyncWebhookStatus = async () => ({
    registeredCount: 6,
    totalTracked: 6,
    webhooks: [],
  });
  require(subscriptionServicePath).getCurrentSubscription = async () => ({
    planName: "PRO",
    status: "active_paid",
    billingStatus: "ACTIVE",
    active: true,
    starterModule: null,
    endsAt: null,
    trialEndsAt: null,
  });

  resetModule(routesPath);
  const { shopifyRouter } = require(routesPath);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.shopifySession = { shop: "test-shop.myshopify.com" };
    next();
  });
  app.use("/shopify", shopifyRouter);
  const server = app.listen(0);

  try {
    const response = await request(server, "/shopify/diagnostics");
    assert.equal(response.statusCode, 200);
    assert.match(response.body, /"offlineTokenPresent":true/);
    assert.match(response.body, /"lastWebhookRegistrationStatus":"SUCCEEDED"/);
    assert.match(response.body, /"planName":"PRO"/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("billing activation callback persists the active Shopify plan and redirects back to the app", async () => {
  const prismaPath = path.resolve(__dirname, "../dist/db/prismaClient.js");
  const adminServicePath = path.resolve(
    __dirname,
    "../dist/services/shopifyAdminService.js"
  );
  const routesPath = path.resolve(__dirname, "../dist/routes/billingRoutes.js");

  resetModule(prismaPath);
  resetModule(adminServicePath);

  const prismaModule = require(prismaPath);
  prismaModule.prisma.store.findUnique = async () => ({
    id: "store-1",
    shop: "test-shop.myshopify.com",
  });
  prismaModule.prisma.subscriptionPlan.findFirst = async () => ({
    id: "plan-1",
    name: "PRO",
    price: 99,
    trialDays: 3,
  });
  prismaModule.prisma.storeSubscription.upsert = async () => ({
    id: "subscription-1",
  });

  require(adminServicePath).getActiveAppSubscription = async () => ({
    id: "gid://shopify/AppSubscription/123",
    status: "ACTIVE",
    currentPeriodEnd: "2026-05-06T00:00:00.000Z",
  });

  resetModule(routesPath);
  const { billingRouter } = require(routesPath);
  const app = express();
  app.use("/billing", billingRouter);
  const server = app.listen(0);

  try {
    const response = await request(
      server,
      "/billing/activate?shop=test-shop.myshopify.com&plan=PRO&host=embedded-host"
    );
    assert.equal(response.statusCode, 200);
    assert.match(response.body, /billing=activated/);
    assert.match(response.body, /plan=PRO/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

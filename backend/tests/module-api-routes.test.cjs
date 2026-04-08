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
  const operationalServicePath = path.resolve(
    __dirname,
    "../dist/services/storeOperationalStateService.js"
  );
  const syncJobServicePath = path.resolve(
    __dirname,
    "../dist/services/syncJobService.js"
  );
  const adminServicePath = path.resolve(
    __dirname,
    "../dist/services/shopifyAdminService.js"
  );
  const billingManagementServicePath = path.resolve(
    __dirname,
    "../dist/services/billingManagementService.js"
  );
  const subscriptionServicePath = path.resolve(
    __dirname,
    "../dist/services/subscriptionService.js"
  );
  const routesPath = path.resolve(__dirname, "../dist/routes/shopifyRoutes.js");

  resetModule(prismaPath);
  resetModule(connectionServicePath);
  resetModule(operationalServicePath);
  resetModule(syncJobServicePath);
  resetModule(adminServicePath);
  resetModule(billingManagementServicePath);
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
  require(connectionServicePath).ensureInstallationMetadata = async () => undefined;
  require(connectionServicePath).getConnectionHealth = async () => ({
    shop: "test-shop.myshopify.com",
    code: "OK",
    healthy: true,
    installationFound: true,
    hasOfflineToken: true,
    webhooksRegistered: true,
    webhookCoverageReady: true,
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
  require(operationalServicePath).getStoreOperationalSnapshot = async () => ({
    store: {
      lastConnectionStatus: "OK",
      lastSyncStatus: "READY_WITH_DATA",
    },
    counts: {
      products: 17,
      orders: 2,
      customers: 2,
      pricingRows: 43,
      profitRows: 38,
      timelineEvents: 5,
      competitorDomains: 2,
      competitorRows: 74,
    },
    latestSyncJob: {
      status: "READY_WITH_DATA",
      errorMessage: null,
    },
    latestCompetitorIngestJob: null,
    latestCompetitorAt: new Date("2026-04-06T02:15:00.000Z"),
    latestProcessingAt: new Date("2026-04-06T02:20:00.000Z"),
  });
  require(operationalServicePath).deriveSyncStatus = () => ({
    status: "READY_WITH_DATA",
    reason: "Shopify data and derived module outputs are available.",
  });
  require(syncJobServicePath).getLatestSyncJob = async () => ({
    id: "job-1",
    status: "READY_WITH_DATA",
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
  require(subscriptionServicePath).resolveBillingState = async () => ({
    planName: "PRO",
    normalizedBillingStatus: "ACTIVE",
    active: true,
    status: "active_paid",
    starterModule: null,
    endsAt: null,
    subscriptionId: "subscription-1",
    shopifyChargeId: "gid://shopify/AppSubscription/123",
    planSource: "database",
    dbPlanName: "PRO",
    dbBillingStatus: "ACTIVE",
    lastBillingSyncAt: "2026-04-06T02:00:00.000Z",
    lastBillingWebhookProcessedAt: "2026-04-06T02:10:00.000Z",
    lastBillingResolutionSource: "webhook_app_subscriptions_update",
    mismatchWarnings: [],
  });
  require(billingManagementServicePath).getBillingManagementState = async () => ({
    subscription: {
      planName: "PRO",
      status: "active_paid",
      billingStatus: "ACTIVE",
      active: true,
      starterModule: null,
      endsAt: null,
      trialEndsAt: null,
    },
    billing: {
      planName: "PRO",
      normalizedBillingStatus: "ACTIVE",
      active: true,
      status: "active_paid",
      starterModule: null,
      endsAt: null,
      subscriptionId: "subscription-1",
      shopifyChargeId: "gid://shopify/AppSubscription/123",
      planSource: "database",
      dbPlanName: "PRO",
      dbBillingStatus: "ACTIVE",
      mismatchWarnings: [],
    },
    pendingIntent: null,
    availableActions: {
      canManagePlans: true,
      canCancelSubscription: true,
      canChangeStarterModule: false,
      awaitingApproval: false,
    },
    plans: [],
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
    assert.match(response.body, /"reconnectRequired":false/);
    assert.match(response.body, /"tokenRefreshHealthy":true/);
    assert.match(response.body, /"planSource":"database"/);
    assert.match(response.body, /"billingStatus":"ACTIVE"/);
    assert.match(response.body, /"operationalCounts"/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("billing health route uses normalized billing resolver output", async () => {
  const billingManagementServicePath = path.resolve(
    __dirname,
    "../dist/services/billingManagementService.js"
  );
  const subscriptionServicePath = path.resolve(
    __dirname,
    "../dist/services/subscriptionService.js"
  );
  const routesPath = path.resolve(__dirname, "../dist/routes/shopifyRoutes.js");

  resetModule(billingManagementServicePath);
  resetModule(subscriptionServicePath);
  require(billingManagementServicePath).getBillingManagementState = async () => ({
    pendingIntent: {
      id: "intent-1",
      requestedPlanName: "PRO",
      requestedStarterModule: null,
      actionType: "upgrade",
      status: "PENDING_APPROVAL",
      confirmationUrl: "https://shopify.test/confirm",
      shopifyChargeId: null,
      errorCode: null,
      errorMessage: null,
      createdAt: "2026-04-08T05:01:00.000Z",
      updatedAt: "2026-04-08T05:01:00.000Z",
      confirmedAt: null,
      cancelledAt: null,
      expiresAt: "2026-04-08T06:01:00.000Z",
    },
  });
  const subscriptionService = require(subscriptionServicePath);
  subscriptionService.getCurrentSubscription = async () => ({
    planName: "PRO",
    status: "active_paid",
    billingStatus: "ACTIVE",
    active: true,
    starterModule: null,
    endsAt: "2026-05-06T00:00:00.000Z",
    trialEndsAt: null,
  });
  subscriptionService.resolveBillingState = async () => ({
    planName: "PRO",
    normalizedBillingStatus: "ACTIVE",
    active: true,
    status: "active_paid",
    starterModule: null,
    endsAt: "2026-05-06T00:00:00.000Z",
    subscriptionId: "subscription-1",
    shopifyChargeId: "gid://shopify/AppSubscription/123",
    planSource: "shopify_reconciled",
    dbPlanName: "PRO",
    dbBillingStatus: "ACTIVE",
    lastBillingSyncAt: "2026-04-08T05:00:00.000Z",
    lastBillingWebhookProcessedAt: "2026-04-08T05:05:00.000Z",
    lastBillingResolutionSource: "webhook_app_subscriptions_update",
    mismatchWarnings: [],
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
    const response = await request(server, "/shopify/internal/debug/billing-health");
    assert.equal(response.statusCode, 200);
    assert.match(response.body, /"dbPlan":"PRO"/);
    assert.match(response.body, /"lastBillingWebhookProcessedAt":"2026-04-08T05:05:00.000Z"/);
    assert.match(response.body, /"billingResolutionSource":"webhook_app_subscriptions_update"/);
    assert.match(response.body, /"planSource":"shopify_reconciled"/);
    assert.match(response.body, /"pendingIntent"/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("connection health exposes reconnect-required state for missing offline token", async () => {
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
    webhookCoverageReady: false,
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
    const response = await request(server, "/shopify/connection-health");
    assert.equal(response.statusCode, 200);
    assert.match(response.body, /"code":"MISSING_OFFLINE_TOKEN"/);
    assert.match(response.body, /"reauthRequired":true/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("billing state route returns current management state", async () => {
  const billingManagementServicePath = path.resolve(
    __dirname,
    "../dist/services/billingManagementService.js"
  );
  const routesPath = path.resolve(__dirname, "../dist/routes/billingRoutes.js");

  resetModule(billingManagementServicePath);
  require(billingManagementServicePath).getBillingManagementState = async () => ({
    subscription: {
      planName: "GROWTH",
      status: "active_paid",
      billingStatus: "ACTIVE",
      active: true,
      starterModule: null,
      endsAt: "2026-05-06T00:00:00.000Z",
      trialEndsAt: null,
    },
    billing: {
      planName: "GROWTH",
      normalizedBillingStatus: "ACTIVE",
      active: true,
      status: "active_paid",
      starterModule: null,
      endsAt: "2026-05-06T00:00:00.000Z",
      subscriptionId: "subscription-1",
      shopifyChargeId: "gid://shopify/AppSubscription/123",
      planSource: "database",
      dbPlanName: "GROWTH",
      dbBillingStatus: "ACTIVE",
      mismatchWarnings: [],
    },
    pendingIntent: null,
    availableActions: {
      canManagePlans: true,
      canCancelSubscription: true,
      canChangeStarterModule: false,
      awaitingApproval: false,
    },
    plans: [],
  });

  resetModule(routesPath);
  const { billingApiRouter } = require(routesPath);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.shopifySession = { shop: "test-shop.myshopify.com" };
    next();
  });
  app.use("/billing", billingApiRouter);
  const server = app.listen(0);

  try {
    const response = await request(server, "/billing/state");
    assert.equal(response.statusCode, 200);
    assert.match(response.body, /"planName":"GROWTH"/);
    assert.match(response.body, /"canCancelSubscription":true/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("change-plan route returns Shopify confirmation URL and pending intent", async () => {
  const billingManagementServicePath = path.resolve(
    __dirname,
    "../dist/services/billingManagementService.js"
  );
  const routesPath = path.resolve(__dirname, "../dist/routes/billingRoutes.js");

  resetModule(billingManagementServicePath);
  require(billingManagementServicePath).requestBillingPlanChange = async () => ({
    outcome: "REDIRECT_REQUIRED",
    confirmationUrl: "https://shopify.test/confirm",
    pendingIntent: {
      id: "intent-1",
      requestedPlanName: "PRO",
      requestedStarterModule: null,
      actionType: "upgrade",
      status: "PENDING_APPROVAL",
      confirmationUrl: "https://shopify.test/confirm",
      shopifyChargeId: null,
      errorCode: null,
      errorMessage: null,
      createdAt: "2026-04-08T05:01:00.000Z",
      updatedAt: "2026-04-08T05:01:00.000Z",
      confirmedAt: null,
      cancelledAt: null,
      expiresAt: "2026-04-08T06:01:00.000Z",
    },
    state: {
      subscription: {
        planName: "TRIAL",
        status: "trial_active",
        billingStatus: null,
        active: true,
        starterModule: null,
        endsAt: null,
        trialEndsAt: "2026-04-10T00:00:00.000Z",
      },
      billing: {
        planName: "TRIAL",
        normalizedBillingStatus: null,
        active: true,
        status: "trial_active",
        starterModule: null,
        endsAt: "2026-04-10T00:00:00.000Z",
        subscriptionId: null,
        shopifyChargeId: null,
        planSource: "trial",
        dbPlanName: "NONE",
        dbBillingStatus: null,
        mismatchWarnings: [],
      },
      pendingIntent: null,
      availableActions: {
        canManagePlans: true,
        canCancelSubscription: false,
        canChangeStarterModule: false,
        awaitingApproval: true,
      },
      plans: [],
    },
  });

  resetModule(routesPath);
  const { billingApiRouter } = require(routesPath);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.shopifySession = { shop: "test-shop.myshopify.com" };
    next();
  });
  app.use("/billing", billingApiRouter);
  const server = app.listen(0);

  try {
    const response = await request(server, "/billing/change-plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan: "PRO", returnPath: "/subscription" }),
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.body, /"outcome":"REDIRECT_REQUIRED"/);
    assert.match(response.body, /"confirmationUrl":"https:\/\/shopify.test\/confirm"/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("cancel-plan route returns refreshed billing state", async () => {
  const billingManagementServicePath = path.resolve(
    __dirname,
    "../dist/services/billingManagementService.js"
  );
  const routesPath = path.resolve(__dirname, "../dist/routes/billingRoutes.js");

  resetModule(billingManagementServicePath);
  require(billingManagementServicePath).cancelBillingPlan = async () => ({
    subscription: {
      planName: "NONE",
      status: "inactive",
      billingStatus: "CANCELLED",
      active: false,
      starterModule: null,
      endsAt: null,
      trialEndsAt: null,
    },
    billing: {
      planName: "NONE",
      normalizedBillingStatus: "CANCELLED",
      active: false,
      status: "inactive",
      starterModule: null,
      endsAt: null,
      subscriptionId: "subscription-1",
      shopifyChargeId: "gid://shopify/AppSubscription/123",
      planSource: "none",
      dbPlanName: "PRO",
      dbBillingStatus: "CANCELLED",
      mismatchWarnings: [],
    },
    pendingIntent: null,
    availableActions: {
      canManagePlans: true,
      canCancelSubscription: false,
      canChangeStarterModule: false,
      awaitingApproval: false,
    },
    plans: [],
  });

  resetModule(routesPath);
  const { billingApiRouter } = require(routesPath);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.shopifySession = { shop: "test-shop.myshopify.com" };
    next();
  });
  app.use("/billing", billingApiRouter);
  const server = app.listen(0);

  try {
    const response = await request(server, "/billing/cancel-plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: true }),
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.body, /"planName":"NONE"/);
    assert.match(response.body, /"billingStatus":"CANCELLED"/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("billing activation callback confirms the billing intent and redirects back to the app", async () => {
  const billingManagementServicePath = path.resolve(
    __dirname,
    "../dist/services/billingManagementService.js"
  );
  const routesPath = path.resolve(__dirname, "../dist/routes/billingRoutes.js");

  resetModule(billingManagementServicePath);
  require(billingManagementServicePath).confirmBillingApprovalReturn = async () => ({
    subscription: {
      planName: "PRO",
      status: "active_paid",
      billingStatus: "ACTIVE",
      active: true,
      starterModule: null,
      endsAt: "2026-05-06T00:00:00.000Z",
      trialEndsAt: null,
    },
    billing: {
      planName: "PRO",
      normalizedBillingStatus: "ACTIVE",
      active: true,
      status: "active_paid",
      starterModule: null,
      endsAt: "2026-05-06T00:00:00.000Z",
      subscriptionId: "subscription-1",
      shopifyChargeId: "gid://shopify/AppSubscription/123",
      planSource: "shopify_reconciled",
      dbPlanName: "PRO",
      dbBillingStatus: "ACTIVE",
      mismatchWarnings: [],
    },
    pendingIntent: null,
    availableActions: {
      canManagePlans: true,
      canCancelSubscription: true,
      canChangeStarterModule: false,
      awaitingApproval: false,
    },
    plans: [],
  });

  resetModule(routesPath);
  const { billingRouter } = require(routesPath);
  const app = express();
  app.use("/billing", billingRouter);
  const server = app.listen(0);

  try {
    const response = await request(
      server,
      "/billing/activate?shop=test-shop.myshopify.com&intentId=intent-1&host=embedded-host"
    );
    assert.equal(response.statusCode, 200);
    assert.match(response.body, /billingResult=confirmed/);
    assert.match(response.body, /intentId=intent-1/);
    assert.match(response.body, /plan=PRO/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

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

function request(server, pathname) {
  const address = server.address();

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: address.port,
        path: pathname,
        method: "GET",
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          resolve({ statusCode: res.statusCode, body });
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

test("app state route returns structured error when shop context is missing", async () => {
  const routePath = path.resolve(__dirname, "../dist/routes/appStateRoutes.js");
  const servicePath = path.resolve(__dirname, "../dist/services/appStateService.js");

  resetModule(servicePath);
  require(servicePath).getMerchantAppState = async () => {
    throw new Error("Should not be called without a shop.");
  };

  resetModule(routePath);
  const { appStateRouter } = require(routePath);

  const app = express();
  app.use("/api/app-state", appStateRouter);
  const server = app.listen(0);

  try {
    const response = await request(server, "/api/app-state");
    assert.equal(response.statusCode, 400);
    assert.match(response.body, /MISSING_SHOP_CONTEXT/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("app state route rejects invalid bootstrap payloads", async () => {
  const routePath = path.resolve(__dirname, "../dist/routes/appStateRoutes.js");
  const servicePath = path.resolve(__dirname, "../dist/services/appStateService.js");

  resetModule(servicePath);
  require(servicePath).getMerchantAppState = async () => ({
    connection: { status: "healthy" },
  });

  resetModule(routePath);
  const { appStateRouter } = require(routePath);

  const app = express();
  app.use((req, _res, next) => {
    req.shopifySession = { shop: "test-shop.myshopify.com" };
    next();
  });
  app.use("/api/app-state", appStateRouter);
  const server = app.listen(0);

  try {
    const response = await request(server, "/api/app-state");
    assert.equal(response.statusCode, 503);
    assert.match(response.body, /APP_STATE_UNAVAILABLE/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("app state route returns canonical bootstrap payload when installation is present", async () => {
  const routePath = path.resolve(__dirname, "../dist/routes/appStateRoutes.js");
  const servicePath = path.resolve(__dirname, "../dist/services/appStateService.js");

  resetModule(servicePath);
  require(servicePath).getMerchantAppState = async () => ({
    appStatus: "ready",
    install: {
      status: "installed",
      title: "Installed",
      description: "Ready",
      reauthorizeUrl: null,
    },
    connection: {
      status: "healthy",
      title: "Healthy",
      description: "Healthy",
    },
    sync: {
      status: "ready",
      title: "Ready",
      description: "Ready",
      lastUpdatedAt: null,
    },
    billing: {
      planName: "PRO",
      status: "ACTIVE",
      active: true,
      accessActive: true,
      endsAt: null,
      trialEndsAt: null,
      title: "Billing ready",
      description: "Billing ready",
    },
    onboarding: {
      stage: "complete",
      isCompleted: true,
      canAccessDashboard: true,
      nextRoute: "/app/dashboard",
      title: "Ready",
      description: "Ready",
    },
    entitlements: {
      trustAbuse: true,
      competitor: true,
      pricingProfit: true,
      reports: true,
      settings: true,
    },
    modules: {
      fraud: { status: "ready", title: "Ready", description: "Ready" },
      competitor: { status: "ready", title: "Ready", description: "Ready" },
      pricing: { status: "ready", title: "Ready", description: "Ready" },
    },
    readiness: {
      connection: {
        state: "ready",
        status: "ready",
        title: "Ready",
        description: "Ready",
        ready: true,
        healthy: true,
        code: "OK",
      },
      initialSync: {
        state: "ready",
        status: "ready",
        title: "Ready",
        description: "Ready",
        ready: true,
        syncStatus: "READY_WITH_DATA",
        hasRawData: true,
        hasProcessedData: true,
      },
      billing: {
        state: "ready",
        status: "ready",
        title: "Ready",
        description: "Ready",
        ready: true,
        lifecycle: "active",
        planName: "PRO",
        accessActive: true,
        verified: true,
      },
      modules: {
        fraud: {
          state: "ready",
          status: "ready",
          title: "Ready",
          description: "Ready",
          ready: true,
        },
        competitor: {
          state: "ready",
          status: "ready",
          title: "Ready",
          description: "Ready",
          ready: true,
        },
        pricing: {
          state: "ready",
          status: "ready",
          title: "Ready",
          description: "Ready",
          ready: true,
        },
      },
      setup: {
        minimumComplete: true,
        allCoreModulesReady: true,
        blockers: [],
        nextAction: { label: "Open dashboard", route: "/app/dashboard" },
        percent: 100,
        summaryTitle: "Ready",
        summaryDescription: "Ready",
      },
      quickAccess: {
        fraud: { state: "ready", status: "ready", freshnessAt: null, reason: "Ready" },
        competitor: {
          state: "ready",
          status: "ready",
          freshnessAt: null,
          reason: "Ready",
        },
        pricing: { state: "ready", status: "ready", freshnessAt: null, reason: "Ready" },
      },
    },
  });

  resetModule(routePath);
  const { appStateRouter } = require(routePath);

  const app = express();
  app.use((req, _res, next) => {
    req.shopifySession = { shop: "test-shop.myshopify.com" };
    next();
  });
  app.use("/api/app-state", appStateRouter);
  const server = app.listen(0);

  try {
    const response = await request(server, "/api/app-state");
    assert.equal(response.statusCode, 200);
    assert.match(response.body, /\"status\":\"installed\"/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

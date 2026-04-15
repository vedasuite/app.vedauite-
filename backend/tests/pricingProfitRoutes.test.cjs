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
          resolve({ statusCode: res.statusCode, body });
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

test("pricing profit overview returns timeout code when compute exceeds route timeout", async () => {
  const routePath = path.resolve(__dirname, "../dist/routes/pricingProfitRoutes.js");
  const servicePath = path.resolve(__dirname, "../dist/services/pricingProfitService.js");
  const subscriptionPath = path.resolve(
    __dirname,
    "../dist/services/subscriptionService.js"
  );

  resetModule(servicePath);
  require(servicePath).getPricingProfitOverview = async () =>
    new Promise(() => undefined);
  resetModule(subscriptionPath);
  require(subscriptionPath).getCurrentSubscription = async () => ({
    planName: "PRO",
    capabilities: {
      "module.pricingProfit": true,
    },
  });

  resetModule(routePath);
  const { pricingProfitRouter } = require(routePath);

  const app = express();
  app.use((req, _res, next) => {
    req.shopifySession = { shop: "test-shop.myshopify.com" };
    next();
  });
  app.use("/api/pricing-profit", pricingProfitRouter);
  const server = app.listen(0);

  try {
    const response = await request(server, "/api/pricing-profit/overview");
    assert.equal(response.statusCode, 504);
    assert.match(response.body, /PRICING_TIMEOUT/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("pricing profit overview returns access error when entitlement is denied", async () => {
  const routePath = path.resolve(__dirname, "../dist/routes/pricingProfitRoutes.js");
  const capabilityPath = path.resolve(
    __dirname,
    "../dist/middleware/requireCapability.js"
  );
  const servicePath = path.resolve(__dirname, "../dist/services/pricingProfitService.js");

  resetModule(servicePath);
  require(servicePath).getPricingProfitOverview = async () => ({
    viewState: {
      status: "ready",
      title: "Pricing ready",
      description: "Should never be reached when access is denied.",
    },
  });
  resetModule(capabilityPath);
  require(capabilityPath).requireCapability = () => (_req, res) =>
    res.status(403).json({
      error: {
        code: "CAPABILITY_REQUIRED",
        message: "Your current plan does not include module.pricingProfit.",
      },
    });

  resetModule(routePath);
  const { pricingProfitRouter } = require(routePath);

  const app = express();
  app.use((req, _res, next) => {
    req.shopifySession = { shop: "test-shop.myshopify.com" };
    next();
  });
  app.use("/api/pricing-profit", pricingProfitRouter);
  const server = app.listen(0);

  try {
    const response = await request(server, "/api/pricing-profit/overview");
    assert.equal(response.statusCode, 403);
    assert.match(response.body, /CAPABILITY_REQUIRED/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("pricing profit overview returns failure code when backend throws", async () => {
  const routePath = path.resolve(__dirname, "../dist/routes/pricingProfitRoutes.js");
  const capabilityPath = path.resolve(
    __dirname,
    "../dist/middleware/requireCapability.js"
  );
  const servicePath = path.resolve(__dirname, "../dist/services/pricingProfitService.js");

  resetModule(capabilityPath);
  require(capabilityPath).requireCapability = () => (_req, _res, next) => next();

  resetModule(servicePath);
  require(servicePath).getPricingProfitOverview = async () => {
    throw new Error("Pricing compute failed.");
  };

  resetModule(routePath);
  const { pricingProfitRouter } = require(routePath);

  const app = express();
  app.use((req, _res, next) => {
    req.shopifySession = { shop: "test-shop.myshopify.com" };
    next();
  });
  app.use("/api/pricing-profit", pricingProfitRouter);
  const server = app.listen(0);

  try {
    const response = await request(server, "/api/pricing-profit/overview");
    assert.equal(response.statusCode, 503);
    assert.match(response.body, /PRICING_OVERVIEW_FAILED/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

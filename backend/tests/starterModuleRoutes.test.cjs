const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const express = require("express");

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
    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

test("active STARTER fraud to competitor returns competitor entitlements", async () => {
  const servicePath = path.resolve(
    __dirname,
    "../dist/services/subscriptionService.js"
  );
  const middlewarePath = path.resolve(
    __dirname,
    "../dist/middleware/requireCapability.js"
  );
  const routePath = path.resolve(__dirname, "../dist/routes/subscriptionRoutes.js");

  resetModule(servicePath);
  require(servicePath).updateStarterModuleSelection = async () => ({
    planName: "STARTER",
    starterModule: "competitor",
  });
  require(servicePath).resolveEntitlements = async () => ({
    plan: "STARTER",
    billingStatus: "ACTIVE",
    starterModule: "competitor",
    enabledModules: ["competitor"],
    lockedModules: ["fraud", "pricing", "profit"],
  });
  require(servicePath).resolveBillingState = async () => ({
    dbPlanName: "STARTER",
    starterModule: "competitor",
  });

  resetModule(middlewarePath);
  require(middlewarePath).requireCapability = () => (_req, _res, next) => next();

  resetModule(routePath);
  const { subscriptionRouter, subscriptionDebugRouter } = require(routePath);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.shopifySession = { shop: "test-shop.myshopify.com" };
    next();
  });
  app.use("/subscription", subscriptionRouter);
  app.use("/debug", subscriptionDebugRouter);
  const server = app.listen(0);

  try {
    const response = await request(server, "/subscription/starter-module?shop=test-shop.myshopify.com", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ starterModule: "competitor" }),
    });

    assert.equal(response.statusCode, 200);
    assert.match(response.body, /"starterModule":"competitor"/);
    assert.match(response.body, /"enabledModules":\["competitor"\]/);
    assert.match(response.body, /"lockedModules":\["fraud","pricing","profit"\]/);

    const debugResponse = await request(
      server,
      "/debug/entitlements?shop=test-shop.myshopify.com"
    );
    assert.equal(debugResponse.statusCode, 200);
    assert.match(debugResponse.body, /"dbPlan":"STARTER"/);
    assert.match(debugResponse.body, /"normalizedStarterModule":"competitor"/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("active STARTER competitor to fraud returns fraud entitlements", async () => {
  const servicePath = path.resolve(
    __dirname,
    "../dist/services/subscriptionService.js"
  );
  const middlewarePath = path.resolve(
    __dirname,
    "../dist/middleware/requireCapability.js"
  );
  const routePath = path.resolve(__dirname, "../dist/routes/subscriptionRoutes.js");

  resetModule(servicePath);
  require(servicePath).updateStarterModuleSelection = async () => ({
    planName: "STARTER",
    starterModule: "fraud",
  });
  require(servicePath).resolveEntitlements = async () => ({
    plan: "STARTER",
    billingStatus: "ACTIVE",
    starterModule: "fraud",
    enabledModules: ["fraud"],
    lockedModules: ["competitor", "pricing", "profit"],
  });
  require(servicePath).resolveBillingState = async () => ({
    dbPlanName: "STARTER",
    starterModule: "fraud",
  });

  resetModule(middlewarePath);
  require(middlewarePath).requireCapability = () => (_req, _res, next) => next();

  resetModule(routePath);
  const { subscriptionRouter } = require(routePath);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.shopifySession = { shop: "test-shop.myshopify.com" };
    next();
  });
  app.use("/subscription", subscriptionRouter);
  const server = app.listen(0);

  try {
    const response = await request(server, "/subscription/starter-module?shop=test-shop.myshopify.com", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ starterModule: "fraud" }),
    });

    assert.equal(response.statusCode, 200);
    assert.match(response.body, /"starterModule":"fraud"/);
    assert.match(response.body, /"enabledModules":\["fraud"\]/);
    assert.match(response.body, /"lockedModules":\["competitor","pricing","profit"\]/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

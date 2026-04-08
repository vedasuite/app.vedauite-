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

test("PRO plan unlocks protected capabilities through backend gating", async () => {
  const subscriptionServicePath = path.resolve(
    __dirname,
    "../dist/services/subscriptionService.js"
  );
  const middlewarePath = path.resolve(
    __dirname,
    "../dist/middleware/requireCapability.js"
  );

  resetModule(subscriptionServicePath);
  require(subscriptionServicePath).getCurrentSubscription = async () => ({
    planName: "PRO",
    active: true,
    status: "active_paid",
    billingStatus: "ACTIVE",
    capabilities: {
      "reports.view": true,
    },
  });

  resetModule(middlewarePath);
  const { requireCapability } = require(middlewarePath);
  const app = express();
  app.use((req, _res, next) => {
    req.shopifySession = { shop: "test-shop.myshopify.com" };
    next();
  });
  app.get(
    "/protected",
    requireCapability("reports.view"),
    (_req, res) => res.json({ ok: true })
  );
  const server = app.listen(0);

  try {
    const response = await request(server, "/protected?shop=test-shop.myshopify.com");
    assert.equal(response.statusCode, 200);
    assert.match(response.body, /"ok":true/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("inactive paid plan blocks protected capabilities through backend gating", async () => {
  const subscriptionServicePath = path.resolve(
    __dirname,
    "../dist/services/subscriptionService.js"
  );
  const middlewarePath = path.resolve(
    __dirname,
    "../dist/middleware/requireCapability.js"
  );

  resetModule(subscriptionServicePath);
  require(subscriptionServicePath).getCurrentSubscription = async () => ({
    planName: "NONE",
    active: false,
    status: "inactive",
    billingStatus: "CANCELLED",
    capabilities: {
      "reports.view": false,
    },
  });

  resetModule(middlewarePath);
  const { requireCapability } = require(middlewarePath);
  const app = express();
  app.use((req, _res, next) => {
    req.shopifySession = { shop: "test-shop.myshopify.com" };
    next();
  });
  app.get(
    "/protected",
    requireCapability("reports.view"),
    (_req, res) => res.json({ ok: true })
  );
  const server = app.listen(0);

  try {
    const response = await request(server, "/protected?shop=test-shop.myshopify.com");
    assert.equal(response.statusCode, 403);
    assert.match(response.body, /currentPlan/);
    assert.match(response.body, /NONE/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

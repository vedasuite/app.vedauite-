const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const express = require("express");

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

test("reports router returns weekly report payload", async () => {
  const servicesPath = path.resolve(__dirname, "../dist/services/reportsService.js");
  const middlewarePath = path.resolve(
    __dirname,
    "../dist/middleware/requireCapability.js"
  );
  const subscriptionServicePath = path.resolve(
    __dirname,
    "../dist/services/subscriptionService.js"
  );
  const routesPath = path.resolve(__dirname, "../dist/routes/reportsRoutes.js");

  resetModule(servicesPath);
  const reportsService = require(servicesPath);
  reportsService.getWeeklyReport = async () => ({
    since: "2026-03-18T00:00:00.000Z",
    summary: { totalOrders: 5, totalRevenue: 500, totalRefunds: 1, averageOrderValue: 100 },
    health: {
      revenueTrend: "Stable",
      fraudPressure: "Low",
      marketPressure: "Medium",
      pricingMomentum: "High",
    },
    recommendations: ["One", "Two", "Three"],
    fraud: { highRiskOrders: 1 },
    competitor: { intelligenceEvents: 4 },
    pricing: { suggestionsGenerated: 3 },
    profit: { opportunitiesIdentified: 2 },
    trends: [],
    customers: { topRisky: [] },
    pricingHighlights: [],
    profitHighlights: [],
    competitorHighlights: [],
  });
  resetModule(subscriptionServicePath);
  const subscriptionService = require(subscriptionServicePath);
  subscriptionService.getCurrentSubscription = async () => ({
    capabilities: {
      "reports.view": true,
    },
  });
  resetModule(middlewarePath);

  resetModule(routesPath);
  const { reportsRouter } = require(routesPath);
  const app = express();
  app.use((req, _res, next) => {
    req.shopifySession = { shop: "test-shop.myshopify.com" };
    next();
  });
  app.use("/reports", reportsRouter);
  const server = app.listen(0);

  try {
    const response = await request(server, "/reports/weekly?shop=test-shop.myshopify.com");
    assert.equal(response.statusCode, 200);
    assert.match(response.body, /"totalRevenue":500/);
    assert.match(response.body, /"pricingMomentum":"High"/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("competitor router returns connector payload", async () => {
  const servicesPath = path.resolve(
    __dirname,
    "../dist/services/competitorService.js"
  );
  const middlewarePath = path.resolve(
    __dirname,
    "../dist/middleware/requireCapability.js"
  );
  const subscriptionServicePath = path.resolve(
    __dirname,
    "../dist/services/subscriptionService.js"
  );
  const routesPath = path.resolve(__dirname, "../dist/routes/competitorRoutes.js");

  resetModule(servicesPath);
  const competitorService = require(servicesPath);
  competitorService.listCompetitorConnectors = async () => [
    {
      id: "website",
      label: "Website crawler",
      description: "Fetches live product pages from tracked competitor domains.",
      connected: true,
      trackedTargets: 3,
      lastIngestedAt: "2026-03-24T10:00:00.000Z",
      readiness: "Healthy",
    },
  ];
  competitorService.getCompetitorOverview = async () => ({
    recentPriceChanges: 10,
    promotionAlerts: 4,
    stockMovementAlerts: 2,
    trackedDomains: 3,
  });
  competitorService.listTrackedCompetitorProducts = async () => [];
  resetModule(subscriptionServicePath);
  const subscriptionService = require(subscriptionServicePath);
  subscriptionService.getCurrentSubscription = async () => ({
    capabilities: {
      "module.competitorIntel": true,
    },
  });
  resetModule(middlewarePath);

  resetModule(routesPath);
  const { competitorRouter } = require(routesPath);
  const app = express();
  app.use((req, _res, next) => {
    req.shopifySession = { shop: "test-shop.myshopify.com" };
    next();
  });
  app.use("/competitor", competitorRouter);
  const server = app.listen(0);

  try {
    const response = await request(
      server,
      "/competitor/connectors?shop=test-shop.myshopify.com"
    );
    assert.equal(response.statusCode, 200);
    assert.match(response.body, /"Website crawler"/);
    assert.match(response.body, /"readiness":"Healthy"/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const http = require("node:http");
const express = require("express");

process.env.SHOPIFY_API_KEY ||= "test-key";
process.env.SHOPIFY_API_SECRET ||= "test-secret";
process.env.SHOPIFY_APP_URL ||= "https://app.vedasuite.in";
process.env.DATABASE_URL ||= "postgresql://example:example@localhost:5432/example";

const SHOP = "test-shop.myshopify.com";

// ---- shared mutable state driven per test ----
const state = {
  shop: SHOP,
  enabledModules: ["fraud", "competitor", "pricing", "profit"],
  store: { id: "store-1", lastSyncStatus: "ready", lastConnectionStatus: "OK", lastSyncAt: new Date() },
  recentOrders: [],
  openHighRisk: [],
  priceHistory: [],
  profitData: [],
  competitorData: [],
  storeEligibleOrderCount: 0,
  storeRefundedEligibleCount: 0,
  orderTotalCount: 0,
  orderWindowTotalCount: 0,
  competitorTotalCount: 0,
  priceHistoryCount: 0,
  profitDataCount: 0,
  throwOnStore: false,
};

const fakePrisma = {
  store: {
    findUnique: async () => {
      if (state.throwOnStore) throw new Error("controlled service error");
      return state.store;
    },
  },
  order: {
    findMany: async (args) => (args.where && args.where.fraudRiskLevel ? state.openHighRisk : state.recentOrders),
    count: async (args) => {
      const w = args.where || {};
      if (w.refunded === true) return state.storeRefundedEligibleCount;
      if (w.status && w.createdAt) return state.storeEligibleOrderCount;
      if (w.createdAt && !w.status) return state.orderWindowTotalCount;
      return state.orderTotalCount;
    },
  },
  priceHistory: { findMany: async () => state.priceHistory, count: async () => state.priceHistoryCount },
  profitOptimizationData: { findMany: async () => state.profitData, count: async () => state.profitDataCount },
  competitorData: { findMany: async () => state.competitorData, count: async () => state.competitorTotalCount },
};

function mockModule(relPath, exports) {
  const abs = require.resolve(path.resolve(__dirname, relPath));
  require.cache[abs] = { id: abs, filename: abs, loaded: true, exports };
}

mockModule("../dist/db/prismaClient.js", { prisma: fakePrisma });
mockModule("../dist/services/subscriptionService.js", { resolveEntitlements: async () => ({ enabledModules: state.enabledModules }) });
mockModule("../dist/services/observabilityService.js", { logEvent: () => {} });

// Require the REAL route + service after mocks are in place.
const { insightsRouter } = require(path.resolve(__dirname, "../dist/routes/insightsRoutes.js"));

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  if (state.shop) req.shopifySession = { shop: state.shop };
  next();
});
app.use("/api/insights", insightsRouter);

let server;
test.before(async () => { server = app.listen(0); await new Promise((r) => server.once("listening", r)); });
test.after(() => server && server.close());

function get(pathname) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path: pathname, method: "GET", headers: { "Content-Type": "application/json" } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, json: body ? JSON.parse(body) : null, raw: body }));
    });
    req.on("error", reject);
    req.end();
  });
}

function resetState() {
  Object.assign(state, {
    shop: SHOP, enabledModules: ["fraud", "competitor", "pricing", "profit"],
    store: { id: "store-1", lastSyncStatus: "ready", lastConnectionStatus: "OK", lastSyncAt: new Date() },
    recentOrders: [], openHighRisk: [], priceHistory: [], profitData: [], competitorData: [],
    storeEligibleOrderCount: 0, storeRefundedEligibleCount: 0, orderTotalCount: 0, orderWindowTotalCount: 0,
    competitorTotalCount: 0, priceHistoryCount: 0, profitDataCount: 0, throwOnStore: false,
  });
}

const now = new Date();
function seedRichStore() {
  // return-abuse: customer c1 with 6 recent paid orders, 5 refunded (+ a PII field that must NOT leak)
  state.recentOrders = Array.from({ length: 6 }, (_, i) => ({
    id: "o" + i, status: "paid", refunded: i < 5, totalAmount: 100, currency: "USD",
    createdAt: now, customerId: "c1", email: "shopper@example.com", ipAddress: "9.9.9.9",
  }));
  state.openHighRisk = Array.from({ length: 3 }, (_, i) => ({ id: "hr" + i, fraudRiskLevel: "High", status: "paid", refunded: false, totalAmount: 200 }));
  state.priceHistory = [{ id: "ph1", productHandle: "shirt", currentPrice: 20, recommendedPrice: 25, expectedProfitGain: 50, expectedMarginDelta: 5, createdAt: now }];
  state.profitData = [{ id: "pd1", productHandle: "shirt", productCost: 40, sellingPrice: 100, salesVelocity: 10, projectedMonthlyProfit: null, projectedMarginIncrease: 3, optimalPrice: 120, createdAt: now }];
  state.competitorData = [{ id: "cd1", productHandle: "shirt", price: 80, collectedAt: now, insightsJson: JSON.stringify({ confidenceLabel: "high" }) }];
  state.storeEligibleOrderCount = 100; state.storeRefundedEligibleCount = 5;
  state.orderTotalCount = 100; state.orderWindowTotalCount = state.recentOrders.length;
  state.competitorTotalCount = 1; state.priceHistoryCount = 1; state.profitDataCount = 1;
}

// ---------------- Tests ----------------

test("successful response has the full contract shape and one generatedAt", async () => {
  resetState(); seedRichStore();
  const r = await get("/api/insights/dashboard");
  assert.equal(r.status, 200);
  for (const k of ["executiveSummary", "opportunities", "criticalAttention", "revenueLeak", "dataCoverage", "generatedAt"]) {
    assert.ok(k in r.json, "missing " + k);
  }
  assert.ok(Array.isArray(r.json.opportunities));
  assert.ok(Array.isArray(r.json.revenueLeak.potentialUpside));
  assert.ok(Array.isArray(r.json.revenueLeak.revenueAtRisk));
  assert.equal(r.json.executiveSummary.generatedAt, r.json.generatedAt);
});

test("fully entitled merchant sees all modules", async () => {
  resetState(); seedRichStore();
  const r = await get("/api/insights/dashboard");
  const modules = new Set([...r.json.opportunities, ...r.json.criticalAttention].map((i) => i.module));
  assert.ok(modules.has("competitor") || r.json.revenueLeak.revenueAtRisk.some((g) => g.items.some((it) => /Competitor/.test(it.label))));
  const covModules = r.json.dataCoverage.map((c) => c.module);
  assert.ok(covModules.includes("competitor"));
  assert.ok(covModules.includes("pricing"));
});

test("lower plan (fraud only): no competitor/pricing data anywhere", async () => {
  resetState(); seedRichStore();
  state.enabledModules = ["fraud"];
  const r = await get("/api/insights/dashboard");
  const all = [...r.json.opportunities, ...r.json.criticalAttention];
  assert.ok(!all.some((i) => i.module === "competitor" || i.module === "pricing" || i.module === "profit"), "gated module leaked into insights");
  assert.ok(!r.json.dataCoverage.some((c) => c.module === "competitor" || c.module === "pricing"), "gated coverage leaked");
  const competitorInLeak = r.json.revenueLeak.revenueAtRisk.some((g) => g.items.some((it) => /Competitor/.test(it.label)));
  assert.ok(!competitorInLeak, "competitor leaked into revenue leak totals");
});

test("empty store: 200, dataReady false, empty lists", async () => {
  resetState(); // store exists but no rows / counts all 0
  const r = await get("/api/insights/dashboard");
  assert.equal(r.status, 200);
  assert.equal(r.json.executiveSummary.dataReady, false);
  assert.equal(r.json.opportunities.length, 0);
  assert.equal(r.json.criticalAttention.length, 0);
  assert.equal(r.json.revenueLeak.potentialUpside.length, 0);
  assert.equal(r.json.revenueLeak.revenueAtRisk.length, 0);
});

test("missing authenticated store: no shop => 400; store not found => 200 empty", async () => {
  resetState();
  state.shop = null; // no session shop
  const r1 = await get("/api/insights/dashboard");
  assert.equal(r1.status, 400);

  resetState();
  state.store = null; // store not in DB
  const r2 = await get("/api/insights/dashboard");
  assert.equal(r2.status, 200);
  assert.equal(r2.json.executiveSummary.dataReady, false);
});

test("controlled service error => 503", async () => {
  resetState();
  state.throwOnStore = true;
  const r = await get("/api/insights/dashboard");
  assert.equal(r.status, 503);
  assert.equal(r.json.error.code, "INSIGHTS_UNAVAILABLE");
});

test("return-abuse: order window within the bounded read produces a normal insight", async () => {
  resetState(); seedRichStore();
  const r = await get("/api/insights/dashboard");
  const all = [...r.json.opportunities, ...r.json.criticalAttention];
  assert.ok(all.some((i) => i.module === "return_abuse"), "expected a return_abuse insight when the order window is within the bounded read");
});

test("return-abuse: truncated order window suppresses return-abuse insights instead of computing them from partial data", async () => {
  resetState(); seedRichStore();
  // Simulate a merchant whose true 90-day order volume exceeds the bounded
  // read (READ_CAPS.orders = 5000) — `recentOrders` no longer represents the
  // complete window, so per-customer grouping can no longer be trusted.
  state.orderWindowTotalCount = 5001;
  const r = await get("/api/insights/dashboard");
  const all = [...r.json.opportunities, ...r.json.criticalAttention];
  assert.ok(!all.some((i) => i.module === "return_abuse"), "return-abuse insights must not be computed from a truncated order window");
  const fraudCoverage = r.json.dataCoverage.find((c) => c.module === "fraud");
  assert.ok(fraudCoverage, "fraud coverage entry missing");
  assert.match(fraudCoverage.note || "", /exceeds the analysis bound/i);
  // Other modules must be unaffected by the return-abuse truncation.
  assert.ok(all.some((i) => i.module === "competitor"), "unrelated competitor insight should be unaffected");
});

test("no forbidden PII in the serialized JSON", async () => {
  resetState(); seedRichStore();
  const r = await get("/api/insights/dashboard");
  const s = r.raw;
  assert.ok(!/@example\.com|shopper@|9\.9\.9\.9/.test(s), "raw PII value leaked");
  assert.ok(!/"email"|"ipAddress"|"deviceFingerprint"|"paymentFingerprint"|accessToken/i.test(s), "PII field name leaked");
});

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

process.env.SHOPIFY_API_KEY ||= "test-key";
process.env.SHOPIFY_API_SECRET ||= "test-secret";
process.env.SHOPIFY_APP_URL ||= "https://app.vedasuite.in";
process.env.DATABASE_URL ||= "postgresql://example:example@localhost:5432/example";

/**
 * PART 2 — detector orchestration: store scoping, persistence through the Part 1
 * foundation, idempotency/dedupe, and the guarantee that no store data is
 * written and no automatic action is taken.
 */

function resetModule(p) {
  delete require.cache[require.resolve(p)];
}

const PRISMA_PATH = path.resolve(__dirname, "../dist/db/prismaClient.js");
const OBS_PATH = path.resolve(__dirname, "../dist/services/observabilityService.js");
const ENV_PATH = path.resolve(__dirname, "../dist/config/env.js");
const FINDING_PATH = path.resolve(__dirname, "../dist/services/intelligenceFindingService.js");
const DETECTOR_PATH = path.resolve(__dirname, "../dist/services/intelligenceDetectorService.js");

const NOW = "2026-08-22T00:00:00.000Z";
const DAY = 86_400_000;
const daysAgo = (n) => new Date(new Date(NOW).getTime() - n * DAY);

const STORE = "store-1";
const OTHER_STORE = "store-2";

function buildWorld({ flagEnabled = true, orders = [], customers = [], profitRows = [], snapshots = [] } = {}) {
  [PRISMA_PATH, OBS_PATH, ENV_PATH, FINDING_PATH, DETECTOR_PATH].forEach(resetModule);
  process.env.ENABLE_INTELLIGENCE_FINDING_PERSISTENCE = flagEnabled ? "true" : "false";

  const prisma = require(PRISMA_PATH).prisma;
  const logged = [];
  require(OBS_PATH).logEvent = (level, event, details) => logged.push({ level, event, details });

  const findingRows = [];
  let seq = 0;
  const writes = [];

  prisma.order = {
    findMany: async ({ where, select }) => {
      writes.push({ table: "order", op: "read" });
      return orders.filter(
        (o) =>
          o.storeId === where.storeId &&
          (where.customerId === undefined || o.customerId === where.customerId) &&
          (where.createdAt?.gte === undefined || o.createdAt >= where.createdAt.gte)
      );
    },
  };
  prisma.customer = {
    findMany: async ({ where }) => {
      writes.push({ table: "customer", op: "read" });
      return customers.filter((c) => c.storeId === where.storeId);
    },
  };
  prisma.profitOptimizationData = {
    findMany: async ({ where }) => {
      writes.push({ table: "profitOptimizationData", op: "read" });
      return profitRows.filter((r) => r.storeId === where.storeId);
    },
  };
  prisma.productSnapshot = {
    findMany: async ({ where }) => {
      writes.push({ table: "productSnapshot", op: "read" });
      return snapshots.filter((s) => s.storeId === where.storeId);
    },
  };

  prisma.intelligenceFinding = {
    upsert: async ({ where, update, create }) => {
      writes.push({ table: "intelligenceFinding", op: "upsert" });
      const { storeId, fingerprint } = where.storeId_fingerprint;
      const existing = findingRows.find(
        (r) => r.storeId === storeId && r.fingerprint === fingerprint
      );
      if (existing) {
        for (const [k, v] of Object.entries(update)) {
          existing[k] =
            v && typeof v === "object" && "increment" in v ? (existing[k] ?? 0) + v.increment : v;
        }
        return { ...existing };
      }
      seq += 1;
      const row = { id: `f-${seq}`, ...create };
      findingRows.push(row);
      return { ...row };
    },
    update: async ({ where, data }) => {
      const row = findingRows.find((r) => r.id === where.id);
      Object.assign(row, data);
      return { ...row };
    },
    findFirst: async () => null,
    findMany: async () => findingRows.map((r) => ({ ...r })),
  };

  const detectors = require(DETECTOR_PATH);
  return { detectors, findingRows, logged, writes };
}

/** A customer whose history clearly meets the documented thresholds. */
function lossyCustomerOrders(storeId = STORE, customerId = "c-1") {
  return [
    { id: "o1", storeId, customerId, status: "paid", refunded: true, totalAmount: 300, currency: "USD", createdAt: daysAgo(60) },
    { id: "o2", storeId, customerId, status: "paid", refunded: true, totalAmount: 300, currency: "USD", createdAt: daysAgo(40) },
    { id: "o3", storeId, customerId, status: "paid", refunded: false, totalAmount: 100, currency: "USD", createdAt: daysAgo(20) },
  ];
}

/** Enough store-wide baseline orders to clear minStoreOrders. */
function baselineOrders(storeId = STORE, n = 60) {
  return Array.from({ length: n }, (_, i) => ({
    id: `b${i}`,
    storeId,
    customerId: `bulk-${i}`,
    status: "paid",
    refunded: i < 3,
    totalAmount: 100,
    currency: "USD",
    createdAt: daysAgo(10),
  }));
}

// ===========================================================================
// Customer Loss detector
// ===========================================================================

test("customer loss: a qualifying customer produces one persisted finding", async () => {
  const w = buildWorld({
    customers: [{ id: "c-1", storeId: STORE, fraudSignalsCount: 2, updatedAt: daysAgo(1) }],
    orders: [...lossyCustomerOrders(), ...baselineOrders()],
  });

  const insights = await w.detectors.detectCustomerLoss({ storeId: STORE, nowIso: NOW });

  assert.equal(insights.length, 1);
  assert.equal(insights[0].module, "return_abuse");
  assert.match(insights[0].title, /Repeated refund loss/i);
  assert.equal(w.findingRows.length, 1);
  assert.equal(w.findingRows[0].findingType, "customer_loss_repeated_refund");
  assert.equal(w.findingRows[0].storeId, STORE);
  assert.equal(w.findingRows[0].status, "new");
});

test("customer loss: observed and future risk are both explained, and kept apart", async () => {
  const w = buildWorld({
    customers: [{ id: "c-1", storeId: STORE, fraudSignalsCount: 2, updatedAt: daysAgo(1) }],
    orders: [...lossyCustomerOrders(), ...baselineOrders()],
  });

  const [insight] = await w.detectors.detectCustomerLoss({ storeId: STORE, nowIso: NOW });
  const assumptions = insight.methodology.assumptions.join(" ");

  assert.match(insight.methodology.summary, /NOT added to observed loss/i);
  assert.match(assumptions, /Future risk \(separate\)/i);
  assert.match(assumptions, /upper bound/i);
  assert.match(insight.methodology.caps.join(" "), /Missing inputs/i);
});

test("customer loss: a customer below threshold produces nothing", async () => {
  const w = buildWorld({
    customers: [{ id: "c-1", storeId: STORE, fraudSignalsCount: 0, updatedAt: daysAgo(1) }],
    orders: [
      { id: "o1", storeId: STORE, customerId: "c-1", status: "paid", refunded: true, totalAmount: 50, currency: "USD", createdAt: daysAgo(10) },
      { id: "o2", storeId: STORE, customerId: "c-1", status: "paid", refunded: false, totalAmount: 500, currency: "USD", createdAt: daysAgo(5) },
      ...baselineOrders(),
    ],
  });

  const insights = await w.detectors.detectCustomerLoss({ storeId: STORE, nowIso: NOW });
  assert.equal(insights.length, 0);
  assert.equal(w.findingRows.length, 0, "no finding persisted for a non-pattern");
});

test("customer loss: an insufficient store baseline suppresses all findings", async () => {
  const w = buildWorld({
    customers: [{ id: "c-1", storeId: STORE, fraudSignalsCount: 5, updatedAt: daysAgo(1) }],
    orders: [...lossyCustomerOrders(), ...baselineOrders(STORE, 10)],
  });

  const insights = await w.detectors.detectCustomerLoss({ storeId: STORE, nowIso: NOW });
  assert.equal(insights.length, 0, "no baseline, no finding");
});

// ===========================================================================
// Product Profit detector
// ===========================================================================

test("product profit: a weakened product produces one persisted finding", async () => {
  const w = buildWorld({
    profitRows: [
      { storeId: STORE, productHandle: "widget", sellingPrice: 100, productCost: 85, shippingCost: 5, returnRate: 0, salesVelocity: 3, createdAt: daysAgo(2) },
    ],
    snapshots: [{ storeId: STORE, handle: "widget", title: "Widget", currency: "USD", currentPrice: 100 }],
  });

  const insights = await w.detectors.detectProductProfit({ storeId: STORE, nowIso: NOW });

  assert.equal(insights.length, 1);
  assert.equal(insights[0].module, "profit");
  assert.match(insights[0].title, /retained economics/i);
  assert.equal(w.findingRows.length, 1);
  assert.equal(w.findingRows[0].findingType, "product_profit_weakened_retained_margin");
});

test("product profit: a product with a missing cost is skipped, never guessed", async () => {
  const w = buildWorld({
    profitRows: [
      { storeId: STORE, productHandle: "nocost", sellingPrice: 100, productCost: 0, shippingCost: 5, returnRate: 0, salesVelocity: 3, createdAt: daysAgo(2) },
    ],
    snapshots: [{ storeId: STORE, handle: "nocost", title: "No Cost", currency: "USD", currentPrice: 100 }],
  });

  const insights = await w.detectors.detectProductProfit({ storeId: STORE, nowIso: NOW });
  assert.equal(insights.length, 0, "zero cost must not become a 100% margin finding");
  assert.equal(w.findingRows.length, 0);
});

test("product profit: a healthy product produces nothing", async () => {
  const w = buildWorld({
    profitRows: [
      { storeId: STORE, productHandle: "good", sellingPrice: 100, productCost: 40, shippingCost: 5, returnRate: 0.05, salesVelocity: 9, createdAt: daysAgo(2) },
    ],
    snapshots: [{ storeId: STORE, handle: "good", title: "Good", currency: "USD", currentPrice: 100 }],
  });

  assert.equal((await w.detectors.detectProductProfit({ storeId: STORE, nowIso: NOW })).length, 0);
});

test("product profit: only the LATEST row per handle is evaluated", async () => {
  const w = buildWorld({
    // findMany is ordered desc by createdAt in production; the first row wins.
    profitRows: [
      { storeId: STORE, productHandle: "widget", sellingPrice: 100, productCost: 85, shippingCost: 5, returnRate: 0, salesVelocity: 3, createdAt: daysAgo(1) },
      { storeId: STORE, productHandle: "widget", sellingPrice: 100, productCost: 10, shippingCost: 5, returnRate: 0, salesVelocity: 3, createdAt: daysAgo(50) },
    ],
    snapshots: [{ storeId: STORE, handle: "widget", title: "Widget", currency: "USD", currentPrice: 100 }],
  });

  const insights = await w.detectors.detectProductProfit({ storeId: STORE, nowIso: NOW });
  assert.equal(insights.length, 1, "one finding per product, not one per row");
  assert.equal(w.findingRows.length, 1);
});

test("product profit: a product with no snapshot currency is skipped", async () => {
  const w = buildWorld({
    profitRows: [
      { storeId: STORE, productHandle: "nocur", sellingPrice: 100, productCost: 85, shippingCost: 5, returnRate: 0, salesVelocity: 3, createdAt: daysAgo(2) },
    ],
    snapshots: [{ storeId: STORE, handle: "nocur", title: "No Currency", currency: null, currentPrice: 100 }],
  });

  assert.equal((await w.detectors.detectProductProfit({ storeId: STORE, nowIso: NOW })).length, 0);
});

// ===========================================================================
// Idempotency / dedupe — the Part 1 foundation contract
// ===========================================================================

test("re-running both detectors updates the SAME findings, never duplicating", async () => {
  const w = buildWorld({
    customers: [{ id: "c-1", storeId: STORE, fraudSignalsCount: 2, updatedAt: daysAgo(1) }],
    orders: [...lossyCustomerOrders(), ...baselineOrders()],
    profitRows: [
      { storeId: STORE, productHandle: "widget", sellingPrice: 100, productCost: 85, shippingCost: 5, returnRate: 0, salesVelocity: 3, createdAt: daysAgo(2) },
    ],
    snapshots: [{ storeId: STORE, handle: "widget", title: "Widget", currency: "USD", currentPrice: 100 }],
  });

  await w.detectors.runIntelligenceDetectors({ storeId: STORE, nowIso: NOW });
  assert.equal(w.findingRows.length, 2, "one customer-loss + one product-profit finding");

  const firstIds = w.findingRows.map((r) => r.id).sort();

  for (let i = 0; i < 3; i += 1) {
    await w.detectors.runIntelligenceDetectors({ storeId: STORE, nowIso: NOW });
  }

  assert.equal(w.findingRows.length, 2, "still exactly two rows after four runs");
  assert.deepEqual(w.findingRows.map((r) => r.id).sort(), firstIds, "same row identities");
  for (const row of w.findingRows) {
    assert.equal(row.detectionCount, 4, "detection count accumulates on the same row");
  }
});

test("a changed amount does not mint a new finding for the same subject", async () => {
  const w = buildWorld({
    customers: [{ id: "c-1", storeId: STORE, fraudSignalsCount: 2, updatedAt: daysAgo(1) }],
    orders: [...lossyCustomerOrders(), ...baselineOrders()],
  });

  await w.detectors.detectCustomerLoss({ storeId: STORE, nowIso: NOW });
  const fingerprint = w.findingRows[0].fingerprint;

  // A later, larger refund history for the same customer.
  const w2 = buildWorld({
    customers: [{ id: "c-1", storeId: STORE, fraudSignalsCount: 2, updatedAt: daysAgo(1) }],
    orders: [
      ...lossyCustomerOrders(),
      { id: "o4", storeId: STORE, customerId: "c-1", status: "paid", refunded: true, totalAmount: 999, currency: "USD", createdAt: daysAgo(5) },
      ...baselineOrders(),
    ],
  });
  await w2.detectors.detectCustomerLoss({ storeId: STORE, nowIso: NOW });

  assert.equal(
    w2.findingRows[0].fingerprint,
    fingerprint,
    "fingerprint depends on the subject, not on the money"
  );
});

test("the feature flag gates persistence but not detection", async () => {
  const w = buildWorld({
    flagEnabled: false,
    customers: [{ id: "c-1", storeId: STORE, fraudSignalsCount: 2, updatedAt: daysAgo(1) }],
    orders: [...lossyCustomerOrders(), ...baselineOrders()],
  });

  const insights = await w.detectors.detectCustomerLoss({ storeId: STORE, nowIso: NOW });
  assert.equal(insights.length, 1, "the insight is still computed and returned");
  assert.equal(w.findingRows.length, 0, "but nothing is persisted while the flag is off");
});

// ===========================================================================
// Store isolation and no-write guarantees
// ===========================================================================

test("detectors are store-scoped: another store's data never contributes", async () => {
  const w = buildWorld({
    customers: [
      { id: "c-1", storeId: STORE, fraudSignalsCount: 2, updatedAt: daysAgo(1) },
      { id: "c-x", storeId: OTHER_STORE, fraudSignalsCount: 9, updatedAt: daysAgo(1) },
    ],
    orders: [
      ...lossyCustomerOrders(),
      ...baselineOrders(),
      ...lossyCustomerOrders(OTHER_STORE, "c-x"),
      ...baselineOrders(OTHER_STORE),
    ],
  });

  const insights = await w.detectors.detectCustomerLoss({ storeId: STORE, nowIso: NOW });
  assert.equal(insights.length, 1);
  assert.equal(insights[0].storeId, STORE);
  assert.equal(w.findingRows.length, 1);
  assert.equal(w.findingRows[0].storeId, STORE);
});

test("detectors write ONLY to IntelligenceFinding — never to store data", async () => {
  const w = buildWorld({
    customers: [{ id: "c-1", storeId: STORE, fraudSignalsCount: 2, updatedAt: daysAgo(1) }],
    orders: [...lossyCustomerOrders(), ...baselineOrders()],
    profitRows: [
      { storeId: STORE, productHandle: "widget", sellingPrice: 100, productCost: 85, shippingCost: 5, returnRate: 0, salesVelocity: 3, createdAt: daysAgo(2) },
    ],
    snapshots: [{ storeId: STORE, handle: "widget", title: "Widget", currency: "USD", currentPrice: 100 }],
  });

  await w.detectors.runIntelligenceDetectors({ storeId: STORE, nowIso: NOW });

  const writeOps = w.writes.filter((x) => x.op !== "read");
  assert.ok(writeOps.length > 0, "findings were written");
  for (const op of writeOps) {
    assert.equal(
      op.table,
      "intelligenceFinding",
      `no write may touch ${op.table} — detectors must never modify store data`
    );
  }
});

test("recommended actions are advisory and never automatic", async () => {
  const w = buildWorld({
    customers: [{ id: "c-1", storeId: STORE, fraudSignalsCount: 2, updatedAt: daysAgo(1) }],
    orders: [...lossyCustomerOrders(), ...baselineOrders()],
    profitRows: [
      { storeId: STORE, productHandle: "widget", sellingPrice: 100, productCost: 85, shippingCost: 5, returnRate: 0, salesVelocity: 3, createdAt: daysAgo(2) },
    ],
    snapshots: [{ storeId: STORE, handle: "widget", title: "Widget", currency: "USD", currentPrice: 100 }],
  });

  const { customerLoss, productProfit } = await w.detectors.runIntelligenceDetectors({
    storeId: STORE,
    nowIso: NOW,
  });

  for (const insight of [...customerLoss, ...productProfit]) {
    assert.equal(insight.easeOfAction, "manual", "nothing is one-click automatic");
    assert.match(insight.recommendedAction, /No automatic action was taken/i);
    assert.match(insight.recommendedAction, /^Review/i);
  }
});

test("empty stores produce no findings and no errors", async () => {
  const w = buildWorld({});
  const result = await w.detectors.runIntelligenceDetectors({ storeId: STORE, nowIso: NOW });
  assert.deepEqual(result.customerLoss, []);
  assert.deepEqual(result.productProfit, []);
  assert.equal(w.findingRows.length, 0);
});

test("detection is logged with counts for observability", async () => {
  const w = buildWorld({
    customers: [{ id: "c-1", storeId: STORE, fraudSignalsCount: 2, updatedAt: daysAgo(1) }],
    orders: [...lossyCustomerOrders(), ...baselineOrders()],
  });

  await w.detectors.detectCustomerLoss({ storeId: STORE, nowIso: NOW });
  const event = w.logged.find((e) => e.event === "intelligence.customer_loss_detected");
  assert.ok(event);
  assert.equal(event.details.findings, 1);
  assert.equal(event.details.storeId, STORE);
});

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

process.env.SHOPIFY_API_KEY ||= "test-key";
process.env.SHOPIFY_API_SECRET ||= "test-secret";
process.env.SHOPIFY_APP_URL ||= "https://app.vedasuite.in";
process.env.DATABASE_URL ||= "postgresql://example:example@localhost:5432/example";

/**
 * THE STAGING SEED PLAN, PROVEN BEFORE IT IS USED.
 *
 * scripts/seed-staging-test-data.js creates orders in a Shopify development
 * store so the lifecycle smoke test has something to act on. But a fixture
 * nobody has verified is just a hope: if the plan does not actually clear the
 * documented thresholds, the operator runs it, syncs, sees an empty Action
 * Center, and cannot tell whether the FIXTURE is wrong or the PRODUCT is.
 *
 * So this takes the script's real plan — the same exported function the CLI
 * uses, not a copy — maps it to the rows the sync would persist, and runs the
 * real detector over it.
 *
 * If a threshold in customerLossCalc.ts is ever raised past this fixture, this
 * test fails and the correct response is a BIGGER FIXTURE. Never a smaller
 * threshold.
 */

const d = (p) => path.resolve(__dirname, `../dist/${p}`);
const resetModule = (p) => delete require.cache[require.resolve(p)];

const seed = require(path.resolve(__dirname, "../scripts/seed-staging-test-data.js"));
const { CUSTOMER_LOSS } = require(d("services/customerLossCalc.js"));

const STORE = "store-1";

/**
 * Maps the seed plan to the rows the sync would write.
 *
 * Deliberately mirrors shopifyAdminService's own mapping: `refunded` comes from
 * displayFinancialStatus being REFUNDED, and `status` is "paid", which is one
 * of ELIGIBLE_ORDER_STATUSES.
 */
function rowsFromPlan() {
  const plan = seed.buildPlan();
  const orders = plan.map((item, i) => ({
    id: `order-${i}`,
    storeId: STORE,
    customerId: `cust-${item.customerIndex}`,
    status: "paid",
    refunded: item.refund,
    totalAmount: item.amount,
    currency: "USD",
    fraudRiskLevel: "Low",
    createdAt: new Date(item.createdAt),
  }));

  const customerIndexes = [...new Set(plan.map((p) => p.customerIndex))];
  const customers = customerIndexes.map((index) => ({
    id: `cust-${index}`,
    storeId: STORE,
    fraudSignalsCount: 0,
    updatedAt: new Date(),
  }));

  return { orders, customers, plan };
}

function buildWorld({ orders, customers }) {
  const PATHS = [
    d("config/env.js"),
    d("db/prismaClient.js"),
    d("services/observabilityService.js"),
    d("services/intelligenceFindingService.js"),
    d("services/intelligenceDetectorService.js"),
  ];
  PATHS.forEach((p) => {
    try {
      resetModule(p);
    } catch {
      /* not yet loaded */
    }
  });
  process.env.ENABLE_INTELLIGENCE_FINDING_PERSISTENCE = "true";

  const prisma = require(d("db/prismaClient.js")).prisma;
  require(d("services/observabilityService.js")).logEvent = () => {};

  const rows = [];
  let seq = 0;

  prisma.order = {
    findMany: async ({ where }) =>
      orders.filter(
        (o) =>
          o.storeId === where.storeId &&
          (where.createdAt?.gte === undefined || o.createdAt >= where.createdAt.gte) &&
          (where.customerId === undefined || o.customerId === where.customerId)
      ),
  };
  prisma.customer = {
    findMany: async ({ where }) => customers.filter((c) => c.storeId === where.storeId),
  };
  prisma.syncJob = { findMany: async () => [] };
  prisma.store = { findUnique: async () => ({ id: STORE, lastSyncAt: new Date() }) };
  prisma.productSnapshot = { findMany: async () => [] };
  prisma.profitOptimizationData = { findMany: async () => [] };
  prisma.priceHistory = { findMany: async () => [] };
  prisma.competitorDomain = { findMany: async () => [] };
  prisma.competitorData = { findMany: async () => [] };
  prisma.intelligenceFinding = {
    findUnique: async () => null,
    upsert: async ({ create }) => {
      seq += 1;
      const row = { id: `f-${seq}`, ...create };
      rows.push(row);
      return { ...row };
    },
    update: async () => ({}),
    findFirst: async () => null,
    findMany: async () => rows.map((r) => ({ ...r })),
    updateMany: async () => ({ count: 0 }),
  };

  return { rows, detectors: require(d("services/intelligenceDetectorService.js")) };
}

// ===========================================================================

test("the seed plan clears the store-baseline threshold with room to spare", () => {
  const { orders } = rowsFromPlan();
  assert.ok(
    orders.length >= CUSTOMER_LOSS.minStoreOrders,
    `plan has ${orders.length} orders; the detector needs ${CUSTOMER_LOSS.minStoreOrders}`
  );
  assert.ok(orders.length >= 50, "the brief asked for at least 50 orders");
});

test("the seed plan contains a customer that qualifies on merit", () => {
  const { plan } = rowsFromPlan();

  const byCustomer = new Map();
  for (const item of plan) {
    const e = byCustomer.get(item.customerIndex) ?? { orders: 0, refunds: 0, value: 0, refunded: 0 };
    e.orders += 1;
    e.value += item.amount;
    if (item.refund) {
      e.refunds += 1;
      e.refunded += item.amount;
    }
    byCustomer.set(item.customerIndex, e);
  }

  const qualifying = [...byCustomer.values()].filter(
    (e) =>
      e.orders >= CUSTOMER_LOSS.minEligibleOrders &&
      e.refunds >= CUSTOMER_LOSS.minRefundedOrders &&
      e.refunded / e.value >= CUSTOMER_LOSS.minObservedLossRatio
  );

  assert.equal(qualifying.length, 1, "exactly one shopper should qualify — a clean signal");
  const [target] = qualifying;
  assert.ok(target.orders >= 3, "at least 3 orders, as the brief requires");
  assert.ok(target.refunds >= 2, "at least 2 refunds, as the brief requires");

  // Multiple customers, so the baseline is a distribution and not one shopper.
  assert.ok(byCustomer.size >= 5, "the store baseline must span several customers");

  // The STORE's own refund rate must stay low, otherwise the lossy customer is
  // not standing out against a healthy baseline but against a broken one.
  const storeRefundRate = plan.filter((p) => p.refund).length / plan.length;
  assert.ok(storeRefundRate < 0.2, `store refund rate ${storeRefundRate} is too high to be a baseline`);
});

test("PROOF: running the real detector over the seed plan produces a Customer Loss finding", async () => {
  // The whole point. No threshold is relaxed, no evidence is fabricated: this
  // is the shipped detector, over the rows the shipped sync would write, from
  // the plan the shipped script creates.
  const { orders, customers } = rowsFromPlan();
  const w = buildWorld({ orders, customers });

  const insights = await w.detectors.detectCustomerLoss({
    storeId: STORE,
    nowIso: new Date().toISOString(),
  });

  assert.ok(
    insights.length > 0,
    "the seed plan must produce at least one Customer Loss insight, or the " +
      "staging smoke test cannot possibly pass"
  );
  assert.ok(w.rows.length > 0, "and it must be persisted as a finding");
  for (const row of w.rows) {
    assert.equal(row.module, "return_abuse");
    assert.equal(row.status, "new");
    assert.ok(row.snapshotJson, "with the evidence that raised it attached");
  }
});

test("SAFETY: the seed script cannot run without its explicit gate", () => {
  const fs = require("node:fs");
  const src = fs.readFileSync(
    path.resolve(__dirname, "../scripts/seed-staging-test-data.js"),
    "utf8"
  );
  // A data-creating script that can execute as a side effect of a build is a
  // production incident waiting for the wrong environment variable.
  assert.match(src, /SEED_CONFIRM !== REQUIRED_CONFIRMATION/);
  assert.match(src, /myshopify\\\.com/, "it must refuse any non-development-store domain");
  assert.match(src, /require\.main === module/, "importing it must not seed anything");
});

test("SAFETY: the seed script writes no findings and no VedaSuite database rows", () => {
  const fs = require("node:fs");
  // CODE only. The header documents that the script creates no
  // IntelligenceFinding rows, and a whole-file regex cannot tell that promise
  // apart from a violation of it.
  const code = fs
    .readFileSync(path.resolve(__dirname, "../scripts/seed-staging-test-data.js"), "utf8")
    .split(/\r?\n/)
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");

  // Findings must be produced by the real sync -> detection pipeline. A script
  // that inserts them directly would make the smoke test prove nothing.
  assert.doesNotMatch(code, /intelligenceFinding/i);
  assert.doesNotMatch(code, /prisma/i);
  assert.doesNotMatch(code, /DATABASE_URL/);
  // And it must reach Shopify's Admin API only — the shop domain is
  // interpolated, so the literal host never appears in the source.
  assert.match(code, /https:\/\/\$\{shop\}\/admin\/api\//);
});

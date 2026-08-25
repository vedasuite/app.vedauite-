const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

process.env.SHOPIFY_API_KEY ||= "test-key";
process.env.SHOPIFY_API_SECRET ||= "test-secret";
process.env.SHOPIFY_APP_URL ||= "https://app.vedasuite.in";
process.env.DATABASE_URL ||= "postgresql://example:example@localhost:5432/example";

/**
 * THE STAGING SEED PLAN, PROVEN BEFORE IT IS USED.
 *
 * The staging console creates orders in a Shopify development store so the
 * lifecycle smoke test has something real to act on. But a fixture nobody has
 * verified is just a hope: if the plan does not actually clear the documented
 * thresholds, the operator seeds, syncs, sees an empty Action Center, and
 * cannot tell whether the FIXTURE is wrong or the PRODUCT is.
 *
 * So this takes the real exported plan — the same function the console uses,
 * not a copy — maps it to the rows the sync would persist, and runs the real
 * detector over it.
 *
 * If a threshold in customerLossCalc.ts is ever raised past this fixture, this
 * test fails and the correct response is a BIGGER FIXTURE. Never a smaller
 * threshold.
 */

const d = (p) => path.resolve(__dirname, `../dist/${p}`);
const resetModule = (p) => delete require.cache[require.resolve(p)];

const seedPlan = require(d("services/stagingSeedPlan.js"));
const { CUSTOMER_LOSS } = require(d("services/customerLossCalc.js"));

const STORE = "store-1";
/** Fixed clock so the plan is identical on every run. */
const NOW_MS = Date.UTC(2026, 7, 25);

/**
 * Maps the plan to the rows the sync would write.
 *
 * Mirrors shopifyAdminService's own mapping: `refunded` comes from
 * displayFinancialStatus being REFUNDED, and `status` is "paid", one of
 * ELIGIBLE_ORDER_STATUSES.
 */
function rowsFromPlan() {
  const plan = seedPlan.buildStagingSeedPlan(NOW_MS);
  const orders = plan.map((item, i) => ({
    id: `order-${i}`,
    storeId: STORE,
    customerId: `cust-${item.shopperIndex}`,
    status: "paid",
    refunded: item.refunded,
    totalAmount: item.amount,
    currency: "USD",
    fraudRiskLevel: "Low",
    createdAt: new Date(item.processedAt),
  }));

  const customers = [...new Set(plan.map((p) => p.shopperIndex))].map((index) => ({
    id: `cust-${index}`,
    storeId: STORE,
    fraudSignalsCount: 0,
    updatedAt: new Date(NOW_MS),
  }));

  return { orders, customers, plan };
}

function buildWorld({ orders, customers }) {
  [
    d("config/env.js"),
    d("db/prismaClient.js"),
    d("services/observabilityService.js"),
    d("services/intelligenceFindingService.js"),
    d("services/intelligenceDetectorService.js"),
  ].forEach((p) => {
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
  prisma.store = { findUnique: async () => ({ id: STORE, lastSyncAt: new Date(NOW_MS) }) };
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

test("the seed plan contains a shopper that qualifies on merit", () => {
  const summary = seedPlan.summariseStagingSeedPlan(
    seedPlan.buildStagingSeedPlan(NOW_MS)
  );

  assert.equal(summary.qualifyingShoppers, 1, "exactly one shopper — a clean signal");
  const target = summary.shoppers.find((s) => s.shouldQualify);
  assert.ok(target.orders >= CUSTOMER_LOSS.minEligibleOrders, "at least 3 orders");
  assert.ok(target.refunds >= CUSTOMER_LOSS.minRefundedOrders, "at least 2 refunds");
  assert.ok(target.refundedShare >= CUSTOMER_LOSS.minObservedLossRatio);

  // Several shoppers, so the baseline is a distribution and not one customer.
  assert.ok(summary.shoppers.length >= 5, "the baseline must span several shoppers");

  // The STORE's own refund rate must stay low, otherwise the lossy shopper is
  // standing out against a broken baseline rather than a healthy one.
  assert.ok(
    summary.storeRefundRate < 0.2,
    `store refund rate ${summary.storeRefundRate} is too high to be a baseline`
  );
});

test("PROOF: running the real detector over the seed plan produces a Customer Loss finding", async () => {
  // The whole point. No threshold is relaxed and no evidence is fabricated:
  // this is the shipped detector, over the rows the shipped sync would write,
  // from the plan the shipped console creates.
  const { orders, customers } = rowsFromPlan();
  const w = buildWorld({ orders, customers });

  const insights = await w.detectors.detectCustomerLoss({
    storeId: STORE,
    nowIso: new Date(NOW_MS).toISOString(),
  });

  assert.ok(
    insights.length > 0,
    "the seed plan must produce a Customer Loss insight, or the staging smoke " +
      "test cannot possibly pass"
  );
  assert.ok(w.rows.length > 0, "and it must be persisted as a finding");
  for (const row of w.rows) {
    assert.equal(row.module, "return_abuse");
    assert.equal(row.status, "new");
    assert.ok(row.snapshotJson, "with the evidence that raised it attached");
  }
});

// ===========================================================================
// The console's guards
// ===========================================================================

const routerSrc = fs.readFileSync(
  path.resolve(__dirname, "../src/routes/stagingSeedRoutes.ts"),
  "utf8"
);
const serviceSrc = fs.readFileSync(
  path.resolve(__dirname, "../src/services/stagingSeedService.ts"),
  "utf8"
);

test("SAFETY: only development stores can be seeded", () => {
  for (const bad of [
    "app.vedasuite.in",
    "vedasuite.in",
    "example.com",
    "shop.myshopify.com.evil.net",
    "",
    null,
    undefined,
  ]) {
    assert.equal(
      seedPlan.isSeedableShopDomain(bad),
      false,
      `${bad} must not be seedable`
    );
  }
  assert.equal(seedPlan.isSeedableShopDomain("veda-dev.myshopify.com"), true);
});

test("SAFETY: the console does not exist unless STAGING_SEED_TOKEN is set", () => {
  // Secure by default: production never sets it, so on production every route
  // here 404s. Same pattern supportAdminRoutes already uses.
  assert.match(routerSrc, /const expected = process\.env\.STAGING_SEED_TOKEN;/);
  assert.match(routerSrc, /if \(!expected\) \{[\s\S]{0,120}?404/);
  // Wrong token is also 404, never 401 — the console must not be discoverable.
  assert.match(routerSrc, /provided !== expected[\s\S]{0,120}?404/);
});

test("SAFETY: creating data requires a typed confirmation, not just a page load", () => {
  // An accidental visit, a bookmark or a browser prefetch must not seed.
  assert.match(routerSrc, /CONFIRM_PHRASE/);
  assert.match(routerSrc, /requireConfirm && req\.body\?\.confirm !== CONFIRM_PHRASE/);
  // And the two data-creating endpoints must both demand it.
  assert.match(routerSrc, /"\/preflight"[\s\S]{0,400}?resolveAction\(req, res, true\)/);
  assert.match(routerSrc, /"\/run"[\s\S]{0,400}?resolveAction\(req, res, true\)/);
});

test("SAFETY: the seed writes no findings and no VedaSuite database rows", () => {
  // Findings must come from the real sync -> detection pipeline. A seeder that
  // inserts them directly would make the whole smoke test prove nothing.
  const code = serviceSrc
    .split(/\r?\n/)
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");

  assert.doesNotMatch(code, /intelligenceFinding/i);
  assert.doesNotMatch(code, /prisma\./);
  // It reaches Shopify through the app's own client, so it inherits the stored
  // offline token and no operator ever handles a credential.
  assert.match(code, /shopifyGraphQL/);
});

test("SAFETY: every seeded order carries the removable test tag", () => {
  assert.equal(seedPlan.STAGING_TEST_TAG, "vedasuite-test-data");
  assert.match(serviceSrc, /tags: \[STAGING_TEST_TAG\]/);
  // And the count query filters on that same tag, so cleanup is verifiable.
  assert.match(serviceSrc, /tag:'\$\{STAGING_TEST_TAG\}'/);
});

test("SAFETY: the plan has exactly one definition", () => {
  // The CLI script that used to duplicate this was removed precisely so the
  // console and the fixture cannot drift apart.
  assert.equal(
    fs.existsSync(path.resolve(__dirname, "../scripts/seed-staging-test-data.js")),
    false,
    "the duplicate CLI seeder must not come back"
  );
  assert.match(routerSrc, /from "\.\.\/services\/stagingSeedPlan"/);
});

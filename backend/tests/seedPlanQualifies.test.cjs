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
  // The phrase is compared, whichever phrase the endpoint requires. Two
  // consoles now share this guard with DIFFERENT phrases, so one cannot be
  // triggered by the other's confirmation.
  assert.match(routerSrc, /requireConfirm && req\.body\?\.confirm !== phrase/);
  assert.match(routerSrc, /const CONFIRM_PHRASE = "SEED STAGING"/);
  assert.match(routerSrc, /const PRODUCT_CONFIRM_PHRASE = "CREATE TEST PRODUCTS"/);

  // Every data-creating endpoint demands a confirmation...
  assert.match(routerSrc, /"\/run"[\s\S]{0,400}?resolveAction\(req, res, true\)/);
  assert.match(
    routerSrc,
    /"\/products\/run"[\s\S]{0,400}?resolveAction\(req, res, true, PRODUCT_CONFIRM_PHRASE\)/
  );

  // ...and the read-only ones correctly do not, so an operator can always
  // check what exists without being able to create anything by accident.
  assert.match(routerSrc, /"\/state"[\s\S]{0,400}?resolveAction\(req, res, false\)/);
  assert.match(routerSrc, /"\/products\/state"[\s\S]{0,400}?resolveAction\(req, res, false\)/);
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
  // It reaches Shopify through the app's OWN stored offline token, so no
  // operator ever handles a credential. It deliberately uses a local client
  // rather than the shared shopifyGraphQL, because that one discards response
  // headers and Retry-After would be unreachable through it — and because it is
  // the production sync path, which this work must not touch.
  assert.match(code, /resolveOfflineInstallation/);
  assert.match(code, /X-Shopify-Access-Token/);
  assert.doesNotMatch(code, /from "\.\/shopifyAdminService"/);
});

test("SAFETY: every seeded order carries the removable group tag AND an identity tag", () => {
  assert.equal(seedPlan.STAGING_TEST_TAG, "vedasuite-test-data");
  // TWO tags. The group tag makes the whole seed findable and removable; the
  // identity tag is what makes a re-run resumable and duplicate-proof.
  assert.match(serviceSrc, /tags: \[STAGING_TEST_TAG, seedLabelTag\(order\.label\)\]/);
  // And the readback filters on the group tag, so cleanup is verifiable.
  assert.match(serviceSrc, /tag:'\$\{STAGING_TEST_TAG\}'/);

  // The identity tag must round-trip, or resume silently recreates everything.
  const tag = seedPlan.seedLabelTag("baseline-7");
  assert.equal(seedPlan.labelFromSeedTag(tag), "baseline-7");
  assert.equal(seedPlan.labelFromSeedTag(seedPlan.STAGING_TEST_TAG), null);
  assert.equal(seedPlan.labelFromSeedTag("unrelated-tag"), null);
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

// ===========================================================================
// GUARD 0 — production refuses unconditionally
// ===========================================================================

test("SAFETY: production is identified, and an unknown environment counts as production", () => {
  // Fails CLOSED. The cost of being wrong here is a wasted staging trip; the
  // cost of being wrong the other way is fabricated orders in a real store.
  for (const productionish of [
    "https://app.vedasuite.in",
    "https://app.vedasuite.in/",
    "https://vedasuite.in",
    "https://VEDASUITE.IN",
    "https://api.vedasuite.in",
    "https://anything.vedasuite.in/some/path",
    // Unidentifiable: absent, blank, or not a URL at all.
    "",
    "   ",
    null,
    undefined,
    "not-a-url",
    "://broken",
  ]) {
    assert.equal(
      seedPlan.isProductionRuntime(productionish),
      true,
      `${JSON.stringify(productionish)} must be treated as production`
    );
  }
});

test("staging is still correctly identified as NOT production", () => {
  for (const staging of [
    "https://vedasuite-staging.onrender.com",
    "https://vedasuite-staging.onrender.com/",
    "http://localhost:3000",
    "https://some-preview.onrender.com",
  ]) {
    assert.equal(
      seedPlan.isProductionRuntime(staging),
      false,
      `${staging} must remain seedable`
    );
  }
});

test("SAFETY: a lookalike domain does not slip past the production check", () => {
  // Suffix matching must be on a dot boundary, or "notvedasuite.in" and
  // "vedasuite.in.evil.com" would be judged wrongly in one direction or other.
  assert.equal(seedPlan.isProductionRuntime("https://notvedasuite.in"), false);
  assert.equal(seedPlan.isProductionRuntime("https://vedasuite.in.evil.com"), false);
  assert.equal(seedPlan.isProductionRuntime("https://sub.vedasuite.in"), true);
});

test("REGRESSION: guard 0 runs BEFORE the credential check", () => {
  // Order matters. A credential can be leaked, copied, or set on the wrong
  // service; the environment cannot. If the token check came first, a token
  // accidentally set in production would reach the seeding code.
  const src = routerSrc;
  const guardIndex = src.indexOf("isProductionRuntime(env.shopifyAppUrl)");
  const tokenIndex = src.indexOf("const expected = process.env.STAGING_SEED_TOKEN");
  assert.ok(guardIndex > 0, "the production guard must exist");
  assert.ok(tokenIndex > 0, "the token guard must still exist");
  assert.ok(
    guardIndex < tokenIndex,
    "the production guard must be evaluated before the token"
  );
});

// ===========================================================================
// GUARD 0, end to end over HTTP
// ===========================================================================

/**
 * Drives the REAL router over a real HTTP server, varying ONLY the environment.
 *
 * Every other input is deliberately VALID — correct token, a genuine
 * *.myshopify.com store, the exact confirmation phrase — so the only thing that
 * can account for a 404 is the environment guard itself.
 */
async function probeConsole(appUrl) {
  for (const key of Object.keys(require.cache)) {
    if (key.includes(`${path.sep}dist${path.sep}`)) delete require.cache[key];
  }
  process.env.SHOPIFY_API_KEY = "k";
  process.env.SHOPIFY_API_SECRET = "s";
  process.env.DATABASE_URL = "postgresql://e:e@localhost:5432/e";
  process.env.SHOPIFY_APP_URL = appUrl;
  process.env.STAGING_SEED_TOKEN = "valid-token";

  // Stubbed so the staging path can be observed without a live database, and
  // so a 404 can never be mistaken for a connection failure.
  const prismaPath = require.resolve(d("db/prismaClient.js"));
  require.cache[prismaPath] = {
    id: prismaPath,
    filename: prismaPath,
    loaded: true,
    exports: {
      prisma: {
        store: {
          findMany: async () => [{ shop: "veda-dev.myshopify.com", lastSyncAt: null }],
        },
      },
    },
  };

  const express = require("express");
  const { stagingSeedRouter } = require(d("routes/stagingSeedRoutes.js"));
  const app = express();
  app.use(express.json());
  app.use("/staging-seed", stagingSeedRouter);

  return new Promise((resolve) => {
    const server = app.listen(0, async () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      const body = JSON.stringify({
        shop: "veda-dev.myshopify.com",
        confirm: "SEED STAGING",
        token: "valid-token",
      });
      const post = (p) =>
        fetch(`${base}${p}?token=valid-token`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        });

      const page = await fetch(`${base}/staging-seed/?token=valid-token`);
      const run = await post("/staging-seed/run");
      const state = await post("/staging-seed/state");
      const result = { page: page.status, run: run.status, state: state.status };
      server.close(() => resolve(result));
    });
  });
}

test("SAFETY: production refuses even with a VALID token and a VALID dev store", async () => {
  // The exact scenario the audit flagged: STAGING_SEED_TOKEN set on production
  // by mistake, pointed at a legitimate *.myshopify.com store. Before guard 0
  // this would have seeded fabricated orders.
  for (const productionUrl of ["https://app.vedasuite.in", "https://vedasuite.in"]) {
    const r = await probeConsole(productionUrl);
    assert.deepEqual(
      r,
      { page: 404, run: 404, state: 404 },
      `${productionUrl} must refuse every route unconditionally`
    );
  }
});

test("SAFETY: an unidentifiable environment refuses too", async () => {
  const r = await probeConsole("");
  assert.deepEqual(r, { page: 404, run: 404, state: 404 });
});

test("staging remains fully usable — the guard changed nothing there", async () => {
  const r = await probeConsole("https://vedasuite-staging.onrender.com");
  assert.equal(r.page, 200, "the console must still render on staging");
  assert.equal(r.state, 200, "and its read-only endpoint must still work");
  // `run` reaches Shopify, which is unreachable here; what matters is that it
  // was NOT refused by a guard.
  assert.notEqual(r.run, 404, "staging must not be blocked");
});

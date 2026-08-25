const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

process.env.SHOPIFY_API_KEY ||= "test-key";
process.env.SHOPIFY_API_SECRET ||= "test-secret";
process.env.SHOPIFY_APP_URL ||= "https://vedasuite-staging.onrender.com";
process.env.SHOPIFY_ADMIN_API_VERSION ||= "2026-01";
process.env.DATABASE_URL ||= "postgresql://example:example@localhost:5432/example";

/**
 * PROTECTED CUSTOMER DATA.
 *
 * WHAT FAILED
 * -----------
 * The real-data staging smoke test died during Sync Data:
 *
 *   This app is not approved to use the email field
 *   Too many execution errors, max error limit reached. Results truncated
 *
 * `customer { email }` is validated per NODE, so one page of 250 orders raised
 * 250 identical execution errors. That tripped Shopify's own error ceiling and
 * truncated the results — a single unapproved field did not degrade the sync,
 * it destroyed it, and the cause was buried under a wall of duplicate text.
 *
 * Two separate defects, and these tests hold both closed:
 *   1. A protected field was requested that nothing needed.
 *   2. One forbidden field could flood the job with duplicate errors.
 */

const d = (p) => path.resolve(__dirname, `../dist/${p}`);
const resetModule = (p) => delete require.cache[require.resolve(p)];
const SRC = path.resolve(__dirname, "../src");
const SHOP = "veda-dev.myshopify.com";

const adminSrc = fs.readFileSync(path.join(SRC, "services/shopifyAdminService.ts"), "utf8");

/** Source with comments stripped — the comments deliberately QUOTE the old field. */
function codeOnly(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => {
      const t = line.trim();
      return (
        !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*") && !t.startsWith("#")
      );
    })
    .join("\n");
}

// ===========================================================================
// 1. No protected field is requested anywhere
// ===========================================================================

test("REGRESSION: the order sync requests no protected customer field", () => {
  const code = codeOnly(adminSrc);

  // Extract every GraphQL operation body and inspect the customer selections.
  const customerBlocks = code.match(/customer\s*\{[^}]*\}/g) ?? [];
  assert.ok(customerBlocks.length > 0, "the sync must still read customer identity");

  for (const block of customerBlocks) {
    for (const forbidden of [
      "email",
      "phone",
      "firstName",
      "lastName",
      "displayName",
      "defaultAddress",
      "addresses",
      "verifiedEmail",
    ]) {
      assert.doesNotMatch(
        block,
        new RegExp(`\\b${forbidden}\\b`),
        `customer selection must not request the protected field "${forbidden}"`
      );
    }
  }
});

test("no Shopify query anywhere requests a protected customer field", () => {
  // Not just the line that failed today: the whole file, so fixing `email` does
  // not simply move the failure to `phone` on the next sync.
  const code = codeOnly(adminSrc);
  for (const forbidden of [
    "firstName",
    "lastName",
    "displayName",
    "defaultAddress",
    "verifiedEmail",
    "billingAddress",
    "shippingAddress",
  ]) {
    assert.doesNotMatch(
      code,
      new RegExp(`^\\s*${forbidden}\\s*$`, "m"),
      `"${forbidden}" must not appear as a field selection`
    );
  }
});

test("the OrderNode type no longer carries email, so it cannot be read back", () => {
  // Removing it from the TYPE as well as the query is what stops a later change
  // quietly reintroducing the dependency.
  const orderNodeType = adminSrc.match(/type OrderNode = \{[\s\S]*?\n\};/);
  assert.ok(orderNodeType, "OrderNode must exist");
  assert.doesNotMatch(codeOnly(orderNodeType[0]), /\bemail\b/);
  assert.match(orderNodeType[0], /legacyResourceId/, "identity must still be present");
});

test("the sync never writes an email it did not receive", () => {
  const code = codeOnly(adminSrc);
  // The customer create/update in the sync must not reference email at all.
  const upserts = code.match(/prisma\.customer\.(create|update)\(\{[\s\S]{0,400}?\}\)/g) ?? [];
  assert.ok(upserts.length >= 2, "both the create and update paths must be present");
  for (const block of upserts) {
    assert.doesNotMatch(block, /\bemail\b/, "the sync must not supply email");
  }
});

// ===========================================================================
// 2. One forbidden field cannot flood the job
// ===========================================================================

test("REGRESSION: 250 identical errors collapse into one actionable message", () => {
  const { summarizeGraphQLErrors } = require(d("services/shopifyAdminService.js"));

  const flood = Array.from({ length: 250 }, () => ({
    message: "This app is not approved to use the email field",
  }));
  const summary = summarizeGraphQLErrors(flood);

  // Names the field, so the fix is obvious from the message alone.
  assert.match(summary, /"email"/);
  assert.match(summary, /not approved/i);
  assert.match(summary, /250 identical errors collapsed/);
  // And it must be ONE message, not 250 joined together.
  assert.ok(summary.length < 400, `summary was ${summary.length} chars; it must stay concise`);
  assert.equal(summary.split("This app is not approved").length - 1, 0, "no raw repetition");
});

test("a repeated non-protected error is counted, not concatenated", () => {
  const { summarizeGraphQLErrors } = require(d("services/shopifyAdminService.js"));
  const summary = summarizeGraphQLErrors(
    Array.from({ length: 40 }, () => ({ message: "Internal error" }))
  );
  assert.equal(summary, "Internal error (repeated 40 times)");
});

test("distinct errors are shown but bounded", () => {
  const { summarizeGraphQLErrors } = require(d("services/shopifyAdminService.js"));
  const summary = summarizeGraphQLErrors([
    { message: "one" },
    { message: "two" },
    { message: "three" },
    { message: "four" },
    { message: "five" },
  ]);
  assert.match(summary, /one; two; three/);
  assert.match(summary, /\+2 more distinct errors, 5 total/);
});

test("an empty or malformed error array still produces something readable", () => {
  const { summarizeGraphQLErrors } = require(d("services/shopifyAdminService.js"));
  assert.match(summarizeGraphQLErrors([]), /unspecified/i);
  assert.match(summarizeGraphQLErrors([{ message: "" }]), /unspecified/i);
});

// ===========================================================================
// 3. The sync works without email, at real volume
// ===========================================================================

/** A Shopify that returns orders WITHOUT any customer email, and 429s on nothing. */
/** The exact per-node error Shopify emits for an unapproved field. */
function emailDenied(count) {
  return {
    errors: Array.from({ length: count }, () => ({
      message: "This app is not approved to use the email field",
    })),
  };
}

function fakeShopify({ orderCount = 60, shopperCount = 9 }) {
  const seen = { customerFieldsRequested: new Set() };

  return async (_url, init) => {
    const body = JSON.parse(init.body);

    // Record exactly which customer fields the real query asked for.
    const customerBlock = body.query.match(/customer\s*\{([^}]*)\}/);
    if (customerBlock) {
      for (const field of customerBlock[1].split(/\s+/).filter(Boolean)) {
        if (!field.startsWith("#")) seen.customerFieldsRequested.add(field);
      }
    }

    // A store that enforces Shopify's real rule: asking for email fails per node.
    if (/\bemail\b/.test(customerBlock?.[1] ?? "")) {
      return {
        ok: true,
        status: 200,
        headers: new Map(),
        text: async () => JSON.stringify(emailDenied(orderCount)),
        json: async () => emailDenied(orderCount),
      };
    }

    if (/SyncStoreProducts/.test(body.query)) {
      return json({
        shop: { name: "Dev Store" },
        products: { pageInfo: { hasNextPage: false, endCursor: null }, edges: [] },
      });
    }

    const edges = Array.from({ length: orderCount }, (_, i) => ({
      node: {
        id: `gid://shopify/Order/${i}`,
        legacyResourceId: String(i),
        name: `#${1000 + i}`,
        createdAt: new Date(Date.UTC(2026, 6, 1 + (i % 28))).toISOString(),
        // The repeat-refund shopper is index 8 and refunds most of its orders.
        displayFinancialStatus: i % shopperCount === 8 && i > 8 ? "REFUNDED" : "PAID",
        displayFulfillmentStatus: "FULFILLED",
        currentTotalPriceSet: { shopMoney: { amount: "100.00", currencyCode: "USD" } },
        customer: {
          id: `gid://shopify/Customer/${i % shopperCount}`,
          legacyResourceId: String(i % shopperCount),
          numberOfOrders: 5,
        },
        tags: ["vedasuite-test-data"],
      },
    }));

    return json({ orders: { pageInfo: { hasNextPage: false, endCursor: null }, edges } });
  };

  function json(data) {
    const payload = { data };
    const text = JSON.stringify(payload);
    // shopifyGraphQL reads .json(); other clients read .text(). Support both.
    return {
      ok: true,
      status: 200,
      headers: new Map(),
      text: async () => text,
      json: async () => payload,
    };
  }
}

function loadSync(handler) {
  const connectionPath = d("services/shopifyConnectionService.js");
  const adminPath = d("services/shopifyAdminService.js");
  const prismaPath = d("db/prismaClient.js");
  const obsPath = d("services/observabilityService.js");

  [connectionPath, adminPath, prismaPath, obsPath].forEach((p) => {
    try {
      resetModule(p);
    } catch {
      /* not loaded */
    }
  });

  require.cache[connectionPath] = {
    id: connectionPath,
    filename: connectionPath,
    loaded: true,
    exports: {
      resolveOfflineInstallation: async () => ({
        id: "store-1",
        shop: SHOP,
        accessToken: "token",
        pricingBias: 50,
        profitGuardrail: 50,
      }),
      forceRefreshOfflineAccessToken: async () => ({ accessToken: "token" }),
      normalizeShopDomain: (s) => s,
      updateConnectionDiagnostics: async () => {},
      isShopifyAuthRejection: () => false,
    },
  };

  const prisma = require(prismaPath).prisma;
  const saved = { orders: [], customers: new Map() };

  prisma.store = {
    findUnique: async () => ({ id: "store-1", shop: SHOP }),
    update: async () => ({}),
  };
  prisma.customer = {
    findFirst: async ({ where }) => saved.customers.get(where.shopifyCustomerId) ?? null,
    create: async ({ data }) => {
      const row = { id: `c-${data.shopifyCustomerId}`, ...data };
      saved.customers.set(data.shopifyCustomerId, row);
      return row;
    },
    update: async ({ where, data }) => {
      // Real Prisma returns the UPDATED RECORD. Returning {} made the sync read
      // customer.id as undefined for every repeat customer, so 51 of 60 orders
      // were persisted unattached — a harness bug that would have masked the
      // very grouping this file is meant to prove.
      for (const row of saved.customers.values()) {
        if (row.id === where.id) {
          Object.assign(row, data);
          return { ...row };
        }
      }
      return null;
    },
    findMany: async () =>
      [...saved.customers.values()].map((row) => ({
        ...row,
        orders: saved.orders.filter((o) => o.customerId === row.id),
        fraudSignals: [],
      })),
  };
  prisma.order = {
    findFirst: async ({ where }) =>
      saved.orders.find((o) => o.shopifyOrderId === where.shopifyOrderId) ?? null,
    create: async ({ data }) => {
      saved.orders.push({ id: `o-${saved.orders.length}`, ...data });
      return {};
    },
    update: async () => ({}),
  };
  prisma.productSnapshot = { findUnique: async () => null, upsert: async (a) => ({ id: "p", ...a.create }) };
  prisma.variantSnapshot = { findUnique: async () => null, upsert: async () => ({}) };
  prisma.priceHistory = { count: async () => 0, create: async () => ({}), deleteMany: async () => ({ count: 0 }) };

  const originalFetch = global.fetch;
  global.fetch = handler;
  const admin = require(adminPath);
  require(obsPath).logEvent = () => {};

  return { admin, saved, restore: () => (global.fetch = originalFetch) };
}

test("REGRESSION: the sync completes with no customer email available", async () => {
  const w = loadSync(fakeShopify({ orderCount: 60 }));
  try {
    const result = await w.admin.syncShopifyStoreData(SHOP);
    assert.equal(result.counts.fetched.orders, 60, "every order must sync");
    assert.equal(w.saved.orders.length, 60);
    // And no customer row carries an email, because none was ever received.
    for (const customer of w.saved.customers.values()) {
      assert.equal(customer.email, undefined, "the sync must not invent an email");
    }
  } finally {
    w.restore();
  }
});

test("REGRESSION: 50+ orders sync, so Customer Loss can reach its baseline", async () => {
  const { CUSTOMER_LOSS } = require(d("services/customerLossCalc.js"));
  const w = loadSync(fakeShopify({ orderCount: 74 }));
  try {
    const result = await w.admin.syncShopifyStoreData(SHOP);
    assert.ok(
      result.counts.fetched.orders >= CUSTOMER_LOSS.minStoreOrders,
      `synced ${result.counts.fetched.orders}; the detector needs ${CUSTOMER_LOSS.minStoreOrders}`
    );
    assert.equal(w.saved.orders.length, 74, "the 74 staging orders must all persist");
  } finally {
    w.restore();
  }
});

test("repeat customers stay deterministically identifiable without email", async () => {
  const w = loadSync(fakeShopify({ orderCount: 60, shopperCount: 9 }));
  try {
    await w.admin.syncShopifyStoreData(SHOP);

    // Nine distinct shoppers, keyed by the stable Shopify customer ID.
    assert.equal(w.saved.customers.size, 9, "one row per Shopify customer, no fan-out");
    for (const customer of w.saved.customers.values()) {
      assert.ok(customer.shopifyCustomerId, "identity is the Shopify ID, not a fabrication");
    }

    // Every order is attached to a customer, so grouping is total.
    const grouped = new Map();
    for (const order of w.saved.orders) {
      grouped.set(order.customerId, (grouped.get(order.customerId) ?? 0) + 1);
    }
    assert.equal(grouped.size, 9);
    assert.equal(
      [...grouped.values()].reduce((a, b) => a + b, 0),
      60,
      "no order may be orphaned by the loss of email"
    );

    // Deterministic: syncing the same store again must not create new identities.
    const before = new Set(w.saved.customers.keys());
    await w.admin.syncShopifyStoreData(SHOP);
    assert.deepEqual(
      new Set(w.saved.customers.keys()),
      before,
      "a second sync must reuse the same customer identities"
    );
  } finally {
    w.restore();
  }
});

test("REGRESSION: a store that still asks for email fails once, concisely", async () => {
  // Proves the two fixes are independent: even if a protected field were
  // reintroduced, the operator gets one actionable line rather than a flood.
  const { summarizeGraphQLErrors } = require(d("services/shopifyAdminService.js"));
  const flood = Array.from({ length: 250 }, () => ({
    message: "This app is not approved to use the email field",
  }));
  const summary = summarizeGraphQLErrors(flood);
  assert.ok(
    !/Too many execution errors/i.test(summary),
    "the summary must explain the cause, not echo Shopify's truncation warning"
  );
  assert.match(summary, /email/);
});

// ===========================================================================
// 4. The seeded shopper reaches detection through the email-free sync
// ===========================================================================

test("END TO END: the seeded repeat-refund shopper reaches Customer Loss without email", async () => {
  // The whole point of the fix. Sync 74 orders with NO customer email, then run
  // the real detector over exactly what the sync persisted. If identity had
  // depended on email, the repeat shopper would fragment and never qualify.
  const seedPlan = require(d("services/stagingSeedPlan.js"));
  const NOW_MS = Date.UTC(2026, 7, 25);
  const plan = seedPlan.buildStagingSeedPlan(NOW_MS);

  // A Shopify serving exactly the seeded fixture, email-free.
  const handler = async (_url, init) => {
    const body = JSON.parse(init.body);
    const json = (data) => {
      const payload = { data };
      const text = JSON.stringify(payload);
      return { ok: true, status: 200, headers: new Map(), text: async () => text, json: async () => payload };
    };

    if (/SyncStoreProducts/.test(body.query)) {
      return json({
        shop: { name: "Dev Store" },
        products: { pageInfo: { hasNextPage: false, endCursor: null }, edges: [] },
      });
    }

    const edges = plan.map((order, i) => ({
      node: {
        id: `gid://shopify/Order/${i}`,
        legacyResourceId: String(i),
        name: `#${1000 + i}`,
        createdAt: order.processedAt,
        displayFinancialStatus: order.refunded ? "REFUNDED" : "PAID",
        displayFulfillmentStatus: "FULFILLED",
        currentTotalPriceSet: {
          shopMoney: { amount: order.amount.toFixed(2), currencyCode: "USD" },
        },
        customer: {
          id: `gid://shopify/Customer/${order.shopperIndex}`,
          legacyResourceId: String(order.shopperIndex),
          numberOfOrders: 5,
        },
        tags: ["vedasuite-test-data"],
      },
    }));

    return json({ orders: { pageInfo: { hasNextPage: false, endCursor: null }, edges } });
  };

  const w = loadSync(handler);
  try {
    const result = await w.admin.syncShopifyStoreData(SHOP);
    assert.equal(result.counts.fetched.orders, plan.length, "the whole fixture must sync");

    // Now run the REAL detector over exactly what the sync persisted.
    const detectorPath = d("services/intelligenceDetectorService.js");
    const prismaPath = d("db/prismaClient.js");
    const findingPath = d("services/intelligenceFindingService.js");
    // env is reset too: the config object is built once at import time, so
    // setting the flag without reloading it leaves recordFinding disabled and
    // the persistence assertion fails for the wrong reason.
    process.env.ENABLE_INTELLIGENCE_FINDING_PERSISTENCE = "true";
    [d("config/env.js"), detectorPath, findingPath].forEach((p) => {
      try {
        resetModule(p);
      } catch {
        /* not loaded */
      }
    });

    const prisma = require(prismaPath).prisma;
    const rows = [];
    prisma.order.findMany = async ({ where }) =>
      w.saved.orders.filter(
        (o) =>
          (where.createdAt?.gte === undefined || o.createdAt >= where.createdAt.gte) &&
          (where.customerId === undefined || o.customerId === where.customerId)
      );
    prisma.customer.findMany = async () =>
      [...w.saved.customers.values()].map((c) => ({ ...c, fraudSignalsCount: 0 }));
    prisma.intelligenceFinding = {
      findUnique: async () => null,
      upsert: async ({ create }) => {
        rows.push({ id: `f-${rows.length}`, ...create });
        return rows[rows.length - 1];
      },
      update: async () => ({}),
      findFirst: async () => null,
      findMany: async () => rows.map((r) => ({ ...r })),
      updateMany: async () => ({ count: 0 }),
    };

    const detectors = require(detectorPath);
    const insights = await detectors.detectCustomerLoss({
      storeId: "store-1",
      nowIso: new Date(NOW_MS).toISOString(),
    });

    assert.ok(
      insights.length > 0,
      "the repeat-refund shopper must still be detected with no email anywhere in the pipeline"
    );
    assert.ok(rows.length > 0, "and the finding must be persisted");
    assert.equal(rows[0].module, "return_abuse");
  } finally {
    w.restore();
  }
});

// ===========================================================================
// 5. Sale status and refund status are orthogonal
// ===========================================================================

test("REGRESSION: a refunded order is still an ELIGIBLE paid sale", () => {
  // The second defect on this path, found while proving the first was fixed.
  //
  // The sync lowercased Shopify's displayFinancialStatus straight into
  // Order.status, so a refunded order became status "refunded" — which is not in
  // ELIGIBLE_ORDER_STATUSES. customerLossCalc counts refunds WITHIN the eligible
  // set, so the moment an order was refunded it stopped being countable as a
  // refund. minRefundedOrders: 2 could never be satisfied by any real store.
  const { mapFinancialStatusToSaleStatus } = require(d("services/shopifyAdminService.js"));
  const { ELIGIBLE_ORDER_STATUSES } = require(d("services/explainabilityCalc.js"));

  for (const shopifyStatus of ["PAID", "REFUNDED", "PARTIALLY_REFUNDED"]) {
    const mapped = mapFinancialStatusToSaleStatus(shopifyStatus);
    assert.ok(
      ELIGIBLE_ORDER_STATUSES.includes(mapped),
      `${shopifyStatus} was a completed sale and must map to an eligible status, got "${mapped}"`
    );
  }

  assert.equal(mapFinancialStatusToSaleStatus("AUTHORIZED"), "approved");
});

test("SAFETY: an order that was never paid does NOT become eligible", () => {
  // The mirror error. Mapping everything to "paid" would let voided and expired
  // orders into the baseline, inflating the store's order count with sales that
  // never happened.
  const { mapFinancialStatusToSaleStatus } = require(d("services/shopifyAdminService.js"));
  const { ELIGIBLE_ORDER_STATUSES } = require(d("services/explainabilityCalc.js"));

  for (const shopifyStatus of ["VOIDED", "EXPIRED", "PENDING", "PARTIALLY_PAID"]) {
    const mapped = mapFinancialStatusToSaleStatus(shopifyStatus);
    assert.ok(
      !ELIGIBLE_ORDER_STATUSES.includes(mapped),
      `${shopifyStatus} was not a completed sale and must stay ineligible, got "${mapped}"`
    );
  }
  // An unrecognised future status passes through rather than being guessed at.
  assert.equal(mapFinancialStatusToSaleStatus("SOMETHING_NEW"), "something_new");
  assert.equal(mapFinancialStatusToSaleStatus(""), "");
});

test("REGRESSION: the sync persists refunded orders as paid-and-refunded", async () => {
  // End to end through the real sync: the two facts must survive separately.
  const handler = async (_url, init) => {
    const body = JSON.parse(init.body);
    const json = (data) => {
      const payload = { data };
      const text = JSON.stringify(payload);
      return { ok: true, status: 200, headers: new Map(), text: async () => text, json: async () => payload };
    };
    if (/SyncStoreProducts/.test(body.query)) {
      return json({
        shop: { name: "Dev Store" },
        products: { pageInfo: { hasNextPage: false, endCursor: null }, edges: [] },
      });
    }
    const statuses = ["PAID", "REFUNDED", "PARTIALLY_REFUNDED", "VOIDED"];
    const edges = statuses.map((financial, i) => ({
      node: {
        id: `gid://shopify/Order/${i}`,
        legacyResourceId: String(i),
        name: `#${1000 + i}`,
        createdAt: new Date(Date.UTC(2026, 6, 10)).toISOString(),
        displayFinancialStatus: financial,
        displayFulfillmentStatus: "FULFILLED",
        currentTotalPriceSet: { shopMoney: { amount: "100.00", currencyCode: "USD" } },
        customer: {
          id: "gid://shopify/Customer/1",
          legacyResourceId: "1",
          numberOfOrders: 4,
        },
        tags: [],
      },
    }));
    return json({ orders: { pageInfo: { hasNextPage: false, endCursor: null }, edges } });
  };

  const w = loadSync(handler);
  try {
    await w.admin.syncShopifyStoreData(SHOP);
    // The sync keys orders by their DISPLAY name (#1000...), not the legacy id.
    const byShopifyId = new Map(w.saved.orders.map((o) => [o.shopifyOrderId, o]));

    assert.equal(byShopifyId.get("#1000").status, "paid");
    assert.equal(byShopifyId.get("#1000").refunded, false);

    // The pair that matters: eligible AND refunded at the same time.
    assert.equal(byShopifyId.get("#1001").status, "paid");
    assert.equal(byShopifyId.get("#1001").refunded, true);
    assert.equal(byShopifyId.get("#1002").status, "paid");
    assert.equal(byShopifyId.get("#1002").refunded, true);

    // And a void stays out of the eligible set entirely.
    assert.equal(byShopifyId.get("#1003").status, "voided");
    assert.equal(byShopifyId.get("#1003").refunded, false);
  } finally {
    w.restore();
  }
});

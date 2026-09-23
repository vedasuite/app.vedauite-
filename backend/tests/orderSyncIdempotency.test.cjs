const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

process.env.SHOPIFY_API_KEY ||= "test-key";
process.env.SHOPIFY_API_SECRET ||= "test-secret";
process.env.SHOPIFY_APP_URL ||= "https://app.vedasuite.in";
process.env.SHOPIFY_ADMIN_API_VERSION ||= "2026-01";
process.env.DATABASE_URL ||= "postgresql://example:example@localhost:5432/example";

/**
 * ORDER IDENTITY IS STORE-SCOPED.
 *
 * THE PRODUCTION FAILURE
 * ----------------------
 * m1g3bm-1a.myshopify.com connected, Shopify returned 464 products and 95
 * orders, and persistence died on:
 *
 *     Unique constraint failed on the fields: (`shopifyOrderId`)
 *
 * `shopifyOrderId` holds the Shopify order NAME ("#1001") and carried a GLOBAL
 * unique constraint. The sync looks an order up scoped to its store, so a
 * second merchant's #1001 was never found, fell through to create(), and
 * collided with the FIRST merchant's row.
 *
 * Deterministic, not a race: a store-scoped lookup can never find another
 * store's row, so all three retries failed identically and the store was left
 * SYNC_REQUIRED. Shopify starts every store at #1001, so this broke onboarding
 * for essentially any merchant after the first.
 *
 * Fixed by scoping the constraint to (storeId, shopifyOrderId) and writing
 * through a single atomic upsert on that key.
 */

function resetModule(modulePath) {
  delete require.cache[require.resolve(modulePath)];
}

function mockModule(absPath, exports) {
  require.cache[absPath] = { id: absPath, filename: absPath, loaded: true, exports };
}

const d = (p) => path.resolve(__dirname, `../dist/${p}`);

function orderPage(items) {
  return {
    orders: {
      pageInfo: { hasNextPage: false, endCursor: null },
      edges: items.map((item, i) => ({
        node: {
          id: item.gid ?? `gid://shopify/Order/${1000 + i}`,
          legacyResourceId: item.legacyId ?? String(1000 + i),
          // The order NAME. Every Shopify store starts at #1001.
          name: item.name,
          createdAt: item.createdAt ?? "2026-09-01T10:00:00.000Z",
          displayFinancialStatus: item.financialStatus ?? "PAID",
          displayFulfillmentStatus: "FULFILLED",
          currentTotalPriceSet: {
            shopMoney: { amount: item.amount ?? "100.00", currencyCode: "USD" },
          },
          customer: null,
          tags: item.tags ?? [],
        },
      })),
    },
  };
}

function emptyProductPage() {
  return {
    shop: { name: "Test Store" },
    products: { pageInfo: { hasNextPage: false, endCursor: null }, edges: [] },
  };
}

/**
 * A Postgres-faithful fake of the Order table.
 *
 * It ENFORCES the compound unique key rather than assuming it, so a regression
 * to a non-atomic write or a wrong key surfaces here as the same violation
 * production saw — not as a silently passing test.
 */
function makeOrderTable(shared) {
  const rows = shared;
  const keyOf = (storeId, shopifyOrderId) => `${storeId}::${shopifyOrderId}`;

  return {
    rows,
    findFirst: async ({ where }) => {
      return (
        rows.find((r) => {
          if (where.storeId && r.storeId !== where.storeId) return false;
          if (where.OR) {
            return where.OR.some((clause) => {
              const [field, value] = Object.entries(clause)[0];
              return value != null && r[field] === value;
            });
          }
          if (where.shopifyOrderGid && r.shopifyOrderGid !== where.shopifyOrderGid) return false;
          return true;
        }) ?? null
      );
    },
    create: async ({ data }) => {
      // The global constraint that actually fired in production.
      if (rows.some((r) => r.shopifyOrderId === data.shopifyOrderId && r.storeId === data.storeId)) {
        const e = new Error(
          "Unique constraint failed on the fields: (`storeId`,`shopifyOrderId`)"
        );
        e.code = "P2002";
        throw e;
      }
      const row = { id: `o-${rows.length}`, ...data };
      rows.push(row);
      return row;
    },
    update: async ({ where, data }) => {
      const row = rows.find((r) => r.id === where.id);
      if (row) Object.assign(row, data);
      return row ?? {};
    },
    upsert: async ({ where, create, update, select }) => {
      const k = where.storeId_shopifyOrderId;
      assert.ok(k, "upsert must target the compound storeId_shopifyOrderId key");
      const existing = rows.find(
        (r) => keyOf(r.storeId, r.shopifyOrderId) === keyOf(k.storeId, k.shopifyOrderId)
      );
      if (existing) {
        // `createdAt` must never be rewritten by a repeat sync.
        assert.ok(
          !("createdAt" in update),
          "update branch must not rewrite createdAt"
        );
        Object.assign(existing, update);
        return select ? { id: existing.id } : existing;
      }
      const row = { id: `o-${rows.length}`, ...create };
      rows.push(row);
      return select ? { id: row.id } : row;
    },
    count: async ({ where } = {}) =>
      rows.filter((r) => !where?.storeId || r.storeId === where.storeId).length,
  };
}

/** Loads the real sync against mocked Shopify + a constraint-enforcing fake DB. */
function loadSync({ orderPages, productPages = [emptyProductPage()], store, sharedOrders }) {
  const connectionPath = d("services/shopifyConnectionService.js");
  const adminPath = d("services/shopifyAdminService.js");
  const prismaPath = d("db/prismaClient.js");
  const obsPath = d("services/observabilityService.js");

  [connectionPath, adminPath, prismaPath, obsPath].forEach((p) => {
    try {
      resetModule(p);
    } catch {
      /* not yet loaded */
    }
  });

  const theStore = store ?? { id: "store-1", shop: "test-shop.myshopify.com" };

  mockModule(connectionPath, {
    resolveOfflineInstallation: async () => ({
      ...theStore,
      accessToken: "token",
      pricingBias: 50,
      profitGuardrail: 50,
    }),
    forceRefreshOfflineAccessToken: async () => ({ accessToken: "token" }),
    normalizeShopDomain: (shop) => shop,
    updateConnectionDiagnostics: async () => {},
    isShopifyAuthRejection: () => false,
  });

  const prisma = require(prismaPath).prisma;
  const orderTable = makeOrderTable(sharedOrders ?? []);

  prisma.store = {
    findUnique: async () => theStore,
    update: async () => ({}),
  };
  prisma.customer = {
    findFirst: async () => null,
    create: async ({ data }) => ({ id: "c-0", ...data, orders: [] }),
    update: async () => ({}),
    findMany: async () => [],
  };
  prisma.order = orderTable;
  prisma.orderLineItem = {
    upsert: async () => ({}),
    findUnique: async () => null,
    count: async () => 0,
  };
  prisma.productSnapshot = { findUnique: async () => null, upsert: async ({ create }) => ({ id: "p-0", ...create }) };
  prisma.variantSnapshot = { findUnique: async () => null, upsert: async () => ({}) };
  prisma.priceHistory = { count: async () => 0, create: async () => ({}), deleteMany: async () => ({ count: 0 }) };

  const originalFetch = global.fetch;
  let productIdx = 0;
  let orderIdx = 0;

  global.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const isProducts = /SyncStoreProducts/.test(body.query);
    const payload = isProducts
      ? productPages[Math.min(productIdx++, productPages.length - 1)]
      : orderPages[Math.min(orderIdx++, orderPages.length - 1)];
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: payload }),
      text: async () => "",
    };
  };

  return {
    admin: require(adminPath),
    orders: orderTable.rows,
    restore: () => {
      global.fetch = originalFetch;
    },
  };
}

// ===========================================================================
// TEST A — Fresh order
// ===========================================================================

test("A: a previously unseen order creates exactly one row", async () => {
  const w = loadSync({ orderPages: [orderPage([{ name: "#1001" }])] });
  try {
    const result = await w.admin.syncShopifyStoreData("test-shop.myshopify.com");
    assert.equal(result.counts.saved.ordersCreated, 1);
    assert.equal(w.orders.length, 1);
    assert.equal(w.orders[0].shopifyOrderId, "#1001");
    assert.equal(w.orders[0].storeId, "store-1");
  } finally {
    w.restore();
  }
});

// ===========================================================================
// TEST B — Same order twice
// ===========================================================================

test("B: the identical order processed twice throws nothing and stays one row", async () => {
  const shared = [];
  for (const pass of [1, 2]) {
    const w = loadSync({ orderPages: [orderPage([{ name: "#1001" }])], sharedOrders: shared });
    try {
      await w.admin.syncShopifyStoreData("test-shop.myshopify.com");
    } finally {
      w.restore();
    }
    assert.equal(shared.length, 1, `pass ${pass}: exactly one order row`);
  }
});

// ===========================================================================
// TEST C — Updated order
// ===========================================================================

test("C: changed Shopify data updates in place, createdAt preserved", async () => {
  const shared = [];

  let w = loadSync({
    orderPages: [orderPage([{ name: "#1001", amount: "100.00", financialStatus: "PAID" }])],
    sharedOrders: shared,
  });
  try {
    await w.admin.syncShopifyStoreData("test-shop.myshopify.com");
  } finally {
    w.restore();
  }
  const originalCreatedAt = shared[0].createdAt;

  // Same order, refunded and re-priced, and Shopify reports a later createdAt.
  w = loadSync({
    orderPages: [
      orderPage([
        {
          name: "#1001",
          amount: "250.00",
          financialStatus: "REFUNDED",
          createdAt: "2026-09-10T10:00:00.000Z",
        },
      ]),
    ],
    sharedOrders: shared,
  });
  try {
    await w.admin.syncShopifyStoreData("test-shop.myshopify.com");
  } finally {
    w.restore();
  }

  assert.equal(shared.length, 1, "still exactly one row");
  assert.equal(shared[0].totalAmount, 250, "amount refreshed");
  assert.equal(shared[0].refunded, true, "refund state refreshed");
  assert.equal(
    shared[0].createdAt,
    originalCreatedAt,
    "createdAt is a fact about the order and must not be rewritten"
  );
});

// ===========================================================================
// TEST D — Full sync repeated
// ===========================================================================

test("D: the same full sync run twice succeeds with stable counts", async () => {
  const page = orderPage([{ name: "#1001" }, { name: "#1002" }, { name: "#1003" }]);
  const shared = [];

  const first = loadSync({ orderPages: [page], sharedOrders: shared });
  let r1;
  try {
    r1 = await first.admin.syncShopifyStoreData("test-shop.myshopify.com");
  } finally {
    first.restore();
  }
  assert.equal(r1.counts.saved.ordersCreated, 3);
  assert.equal(shared.length, 3);

  const second = loadSync({ orderPages: [page], sharedOrders: shared });
  let r2;
  try {
    r2 = await second.admin.syncShopifyStoreData("test-shop.myshopify.com");
  } finally {
    second.restore();
  }

  assert.equal(r2.counts.fetched.orders, 3, "second sync still fetches all three");
  assert.equal(shared.length, 3, "no duplicates after the second sync");
  assert.equal(r2.counts.saved.ordersUpdated, 3, "all three recognised as existing");
  assert.equal(r2.counts.saved.ordersCreated, 0);
});

// ===========================================================================
// TEST E — Webhook after full sync
// ===========================================================================

test("E: a webhook sync over an already-synced order does not fail", async () => {
  const shared = [];
  const page = orderPage([{ name: "#1001" }, { name: "#1002" }]);

  const full = loadSync({ orderPages: [page], sharedOrders: shared });
  try {
    await full.admin.syncShopifyStoreData("test-shop.myshopify.com");
  } finally {
    full.restore();
  }

  // The webhook path runs the same syncShopifyStoreData via runStoreSyncJob.
  const webhook = loadSync({ orderPages: [page], sharedOrders: shared });
  let result;
  try {
    result = await webhook.admin.syncShopifyStoreData("test-shop.myshopify.com");
  } finally {
    webhook.restore();
  }

  assert.notEqual(result.status, "FAILED", "a webhook re-sync must not fail the store");
  assert.equal(shared.length, 2, "no duplicate orders");
  assert.equal(result.resourceStatus.orders.status, "SUCCESS");
});

test("E2: CONCURRENCY — interleaved webhook and manual sync stay consistent", async () => {
  // Webhooks and manual sync both call runStoreSyncJob with no concurrency
  // guard, so the two passes really can interleave. The upsert is one
  // statement, so the database — not the application — resolves the collision.
  const shared = [];
  const page = orderPage([{ name: "#1001" }, { name: "#1002" }, { name: "#1003" }]);

  const a = loadSync({ orderPages: [page], sharedOrders: shared });
  const b = loadSync({ orderPages: [page], sharedOrders: shared });

  try {
    const [ra, rb] = await Promise.all([
      a.admin.syncShopifyStoreData("test-shop.myshopify.com"),
      b.admin.syncShopifyStoreData("test-shop.myshopify.com"),
    ]);
    assert.notEqual(ra.status, "FAILED");
    assert.notEqual(rb.status, "FAILED");
  } finally {
    a.restore();
    b.restore();
  }

  assert.equal(shared.length, 3, "concurrent syncs must not duplicate orders");
  const keys = shared.map((r) => `${r.storeId}::${r.shopifyOrderId}`);
  assert.equal(new Set(keys).size, 3, "every (storeId, shopifyOrderId) is unique");
});

// ===========================================================================
// TEST F — Two stores
// ===========================================================================

test("F: REGRESSION — two stores may both have order #1001", async () => {
  // The exact production failure. Store A syncs #1001; store B (the new
  // merchant) then syncs its own #1001. Before the fix, B's create() collided
  // with A's row on the GLOBAL unique constraint and killed the whole sync.
  const shared = [];

  const storeA = loadSync({
    orderPages: [orderPage([{ name: "#1001" }, { name: "#1002" }])],
    store: { id: "store-A", shop: "merchant-a.myshopify.com" },
    sharedOrders: shared,
  });
  try {
    await storeA.admin.syncShopifyStoreData("merchant-a.myshopify.com");
  } finally {
    storeA.restore();
  }
  assert.equal(shared.length, 2);

  const storeB = loadSync({
    orderPages: [orderPage([{ name: "#1001" }, { name: "#1002" }])],
    store: { id: "store-B", shop: "m1g3bm-1a.myshopify.com" },
    sharedOrders: shared,
  });
  let result;
  try {
    result = await storeB.admin.syncShopifyStoreData("m1g3bm-1a.myshopify.com");
  } finally {
    storeB.restore();
  }

  assert.notEqual(result.status, "FAILED", "the second merchant's sync must succeed");
  assert.equal(shared.length, 4, "both stores keep their own #1001 and #1002");

  const byStore = (id) => shared.filter((r) => r.storeId === id).map((r) => r.shopifyOrderId).sort();
  assert.deepEqual(byStore("store-A"), ["#1001", "#1002"]);
  assert.deepEqual(byStore("store-B"), ["#1001", "#1002"]);
});

test("F2: the same order name in two stores is two distinct rows", async () => {
  const shared = [];
  for (const [id, shop] of [["store-A", "a.myshopify.com"], ["store-B", "b.myshopify.com"]]) {
    const w = loadSync({
      orderPages: [orderPage([{ name: "#1001" }])],
      store: { id, shop },
      sharedOrders: shared,
    });
    try {
      await w.admin.syncShopifyStoreData(shop);
    } finally {
      w.restore();
    }
  }
  assert.equal(shared.length, 2);
  assert.deepEqual(shared.map((r) => r.storeId).sort(), ["store-A", "store-B"]);
  assert.deepEqual(shared.map((r) => r.shopifyOrderId), ["#1001", "#1001"]);
});

// ===========================================================================
// Schema + call-site guards
// ===========================================================================

test("the schema scopes order identity to the store", () => {
  const fs = require("node:fs");
  const schema = fs.readFileSync(
    path.resolve(__dirname, "../prisma/schema.prisma"),
    "utf8"
  );
  const model = schema.slice(schema.indexOf("model Order {"));
  const body = model.slice(0, model.indexOf("\n}"));

  assert.match(body, /@@unique\(\[storeId, shopifyOrderId\]\)/);
  assert.ok(
    !/shopifyOrderId\s+String\s+@unique/.test(body),
    "shopifyOrderId must NOT carry a global unique constraint — it holds the order name"
  );
});

test("the order write is a single atomic upsert on the compound key", () => {
  const fs = require("node:fs");
  const src = fs.readFileSync(
    path.resolve(__dirname, "../src/services/shopifyAdminService.ts"),
    "utf8"
  );
  const code = src
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");

  assert.match(code, /prisma\.order\.upsert\(/, "the order write must be an upsert");
  assert.match(code, /storeId_shopifyOrderId/, "it must target the compound key");
  assert.ok(
    !/prisma\.order\.create\(/.test(code),
    "no create-then-hope path may remain in the sync"
  );
});

test("the migration widens rather than rewrites", () => {
  const fs = require("node:fs");
  const sql = fs.readFileSync(
    path.resolve(
      __dirname,
      "../prisma/migrations/20260914_order_identity_store_scoped/migration.sql"
    ),
    "utf8"
  );
  // The replacement is created BEFORE the old one is dropped, so the column is
  // never left unguarded.
  assert.ok(
    sql.indexOf("CREATE UNIQUE INDEX") < sql.indexOf("DROP INDEX"),
    "create the new index before dropping the old one"
  );
  assert.match(sql, /IF NOT EXISTS/);
  assert.match(sql, /IF EXISTS/);
  // No data may be touched.
  for (const destructive of ["DELETE FROM", "TRUNCATE", "UPDATE \"Order\"", "DROP TABLE"]) {
    assert.ok(!sql.includes(destructive), `migration must not contain ${destructive}`);
  }
});

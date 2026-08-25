const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

process.env.SHOPIFY_API_KEY ||= "test-key";
process.env.SHOPIFY_API_SECRET ||= "test-secret";
process.env.SHOPIFY_APP_URL ||= "https://app.vedasuite.in";
process.env.SHOPIFY_ADMIN_API_VERSION ||= "2026-01";
process.env.DATABASE_URL ||= "postgresql://example:example@localhost:5432/example";

/**
 * SYNC PAGINATION.
 *
 * THE DEFECT
 * ----------
 * The sync query was `products(first: 20)` and `orders(first: 20)` with no
 * pagination anywhere in the file. Twenty orders was the entire dataset
 * VedaSuite ever held about a store, however large that store was.
 *
 * That is structural, not a tuning choice. CUSTOMER_LOSS.minStoreOrders is 50:
 * the detector refuses to compute a refund baseline from less history than
 * that, deliberately. With a hard ceiling of 20 synced orders the gate could
 * never open, so the entire Customer Loss family was unreachable for every
 * merchant on every plan — not empty, unreachable. Product Profit had the same
 * problem at 20 products, and explainabilityService reads with
 * READ_CAPS.orders = 5000, a bound written for a dataset the sync could never
 * deliver.
 *
 * The engines were correct. They were being starved.
 *
 * These tests drive the real sync against a mocked Shopify and assert that it
 * follows cursors, stops at its documented ceiling, and reports truncation
 * rather than presenting a bounded read as a complete one.
 */

function resetModule(modulePath) {
  delete require.cache[require.resolve(modulePath)];
}

function mockModule(absPath, exports) {
  require.cache[absPath] = { id: absPath, filename: absPath, loaded: true, exports };
}

const d = (p) => path.resolve(__dirname, `../dist/${p}`);

/** Builds one Shopify order page payload. */
function orderPage(count, { hasNextPage, cursor, startIndex = 0 }) {
  return {
    orders: {
      pageInfo: { hasNextPage, endCursor: cursor },
      edges: Array.from({ length: count }, (_, i) => {
        const n = startIndex + i;
        return {
          node: {
            id: `gid://shopify/Order/${n}`,
            legacyResourceId: String(n),
            name: `#${1000 + n}`,
            createdAt: new Date(Date.UTC(2026, 6, 1 + (n % 28))).toISOString(),
            displayFinancialStatus: n % 5 === 0 ? "REFUNDED" : "PAID",
            displayFulfillmentStatus: "FULFILLED",
            currentTotalPriceSet: {
              shopMoney: { amount: "100.00", currencyCode: "USD" },
            },
            customer: {
              id: `gid://shopify/Customer/${n % 7}`,
              legacyResourceId: String(n % 7),
              email: `buyer${n % 7}@example.test`,
              numberOfOrders: 4,
            },
            tags: [],
          },
        };
      }),
    },
  };
}

function productPage(count, { hasNextPage, cursor, startIndex = 0 }) {
  return {
    shop: { name: "Test Store" },
    products: {
      pageInfo: { hasNextPage, endCursor: cursor },
      edges: Array.from({ length: count }, (_, i) => {
        const n = startIndex + i;
        return {
          node: {
            id: `gid://shopify/Product/${n}`,
            handle: `product-${n}`,
            title: `Product ${n}`,
            status: "ACTIVE",
            variants: {
              edges: [
                {
                  node: {
                    id: `gid://shopify/ProductVariant/${n}`,
                    title: "Default",
                    price: "50.00",
                  },
                },
              ],
            },
          },
        };
      }),
    },
  };
}

/**
 * Loads the sync with Shopify mocked at `fetch` and the database mocked at
 * prisma, so the REAL pagination loop runs.
 */
function loadSync({ productPages, orderPages }) {
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

  mockModule(connectionPath, {
    resolveOfflineInstallation: async () => ({
      id: "store-1",
      shop: "test-shop.myshopify.com",
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
  const saved = { orders: [], products: [], customers: new Map() };

  prisma.store = {
    findUnique: async () => ({ id: "store-1", shop: "test-shop.myshopify.com" }),
    update: async () => ({}),
  };
  prisma.customer = {
    findFirst: async ({ where }) => saved.customers.get(where.shopifyCustomerId) ?? null,
    create: async ({ data }) => {
      const row = { id: `c-${saved.customers.size}`, ...data, orders: [] };
      saved.customers.set(data.shopifyCustomerId, row);
      return row;
    },
    update: async ({ where, data }) => {
      for (const row of saved.customers.values()) {
        if (row.id === where.id) Object.assign(row, data);
      }
      return {};
    },
    // The real call is `include: { orders: true, fraudSignals: true }`, so the
    // rows are returned with those relations attached. Without them the post-
    // sync trust recompute throws on `customer.orders.length`.
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
    count: async () => saved.orders.length,
  };
  prisma.productSnapshot = {
    findUnique: async ({ where }) =>
      saved.products.find(
        (p) => p.shopifyProductId === where.storeId_shopifyProductId?.shopifyProductId
      ) ?? null,
    upsert: async ({ create }) => {
      const existing = saved.products.find(
        (p) => p.shopifyProductId === create.shopifyProductId
      );
      if (existing) return existing;
      const row = { id: `p-${saved.products.length}`, ...create };
      saved.products.push(row);
      return row;
    },
  };
  prisma.variantSnapshot = {
    findUnique: async () => null,
    upsert: async ({ create }) => ({ id: "v-0", ...create }),
  };
  prisma.priceHistory = {
    count: async () => 0,
    create: async () => ({}),
    deleteMany: async () => ({ count: 0 }),
  };

  const requested = [];
  const originalFetch = global.fetch;
  let productIdx = 0;
  let orderIdx = 0;

  global.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    requested.push({ query: body.query, variables: body.variables });
    const isProducts = /SyncStoreProducts/.test(body.query);
    const payload = isProducts ? productPages[productIdx++] : orderPages[orderIdx++];
    if (!payload) {
      throw new Error(
        `sync asked for more pages than the fixture provides (products=${productIdx}, orders=${orderIdx})`
      );
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: payload }),
      text: async () => "",
    };
  };

  const admin = require(adminPath);
  return {
    admin,
    requested,
    saved,
    restore: () => {
      global.fetch = originalFetch;
    },
  };
}

// ===========================================================================

test("the pagination bounds are documented constants, not buried literals", () => {
  const { SYNC_PAGE_SIZE, MAX_ORDER_PAGES, MAX_PRODUCT_PAGES } = require(
    d("services/shopifyAdminService.js")
  );
  assert.equal(SYNC_PAGE_SIZE, 250, "Shopify's maximum page size — fewest round trips");
  // 20 pages x 250 = 5000, which is exactly explainabilityService's
  // READ_CAPS.orders. The sync now delivers precisely what the analysis layer
  // is already bounded to consume.
  assert.equal(MAX_ORDER_PAGES, 20);
  assert.equal(MAX_PRODUCT_PAGES, 8);
});

test("REGRESSION: the sync follows cursors instead of stopping at one page", async () => {
  const w = loadSync({
    productPages: [productPage(2, { hasNextPage: false, cursor: null })],
    orderPages: [
      orderPage(250, { hasNextPage: true, cursor: "cursor-1", startIndex: 0 }),
      orderPage(250, { hasNextPage: true, cursor: "cursor-2", startIndex: 250 }),
      orderPage(60, { hasNextPage: false, cursor: null, startIndex: 500 }),
    ],
  });

  try {
    const result = await w.admin.syncShopifyStoreData("test-shop.myshopify.com");
    assert.equal(result.counts.fetched.orders, 560, "all three pages must be read");
    assert.equal(result.counts.fetched.orderPages, 3);
    assert.equal(result.counts.fetched.ordersTruncated, false);

    // The second and third requests must carry the cursor the previous page
    // returned — a loop that refetches page one forever would also "paginate".
    const orderRequests = w.requested.filter((r) => /SyncStoreOrders/.test(r.query));
    assert.equal(orderRequests.length, 3);
    assert.equal(orderRequests[0].variables.after, null);
    assert.equal(orderRequests[1].variables.after, "cursor-1");
    assert.equal(orderRequests[2].variables.after, "cursor-2");
    assert.equal(orderRequests[0].variables.first, 250);
  } finally {
    w.restore();
  }
});

test("REGRESSION: 50+ orders now reach the database, so Customer Loss can qualify", async () => {
  // The specific consequence of the old 20-row ceiling: CUSTOMER_LOSS refuses
  // to compute a baseline below 50 eligible store orders, so the family could
  // never fire. This asserts the precondition is now satisfiable.
  const { CUSTOMER_LOSS } = require(d("services/customerLossCalc.js"));
  assert.equal(CUSTOMER_LOSS.minStoreOrders, 50, "if this moves, revisit the bound below");

  const w = loadSync({
    productPages: [productPage(3, { hasNextPage: false, cursor: null })],
    orderPages: [orderPage(120, { hasNextPage: false, cursor: null })],
  });

  try {
    const result = await w.admin.syncShopifyStoreData("test-shop.myshopify.com");
    assert.ok(
      result.counts.fetched.orders >= CUSTOMER_LOSS.minStoreOrders,
      "the sync must be able to deliver a store baseline at all"
    );
    assert.ok(
      w.saved.orders.length >= CUSTOMER_LOSS.minStoreOrders,
      `only ${w.saved.orders.length} orders persisted; the detector needs ${CUSTOMER_LOSS.minStoreOrders}`
    );
  } finally {
    w.restore();
  }
});

test("SAFETY: a very large store stops at the ceiling and SAYS it was truncated", async () => {
  const { MAX_ORDER_PAGES } = require(d("services/shopifyAdminService.js"));
  // Every page claims another page follows, so only the ceiling stops it.
  const endless = Array.from({ length: MAX_ORDER_PAGES }, (_, i) =>
    orderPage(250, { hasNextPage: true, cursor: `c${i}`, startIndex: i * 250 })
  );

  const w = loadSync({
    productPages: [productPage(1, { hasNextPage: false, cursor: null })],
    orderPages: endless,
  });

  try {
    const result = await w.admin.syncShopifyStoreData("test-shop.myshopify.com");
    assert.equal(result.counts.fetched.orderPages, MAX_ORDER_PAGES, "the bound must hold");
    assert.equal(
      result.counts.fetched.ordersTruncated,
      true,
      "a bound the merchant is not told about reads as completeness"
    );
  } finally {
    w.restore();
  }
});

test("SAFETY: products paginate and bound the same way", async () => {
  const { MAX_PRODUCT_PAGES } = require(d("services/shopifyAdminService.js"));
  const endless = Array.from({ length: MAX_PRODUCT_PAGES }, (_, i) =>
    productPage(250, { hasNextPage: true, cursor: `p${i}`, startIndex: i * 250 })
  );

  const w = loadSync({
    productPages: endless,
    orderPages: [orderPage(1, { hasNextPage: false, cursor: null })],
  });

  try {
    const result = await w.admin.syncShopifyStoreData("test-shop.myshopify.com");
    assert.equal(result.counts.fetched.productPages, MAX_PRODUCT_PAGES);
    assert.equal(result.counts.fetched.productsTruncated, true);
  } finally {
    w.restore();
  }
});

test("a small store makes exactly one request per resource", async () => {
  const w = loadSync({
    productPages: [productPage(4, { hasNextPage: false, cursor: null })],
    orderPages: [orderPage(9, { hasNextPage: false, cursor: null })],
  });

  try {
    const result = await w.admin.syncShopifyStoreData("test-shop.myshopify.com");
    assert.equal(result.counts.fetched.orderPages, 1, "no wasted round trips");
    assert.equal(result.counts.fetched.productPages, 1);
    assert.equal(result.counts.fetched.ordersTruncated, false);
    assert.equal(result.counts.fetched.productsTruncated, false);
  } finally {
    w.restore();
  }
});

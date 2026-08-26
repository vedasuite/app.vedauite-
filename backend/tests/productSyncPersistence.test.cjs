const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

process.env.SHOPIFY_API_KEY ||= "test-key";
process.env.SHOPIFY_API_SECRET ||= "test-secret";
process.env.SHOPIFY_APP_URL ||= "https://app.vedasuite.in";
process.env.SHOPIFY_ADMIN_API_VERSION ||= "2026-01";
process.env.DATABASE_URL ||= "postgresql://example:example@localhost:5432/example";

/**
 * A PRODUCT IS NOT DISCARDED FOR HAVING NO PRICE.
 *
 * THE DEFECT
 * ----------
 * Three products were created by hand in the staging store — SKU-A at 20,
 * SKU-B at 8, SKU-C at 5 — and VedaSuite reported "Products checked: 0" and
 * "No products synced yet". Reconciliation had no Shopify side at all, so it
 * treated the file's SKUs as unmatched.
 *
 * The sync fetched all three. The persistence loop then began:
 *
 *     if (!product.handle || variants.length === 0 || !currentPrice) {
 *       syncCounts.skipped.products += 1;
 *       continue;
 *     }
 *
 * A product priced 0.00 — which is what the Price field holds when nobody
 * types into it — failed `!currentPrice` and was thrown away before it was
 * ever stored. The only record was an internal `skipped` tally that no surface
 * read.
 *
 * The guard was not arbitrary: the pricing baseline further down computes
 * `(recommended - current) / current`, which is NaN at zero and rejected by
 * Prisma. But that is a reason to skip the BASELINE, not the product. Price is
 * a fact about a product; SKU and inventory — the things reconciliation needs —
 * have nothing to do with it.
 *
 * These tests drive the real sync against a mocked Shopify and a mocked
 * database, and assert the three staging products land with their SKUs and
 * quantities intact.
 */

function resetModule(modulePath) {
  delete require.cache[require.resolve(modulePath)];
}

function mockModule(absPath, exports) {
  require.cache[absPath] = { id: absPath, filename: absPath, loaded: true, exports };
}

const d = (p) => path.resolve(__dirname, `../dist/${p}`);

/** The three products the staging store actually contains. */
const STAGING_PRODUCTS = [
  { sku: "SKU-A", qty: 20 },
  { sku: "SKU-B", qty: 8 },
  { sku: "SKU-C", qty: 5 },
];

/**
 * One Shopify product page.
 *
 * `price` defaults to "0.00" — what Shopify returns for a product created in
 * the admin without typing into the Price field, and the exact input that used
 * to make the product vanish.
 */
function productPage(items, { hasNextPage = false, cursor = null } = {}) {
  return {
    shop: { name: "Test Store" },
    products: {
      pageInfo: { hasNextPage, endCursor: cursor },
      edges: items.map((item, i) => ({
        node: {
          id: `gid://shopify/Product/${i}`,
          handle: item.handle ?? `vedasuite-test-product-${i}`,
          title: item.title ?? `Product ${i}`,
          status: "ACTIVE",
          variants: {
            edges: [
              {
                node: {
                  id: `gid://shopify/ProductVariant/${i}`,
                  title: "Default Title",
                  price: item.price ?? "0.00",
                  sku: item.sku ?? null,
                  inventoryQuantity: item.qty ?? null,
                },
              },
            ],
          },
        },
      })),
    },
  };
}

function emptyOrderPage() {
  return { orders: { pageInfo: { hasNextPage: false, endCursor: null }, edges: [] } };
}

/** Orders that DO persist, so the global fetched-but-saved-nothing guard stays quiet. */
function orderPage(count) {
  return {
    orders: {
      pageInfo: { hasNextPage: false, endCursor: null },
      edges: Array.from({ length: count }, (_, n) => ({
        node: {
          id: `gid://shopify/Order/${n}`,
          legacyResourceId: String(n),
          name: `#${1000 + n}`,
          createdAt: new Date(Date.UTC(2026, 6, 1 + (n % 28))).toISOString(),
          displayFinancialStatus: "PAID",
          displayFulfillmentStatus: "FULFILLED",
          currentTotalPriceSet: { shopMoney: { amount: "100.00", currencyCode: "USD" } },
          customer: null,
          tags: [],
        },
      })),
    },
  };
}

/** Loads the real sync with Shopify mocked at fetch and the database at prisma. */
function loadSync({ productPages, orderPages = [emptyOrderPage()] }) {
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
  const saved = { products: [], variants: [], priceRows: [], orders: [] };

  prisma.store = {
    findUnique: async () => ({ id: "store-1", shop: "test-shop.myshopify.com" }),
    update: async () => ({}),
  };
  prisma.customer = {
    findFirst: async () => null,
    create: async ({ data }) => ({ id: "c-0", ...data, orders: [] }),
    update: async () => ({}),
    findMany: async () => [],
  };
  prisma.order = {
    findFirst: async () => null,
    create: async () => ({}),
    update: async () => ({}),
    count: async () => 0,
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
    upsert: async ({ create }) => {
      const row = { id: `v-${saved.variants.length}`, ...create };
      saved.variants.push(row);
      return row;
    },
  };
  prisma.priceHistory = {
    count: async () => 0,
    // Real Prisma rejects NaN on a Float column. The harness must too, or a
    // divide-by-zero would pass here and fail only in production.
    create: async ({ data }) => {
      for (const [key, value] of Object.entries(data)) {
        if (typeof value === "number" && !Number.isFinite(value)) {
          throw new Error(`priceHistory.${key} received a non-finite number: ${value}`);
        }
      }
      saved.priceRows.push(data);
      return {};
    },
    deleteMany: async () => ({ count: 0 }),
  };

  const originalFetch = global.fetch;
  let productIdx = 0;
  let orderIdx = 0;

  global.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const isProducts = /SyncStoreProducts/.test(body.query);
    const payload = isProducts ? productPages[productIdx++] : orderPages[orderIdx++];
    if (!payload) throw new Error("sync asked for more pages than the fixture provides");
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: payload }),
      text: async () => "",
    };
  };

  return {
    admin: require(adminPath),
    saved,
    restore: () => {
      global.fetch = originalFetch;
    },
  };
}

// ===========================================================================

test("REGRESSION: the three staging products persist despite having no price", async () => {
  const w = loadSync({
    productPages: [
      productPage(
        STAGING_PRODUCTS.map((p, i) => ({
          sku: p.sku,
          qty: p.qty,
          handle: `vedasuite-test-product-${"abc"[i]}`,
          title: `VedaSuite Test Product ${"ABC"[i]}`,
          price: "0.00", // the exact value that used to delete them
        }))
      ),
    ],
  });

  try {
    const result = await w.admin.syncShopifyStoreData("test-shop.myshopify.com");

    assert.equal(result.counts.fetched.products, 3, "Shopify returned three");
    assert.equal(
      result.counts.saved.productsCreated,
      3,
      "all three must be stored — this was 0"
    );
    assert.equal(result.counts.skipped.products, 0, "none may be discarded");
    assert.equal(w.saved.products.length, 3);

    // The values reconciliation actually compares against.
    for (const expected of STAGING_PRODUCTS) {
      const variant = w.saved.variants.find((v) => v.sku === expected.sku);
      assert.ok(variant, `${expected.sku} must reach VariantSnapshot`);
      assert.equal(
        variant.inventoryQuantity,
        expected.qty,
        `${expected.sku} must carry Shopify quantity ${expected.qty}`
      );
    }
  } finally {
    w.restore();
  }
});

test("a zero price skips the pricing baseline, not the product", async () => {
  const w = loadSync({
    productPages: [productPage([{ sku: "SKU-A", qty: 20, price: "0.00" }])],
  });

  try {
    const result = await w.admin.syncShopifyStoreData("test-shop.myshopify.com");

    // Stored...
    assert.equal(result.counts.saved.productsCreated, 1);
    // ...but no pricing row invented from a price of zero.
    assert.equal(w.saved.priceRows.length, 0);
    assert.equal(result.counts.skipped.priceBaselines, 1);
  } finally {
    w.restore();
  }
});

test("a priced product still gets its pricing baseline", async () => {
  const w = loadSync({
    productPages: [productPage([{ sku: "SKU-A", qty: 20, price: "25.00" }])],
  });

  try {
    const result = await w.admin.syncShopifyStoreData("test-shop.myshopify.com");
    assert.equal(result.counts.saved.productsCreated, 1);
    assert.equal(w.saved.priceRows.length, 1, "a real price must still produce a baseline");
    assert.equal(result.counts.skipped.priceBaselines, 0);
    assert.ok(
      Number.isFinite(w.saved.priceRows[0].expectedMarginDelta),
      "margin delta must be a real number"
    );
  } finally {
    w.restore();
  }
});

test("products genuinely unusable are skipped WITH a reason", async () => {
  const w = loadSync({
    productPages: [
      productPage([
        { sku: "SKU-A", qty: 20, price: "25.00" },
        { sku: "SKU-B", qty: 8, price: "0.00", handle: "" },
      ]),
    ],
  });

  try {
    const result = await w.admin.syncShopifyStoreData("test-shop.myshopify.com");
    assert.equal(result.counts.saved.productsCreated, 1);
    assert.equal(result.counts.skipped.products, 1);
    // A count without a reason is what made this invisible for a whole cycle.
    assert.equal(result.counts.skippedReasons.noHandle, 1);
    assert.equal(result.counts.skippedReasons.noVariants, 0);
  } finally {
    w.restore();
  }
});

test("fetching products and storing none is never reported as SUCCESS", async () => {
  // FAITHFUL TO STAGING: orders persisted, products did not.
  //
  // There IS a global guard that throws when a sync fetches records and saves
  // nothing at all — but it sums every resource together. With 75 orders
  // committed, `savedTotal` was comfortably non-zero and the guard stayed
  // silent while every product was discarded. A whole-sync check cannot see one
  // resource go to zero, which is why the per-resource status below has to.
  const w = loadSync({
    productPages: [
      productPage([
        { sku: "SKU-A", qty: 20, price: "0.00", handle: "" },
        { sku: "SKU-B", qty: 8, price: "0.00", handle: "" },
      ]),
    ],
    orderPages: [orderPage(3)],
  });

  try {
    const result = await w.admin.syncShopifyStoreData("test-shop.myshopify.com");

    assert.equal(result.counts.fetched.products, 2);
    assert.equal(result.counts.saved.productsCreated, 0);

    // "SUCCESS" here used to mean only "did not throw", and the diagnostics
    // endpoint read that as proof the merchant's catalogue was empty.
    assert.equal(result.resourceStatus.products.status, "FETCHED_NONE_PERSISTED");
    assert.equal(result.resourceStatus.products.fetched, 2);
    assert.equal(result.resourceStatus.products.count, 0);
    assert.equal(result.resourceStatus.products.skipped, 2);
  } finally {
    w.restore();
  }
});

test("an empty catalogue is distinguishable from a discarded one", async () => {
  const w = loadSync({ productPages: [productPage([])] });

  try {
    const result = await w.admin.syncShopifyStoreData("test-shop.myshopify.com");
    assert.equal(result.counts.fetched.products, 0);
    assert.equal(
      result.resourceStatus.products.status,
      "SUCCESS_EMPTY",
      "genuinely empty must not share a status with fetched-then-discarded"
    );
  } finally {
    w.restore();
  }
});

test("storing some but not all is its own outcome", async () => {
  const w = loadSync({
    productPages: [
      productPage([
        { sku: "SKU-A", qty: 20, price: "25.00" },
        { sku: "SKU-B", qty: 8, price: "0.00", handle: "" },
      ]),
    ],
  });

  try {
    const result = await w.admin.syncShopifyStoreData("test-shop.myshopify.com");
    assert.equal(result.resourceStatus.products.status, "SUCCESS_PARTIAL");
    assert.equal(result.resourceStatus.products.fetched, 2);
    assert.equal(result.resourceStatus.products.count, 1);
  } finally {
    w.restore();
  }
});

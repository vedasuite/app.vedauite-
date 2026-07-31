const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

process.env.SHOPIFY_API_KEY ||= "test-key";
process.env.SHOPIFY_API_SECRET ||= "test-secret";
process.env.SHOPIFY_APP_URL ||= "https://app.vedasuite.in";
process.env.SHOPIFY_ADMIN_API_VERSION ||= "2026-01";
process.env.DATABASE_URL ||= "postgresql://example:example@localhost:5432/example";

function resetModule(modulePath) {
  const resolved = require.resolve(modulePath);
  delete require.cache[resolved];
}

function mockModule(absPath, exports) {
  require.cache[absPath] = { id: absPath, filename: absPath, loaded: true, exports };
}

// shopifyGraphQL talks to Shopify directly via global fetch (not axios) and
// only depends on shopifyConnectionService for token resolution/refresh —
// mock that module directly so these tests exercise the real retry logic in
// shopifyAdminService.js without touching a real database.
function loadService({ resolveOfflineInstallation, forceRefreshOfflineAccessToken }) {
  const connectionServicePath = path.resolve(
    __dirname,
    "../dist/services/shopifyConnectionService.js"
  );
  const adminServicePath = path.resolve(
    __dirname,
    "../dist/services/shopifyAdminService.js"
  );
  resetModule(connectionServicePath);
  resetModule(adminServicePath);

  mockModule(connectionServicePath, {
    resolveOfflineInstallation,
    forceRefreshOfflineAccessToken,
    normalizeShopDomain: (shop) => shop,
    updateConnectionDiagnostics: async () => {},
    isShopifyAuthRejection: (status, text) => {
      if (status === 401) return true;
      if (status === 403 && /non-expiring access tokens? (is|are) no longer accepted/i.test(text)) {
        return true;
      }
      return /invalid api key|invalid access token|unrecognized login|wrong password/i.test(text);
    },
  });

  return require(adminServicePath);
}

test("a 403 'non-expiring access tokens are no longer accepted' response triggers exactly one forced refresh, then retries and succeeds", async () => {
  let refreshCalls = 0;
  let installationCalls = 0;
  const { shopifyGraphQL } = loadService({
    resolveOfflineInstallation: async () => {
      installationCalls += 1;
      return { id: "store-1", shop: "test-shop.myshopify.com", accessToken: "stale-legacy-token" };
    },
    forceRefreshOfflineAccessToken: async () => {
      refreshCalls += 1;
      return { accessToken: "fresh-token" };
    },
  });

  let fetchCalls = 0;
  const originalFetch = global.fetch;
  global.fetch = async () => {
    fetchCalls += 1;
    if (fetchCalls === 1) {
      return {
        ok: false,
        status: 403,
        text: async () =>
          '{"errors":"[API] Non-expiring access tokens are no longer accepted for the Admin API."}',
      };
    }
    return {
      ok: true,
      json: async () => ({ data: { shop: { name: "Test Shop" } } }),
    };
  };

  try {
    const data = await shopifyGraphQL("test-shop.myshopify.com", "query { shop { name } }");
    assert.deepEqual(data, { shop: { name: "Test Shop" } });
    assert.equal(refreshCalls, 1, "expected exactly one forced refresh");
    assert.equal(fetchCalls, 2, "expected one failed call and one retried call");
    assert.equal(installationCalls, 2, "expected token to be re-resolved for the retry");
  } finally {
    global.fetch = originalFetch;
  }
});

test("a definitively rejected refresh (no way to self-heal) surfaces a controlled reconnect error instead of the raw Shopify error, and never retries a second time", async () => {
  let refreshCalls = 0;
  const { shopifyGraphQL } = loadService({
    resolveOfflineInstallation: async () => ({
      id: "store-1",
      shop: "test-shop.myshopify.com",
      accessToken: "stale-legacy-token",
    }),
    forceRefreshOfflineAccessToken: async () => {
      refreshCalls += 1;
      const err = new Error("Stored Shopify offline installation does not include a refresh token.");
      err.code = "SHOPIFY_RECONNECT_REQUIRED";
      throw err;
    },
  });

  let fetchCalls = 0;
  const originalFetch = global.fetch;
  global.fetch = async () => {
    fetchCalls += 1;
    return {
      ok: false,
      status: 403,
      text: async () =>
        '{"errors":"[API] Non-expiring access tokens are no longer accepted for the Admin API."}',
    };
  };

  try {
    await assert.rejects(
      () => shopifyGraphQL("test-shop.myshopify.com", "query { shop { name } }"),
      (error) => {
        assert.match(error.message, /Reauthorize the app and retry/i);
        return true;
      }
    );
    assert.equal(refreshCalls, 1, "expected exactly one refresh attempt, not a retry loop");
    assert.equal(fetchCalls, 1, "must not call Shopify again after the refresh attempt fails");
  } finally {
    global.fetch = originalFetch;
  }
});

test("a generic 500 error is not treated as an auth rejection and is not retried", async () => {
  let refreshCalls = 0;
  const { shopifyGraphQL } = loadService({
    resolveOfflineInstallation: async () => ({
      id: "store-1",
      shop: "test-shop.myshopify.com",
      accessToken: "some-token",
    }),
    forceRefreshOfflineAccessToken: async () => {
      refreshCalls += 1;
      return { accessToken: "irrelevant" };
    },
  });

  let fetchCalls = 0;
  const originalFetch = global.fetch;
  global.fetch = async () => {
    fetchCalls += 1;
    return { ok: false, status: 500, text: async () => "Internal Server Error" };
  };

  try {
    await assert.rejects(() =>
      shopifyGraphQL("test-shop.myshopify.com", "query { shop { name } }")
    );
    assert.equal(refreshCalls, 0, "a non-auth failure must not trigger a token refresh");
    assert.equal(fetchCalls, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

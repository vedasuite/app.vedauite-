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

test("refreshes expiring offline token before server-side Admin access", async () => {
  const prismaPath = path.resolve(__dirname, "../dist/db/prismaClient.js");
  const axiosPath = require.resolve("axios");
  const servicePath = path.resolve(
    __dirname,
    "../dist/services/shopifyConnectionService.js"
  );

  resetModule(prismaPath);
  resetModule(axiosPath);
  resetModule(servicePath);

  const prismaModule = require(prismaPath);
  const axiosModule = require(axiosPath);

  prismaModule.prisma.store.findUnique = async () => ({
    id: "store-1",
    shop: "test-shop.myshopify.com",
    accessToken: "expired-access-token",
    refreshToken: "refresh-token",
    grantedScopes: "read_products,read_orders",
    tokenAcquisitionMode: "offline_expiring",
    accessTokenExpiresAt: new Date(Date.now() - 60_000),
    refreshTokenExpiresAt: new Date(Date.now() + 86_400_000),
    pricingBias: 55,
    profitGuardrail: 18,
    uninstalledAt: null,
  });

  let updatePayload = null;
  prismaModule.prisma.store.update = async (payload) => {
    updatePayload = payload;
    return {
      id: "store-1",
      shop: "test-shop.myshopify.com",
      accessToken: payload.data.accessToken,
      refreshToken: payload.data.refreshToken,
      grantedScopes: payload.data.grantedScopes,
      tokenAcquisitionMode: payload.data.tokenAcquisitionMode,
      accessTokenExpiresAt: payload.data.accessTokenExpiresAt,
      refreshTokenExpiresAt: payload.data.refreshTokenExpiresAt,
      pricingBias: 55,
      profitGuardrail: 18,
      uninstalledAt: null,
    };
  };

  axiosModule.post = async (_url, body) => {
    assert.equal(body.grant_type, "refresh_token");
    assert.equal(body.refresh_token, "refresh-token");
    return {
      data: {
        access_token: "new-offline-token",
        refresh_token: "new-refresh-token",
        expires_in: 3600,
        refresh_token_expires_in: 86400,
        scope: "read_products,read_orders",
      },
    };
  };
  if (axiosModule.default) {
    axiosModule.default.post = axiosModule.post;
  }

  const { getShopAccessToken } = require(servicePath);
  const token = await getShopAccessToken("test-shop.myshopify.com");

  assert.equal(token, "new-offline-token");
  assert.ok(updatePayload);
  assert.equal(updatePayload.data.tokenAcquisitionMode, "offline_expiring");
  assert.equal(updatePayload.data.refreshToken, "new-refresh-token");
});

test("returns REFRESH_TOKEN_EXPIRED when refresh token has already expired", async () => {
  const prismaPath = path.resolve(__dirname, "../dist/db/prismaClient.js");
  const servicePath = path.resolve(
    __dirname,
    "../dist/services/shopifyConnectionService.js"
  );

  resetModule(prismaPath);
  resetModule(servicePath);

  const prismaModule = require(prismaPath);
  prismaModule.prisma.store.findUnique = async () => ({
    id: "store-1",
    shop: "test-shop.myshopify.com",
    accessToken: "expired-access-token",
    refreshToken: "expired-refresh-token",
    grantedScopes: "read_products,read_orders",
    tokenAcquisitionMode: "offline_expiring",
    accessTokenExpiresAt: new Date(Date.now() - 60_000),
    refreshTokenExpiresAt: new Date(Date.now() - 60_000),
    pricingBias: 55,
    profitGuardrail: 18,
    uninstalledAt: null,
  });

  prismaModule.prisma.store.update = async () => ({ id: "store-1" });

  const { resolveOfflineInstallation } = require(servicePath);

  await assert.rejects(
    () => resolveOfflineInstallation("test-shop.myshopify.com"),
    (error) => {
      assert.equal(error.code, "REFRESH_TOKEN_EXPIRED");
      return true;
    }
  );
});

// A legacy (non-expiring) token with no refresh token is no longer an
// immediate dead end: refreshOfflineAccessToken now attempts a one-time
// migration exchange (exchangeLegacyOfflineToken, using the existing legacy
// access token itself — no live session token required) before giving up.
// These two tests cover both outcomes of that attempt.

test("session-less self-heal: forceRefreshOfflineAccessToken migrates a legacy token (no refresh token) using the legacy access token itself, no session token needed", async () => {
  const prismaPath = path.resolve(__dirname, "../dist/db/prismaClient.js");
  const axiosPath = require.resolve("axios");
  const servicePath = path.resolve(
    __dirname,
    "../dist/services/shopifyConnectionService.js"
  );

  resetModule(prismaPath);
  resetModule(axiosPath);
  resetModule(servicePath);

  const prismaModule = require(prismaPath);
  const axiosModule = require(axiosPath);

  let currentAccessToken = "legacy-access-token";
  prismaModule.prisma.store.findUnique = async () => ({
    id: "store-1",
    shop: "test-shop.myshopify.com",
    accessToken: currentAccessToken,
    refreshToken: null,
    grantedScopes: "read_products,read_orders",
    tokenAcquisitionMode: "offline_legacy",
    installedAt: new Date(Date.now() - 1_000_000),
    reauthorizedAt: new Date(Date.now() - 1_000_000),
    accessTokenExpiresAt: null,
    refreshTokenExpiresAt: null,
    pricingBias: 55,
    profitGuardrail: 18,
    webhooksRegisteredAt: new Date(),
    lastWebhookRegistrationStatus: "SUCCEEDED",
    lastSyncStatus: "SUCCEEDED",
    lastSyncAt: new Date(),
    lastConnectionCheckAt: new Date(),
    lastConnectionStatus: "OK",
    authErrorCode: null,
    authErrorMessage: null,
    lastConnectionError: null,
    uninstalledAt: null,
  });
  prismaModule.prisma.store.update = async (payload) => {
    if (payload.data.accessToken) currentAccessToken = payload.data.accessToken;
    return { id: "store-1", ...payload.data };
  };

  axiosModule.post = async (_url, body) => {
    assert.equal(body.subject_token, "legacy-access-token");
    assert.equal(
      body.subject_token_type,
      "urn:shopify:params:oauth:token-type:offline-access-token"
    );
    assert.equal(body.expiring, "1");
    return {
      data: {
        access_token: "migrated-expiring-token",
        refresh_token: "migrated-refresh-token",
        expires_in: 3600,
        refresh_token_expires_in: 86400,
        scope: "read_products,read_orders",
      },
    };
  };
  if (axiosModule.default) axiosModule.default.post = axiosModule.post;

  const { forceRefreshOfflineAccessToken } = require(servicePath);
  const updated = await forceRefreshOfflineAccessToken("test-shop.myshopify.com");

  assert.equal(updated.accessToken, "migrated-expiring-token");
  assert.equal(currentAccessToken, "migrated-expiring-token");
});

test("health falls back to reconnect-required state when a legacy token cannot be migrated or refreshed", async () => {
  const prismaPath = path.resolve(__dirname, "../dist/db/prismaClient.js");
  const axiosPath = require.resolve("axios");
  const servicePath = path.resolve(
    __dirname,
    "../dist/services/shopifyConnectionService.js"
  );

  resetModule(prismaPath);
  resetModule(axiosPath);
  resetModule(servicePath);

  const prismaModule = require(prismaPath);
  const axiosModule = require(axiosPath);

  prismaModule.prisma.store.findUnique = async () => ({
    id: "store-1",
    shop: "test-shop.myshopify.com",
    accessToken: "expired-access-token",
    refreshToken: null,
    grantedScopes: "read_products,read_orders",
    tokenAcquisitionMode: "offline_legacy",
    installedAt: new Date(Date.now() - 1_000_000),
    reauthorizedAt: new Date(Date.now() - 1_000_000),
    accessTokenExpiresAt: new Date(Date.now() - 60_000),
    refreshTokenExpiresAt: null,
    pricingBias: 55,
    profitGuardrail: 18,
    webhooksRegisteredAt: new Date(),
    lastWebhookRegistrationStatus: "SUCCEEDED",
    lastSyncStatus: "SUCCEEDED",
    lastSyncAt: new Date(),
    lastConnectionCheckAt: new Date(),
    lastConnectionStatus: "OK",
    authErrorCode: null,
    authErrorMessage: null,
    lastConnectionError: null,
    uninstalledAt: null,
  });
  prismaModule.prisma.store.update = async () => ({ id: "store-1" });

  const definitiveRejection = Object.assign(new Error("invalid_grant"), {
    isAxiosError: true,
    response: { status: 400, data: { error: "invalid_grant" } },
  });
  axiosModule.post = async () => {
    throw definitiveRejection;
  };
  if (axiosModule.default) axiosModule.default.post = axiosModule.post;
  if (axiosModule.isAxiosError === undefined) {
    axiosModule.isAxiosError = (err) => !!err?.isAxiosError;
  }

  const { getConnectionHealth } = require(servicePath);
  const health = await getConnectionHealth("test-shop.myshopify.com", {
    probeApi: true,
  });

  assert.equal(health.healthy, false);
  assert.equal(health.code, "SHOPIFY_RECONNECT_REQUIRED");
  assert.equal(health.reauthRequired, true);
  assert.ok(health.reauthorizeUrl && health.reauthorizeUrl.includes("/auth/reconnect"));
});

// ---------------------------------------------------------------------------
// Expiring-token acquisition, persistence, refresh, concurrency, and failure
// handling — added for the Shopify "non-expiring access tokens are no longer
// accepted" verification fix.
// ---------------------------------------------------------------------------

function loadFreshModules() {
  const prismaPath = path.resolve(__dirname, "../dist/db/prismaClient.js");
  const axiosPath = require.resolve("axios");
  const servicePath = path.resolve(
    __dirname,
    "../dist/services/shopifyConnectionService.js"
  );
  resetModule(prismaPath);
  resetModule(axiosPath);
  resetModule(servicePath);
  const prismaModule = require(prismaPath);
  const axiosModule = require(axiosPath);
  const service = require(servicePath);
  return { prismaModule, axiosModule, service };
}

test("expiring-token acquisition: session-token exchange persists access token, expiry, refresh token, and refresh expiry", async () => {
  const { prismaModule, axiosModule, service } = loadFreshModules();

  let upsertPayload = null;
  prismaModule.prisma.store.upsert = async (payload) => {
    upsertPayload = payload;
    return { id: "store-1", shop: "test-shop.myshopify.com", ...payload.create };
  };

  axiosModule.post = async (_url, body) => {
    assert.equal(
      body.grant_type,
      "urn:ietf:params:oauth:grant-type:token-exchange"
    );
    assert.equal(body.subject_token, "session-token-abc");
    assert.equal(body.expiring, "1", "must explicitly request an expiring token");
    return {
      data: {
        access_token: "fresh-offline-token",
        refresh_token: "fresh-refresh-token",
        expires_in: 3600,
        refresh_token_expires_in: 86400,
        scope: "read_products,read_orders",
      },
    };
  };
  if (axiosModule.default) axiosModule.default.post = axiosModule.post;

  const store = await service.exchangeSessionTokenForOfflineToken(
    "test-shop.myshopify.com",
    "session-token-abc"
  );

  assert.equal(store.accessToken, "fresh-offline-token");
  assert.ok(upsertPayload.create.accessTokenExpiresAt instanceof Date);
  assert.equal(upsertPayload.create.refreshToken, "fresh-refresh-token");
  assert.ok(upsertPayload.create.refreshTokenExpiresAt instanceof Date);
  assert.equal(upsertPayload.create.tokenAcquisitionMode, "offline_expiring");
});

test("valid token reuse: a fresh, non-legacy token makes no network call", async () => {
  const { prismaModule, axiosModule, service } = loadFreshModules();

  prismaModule.prisma.store.findUnique = async () => ({
    accessToken: "still-good-token",
    accessTokenExpiresAt: new Date(Date.now() + 3600_000),
    refreshToken: "some-refresh-token",
    uninstalledAt: null,
  });

  let calledPost = false;
  axiosModule.post = async () => {
    calledPost = true;
    throw new Error("should not be called");
  };
  if (axiosModule.default) axiosModule.default.post = axiosModule.post;

  const usable = await service.ensureOfflineAccessToken(
    "test-shop.myshopify.com",
    "any-session-token"
  );

  assert.equal(usable, true);
  assert.equal(calledPost, false);
});

test("legacy token opportunistic upgrade: a token with no refresh token is exchanged once when a session token is present", async () => {
  const { prismaModule, axiosModule, service } = loadFreshModules();

  prismaModule.prisma.store.findUnique = async () => ({
    accessToken: "legacy-non-expiring-token",
    accessTokenExpiresAt: null,
    refreshToken: null,
    uninstalledAt: null,
  });
  prismaModule.prisma.store.upsert = async (payload) => ({
    id: "store-1",
    shop: "test-shop.myshopify.com",
    ...payload.update,
  });

  let postCalls = 0;
  axiosModule.post = async (_url, body) => {
    postCalls += 1;
    assert.equal(
      body.grant_type,
      "urn:ietf:params:oauth:grant-type:token-exchange"
    );
    assert.equal(body.expiring, "1", "must explicitly request an expiring token");
    return {
      data: {
        access_token: "upgraded-expiring-token",
        refresh_token: "new-refresh-token",
        expires_in: 3600,
        refresh_token_expires_in: 86400,
        scope: "read_products,read_orders",
      },
    };
  };
  if (axiosModule.default) axiosModule.default.post = axiosModule.post;

  const usable = await service.ensureOfflineAccessToken(
    "test-shop.myshopify.com",
    "live-session-token"
  );

  assert.equal(usable, true);
  assert.equal(postCalls, 1, "expected exactly one upgrade exchange call");
});

test("concurrent refresh protection: two simultaneous refreshes for the same shop only issue one Shopify request", async () => {
  const { prismaModule, axiosModule, service } = loadFreshModules();

  prismaModule.prisma.store.findUnique = async () => ({
    id: "store-1",
    shop: "test-shop.myshopify.com",
    accessToken: "expiring-soon-token",
    refreshToken: "refresh-token-1",
    grantedScopes: "read_products,read_orders",
    tokenAcquisitionMode: "offline_expiring",
    accessTokenExpiresAt: new Date(Date.now() + 30_000), // within the refresh buffer
    refreshTokenExpiresAt: new Date(Date.now() + 86_400_000),
    pricingBias: 55,
    profitGuardrail: 18,
    uninstalledAt: null,
  });
  prismaModule.prisma.store.update = async (payload) => ({
    id: "store-1",
    shop: "test-shop.myshopify.com",
    ...payload.data,
  });

  let postCalls = 0;
  axiosModule.post = async (_url, body) => {
    postCalls += 1;
    assert.equal(body.grant_type, "refresh_token");
    await new Promise((resolve) => setTimeout(resolve, 20)); // force overlap
    return {
      data: {
        access_token: "refreshed-token",
        refresh_token: "refresh-token-2",
        expires_in: 3600,
        refresh_token_expires_in: 86400,
        scope: "read_products,read_orders",
      },
    };
  };
  if (axiosModule.default) axiosModule.default.post = axiosModule.post;

  const [a, b] = await Promise.all([
    service.resolveOfflineInstallation("test-shop.myshopify.com"),
    service.resolveOfflineInstallation("test-shop.myshopify.com"),
  ]);

  assert.equal(postCalls, 1, "expected the second caller to reuse the first refresh in flight");
  assert.equal(a.accessToken, "refreshed-token");
  assert.equal(b.accessToken, "refreshed-token");
});

test("rotated refresh token: a subsequent refresh uses the newly rotated token, never the old one", async () => {
  const { prismaModule, axiosModule, service } = loadFreshModules();

  let currentRefreshToken = "refresh-token-v1";
  prismaModule.prisma.store.findUnique = async () => ({
    id: "store-1",
    shop: "test-shop.myshopify.com",
    accessToken: "old-token",
    refreshToken: currentRefreshToken,
    grantedScopes: "read_products,read_orders",
    tokenAcquisitionMode: "offline_expiring",
    installedAt: new Date(Date.now() - 1_000_000),
    reauthorizedAt: new Date(Date.now() - 1_000_000),
    accessTokenExpiresAt: new Date(Date.now() - 1000),
    refreshTokenExpiresAt: new Date(Date.now() + 86_400_000),
    pricingBias: 55,
    profitGuardrail: 18,
    uninstalledAt: null,
  });
  prismaModule.prisma.store.update = async (payload) => {
    // Some updates along this path (e.g. installation-metadata backfill) don't
    // touch the refresh token at all — only track it when the payload actually
    // sets it, so an unrelated update can't clobber it back to undefined.
    if (payload.data.refreshToken !== undefined) {
      currentRefreshToken = payload.data.refreshToken;
    }
    return { id: "store-1", shop: "test-shop.myshopify.com", ...payload.data };
  };

  axiosModule.post = async (_url, body) => {
    assert.equal(body.refresh_token, "refresh-token-v1");
    return {
      data: {
        access_token: "token-v2",
        refresh_token: "refresh-token-v2",
        expires_in: 3600,
        refresh_token_expires_in: 86400,
        scope: "read_products,read_orders",
      },
    };
  };
  if (axiosModule.default) axiosModule.default.post = axiosModule.post;

  await service.forceRefreshOfflineAccessToken("test-shop.myshopify.com");
  assert.equal(currentRefreshToken, "refresh-token-v2");

  // A second, later refresh must present the newly rotated token, not v1.
  const servicePath = path.resolve(__dirname, "../dist/services/shopifyConnectionService.js");
  resetModule(servicePath);
  const service2 = require(servicePath);
  prismaModule.prisma.store.findUnique = async () => ({
    id: "store-1",
    shop: "test-shop.myshopify.com",
    accessToken: "token-v2",
    refreshToken: currentRefreshToken,
    grantedScopes: "read_products,read_orders",
    tokenAcquisitionMode: "offline_expiring",
    accessTokenExpiresAt: new Date(Date.now() - 1000),
    refreshTokenExpiresAt: new Date(Date.now() + 86_400_000),
    pricingBias: 55,
    profitGuardrail: 18,
    uninstalledAt: null,
  });
  axiosModule.post = async (_url, body) => {
    assert.equal(body.refresh_token, "refresh-token-v2");
    return {
      data: {
        access_token: "token-v3",
        refresh_token: "refresh-token-v3",
        expires_in: 3600,
        refresh_token_expires_in: 86400,
      },
    };
  };
  if (axiosModule.default) axiosModule.default.post = axiosModule.post;
  await service2.forceRefreshOfflineAccessToken("test-shop.myshopify.com");
  assert.equal(currentRefreshToken, "refresh-token-v3");
});

test("transient refresh failure: a 500 from Shopify is reported as TOKEN_REFRESH_FAILED, not a forced reconnect", async () => {
  const { prismaModule, axiosModule, service } = loadFreshModules();

  prismaModule.prisma.store.findUnique = async () => ({
    id: "store-1",
    shop: "test-shop.myshopify.com",
    accessToken: "old-token",
    refreshToken: "refresh-token-1",
    grantedScopes: "read_products,read_orders",
    tokenAcquisitionMode: "offline_expiring",
    accessTokenExpiresAt: new Date(Date.now() - 1000),
    refreshTokenExpiresAt: new Date(Date.now() + 86_400_000),
    pricingBias: 55,
    profitGuardrail: 18,
    uninstalledAt: null,
  });
  prismaModule.prisma.store.update = async () => ({ id: "store-1" });

  const transientError = Object.assign(new Error("upstream unavailable"), {
    isAxiosError: true,
    response: { status: 503, data: "Service Unavailable" },
  });
  axiosModule.post = async () => {
    throw transientError;
  };
  if (axiosModule.default) axiosModule.default.post = axiosModule.post;
  if (axiosModule.isAxiosError === undefined) {
    axiosModule.isAxiosError = (err) => !!err?.isAxiosError;
  }

  await assert.rejects(
    () => service.forceRefreshOfflineAccessToken("test-shop.myshopify.com"),
    (error) => {
      assert.equal(error.code, "TOKEN_REFRESH_FAILED");
      return true;
    }
  );
});

test("definitively invalid refresh token: Shopify rejecting the grant returns a controlled reconnect-required response with a reauthorize URL", async () => {
  const { prismaModule, axiosModule, service } = loadFreshModules();

  prismaModule.prisma.store.findUnique = async () => ({
    id: "store-1",
    shop: "test-shop.myshopify.com",
    accessToken: "old-token",
    refreshToken: "revoked-refresh-token",
    grantedScopes: "read_products,read_orders",
    tokenAcquisitionMode: "offline_expiring",
    accessTokenExpiresAt: new Date(Date.now() - 1000),
    refreshTokenExpiresAt: new Date(Date.now() + 86_400_000),
    pricingBias: 55,
    profitGuardrail: 18,
    uninstalledAt: null,
  });
  prismaModule.prisma.store.update = async () => ({ id: "store-1" });

  const rejectedGrant = Object.assign(new Error("invalid_grant"), {
    isAxiosError: true,
    response: { status: 400, data: { error: "invalid_grant" } },
  });
  axiosModule.post = async () => {
    throw rejectedGrant;
  };
  if (axiosModule.default) axiosModule.default.post = axiosModule.post;
  if (axiosModule.isAxiosError === undefined) {
    axiosModule.isAxiosError = (err) => !!err?.isAxiosError;
  }

  await assert.rejects(
    () => service.forceRefreshOfflineAccessToken("test-shop.myshopify.com"),
    (error) => {
      assert.equal(error.code, "SHOPIFY_RECONNECT_REQUIRED");
      assert.ok(error.reauthorizeUrl, "expected a reauthorize URL so the Reconnect button works");
      assert.ok(error.reauthorizeUrl.includes("/auth/reconnect"));
      return true;
    }
  );
});

test("isShopifyAuthRejection recognizes 401, the 403 non-expiring-token message, and does not false-positive on an unrelated 500", () => {
  const { service } = loadFreshModules();
  assert.equal(service.isShopifyAuthRejection(401, "anything"), true);
  assert.equal(
    service.isShopifyAuthRejection(
      403,
      '{"errors":"[API] Non-expiring access tokens are no longer accepted for the Admin API."}'
    ),
    true
  );
  assert.equal(service.isShopifyAuthRejection(500, "Internal Server Error"), false);
  assert.equal(service.isShopifyAuthRejection(403, "forbidden: missing scope read_orders"), false);
});

test("no token leakage: thrown reconnect errors and their messages never include the raw access or refresh token values", async () => {
  const { prismaModule, axiosModule, service } = loadFreshModules();

  const secretAccessToken = "shpat_super-secret-access-token-value";
  const secretRefreshToken = "shrfrsh_super-secret-refresh-token-value";

  prismaModule.prisma.store.findUnique = async () => ({
    id: "store-1",
    shop: "test-shop.myshopify.com",
    accessToken: secretAccessToken,
    refreshToken: secretRefreshToken,
    grantedScopes: "read_products,read_orders",
    tokenAcquisitionMode: "offline_expiring",
    accessTokenExpiresAt: new Date(Date.now() - 1000),
    refreshTokenExpiresAt: new Date(Date.now() - 1000), // already expired
    pricingBias: 55,
    profitGuardrail: 18,
    uninstalledAt: null,
  });
  prismaModule.prisma.store.update = async () => ({ id: "store-1" });

  try {
    await service.forceRefreshOfflineAccessToken("test-shop.myshopify.com");
    assert.fail("expected forceRefreshOfflineAccessToken to throw");
  } catch (error) {
    const serialized = JSON.stringify({
      message: error.message,
      code: error.code,
      reauthorizeUrl: error.reauthorizeUrl,
    });
    assert.ok(!serialized.includes(secretAccessToken), "access token leaked into the error");
    assert.ok(!serialized.includes(secretRefreshToken), "refresh token leaked into the error");
  }
});

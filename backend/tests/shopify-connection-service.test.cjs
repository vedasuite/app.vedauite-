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

test("health falls back to reconnect-required state when offline token cannot be refreshed", async () => {
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
    refreshToken: null,
    grantedScopes: "read_products,read_orders",
    tokenAcquisitionMode: "offline_legacy",
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

  const { getConnectionHealth } = require(servicePath);
  const health = await getConnectionHealth("test-shop.myshopify.com", {
    probeApi: true,
  });

  assert.equal(health.healthy, false);
  assert.equal(health.code, "OFFLINE_TOKEN_EXPIRED");
  assert.equal(health.reauthRequired, true);
});

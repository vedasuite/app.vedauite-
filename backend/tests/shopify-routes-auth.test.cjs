const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const crypto = require("node:crypto");
const express = require("express");
const cookieParser = require("cookie-parser");

process.env.SHOPIFY_API_KEY ||= "test-key";
process.env.SHOPIFY_API_SECRET ||= "test-secret";
process.env.SHOPIFY_APP_URL ||= "https://app.vedasuite.in";
process.env.DATABASE_URL ||= "postgresql://example:example@localhost:5432/example";

function resetModule(modulePath) {
  const resolved = require.resolve(modulePath);
  delete require.cache[resolved];
}

function buildOAuthHmac(query, secret) {
  const message = Object.entries(query)
    .filter(([key, value]) => key !== "hmac" && key !== "signature" && value != null)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join(",") : value}`)
    .join("&");

  return crypto.createHmac("sha256", secret).update(message).digest("hex");
}

function request(server, pathname, options = {}) {
  const address = server.address();

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: address.port,
        path: pathname,
        method: options.method ?? "GET",
        headers: options.headers ?? {},
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          resolve({ statusCode: res.statusCode, headers: res.headers, body });
        });
      }
    );

    req.on("error", reject);

    if (options.body) {
      req.write(options.body);
    }

    req.end();
  });
}

test("oauth reconnect start issues Shopify authorize redirect and stores signed state", async () => {
  const routesPath = path.resolve(__dirname, "../dist/routes/authRoutes.js");
  resetModule(routesPath);
  const { authRouter } = require(routesPath);

  const app = express();
  app.use(cookieParser());
  app.use("/auth", authRouter);
  const server = app.listen(0);

  try {
    const response = await request(
      server,
      "/auth/reconnect?shop=test-shop.myshopify.com&host=embedded-host&returnTo=%2Fsettings"
    );

    assert.equal(response.statusCode, 200);
    assert.match(response.body, /admin\/oauth\/authorize/);
    assert.match(response.body, /state=/);
    assert.ok(
      (response.headers["set-cookie"] || []).some((cookie) =>
        cookie.includes("vedasuite_oauth_state=")
      )
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("oauth callback persists offline installation and triggers repair tasks", async () => {
  const prismaPath = path.resolve(__dirname, "../dist/db/prismaClient.js");
  const axiosPath = require.resolve("axios");
  const bootstrapPath = path.resolve(__dirname, "../dist/services/bootstrapService.js");
  const adminServicePath = path.resolve(
    __dirname,
    "../dist/services/shopifyAdminService.js"
  );
  const syncJobServicePath = path.resolve(
    __dirname,
    "../dist/services/syncJobService.js"
  );
  const connectionServicePath = path.resolve(
    __dirname,
    "../dist/services/shopifyConnectionService.js"
  );
  const routesPath = path.resolve(__dirname, "../dist/routes/authRoutes.js");

  resetModule(prismaPath);
  resetModule(axiosPath);
  resetModule(bootstrapPath);
  resetModule(adminServicePath);
  resetModule(syncJobServicePath);
  resetModule(connectionServicePath);
  resetModule(routesPath);

  const prismaModule = require(prismaPath);
  let upsertPayload = null;
  prismaModule.prisma.store.findUnique = async () => null;
  prismaModule.prisma.store.upsert = async (payload) => {
    upsertPayload = payload;
    return { id: "store-1", shop: payload.where.shop };
  };

  const axiosModule = require(axiosPath);
  axiosModule.post = async () => ({
    data: {
      access_token: "offline-token",
      scope: "read_products,read_orders,read_customers",
      expires_in: 3600,
      refresh_token: "refresh-token",
      refresh_token_expires_in: 86400,
    },
  });
  if (axiosModule.default) {
    axiosModule.default.post = axiosModule.post;
  }

  require(bootstrapPath).ensureStoreBootstrapped = async () => undefined;

  let registeredShop = null;
  require(adminServicePath).registerSyncWebhooks = async (shop) => {
    registeredShop = shop;
    return { created: ["ORDERS_CREATE"], totalTracked: 6 };
  };

  let syncShop = null;
  require(syncJobServicePath).runStoreSyncJob = async (shop) => {
    syncShop = shop;
    return { id: "job-1", status: "SUCCEEDED" };
  };

  require(connectionServicePath).updateConnectionDiagnostics = async () => undefined;

  const { authRouter } = require(routesPath);
  const app = express();
  app.use(cookieParser());
  app.use("/auth", authRouter);
  const server = app.listen(0);

  try {
    const start = await request(
      server,
      "/auth/reconnect?shop=test-shop.myshopify.com&host=embedded-host&returnTo=%2Fsubscription"
    );
    const cookieHeader = start.headers["set-cookie"];
    const setCookie = Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader;
    const stateMatch = start.body.match(/state=([a-f0-9]+)/i);
    assert.ok(setCookie);
    assert.ok(stateMatch);

    const query = {
      code: "temporary-code",
      shop: "test-shop.myshopify.com",
      state: stateMatch[1],
      timestamp: "1712345678",
    };
    const hmac = buildOAuthHmac(query, process.env.SHOPIFY_API_SECRET);

    const callback = await request(
      server,
      `/auth/callback?shop=${encodeURIComponent(query.shop)}&code=${encodeURIComponent(
        query.code
      )}&state=${encodeURIComponent(query.state)}&timestamp=${query.timestamp}&hmac=${hmac}`,
      {
        headers: {
          Cookie: setCookie,
        },
      }
    );

    assert.equal(callback.statusCode, 200);
    assert.match(callback.body, /\/subscription\?shop=test-shop\.myshopify\.com/);
    assert.ok(upsertPayload);
    assert.equal(upsertPayload.where.shop, "test-shop.myshopify.com");
    assert.equal(upsertPayload.create.accessToken, "offline-token");
    assert.equal(upsertPayload.create.refreshToken, "refresh-token");
    assert.equal(upsertPayload.create.tokenAcquisitionMode, "offline_expiring");
    assert.ok(upsertPayload.create.accessTokenExpiresAt instanceof Date);
    assert.ok(upsertPayload.create.refreshTokenExpiresAt instanceof Date);
    assert.equal(registeredShop, "test-shop.myshopify.com");
    assert.equal(syncShop, "test-shop.myshopify.com");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("oauth callback preserves first install timestamp and updates reauthorization metadata", async () => {
  const prismaPath = path.resolve(__dirname, "../dist/db/prismaClient.js");
  const axiosPath = require.resolve("axios");
  const bootstrapPath = path.resolve(__dirname, "../dist/services/bootstrapService.js");
  const adminServicePath = path.resolve(__dirname, "../dist/services/shopifyAdminService.js");
  const syncJobServicePath = path.resolve(__dirname, "../dist/services/syncJobService.js");
  const connectionServicePath = path.resolve(__dirname, "../dist/services/shopifyConnectionService.js");
  const routesPath = path.resolve(__dirname, "../dist/routes/authRoutes.js");

  resetModule(prismaPath);
  resetModule(axiosPath);
  resetModule(bootstrapPath);
  resetModule(adminServicePath);
  resetModule(syncJobServicePath);
  resetModule(connectionServicePath);
  resetModule(routesPath);

  const prismaModule = require(prismaPath);
  let upsertPayload = null;
  const originalInstalledAt = new Date("2026-04-01T00:00:00.000Z");
  prismaModule.prisma.store.findUnique = async () => ({
    installedAt: originalInstalledAt,
    trialStartedAt: originalInstalledAt,
    trialEndsAt: new Date("2026-04-04T00:00:00.000Z"),
    createdAt: originalInstalledAt,
  });
  prismaModule.prisma.store.upsert = async (payload) => {
    upsertPayload = payload;
    return { id: "store-1", shop: payload.where.shop };
  };

  const axiosModule = require(axiosPath);
  axiosModule.post = async () => ({
    data: {
      access_token: "offline-token",
      scope: "read_products,read_orders,read_customers",
    },
  });
  if (axiosModule.default) {
    axiosModule.default.post = axiosModule.post;
  }

  require(bootstrapPath).ensureStoreBootstrapped = async () => undefined;
  require(adminServicePath).registerSyncWebhooks = async () => ({ created: [], totalTracked: 6 });
  require(syncJobServicePath).runStoreSyncJob = async () => ({ id: "job-1", status: "READY_WITH_DATA" });
  require(connectionServicePath).updateConnectionDiagnostics = async () => undefined;

  const { authRouter } = require(routesPath);
  const app = express();
  app.use(cookieParser());
  app.use("/auth", authRouter);
  const server = app.listen(0);

  try {
    const start = await request(
      server,
      "/auth/reconnect?shop=test-shop.myshopify.com&host=embedded-host&returnTo=%2F"
    );
    const cookieHeader = start.headers["set-cookie"];
    const setCookie = Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader;
    const stateMatch = start.body.match(/state=([a-f0-9]+)/i);
    const query = {
      code: "temporary-code",
      shop: "test-shop.myshopify.com",
      state: stateMatch[1],
      timestamp: "1712345678",
    };
    const hmac = buildOAuthHmac(query, process.env.SHOPIFY_API_SECRET);

    const callback = await request(
      server,
      `/auth/callback?shop=${encodeURIComponent(query.shop)}&code=${encodeURIComponent(
        query.code
      )}&state=${encodeURIComponent(query.state)}&timestamp=${query.timestamp}&hmac=${hmac}`,
      {
        headers: {
          Cookie: setCookie,
        },
      }
    );

    assert.equal(callback.statusCode, 200);
    assert.ok(upsertPayload);
    assert.equal(upsertPayload.update.installedAt.getTime(), originalInstalledAt.getTime());
    assert.ok(upsertPayload.update.reauthorizedAt instanceof Date);
    assert.equal(upsertPayload.update.grantedScopes, "read_products,read_orders,read_customers");
    assert.equal(upsertPayload.update.tokenAcquisitionMode, "offline_legacy");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

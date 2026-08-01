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

/**
 * /auth/install and /auth/reconnect are top-level browser navigations, so the
 * app answers them with a plain 302 to Shopify's authorize URL and carries the
 * OAuth state in a signed token on that URL. (An earlier implementation
 * returned an HTML page and a `vedasuite_oauth_state` cookie; that approach was
 * removed in 099ed6c because it depended on script execution inside an iframe.)
 *
 * These helpers read the state the way the real flow does — from the redirect
 * target — instead of scraping a response body.
 */
function authorizeUrlFrom(response) {
  assert.equal(response.statusCode, 302, "OAuth start must be a 302 redirect");
  const location = response.headers.location;
  assert.ok(location, "302 response must carry a Location header");
  return new URL(location);
}

function stateFrom(response) {
  const state = authorizeUrlFrom(response).searchParams.get("state");
  assert.ok(state, "the authorize URL must carry an OAuth state token");
  return state;
}

/** The state is `base64url(payload).hexSignature` — assert it is really signed. */
function assertSignedState(state) {
  assert.ok(state.length > 0, "state must not be empty");
  const parts = state.split(".");
  assert.equal(parts.length, 2, "state must be a signed <payload>.<signature> token");
  const [encodedPayload, signature] = parts;
  assert.ok(encodedPayload.length > 0, "state payload must not be empty");
  assert.match(signature, /^[a-f0-9]{64}$/i, "state must carry a SHA-256 HMAC signature");

  // The payload must genuinely describe this OAuth attempt, not be filler.
  const decoded = JSON.parse(
    Buffer.from(encodedPayload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")
  );
  assert.equal(decoded.shop, "test-shop.myshopify.com");
  assert.ok(decoded.nonce, "state must carry a nonce");
  assert.ok(typeof decoded.issuedAt === "number", "state must carry an issuedAt timestamp");
  return decoded;
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

    const authorizeUrl = authorizeUrlFrom(response);

    // The redirect must target this shop's Shopify authorize endpoint.
    assert.equal(authorizeUrl.protocol, "https:");
    assert.equal(authorizeUrl.hostname, "test-shop.myshopify.com");
    assert.equal(authorizeUrl.pathname, "/admin/oauth/authorize");

    // and carry the parameters Shopify requires to start OAuth.
    assert.equal(authorizeUrl.searchParams.get("client_id"), process.env.SHOPIFY_API_KEY);
    assert.ok(authorizeUrl.searchParams.get("scope"), "authorize URL must request scopes");
    assert.equal(
      authorizeUrl.searchParams.get("redirect_uri"),
      `${process.env.SHOPIFY_APP_URL}/auth/callback`
    );

    // The state must be present, non-empty and genuinely signed.
    const decoded = assertSignedState(stateFrom(response));
    assert.equal(decoded.returnTo, "/settings", "state must preserve the requested returnTo");
    assert.equal(decoded.host, "embedded-host", "state must preserve the embedded host");
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
  // persistInstallationRecord also cancels stale billing intents on reinstall.
  // Without this stub the real Prisma delegate tries to reach a database.
  let cancelledIntentPayload = null;
  prismaModule.prisma.billingPlanIntent.updateMany = async (payload) => {
    cancelledIntentPayload = payload;
    return { count: 0 };
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
    // State travels on the redirect URL, not in a cookie.
    const state = stateFrom(start);
    assertSignedState(state);

    const query = {
      code: "temporary-code",
      shop: "test-shop.myshopify.com",
      state,
      timestamp: "1712345678",
    };
    const hmac = buildOAuthHmac(query, process.env.SHOPIFY_API_SECRET);

    const callback = await request(
      server,
      `/auth/callback?shop=${encodeURIComponent(query.shop)}&code=${encodeURIComponent(
        query.code
      )}&state=${encodeURIComponent(query.state)}&timestamp=${query.timestamp}&hmac=${hmac}`
    );

    // The callback is also a top-level navigation and answers with a 302 back
    // into the embedded app at the requested returnTo path.
    assert.equal(callback.statusCode, 302);
    assert.match(
      callback.headers.location,
      /\/subscription\?shop=test-shop\.myshopify\.com/
    );
    assert.ok(upsertPayload);
    assert.equal(upsertPayload.where.shop, "test-shop.myshopify.com");
    assert.equal(upsertPayload.create.accessToken, "offline-token");
    assert.equal(upsertPayload.create.refreshToken, "refresh-token");
    assert.equal(upsertPayload.create.tokenAcquisitionMode, "offline_expiring");
    assert.ok(upsertPayload.create.accessTokenExpiresAt instanceof Date);
    assert.ok(upsertPayload.create.refreshTokenExpiresAt instanceof Date);
    assert.equal(registeredShop, "test-shop.myshopify.com");
    assert.equal(syncShop, "test-shop.myshopify.com");

    // Stale billing intents from a previous install cycle must be cancelled so
    // they don't resurface as "awaiting approval" after a reinstall.
    assert.ok(cancelledIntentPayload, "pending billing intents should be cancelled");
    assert.deepEqual(cancelledIntentPayload.where.status, {
      in: ["CREATING", "PENDING_APPROVAL"],
    });
    assert.equal(cancelledIntentPayload.data.status, "CANCELLED");
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
  // persistInstallationRecord also cancels stale billing intents on reinstall.
  // Without this stub the real Prisma delegate tries to reach a database.
  let cancelledIntentPayload = null;
  prismaModule.prisma.billingPlanIntent.updateMany = async (payload) => {
    cancelledIntentPayload = payload;
    return { count: 0 };
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
    const state = stateFrom(start);
    assertSignedState(state);

    const query = {
      code: "temporary-code",
      shop: "test-shop.myshopify.com",
      state,
      timestamp: "1712345678",
    };
    const hmac = buildOAuthHmac(query, process.env.SHOPIFY_API_SECRET);

    const callback = await request(
      server,
      `/auth/callback?shop=${encodeURIComponent(query.shop)}&code=${encodeURIComponent(
        query.code
      )}&state=${encodeURIComponent(query.state)}&timestamp=${query.timestamp}&hmac=${hmac}`
    );

    assert.equal(callback.statusCode, 302);
    assert.ok(upsertPayload);
    assert.equal(upsertPayload.update.installedAt.getTime(), originalInstalledAt.getTime());
    assert.ok(upsertPayload.update.reauthorizedAt instanceof Date);
    assert.equal(upsertPayload.update.grantedScopes, "read_products,read_orders,read_customers");
    assert.equal(upsertPayload.update.tokenAcquisitionMode, "offline_legacy");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

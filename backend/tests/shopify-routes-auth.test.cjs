const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const express = require("express");

function resetModule(modulePath) {
  const resolved = require.resolve(modulePath);
  delete require.cache[resolved];
}

function request(server, pathname, method = "GET") {
  const address = server.address();

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: address.port,
        path: pathname,
        method,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          resolve({ statusCode: res.statusCode, body });
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

test("shopify sync route returns structured reauthorization payload", async () => {
  const connectionServicePath = path.resolve(
    __dirname,
    "../dist/services/shopifyConnectionService.js"
  );
  const routesPath = path.resolve(
    __dirname,
    "../dist/routes/shopifyRoutes.js"
  );

  resetModule(connectionServicePath);
  const connectionService = require(connectionServicePath);
  connectionService.assertHealthyOfflineAccess = async () => {
    throw new connectionService.ShopifyConnectionError(
      "SHOPIFY_AUTH_REQUIRED",
      "Stored Shopify access token is invalid for test-shop.myshopify.com. Reauthorize the app and retry.",
      {
        reauthorizeUrl:
          "https://app.vedasuite.in/auth/install?shop=test-shop.myshopify.com",
      }
    );
  };

  resetModule(routesPath);
  const { shopifyRouter } = require(routesPath);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.shopifySession = { shop: "test-shop.myshopify.com" };
    next();
  });
  app.use("/shopify", shopifyRouter);
  const server = app.listen(0);

  try {
    const response = await request(
      server,
      "/shopify/sync?shop=test-shop.myshopify.com",
      "POST"
    );
    assert.equal(response.statusCode, 401);
    assert.match(response.body, /SHOPIFY_AUTH_REQUIRED/);
    assert.match(response.body, /reauthorizeUrl/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

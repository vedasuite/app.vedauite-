const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const express = require("express");

function resetModule(modulePath) {
  const resolved = require.resolve(modulePath);
  delete require.cache[resolved];
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
          resolve({ statusCode: res.statusCode, body });
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

test("starter-module endpoint blocks direct local switching and instructs billing approval", async () => {
  const middlewarePath = path.resolve(
    __dirname,
    "../dist/middleware/requireCapability.js"
  );
  const routePath = path.resolve(__dirname, "../dist/routes/subscriptionRoutes.js");

  resetModule(middlewarePath);
  require(middlewarePath).requireCapability = () => (_req, _res, next) => next();

  resetModule(routePath);
  const { subscriptionRouter } = require(routePath);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.shopifySession = { shop: "test-shop.myshopify.com" };
    next();
  });
  app.use("/subscription", subscriptionRouter);
  const server = app.listen(0);

  try {
    const response = await request(
      server,
      "/subscription/starter-module?shop=test-shop.myshopify.com",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ starterModule: "competitor" }),
      }
    );

    assert.equal(response.statusCode, 409);
    assert.match(response.body, /STARTER_MODULE_REQUIRES_BILLING_APPROVAL/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

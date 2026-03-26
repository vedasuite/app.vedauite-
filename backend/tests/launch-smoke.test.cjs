const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");

process.env.SHOPIFY_API_KEY ||= "test-key";
process.env.SHOPIFY_API_SECRET ||= "test-secret";
process.env.SHOPIFY_APP_URL ||= "https://example.ngrok-free.app";
process.env.DATABASE_URL ||= "postgresql://example:example@localhost:5432/example";

const { createApp } = require(path.resolve(__dirname, "../dist/app.js"));

function request(server, pathname) {
  const address = server.address();

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: address.port,
        path: pathname,
        method: "GET",
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          resolve({ statusCode: res.statusCode, body, headers: res.headers });
        });
      }
    );

    req.on("error", reject);
    req.end();
  });
}

test("launch-critical public endpoints respond successfully", async () => {
  const app = createApp();
  const server = app.listen(0);

  try {
    const health = await request(server, "/health");
    assert.equal(health.statusCode, 200);
    assert.match(health.body, /"status":"ok"/);

    const privacy = await request(server, "/legal/privacy");
    assert.equal(privacy.statusCode, 200);
    assert.match(privacy.body, /Privacy Policy/);
    assert.match(privacy.body, /abhimanyu@vedasuite\.in/);

    const terms = await request(server, "/legal/terms");
    assert.equal(terms.statusCode, 200);
    assert.match(terms.body, /Terms of Service/);

    const support = await request(server, "/support");
    assert.equal(support.statusCode, 200);
    assert.match(support.body, /Screenshot or screen recording/);

    const readiness = await request(server, "/launch/readiness");
    assert.equal(readiness.statusCode, 200);
    assert.match(readiness.body, /VedaSuite AI/);
    assert.match(
      readiness.body,
      /Upload final app icon, screenshots, and review\/demo video/
    );

    const audit = await request(server, "/launch/audit");
    assert.equal(audit.statusCode, 200);
    assert.match(audit.body, /repoSideCompletion/);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }

        resolve();
      });
    });
  }
});

test("launch endpoints expose audit and readiness details", async () => {
  const app = createApp();
  const server = app.listen(0);

  try {
    const audit = await request(server, "/launch/audit");
    assert.equal(audit.statusCode, 200);
    assert.match(audit.body, /shopifyIntegration/);
    assert.match(audit.body, /appReviewReadiness/);

    const readiness = await request(server, "/launch/readiness");
    assert.equal(readiness.statusCode, 200);
    assert.match(readiness.body, /support/);
    assert.match(readiness.body, /privacy/);
    assert.match(readiness.body, /terms/);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }

        resolve();
      });
    });
  }
});

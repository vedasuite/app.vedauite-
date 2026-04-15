const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

process.env.SHOPIFY_API_KEY ||= "test-key";
process.env.SHOPIFY_API_SECRET ||= "test-secret";
process.env.SHOPIFY_APP_URL ||= "https://app.vedasuite.in";
process.env.DATABASE_URL ||= "postgresql://example:example@localhost:5432/example";

function resetModule(modulePath) {
  const resolved = require.resolve(modulePath);
  delete require.cache[resolved];
}

test("maskCustomerIdentity redacts direct shopper identifiers", () => {
  const utilPath = path.resolve(
    __dirname,
    "../dist/lib/maskCustomerIdentity.js"
  );
  resetModule(utilPath);
  const { maskCustomerIdentity } = require(utilPath);

  assert.equal(maskCustomerIdentity("alice@example.com", "shopper-1001"), "al***");
  assert.equal(maskCustomerIdentity("987654321", "shopper-1002"), "987***");
  assert.equal(maskCustomerIdentity(null, "shopper-1003"), "shopper-1003");
});

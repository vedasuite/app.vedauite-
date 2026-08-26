const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

process.env.SHOPIFY_API_KEY ||= "test-key";
process.env.SHOPIFY_API_SECRET ||= "test-secret";
process.env.SHOPIFY_APP_URL ||= "https://app.vedasuite.in";
process.env.DATABASE_URL ||= "postgresql://example:example@localhost:5432/example";

/**
 * The staging test-product plan, and the refusal it is expected to hit.
 *
 * VedaSuite requests read access to products and nothing more. This creator
 * must therefore REFUSE on the real scope set rather than quietly requesting
 * write access, and it must refuse before touching Shopify.
 */

const d = (p) => path.resolve(__dirname, `../dist/${p}`);
const plan = require(d("services/stagingTestProductPlan.js"));

/** The scopes VedaSuite actually asks for, copied from shopify.app.toml. */
const REAL_SCOPES = [
  "read_products",
  "read_orders",
  "write_orders",
  "read_customers",
  "read_inventory",
  "read_locations",
];

test("the plan is exactly the three SKUs the inventory test needs", () => {
  const skus = plan.STAGING_TEST_PRODUCTS.map((p) => p.sku);
  assert.deepEqual(skus, ["SKU-A", "SKU-B", "SKU-C"]);

  const qty = Object.fromEntries(
    plan.STAGING_TEST_PRODUCTS.map((p) => [p.sku, p.quantity])
  );
  assert.deepEqual(qty, { "SKU-A": 20, "SKU-B": 8, "SKU-C": 5 });
});

test("SKU-D is never created, so external-only is a real result", () => {
  const skus = plan.STAGING_TEST_PRODUCTS.map((p) => p.sku);
  assert.ok(
    !skus.includes("SKU-D"),
    "SKU-D must exist only in the uploaded file, never in Shopify"
  );
});

test("handles are stable, so productSet upserts instead of duplicating", () => {
  const handles = plan.STAGING_TEST_PRODUCTS.map((p) => p.handle);
  assert.equal(new Set(handles).size, handles.length, "handles must be unique");
  for (const h of handles) {
    assert.match(h, /^vedasuite-test-product-[a-z]$/);
  }
});

test("every product is tagged as VedaSuite test data", () => {
  const seed = require(d("services/stagingSeedPlan.js"));
  for (const p of plan.STAGING_TEST_PRODUCTS) {
    const tags = plan.tagsFor(p);
    assert.ok(tags.includes(seed.STAGING_TEST_TAG), `${p.sku} missing the shared test tag`);
    assert.ok(
      tags.includes(plan.testProductTag(p.sku)),
      `${p.sku} missing its own identity tag`
    );
  }
});

test("VedaSuite's real scope set refuses creation, with the reason named", () => {
  const verdict = plan.judgeScopes(REAL_SCOPES);

  assert.equal(verdict.canCreateProducts, false);
  assert.equal(verdict.canSetInventory, false);
  assert.deepEqual(verdict.missing, ["write_products", "write_inventory"]);

  // The refusal must name the scopes, so the operator can act on it without
  // guessing, and must not read as a transient failure worth retrying.
  assert.match(verdict.reason, /write_products/);
  assert.match(verdict.reason, /nothing was attempted/i);
});

test("products without stock write access are refused, not created empty", () => {
  // Creating products with no inventory would make all three read as
  // mismatches — worse than no test data, because it looks like a finding.
  const verdict = plan.judgeScopes([...REAL_SCOPES, "write_products"]);

  assert.equal(verdict.canCreateProducts, true);
  assert.equal(verdict.canSetInventory, false);
  assert.match(verdict.reason, /prove nothing/i);
  assert.match(verdict.reason, /nothing was attempted/i);
});

test("full write access is the only combination that proceeds", () => {
  const verdict = plan.judgeScopes([
    ...REAL_SCOPES,
    "write_products",
    "write_inventory",
  ]);
  assert.equal(verdict.canCreateProducts, true);
  assert.equal(verdict.canSetInventory, true);
  assert.deepEqual(verdict.missing, []);
  assert.equal(verdict.reason, "");
});

test("the console is unreachable on production regardless of token", () => {
  const seed = require(d("services/stagingSeedPlan.js"));
  assert.equal(seed.isProductionRuntime("https://app.vedasuite.in"), true);
  assert.equal(
    seed.isProductionRuntime("https://vedasuite-staging.onrender.com"),
    false
  );
  // An unidentifiable environment must fail closed.
  assert.equal(seed.isProductionRuntime(""), true);
  assert.equal(seed.isProductionRuntime(null), true);
});

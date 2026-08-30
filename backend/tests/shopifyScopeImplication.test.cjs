const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

process.env.SHOPIFY_API_KEY ||= "test-key";
process.env.SHOPIFY_API_SECRET ||= "test-secret";
process.env.SHOPIFY_APP_URL ||= "https://app.vedasuite.in";
process.env.DATABASE_URL ||= "postgresql://example:example@localhost:5432/example";

/**
 * A WRITE SCOPE CARRIES ITS READ SCOPE.
 *
 * THE DEFECT
 * ----------
 * A newly installed production store logged:
 *
 *     grantedScopes: "read_customers,read_products,write_orders"
 *
 * and diagnostics reported `read_orders` as a MISSING REQUIRED SCOPE. It was
 * not missing. Shopify's model is that `write_x` includes `read_x`, and the
 * granted string it returns lists only the write scope — so a store authorized
 * for all four required scopes comes back with `read_orders` absent because it
 * is subsumed, not refused.
 *
 * `missingRequiredScopes` compared literally, so it raised an alarm about a
 * perfectly healthy install and would have sent someone chasing an OAuth bug
 * that did not exist.
 *
 * Fixed as the general rule — any `write_x` implies `read_x` — rather than a
 * special case for `write_orders`, so a future write scope needs no second fix.
 */

const d = (p) => path.resolve(__dirname, `../dist/${p}`);
const scopes = require(d("services/shopifyScopeState.js"));

/** Exactly what Shopify returned for gilded-lily-jewelry.myshopify.com. */
const PRODUCTION_GRANTED = "read_customers,read_products,write_orders";

// ===========================================================================
// 1. write_orders satisfies read_orders
// ===========================================================================

test("REGRESSION: write_orders alone does not report read_orders as missing", () => {
  assert.deepEqual(
    scopes.missingRequiredScopes(PRODUCTION_GRANTED),
    [],
    "a store granted write_orders has order read access — nothing is missing"
  );
});

test("the effective set contains the implied read, the literal set does not", () => {
  // Both facts stay available: what Shopify said, and what it permits.
  assert.ok(
    !scopes.parseScopes(PRODUCTION_GRANTED).includes("read_orders"),
    "parseScopes must stay literal — diagnostics reports what Shopify returned"
  );
  assert.ok(
    scopes.effectiveScopes(PRODUCTION_GRANTED).includes("read_orders"),
    "effectiveScopes must include the read the write implies"
  );
  assert.ok(scopes.hasScope(PRODUCTION_GRANTED, "read_orders"));
});

test("the implication is general, not a write_orders special case", () => {
  assert.equal(scopes.impliedReadScope("write_products"), "read_products");
  assert.equal(scopes.impliedReadScope("write_inventory"), "read_inventory");
  assert.equal(scopes.impliedReadScope("write_customers"), "read_customers");
  assert.equal(scopes.impliedReadScope("write_anything_future"), "read_anything_future");

  // A read scope implies nothing, and neither does a malformed one.
  assert.equal(scopes.impliedReadScope("read_orders"), null);
  assert.equal(scopes.impliedReadScope("write_"), null);
  assert.equal(scopes.impliedReadScope(""), null);
});

test("the implication does not run backwards", () => {
  // read_orders must NEVER be treated as granting write_orders — that would
  // claim the app may tag orders on a store that never allowed it.
  const readOnly = "read_products,read_orders,read_customers";
  assert.ok(!scopes.hasScope(readOnly, "write_orders"));
  assert.deepEqual(scopes.missingRequiredScopes(readOnly), ["write_orders"]);
});

// ===========================================================================
// 2. genuinely missing required scopes are still detected
// ===========================================================================

test("genuinely missing required scopes are still reported", () => {
  const cases = [
    { granted: "", missing: ["read_products", "read_orders", "write_orders", "read_customers"] },
    { granted: null, missing: ["read_products", "read_orders", "write_orders", "read_customers"] },
    { granted: "read_products", missing: ["read_orders", "write_orders", "read_customers"] },
    { granted: "read_products,write_orders", missing: ["read_customers"] },
    { granted: "read_customers,write_orders", missing: ["read_products"] },
    // write_orders covers both order scopes; only products/customers remain.
    { granted: "write_orders", missing: ["read_products", "read_customers"] },
  ];

  for (const c of cases) {
    assert.deepEqual(
      scopes.missingRequiredScopes(c.granted),
      c.missing,
      `granted=${JSON.stringify(c.granted)}`
    );
  }
});

test("a fully authorized store reports nothing missing, however Shopify phrases it", () => {
  const equivalents = [
    "read_products,read_orders,write_orders,read_customers",
    "read_customers,read_products,write_orders",
    "  READ_PRODUCTS , Write_Orders ,read_customers ",
    "read_products,write_orders,read_customers,read_inventory,read_locations",
  ];
  for (const granted of equivalents) {
    assert.deepEqual(
      scopes.missingRequiredScopes(granted),
      [],
      `"${granted}" is a fully authorized store`
    );
  }
});

// ===========================================================================
// 3. optional scopes remain optional
// ===========================================================================

test("read_inventory and read_locations are never required", () => {
  assert.deepEqual([...scopes.OPTIONAL_SCOPES], ["read_inventory", "read_locations"]);
  for (const optional of scopes.OPTIONAL_SCOPES) {
    assert.ok(
      !scopes.REQUIRED_SCOPES.includes(optional),
      `${optional} must not be a required scope`
    );
  }
  // The production store lacks both and is still fully authorized.
  assert.deepEqual(scopes.missingRequiredScopes(PRODUCTION_GRANTED), []);
});

test("the production store's capability is unchanged by this fix", () => {
  const capability = scopes.inventoryCapability(PRODUCTION_GRANTED);

  // Store-wide inventory works — it needs only read_products. This is what
  // Reconciliation's inventory check compares against.
  assert.equal(capability.storeWide, true);
  // Per-location stays off, as designed, and says which scopes would unlock it.
  assert.equal(capability.perLocation, false);
  assert.equal(capability.locationIdentity, false);
  assert.deepEqual(capability.missingOptional, ["read_inventory", "read_locations"]);
  assert.equal(capability.upgradeAvailable, true);
});

test("write_orders cannot unlock inventory or location capability", () => {
  // The implication is per-resource. Nothing about orders may leak into
  // inventory access, or the app would claim per-location data it cannot read.
  const capability = scopes.inventoryCapability("write_orders");
  assert.equal(capability.perLocation, false);
  assert.equal(capability.locationIdentity, false);
});

test("granting the optional scopes still unlocks per-location inventory", () => {
  const capability = scopes.inventoryCapability(
    "read_products,write_orders,read_customers,read_inventory,read_locations"
  );
  assert.equal(capability.storeWide, true);
  assert.equal(capability.perLocation, true);
  assert.equal(capability.locationIdentity, true);
  assert.deepEqual(capability.missingOptional, []);
  assert.equal(capability.upgradeAvailable, false);
});

// ===========================================================================
// 4. surrounding behaviour unchanged
// ===========================================================================

test("inventorySourceFor still distinguishes its four cases", () => {
  const allowed = scopes.inventoryCapability(PRODUCTION_GRANTED);
  const denied = scopes.inventoryCapability("read_orders");

  assert.equal(scopes.inventorySourceFor({ capability: allowed, reported: 20 }), "ok");
  assert.equal(scopes.inventorySourceFor({ capability: allowed, reported: 0 }), "ok");
  // Null is "the merchant does not track this variant" — never zero.
  assert.equal(scopes.inventorySourceFor({ capability: allowed, reported: null }), "not_tracked");
  // No read_products means we were never allowed to look.
  assert.equal(scopes.inventorySourceFor({ capability: denied, reported: null }), "scope_missing");
});

test("the required scope set itself is unchanged by this fix", () => {
  // The fix corrects how membership is TESTED, never what is required.
  assert.deepEqual(
    [...scopes.REQUIRED_SCOPES],
    ["read_products", "read_orders", "write_orders", "read_customers"]
  );
});

test("diagnostics reports the literal set AND the effective set", () => {
  const fs = require("node:fs");
  const src = fs.readFileSync(
    path.resolve(__dirname, "../src/routes/syncDiagnosticsRoutes.ts"),
    "utf8"
  );
  // Both must be present: one says what Shopify returned, the other what it
  // permits. Showing only the literal set is what made this confusing.
  assert.match(src, /granted: parseScopes\(store\.grantedScopes\)/);
  assert.match(src, /effective: effectiveScopes\(store\.grantedScopes\)/);
  assert.match(src, /missingRequired: missingRequiredScopes\(store\.grantedScopes\)/);
});

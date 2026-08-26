const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const jwt = require("jsonwebtoken");
const express = require("express");

process.env.SHOPIFY_API_KEY ||= "test-key";
process.env.SHOPIFY_API_SECRET ||= "test-secret";
process.env.SHOPIFY_APP_URL ||= "https://app.vedasuite.in";
process.env.DATABASE_URL ||= "postgresql://example:example@localhost:5432/example";

/**
 * THE SESSION NAMES THE SHOP. THE CALLER DOES NOT.
 *
 * `resolveAuthenticatedShop` falls back to `?shop=` / `body.shop` when the
 * session does not name a shop, and almost every module route uses it. That
 * fallback is safe only for as long as a request cannot reach those routes
 * without a session shop.
 *
 * The session shop comes from the token's `dest` claim. The `iss`/`dest`
 * agreement check was conditional on both being present, so a token with no
 * `dest` skipped it, produced no `tokenShop`, skipped the shop-mismatch check
 * that follows, and left the session shop set to whatever the caller asked for.
 *
 * Not reachable in practice — minting a token that clears `jwt.verify` needs
 * this app's signing secret, and no real Shopify token omits `dest`. But it
 * made tenant isolation rest on an external invariant instead of a check of our
 * own, which is not a property to leave unasserted in a boundary this
 * important.
 */

const d = (p) => path.resolve(__dirname, `../dist/${p}`);
const { verifyShopifySessionToken } = require(d("middleware/verifyShopifySessionToken.js"));

const SECRET = process.env.SHOPIFY_API_SECRET;
const API_KEY = process.env.SHOPIFY_API_KEY;
const OWN_SHOP = "own-store.myshopify.com";
const VICTIM_SHOP = "victim-store.myshopify.com";

function sign(payload) {
  return jwt.sign(
    {
      aud: API_KEY,
      exp: Math.floor(Date.now() / 1000) + 300,
      iat: Math.floor(Date.now() / 1000),
      sub: "user-1",
      ...payload,
    },
    SECRET,
    { algorithm: "HS256" }
  );
}

/** Boots the real middleware over real HTTP and reports what the session says. */
async function callWith({ token, query = "" }) {
  const app = express();
  app.use(express.json());
  app.use("/api", verifyShopifySessionToken);
  app.get("/api/probe", (req, res) => {
    res.json({ sessionShop: req.shopifySession?.shop ?? null });
  });

  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = server.address();

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/probe${query}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    const body = await response.json().catch(() => ({}));
    return { status: response.status, body };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("a valid token resolves the shop from dest, not from the query string", async () => {
  const token = sign({
    iss: `https://${OWN_SHOP}/admin`,
    dest: `https://${OWN_SHOP}`,
  });

  const result = await callWith({ token });
  assert.equal(result.status, 200);
  assert.equal(result.body.sessionShop, OWN_SHOP);
});

test("REGRESSION: a token with no dest is refused, not resolved from ?shop=", async () => {
  // Before the fix this returned 200 with sessionShop = victim-store, because
  // the session fell through to the caller-supplied shop.
  const token = sign({ iss: `https://${OWN_SHOP}/admin` });

  const result = await callWith({
    token,
    query: `?shop=${encodeURIComponent(VICTIM_SHOP)}`,
  });

  assert.equal(result.status, 401, "a token that cannot name its shop must be refused");
  assert.notEqual(
    result.body.sessionShop,
    VICTIM_SHOP,
    "the caller must never be able to name the shop"
  );
});

test("an empty dest is refused too", async () => {
  const token = sign({ iss: `https://${OWN_SHOP}/admin`, dest: "" });
  const result = await callWith({
    token,
    query: `?shop=${encodeURIComponent(VICTIM_SHOP)}`,
  });
  assert.equal(result.status, 401);
});

test("a shop parameter that disagrees with the token is refused", async () => {
  const token = sign({
    iss: `https://${OWN_SHOP}/admin`,
    dest: `https://${OWN_SHOP}`,
  });

  const result = await callWith({
    token,
    query: `?shop=${encodeURIComponent(VICTIM_SHOP)}`,
  });

  assert.equal(result.status, 403, "cross-shop access must be refused outright");
});

test("a request with no token at all is refused", async () => {
  const result = await callWith({
    token: null,
    query: `?shop=${encodeURIComponent(VICTIM_SHOP)}`,
  });
  assert.equal(result.status, 401);
});

test("a token signed with the wrong secret is refused", async () => {
  const token = jwt.sign(
    {
      aud: API_KEY,
      exp: Math.floor(Date.now() / 1000) + 300,
      iss: `https://${VICTIM_SHOP}/admin`,
      dest: `https://${VICTIM_SHOP}`,
    },
    "not-the-real-secret",
    { algorithm: "HS256" }
  );

  const result = await callWith({ token });
  assert.equal(result.status, 401);
});

test("a token for another app's audience is refused", async () => {
  const token = jwt.sign(
    {
      aud: "some-other-app-key",
      exp: Math.floor(Date.now() / 1000) + 300,
      iss: `https://${VICTIM_SHOP}/admin`,
      dest: `https://${VICTIM_SHOP}`,
    },
    SECRET,
    { algorithm: "HS256" }
  );

  const result = await callWith({ token });
  assert.equal(result.status, 401);
});

test("iss and dest naming different shops is refused", async () => {
  const token = sign({
    iss: `https://${OWN_SHOP}/admin`,
    dest: `https://${VICTIM_SHOP}`,
  });

  const result = await callWith({ token });
  assert.equal(result.status, 401, "a token whose two shop claims disagree is not usable");
});

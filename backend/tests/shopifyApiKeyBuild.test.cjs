const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

/**
 * SHOPIFY APP BRIDGE API KEY SELECTION.
 *
 * index.html used to hardcode the production app's client id, so the staging
 * deployment declared the PRODUCTION app to App Bridge while its backend
 * verified session tokens against the STAGING app's key. The key is now
 * resolved at build time from VITE_SHOPIFY_API_KEY.
 *
 * Two things must never regress:
 *   1. with no override, the build produces exactly the production key, so
 *      production behaviour is unchanged
 *   2. with an override, the build produces exactly that key, so staging can
 *      declare its own app
 *
 * These tests import and EXECUTE the same module vite.config.ts uses, so they
 * exercise the real resolution logic rather than a copy of it.
 */

const FRONTEND = path.resolve(__dirname, "../../frontend");
const MODULE_URL = pathToFileURL(path.join(FRONTEND, "shopifyApiKey.js")).href;
const INDEX_HTML = path.join(FRONTEND, "index.html");
const VITE_CONFIG = path.join(FRONTEND, "vite.config.ts");

/** The production app's client_id, per shopify.app.toml. */
const PRODUCTION_KEY = "b7789c5899a579e9bc9e950a9bbd6547";
/** The staging app's client_id, as used by the staging OAuth flow. */
const STAGING_KEY = "41d6e60fbf0fe0a5e6d2cd80f5172374";

let resolveShopifyApiKey;
let injectShopifyApiKey;
let readShopifyApiKey;
let PRODUCTION_SHOPIFY_API_KEY;

test.before(async () => {
  const mod = await import(MODULE_URL);
  ({
    resolveShopifyApiKey,
    injectShopifyApiKey,
    readShopifyApiKey,
    PRODUCTION_SHOPIFY_API_KEY,
  } = mod);
});

// ===========================================================================
// Production must be unchanged by default
// ===========================================================================

test("PRODUCTION: the default key is the one that was hardcoded in shopify.app.toml", () => {
  assert.equal(PRODUCTION_SHOPIFY_API_KEY, PRODUCTION_KEY);
});

test("PRODUCTION: no override resolves to the production key", () => {
  // Every shape of "not set" a build environment can produce.
  for (const env of [undefined, null, {}, { VITE_SHOPIFY_API_KEY: undefined }]) {
    assert.equal(
      resolveShopifyApiKey(env),
      PRODUCTION_KEY,
      `env=${JSON.stringify(env)} must fall back to production`
    );
  }
});

test("PRODUCTION: a blank or whitespace override resolves to the production key", () => {
  // Render renders an unset variable as an empty string in some setups; that
  // must not stamp an empty api key and silently break App Bridge.
  for (const value of ["", "   ", "\t", "\n"]) {
    assert.equal(
      resolveShopifyApiKey({ VITE_SHOPIFY_API_KEY: value }),
      PRODUCTION_KEY,
      `blank override ${JSON.stringify(value)} must fall back to production`
    );
  }
});

test("PRODUCTION: a non-string override resolves to the production key", () => {
  for (const value of [123, true, {}, [], null]) {
    assert.equal(resolveShopifyApiKey({ VITE_SHOPIFY_API_KEY: value }), PRODUCTION_KEY);
  }
});

test("PRODUCTION: index.html still ships the production key as its literal default", () => {
  // If this literal drifts, an override-less build stops matching production.
  const html = fs.readFileSync(INDEX_HTML, "utf8");
  assert.equal(
    readShopifyApiKey(html),
    PRODUCTION_KEY,
    "the checked-in index.html default must remain the production key"
  );
});

test("PRODUCTION: an override-less build reproduces the original index.html exactly", () => {
  // The end-to-end guarantee: same input, same bytes as before this change.
  const html = fs.readFileSync(INDEX_HTML, "utf8");
  const built = injectShopifyApiKey(html, resolveShopifyApiKey({}));
  assert.equal(built, html, "a production build must not alter index.html at all");
});

// ===========================================================================
// Staging must be able to use its own app
// ===========================================================================

test("STAGING: an override resolves to that key", () => {
  assert.equal(
    resolveShopifyApiKey({ VITE_SHOPIFY_API_KEY: STAGING_KEY }),
    STAGING_KEY
  );
});

test("STAGING: surrounding whitespace is trimmed, not stamped", () => {
  assert.equal(
    resolveShopifyApiKey({ VITE_SHOPIFY_API_KEY: `  ${STAGING_KEY}\n` }),
    STAGING_KEY
  );
});

test("STAGING: the override is actually stamped into index.html", () => {
  const html = fs.readFileSync(INDEX_HTML, "utf8");
  const built = injectShopifyApiKey(
    html,
    resolveShopifyApiKey({ VITE_SHOPIFY_API_KEY: STAGING_KEY })
  );

  assert.equal(readShopifyApiKey(built), STAGING_KEY, "staging key must be stamped");
  assert.equal(
    built.includes(PRODUCTION_KEY),
    false,
    "a staging build must not contain the production key anywhere in index.html"
  );
});

test("STAGING: stamping changes only the key, nothing else in the document", () => {
  const html = fs.readFileSync(INDEX_HTML, "utf8");
  const built = injectShopifyApiKey(html, STAGING_KEY);

  assert.equal(
    built.replace(STAGING_KEY, PRODUCTION_KEY),
    html,
    "the only difference must be the api key value"
  );
  assert.equal(built.length - html.length, STAGING_KEY.length - PRODUCTION_KEY.length);
});

// ===========================================================================
// The injection itself
// ===========================================================================

test("INJECTION: html without the meta tag is returned unchanged", () => {
  // A build must never crash over this; the missing tag is caught below.
  const html = "<!doctype html><html><head></head><body></body></html>";
  assert.equal(injectShopifyApiKey(html, STAGING_KEY), html);
  assert.equal(readShopifyApiKey(html), null);
});

test("INJECTION: repeated stamping is idempotent", () => {
  const html = fs.readFileSync(INDEX_HTML, "utf8");
  const once = injectShopifyApiKey(html, STAGING_KEY);
  const twice = injectShopifyApiKey(once, STAGING_KEY);
  assert.equal(once, twice);
});

test("INJECTION: the meta tag App Bridge reads is present in index.html", () => {
  const html = fs.readFileSync(INDEX_HTML, "utf8");
  assert.match(
    html,
    /<meta\s+name="shopify-api-key"\s+content="[^"]+"/,
    "App Bridge cannot initialise without this tag"
  );
});

// ===========================================================================
// Wiring
// ===========================================================================

test("WIRING: vite.config.ts applies the plugin and uses the shared resolver", () => {
  const config = fs.readFileSync(VITE_CONFIG, "utf8");

  assert.match(
    config,
    /from "\.\/shopifyApiKey\.js"/,
    "vite.config must import the shared resolver, not reimplement it"
  );
  assert.match(config, /transformIndexHtml/, "the key must be stamped at build time");
  assert.match(
    config,
    /shopifyApiKeyPlugin\(mode\)/,
    "the plugin must be registered in the plugins array"
  );
  assert.match(
    config,
    /process\.env\.VITE_SHOPIFY_API_KEY/,
    "Render supplies the value as a real environment variable"
  );
});

test("WIRING: no source file hardcodes the api key outside index.html and the resolver", () => {
  // The whole point of the change: one place decides the app identity.
  const srcDir = path.join(FRONTEND, "src");
  const offenders = [];

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (/\.(ts|tsx|js|jsx|html)$/.test(entry.name)) {
        if (fs.readFileSync(full, "utf8").includes(PRODUCTION_KEY)) {
          offenders.push(path.relative(FRONTEND, full));
        }
      }
    }
  };
  walk(srcDir);

  assert.deepEqual(
    offenders,
    [],
    `the api key must not be hardcoded in application source:\n${offenders.join("\n")}`
  );
});

/**
 * Build-time resolution of the Shopify App Bridge API key stamped into
 * index.html.
 *
 * The key was previously hardcoded in index.html, so every deployment — the
 * staging service included — declared the PRODUCTION app's client id to App
 * Bridge, while the backend verified session tokens against its own
 * SHOPIFY_API_KEY. Staging can now supply its own key via VITE_SHOPIFY_API_KEY.
 *
 * SAFETY: when VITE_SHOPIFY_API_KEY is unset, blank or whitespace, this falls
 * back to the production key that was previously hardcoded, so a production
 * build with no environment change is byte-identical to before.
 *
 * Plain ESM JavaScript (not .ts) so vite.config.ts and the regression tests can
 * both import and execute this exact module rather than a re-implementation.
 */

/**
 * The value that was hardcoded in index.html, matching client_id in
 * shopify.app.toml. This is the default and must not change without also
 * changing the production Shopify app.
 */
export const PRODUCTION_SHOPIFY_API_KEY = "b7789c5899a579e9bc9e950a9bbd6547";

/** Matches the meta tag's content attribute, capturing the parts around it. */
const META_PATTERN = /(<meta\s+name="shopify-api-key"\s+content=")([^"]*)(")/;

/**
 * Picks the API key for this build.
 *
 * @param {Record<string, string | undefined>} [env] typically process.env
 * @returns {string} the override when it is a non-blank string, else the
 *   production default
 */
export function resolveShopifyApiKey(env) {
  const raw = env?.VITE_SHOPIFY_API_KEY;
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  return trimmed || PRODUCTION_SHOPIFY_API_KEY;
}

/**
 * Rewrites the meta tag's content in an index.html string.
 *
 * Returns the html unchanged when the tag is absent — a build must not fail
 * because of this, and an absent tag is caught by the regression tests.
 *
 * @param {string} html
 * @param {string} apiKey
 * @returns {string}
 */
export function injectShopifyApiKey(html, apiKey) {
  if (typeof html !== "string" || !META_PATTERN.test(html)) {
    return html;
  }
  return html.replace(META_PATTERN, `$1${apiKey}$3`);
}

/** Reads the key currently stamped in an index.html string, or null. */
export function readShopifyApiKey(html) {
  const match = typeof html === "string" ? html.match(META_PATTERN) : null;
  return match ? match[2] : null;
}

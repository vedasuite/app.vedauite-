/**
 * Types for shopifyApiKey.js.
 *
 * The implementation is plain ESM JavaScript so vite.config.ts and the
 * regression tests (backend/tests/shopifyApiKeyBuild.test.cjs) import and
 * execute the same module.
 */

/** The production app's client_id, matching shopify.app.toml. */
export const PRODUCTION_SHOPIFY_API_KEY: string;

/**
 * Picks the API key for this build: a non-blank VITE_SHOPIFY_API_KEY, else the
 * production default.
 */
export function resolveShopifyApiKey(
  env?: Record<string, unknown> | null
): string;

/** Rewrites the shopify-api-key meta tag; returns html unchanged if absent. */
export function injectShopifyApiKey(html: string, apiKey: string): string;

/** Reads the key stamped in an index.html string, or null when absent. */
export function readShopifyApiKey(html: string): string | null;

/**
 * Shopify GraphQL Custom Scalar Coercion Utilities
 *
 * Shopify's Admin GraphQL API serialises several numeric scalars as strings:
 *   - UnsignedInt64 (e.g. numberOfOrders, legacyResourceId) → serialize as string
 *   - Money / Decimal (e.g. price amounts)                  → serialize as string
 *
 * These helpers convert those string-or-number values to the correct JS types
 * before passing them to Prisma, which is strict about Int vs Float.
 *
 * Usage:
 *   import { shopifyInt, shopifyFloat } from "../lib/shopifyScalars";
 *   totalOrders: shopifyInt(customer.numberOfOrders),
 *   price:       shopifyFloat(variant.price),
 */

/**
 * Convert a Shopify UnsignedInt64 scalar (serialised as a string) to a JS
 * integer suitable for Prisma `Int` fields.  Returns 0 for null/undefined/NaN.
 */
export function shopifyInt(value: string | number | null | undefined): number {
  if (value == null) return 0;
  const n = parseInt(String(value), 10);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Convert a Shopify Money / Decimal scalar (serialised as a string like
 * "10.50") to a JS number suitable for Prisma `Float` fields.
 * Returns 0 for null/undefined/NaN.
 */
export function shopifyFloat(value: string | number | null | undefined): number {
  if (value == null) return 0;
  const n = parseFloat(String(value));
  return Number.isFinite(n) ? n : 0;
}

/**
 * Alias for shopifyFloat — use when you want to make the Decimal scalar
 * intent explicit in calling code.
 */
export const shopifyDecimal = shopifyFloat;

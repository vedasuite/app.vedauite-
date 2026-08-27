// The three products the staging inventory test needs, and nothing else.
//
// These exist so the Reconciliation inventory check can be exercised end to end
// against a real Shopify catalogue rather than a fixture. The quantities are
// chosen to produce one of each outcome when compared with the uploaded file:
//
//   SKU-A  Shopify 20, file 13  -> quantity mismatch of 7
//   SKU-B  Shopify  8, file  8  -> exact match
//   SKU-C  Shopify  5, absent   -> missing externally
//   SKU-D  absent,    file  4   -> external-only (no Shopify product, by design)
//
// SKU-D is deliberately NOT in this plan. It has to be missing from Shopify for
// the fourth case to be a real result rather than a staged one.

import { STAGING_TEST_TAG } from "./stagingSeedPlan";

export interface StagingTestProduct {
  sku: string;
  title: string;
  /** Stable handle. `productSet` upserts on it, which is what makes this idempotent. */
  handle: string;
  quantity: number;
  price: string;
}

/** Marks each product individually, so a partial run can be resumed exactly. */
export function testProductTag(sku: string): string {
  return `vedasuite-test-product-${sku.toLowerCase()}`;
}

export const STAGING_TEST_PRODUCTS: readonly StagingTestProduct[] = [
  {
    sku: "SKU-A",
    title: "VedaSuite Test Product A",
    handle: "vedasuite-test-product-a",
    quantity: 20,
    price: "25.00",
  },
  {
    sku: "SKU-B",
    title: "VedaSuite Test Product B",
    handle: "vedasuite-test-product-b",
    quantity: 8,
    price: "40.00",
  },
  {
    sku: "SKU-C",
    title: "VedaSuite Test Product C",
    handle: "vedasuite-test-product-c",
    quantity: 5,
    price: "12.50",
  },
];

/** Every tag a created product carries. */
export function tagsFor(product: StagingTestProduct): string[] {
  return [STAGING_TEST_TAG, testProductTag(product.sku)];
}

/**
 * Scopes required to create these products with real stock levels.
 *
 * VedaSuite deliberately does not request either one: it is a read-only
 * analytics app for products, and `launchRoutes` asserts `write_products` is
 * absent as an App Store scope-minimisation requirement. So this is expected to
 * be unavailable, and the console must say so plainly rather than work around
 * it.
 */
export const PRODUCT_WRITE_SCOPE = "write_products";
export const INVENTORY_WRITE_SCOPE = "write_inventory";

export interface ScopeVerdict {
  canCreateProducts: boolean;
  canSetInventory: boolean;
  missing: string[];
  /** Merchant-free, operator-facing explanation. Never a workaround. */
  reason: string;
}

export function judgeScopes(granted: readonly string[]): ScopeVerdict {
  const has = (s: string) => granted.includes(s);
  const canCreateProducts = has(PRODUCT_WRITE_SCOPE);
  const canSetInventory = has(INVENTORY_WRITE_SCOPE);
  const missing = [
    ...(canCreateProducts ? [] : [PRODUCT_WRITE_SCOPE]),
    ...(canSetInventory ? [] : [INVENTORY_WRITE_SCOPE]),
  ];

  if (canCreateProducts && canSetInventory) {
    return { canCreateProducts, canSetInventory, missing, reason: "" };
  }

  if (!canCreateProducts) {
    return {
      canCreateProducts,
      canSetInventory,
      missing,
      reason:
        `This store's access token does not include ${missing.join(" or ")}. ` +
        "VedaSuite does not request either scope — it only ever reads products, " +
        "and the App Store readiness check requires write_products to stay absent. " +
        "Shopify will reject productSet, so nothing was attempted.",
    };
  }

  return {
    canCreateProducts,
    canSetInventory,
    missing,
    reason:
      `This store's token can create products but not set stock levels (${INVENTORY_WRITE_SCOPE} is missing). ` +
      "Products would be created with no inventory, which would make every SKU look like a mismatch " +
      "and prove nothing. Nothing was attempted.",
  };
}

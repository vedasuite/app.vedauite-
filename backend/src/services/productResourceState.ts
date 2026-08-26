// Why a store has no products — which is FIVE different facts, not one.
//
// PURE. No database.
//
// THE INFERENCE THIS REPLACES
// ---------------------------
// Pricing said "No products synced yet" and Reconciliation said "Your Shopify
// products have no SKUs yet". Both were derived the same way: count the rows,
// find none, state a conclusion. Neither could tell whether the catalogue was
// empty, the sync had failed, or the sync had never run — and "your products
// have no SKUs" is actively false if VedaSuite never managed to read them.
//
// Absence of rows is not evidence of absence in Shopify.

export const PRODUCT_RESOURCE_STATES = [
  "PRODUCTS_PRESENT",
  "NO_PRODUCTS",
  "PRODUCT_SYNC_FAILED",
  "PRODUCT_SYNC_NOT_RUN",
  "AUTH_FAILED",
  "UNKNOWN",
] as const;

export type ProductResourceState = (typeof PRODUCT_RESOURCE_STATES)[number];

export interface ProductResourceResult {
  state: ProductResourceState;
  /** Merchant-facing. Never asserts a fact about Shopify VedaSuite cannot see. */
  message: string;
  /** True only when VedaSuite actually inspected the catalogue. */
  inspected: boolean;
}

/**
 * Resolves what "zero products" means for this store.
 *
 * `resourceStatus` is what the last sync recorded for the product resource.
 * When it is absent — a sync that predates per-resource tracking — the answer
 * is UNKNOWN rather than a guess, and the merchant is told to re-sync.
 */
export function resolveProductResourceState(input: {
  productsPersisted: number;
  /** From SyncJob.summaryJson.syncResult.resourceStatus.products.status */
  productResourceStatus: string | null | undefined;
  everSynced: boolean;
  authFailed: boolean;
}): ProductResourceResult {
  if (input.authFailed) {
    return {
      state: "AUTH_FAILED",
      message:
        "VedaSuite cannot reach Shopify, so it does not know what is in your catalogue. Reconnect the app.",
      inspected: false,
    };
  }

  if (input.productsPersisted > 0) {
    return {
      state: "PRODUCTS_PRESENT",
      message: `${input.productsPersisted} products are synced from Shopify.`,
      inspected: true,
    };
  }

  if (!input.everSynced) {
    return {
      state: "PRODUCT_SYNC_NOT_RUN",
      message:
        "No Shopify sync has run yet, so VedaSuite has not looked at your products.",
      inspected: false,
    };
  }

  if (input.productResourceStatus === "FAILED") {
    return {
      state: "PRODUCT_SYNC_FAILED",
      message:
        "The latest product sync did not complete, so VedaSuite has no product data to work with. This is not the same as your store having no products.",
      inspected: false,
    };
  }

  if (
    input.productResourceStatus === "SUCCESS" ||
    input.productResourceStatus === "SUCCESS_EMPTY"
  ) {
    return {
      state: "NO_PRODUCTS",
      message:
        "The last sync completed and Shopify returned no products, so there is nothing to analyse yet.",
      inspected: true,
    };
  }

  return {
    state: "UNKNOWN",
    message:
      "VedaSuite cannot tell whether your catalogue is empty or the last product sync did not finish. Run a sync from Store Overview and check again.",
    inspected: false,
  };
}

/**
 * What Reconciliation may say about SKUs.
 *
 * "Your Shopify products have no SKUs yet" is a claim about the merchant's
 * Shopify configuration, and it is only sayable when VedaSuite actually looked
 * at the variants. If the product sync failed, the honest statement is that it
 * could not check.
 */
export function describeSkuAvailability(input: {
  product: ProductResourceResult;
  variantsInspected: number;
  variantsWithSku: number;
}): { ready: boolean; reason: string | null } {
  if (input.product.state === "PRODUCTS_PRESENT") {
    if (input.variantsWithSku > 0) {
      return { ready: true, reason: null };
    }
    return {
      ready: false,
      reason: `VedaSuite checked ${input.variantsInspected} product variants and none of them have a SKU set in Shopify. Reconciliation matches on SKU, so add them in Shopify and run a sync.`,
    };
  }

  if (input.product.state === "PRODUCT_SYNC_FAILED") {
    return {
      ready: false,
      reason:
        "VedaSuite could not evaluate Shopify SKUs because the latest product sync did not complete. Your products may well have SKUs — VedaSuite has not been able to look.",
    };
  }

  if (input.product.state === "PRODUCT_SYNC_NOT_RUN") {
    return {
      ready: false,
      reason:
        "VedaSuite has not synced your products yet, so it cannot check for SKUs. Run a sync from Store Overview first.",
    };
  }

  if (input.product.state === "AUTH_FAILED") {
    return { ready: false, reason: input.product.message };
  }

  if (input.product.state === "NO_PRODUCTS") {
    return {
      ready: false,
      reason:
        "Your Shopify catalogue is empty, so there is nothing for an inventory file to be compared against.",
    };
  }

  return { ready: false, reason: input.product.message };
}

/**
 * What Reconciliation may say about stock levels.
 *
 * Same rule. A missing inventory figure can mean the merchant does not track
 * stock, that VedaSuite lacks the permission, or that the sync failed — and
 * they are not interchangeable.
 */
export function describeInventoryAvailability(input: {
  product: ProductResourceResult;
  variantsWithInventory: number;
  permissionMissingReason: string | null;
}): { ready: boolean; reason: string | null } {
  if (input.product.state === "PRODUCT_SYNC_FAILED") {
    return {
      ready: false,
      reason:
        "VedaSuite could not evaluate Shopify stock levels because the latest product sync did not complete.",
    };
  }
  if (input.product.state === "PRODUCT_SYNC_NOT_RUN") {
    return {
      ready: false,
      reason: "VedaSuite has not synced your products yet, so it has no stock levels to compare.",
    };
  }
  if (input.variantsWithInventory > 0) {
    return { ready: true, reason: null };
  }
  if (input.permissionMissingReason) {
    return { ready: false, reason: input.permissionMissingReason };
  }
  if (input.product.state === "PRODUCTS_PRESENT") {
    return {
      ready: false,
      reason:
        "None of your synced Shopify variants report a tracked stock level. Turn on inventory tracking in Shopify for the products you want reconciled.",
    };
  }
  return { ready: false, reason: input.product.message };
}

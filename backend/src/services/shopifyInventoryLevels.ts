// Per-location Shopify stock.
//
// OPTIONAL, AND ISOLATED ON PURPOSE.
//
// Reading InventoryLevel needs the read_inventory scope; reading Location needs
// read_locations or read_inventory. Neither is required to run VedaSuite, and a
// merchant who has not granted them must keep a fully working sync.
//
// So this lives in its own function with its own query and its own try/catch.
// It is called AFTER the main sync has committed, it never throws to the
// caller, and a permission failure is recorded as a fact rather than raised as
// an error. That structure is the point: `shopifyGraphQL` throws on
// `payload.errors`, so a denied field inside the MAIN product query would fail
// the entire product sync — which is exactly how the `email` field broke order
// sync in production.

import { prisma } from "../db/prismaClient";
import { logEvent } from "./observabilityService";
import { shopifyGraphQL } from "./shopifyAdminService";
import { inventoryCapability } from "./shopifyScopeState";

/** Locations per page. Shopify's maximum for this connection is 250. */
export const LOCATION_PAGE_SIZE = 50;
/** Inventory levels read per location page. */
export const LEVEL_PAGE_SIZE = 100;
/** Bound on total pages, so one very large catalog cannot run unbounded. */
export const MAX_LEVEL_PAGES = 40;

export type InventoryLevelSyncResult = {
  attempted: boolean;
  succeeded: boolean;
  locations: number;
  levels: number;
  truncated: boolean;
  /** Why it did not run or did not finish. Merchant-safe. */
  reason: string | null;
};

type LocationPage = {
  locations: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    edges: Array<{
      node: {
        id: string;
        name: string;
        inventoryLevels: {
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          edges: Array<{
            node: {
              id: string;
              quantities: Array<{ name: string; quantity: number }>;
              item: {
                id: string;
                sku: string | null;
                variant: { id: string } | null;
              } | null;
            };
          }>;
        };
      };
    }>;
  };
};

/**
 * Syncs per-location stock, when the merchant has granted the scopes.
 *
 * NEVER THROWS. Every outcome is a result object, because the caller is the
 * main sync and a missing optional permission must not fail it.
 */
export async function syncInventoryLevels(input: {
  shopDomain: string;
  storeId: string;
  grantedScopes: string | null | undefined;
}): Promise<InventoryLevelSyncResult> {
  const capability = inventoryCapability(input.grantedScopes);

  if (!capability.perLocation) {
    return {
      attempted: false,
      succeeded: false,
      locations: 0,
      levels: 0,
      truncated: false,
      reason:
        "Per-location stock needs additional Shopify permissions, which this store has not granted. Store-wide comparison is unaffected.",
    };
  }

  let cursor: string | null = null;
  let locations = 0;
  let levels = 0;
  let pages = 0;
  let truncated = false;

  try {
    do {
      const page: LocationPage = await shopifyGraphQL<LocationPage>(
        input.shopDomain,
        `
          query VedaSuiteInventoryLevels($first: Int!, $after: String, $levels: Int!) {
            locations(first: $first, after: $after, includeLegacy: true) {
              pageInfo { hasNextPage endCursor }
              edges {
                node {
                  id
                  name
                  inventoryLevels(first: $levels) {
                    pageInfo { hasNextPage endCursor }
                    edges {
                      node {
                        id
                        quantities(names: ["available"]) { name quantity }
                        item {
                          id
                          sku
                          variant { id }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        `,
        { first: LOCATION_PAGE_SIZE, after: cursor, levels: LEVEL_PAGE_SIZE },
        { timeoutMs: 60000 }
      );

      for (const edge of page.locations.edges) {
        const location = edge.node;
        locations += 1;
        if (location.inventoryLevels.pageInfo.hasNextPage) truncated = true;

        for (const levelEdge of location.inventoryLevels.edges) {
          const level = levelEdge.node;
          const item = level.item;
          if (!item) continue;

          // Shopify returns a list of named quantities. "available" is the one
          // reconciliation compares; a missing entry stays NULL rather than
          // becoming zero.
          const available = level.quantities.find(
            (quantity) => quantity.name === "available"
          );

          const data = {
            storeId: input.storeId,
            shopifyLocationId: location.id,
            locationName: location.name,
            shopifyVariantId: item.variant?.id ?? null,
            shopifyInventoryItemId: item.id,
            sku: item.sku && item.sku.trim().length > 0 ? item.sku.trim() : null,
            available:
              typeof available?.quantity === "number" ? available.quantity : null,
            syncedAt: new Date(),
          };

          await prisma.inventoryLevelSnapshot.upsert({
            where: {
              storeId_shopifyLocationId_shopifyInventoryItemId: {
                storeId: input.storeId,
                shopifyLocationId: location.id,
                shopifyInventoryItemId: item.id,
              },
            },
            create: data,
            update: data,
          });
          levels += 1;
        }
      }

      pages += 1;
      cursor = page.locations.pageInfo.hasNextPage
        ? page.locations.pageInfo.endCursor
        : null;
      if (pages >= MAX_LEVEL_PAGES && cursor) {
        truncated = true;
        cursor = null;
      }
    } while (cursor);

    logEvent("info", "shopify.inventory_levels.synced", {
      storeId: input.storeId,
      locations,
      levels,
      pages,
      truncated,
    });

    return {
      attempted: true,
      succeeded: true,
      locations,
      levels,
      truncated,
      reason: truncated
        ? "Some locations hold more inventory lines than VedaSuite reads in one pass, so per-location figures are partial."
        : null,
    };
  } catch (error) {
    // A permission problem here is a fact to record, not an error to raise.
    // The main sync has already committed and must not be undone by it.
    const message = error instanceof Error ? error.message : String(error);
    const permissionDenied = /access denied|not authorized|scope|permission/i.test(
      message
    );

    logEvent(permissionDenied ? "info" : "warn", "shopify.inventory_levels.failed", {
      storeId: input.storeId,
      permissionDenied,
      error: message,
    });

    return {
      attempted: true,
      succeeded: false,
      locations,
      levels,
      truncated,
      reason: permissionDenied
        ? "Shopify declined the per-location inventory request for this store. Reconnect the app to grant the additional permission. Store-wide comparison is unaffected."
        : "Per-location stock could not be read on this sync. Store-wide comparison is unaffected.",
    };
  }
}

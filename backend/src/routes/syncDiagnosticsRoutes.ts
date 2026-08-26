import { Router } from "express";
import { prisma } from "../db/prismaClient";
import { logEvent } from "../services/observabilityService";
import { getStoreHealth } from "../services/storeHealthService";
import {
  inventoryCapability,
  missingRequiredScopes,
  parseScopes,
  REQUIRED_SCOPES,
  OPTIONAL_SCOPES,
} from "../services/shopifyScopeState";

/**
 * READ-ONLY sync diagnostics.
 *
 * WHY THIS EXISTS
 * ---------------
 * Staging showed 75 orders and 0 products, and nothing in the product could
 * distinguish between:
 *
 *   A. the Shopify store genuinely has no products
 *   B. Shopify returned products but persistence failed
 *   C. the product query itself failed
 *   D. product sync was never attempted
 *   E. it returned zero because of a scope or API problem
 *   F. products exist but a downstream query is wrong
 *
 * Answering that required database access. This endpoint answers it from the
 * app itself, so the difference between "my catalogue is empty" and "VedaSuite
 * is broken" is visible to whoever is testing.
 *
 * WHAT IT DELIBERATELY DOES NOT RETURN
 * ------------------------------------
 * No customer names, emails, addresses or phone numbers. No access token or
 * secret. No raw GraphQL payload. No order or product contents. Counts,
 * statuses, timestamps and scope names only — every field here is operational
 * metadata about VedaSuite's own behaviour.
 */
export const syncDiagnosticsRouter = Router();

/** Session only. Never a shop named in the query string or body. */
function sessionShop(req: unknown): string | null {
  const shop = (req as { shopifySession?: { shop?: string } }).shopifySession?.shop;
  return typeof shop === "string" && shop.length > 0 ? shop : null;
}

/** Reads the per-resource block a sync job recorded, if it has one. */
function readResourceStatus(summaryJson: string | null): Record<string, unknown> | null {
  if (!summaryJson) return null;
  try {
    const parsed = JSON.parse(summaryJson) as {
      syncResult?: { resourceStatus?: Record<string, unknown> };
      resourceStatus?: Record<string, unknown>;
    };
    return parsed.syncResult?.resourceStatus ?? parsed.resourceStatus ?? null;
  } catch {
    return null;
  }
}

/** Counts a sync job recorded, if it has them. */
function readCounts(summaryJson: string | null): Record<string, unknown> | null {
  if (!summaryJson) return null;
  try {
    const parsed = JSON.parse(summaryJson) as {
      syncResult?: { counts?: Record<string, unknown> };
    };
    return parsed.syncResult?.counts ?? null;
  } catch {
    return null;
  }
}

syncDiagnosticsRouter.get("/sync", async (req, res) => {
  const shop = sessionShop(req);
  if (!shop) {
    return res.status(401).json({
      error: {
        code: "REAUTHORIZE_REQUIRED",
        message:
          "Your Shopify session expired. Reload VedaSuite from Shopify Admin and try again.",
      },
    });
  }

  try {
    const store = await prisma.store.findUnique({
      where: { shop },
      select: {
        id: true,
        shop: true,
        grantedScopes: true,
        lastSyncAt: true,
        lastSyncStatus: true,
        lastConnectionStatus: true,
        lastConnectionError: true,
        authErrorCode: true,
        installedAt: true,
        reauthorizedAt: true,
        syncJobs: {
          where: { jobType: "shopify_sync" },
          orderBy: { createdAt: "desc" },
          take: 3,
          select: {
            id: true,
            status: true,
            startedAt: true,
            finishedAt: true,
            errorMessage: true,
            summaryJson: true,
          },
        },
      },
    });

    if (!store) {
      return res.status(404).json({ error: { message: "Store not found." } });
    }

    // Everything below is a COUNT of VedaSuite's own rows, scoped to this store.
    const [
      productsPersisted,
      variantsPersisted,
      variantsWithSku,
      variantsWithInventoryQuantity,
      ordersPersisted,
      lineItemsPersisted,
      customersPersisted,
      inventoryLevelRows,
      priceRows,
      findingsOpen,
    ] = await Promise.all([
      prisma.productSnapshot.count({ where: { storeId: store.id } }),
      prisma.variantSnapshot.count({ where: { product: { storeId: store.id } } }),
      prisma.variantSnapshot.count({
        where: { product: { storeId: store.id }, NOT: { sku: null } },
      }),
      prisma.variantSnapshot.count({
        where: { product: { storeId: store.id }, NOT: { inventoryQuantity: null } },
      }),
      prisma.order.count({ where: { storeId: store.id } }),
      prisma.orderLineItem.count({ where: { storeId: store.id } }),
      prisma.customer.count({ where: { storeId: store.id } }),
      prisma.inventoryLevelSnapshot.count({ where: { storeId: store.id } }),
      prisma.priceHistory.count({ where: { storeId: store.id } }),
      prisma.intelligenceFinding.count({
        where: { storeId: store.id, status: { in: ["new", "seen", "in_review"] } },
      }),
    ]);

    const latestJob = store.syncJobs[0] ?? null;
    const resourceStatus = readResourceStatus(latestJob?.summaryJson ?? null);
    const counts = readCounts(latestJob?.summaryJson ?? null);
    const capability = inventoryCapability(store.grantedScopes);

    const productStatus =
      (resourceStatus?.products as { status?: string } | undefined)?.status ?? null;

    /**
     * The verdict, spelled out. This is the field a tester reads.
     *
     * Each branch corresponds to one of the six possibilities the observed
     * staging state could not distinguish between.
     */
    const productDiagnosis = !store.lastSyncAt
      ? {
          code: "PRODUCT_SYNC_NOT_RUN",
          meaning: "No Shopify sync has run for this store yet.",
        }
      : productStatus === "FAILED"
      ? {
          code: "PRODUCT_SYNC_FAILED",
          meaning:
            "Shopify returned product data but VedaSuite could not save it. Orders may still have synced successfully.",
        }
      : productsPersisted > 0
      ? {
          code: "PRODUCTS_PRESENT",
          meaning: `${productsPersisted} products are stored and available to every module.`,
        }
      : productStatus === "SUCCESS" || productStatus === "SUCCESS_EMPTY"
      ? {
          code: "NO_PRODUCTS_IN_SHOPIFY",
          meaning:
            "The product sync completed successfully and Shopify returned no products. This store's catalogue is empty.",
        }
      : counts && (counts as { fetched?: { products?: number } }).fetched?.products === 0
      ? {
          code: "NO_PRODUCTS_IN_SHOPIFY",
          meaning:
            "The last sync fetched zero products from Shopify. This store's catalogue is empty.",
        }
      : {
          code: "PRODUCT_STATUS_UNKNOWN",
          meaning:
            "The last sync predates per-resource status tracking. Run a fresh sync from Store Overview and check this page again.",
        };

    logEvent("info", "diagnostics.sync_viewed", {
      shop: store.shop,
      productDiagnosis: productDiagnosis.code,
    });

    return res.json({
      diagnostics: {
        shop: store.shop,
        // ---- what VedaSuite is permitted to read ----------------------------
        scopes: {
          required: REQUIRED_SCOPES,
          optional: OPTIONAL_SCOPES,
          granted: parseScopes(store.grantedScopes),
          missingRequired: missingRequiredScopes(store.grantedScopes),
          canReadProducts: capability.storeWide,
          canReadPerLocationInventory: capability.perLocation,
          canReadLocationNames: capability.locationIdentity,
          reauthorizationWouldAdd: capability.missingOptional,
        },
        // ---- connection -----------------------------------------------------
        connection: {
          status: store.lastConnectionStatus,
          authErrorCode: store.authErrorCode,
          // The stored error is operational text, never a token or payload.
          lastError: store.lastConnectionError,
          installedAt: store.installedAt,
          reauthorizedAt: store.reauthorizedAt,
        },
        // ---- the last sync --------------------------------------------------
        latestSync: latestJob
          ? {
              status: latestJob.status,
              startedAt: latestJob.startedAt,
              finishedAt: latestJob.finishedAt,
              errorMessage: latestJob.errorMessage,
              fetched: (counts as { fetched?: unknown } | null)?.fetched ?? null,
              saved: (counts as { saved?: unknown } | null)?.saved ?? null,
              resourceStatus,
            }
          : null,
        recentSyncStatuses: store.syncJobs.map((job) => ({
          status: job.status,
          startedAt: job.startedAt,
          finishedAt: job.finishedAt,
        })),
        // ---- what is actually stored right now -------------------------------
        persisted: {
          productsPersisted,
          variantsPersisted,
          variantsWithSku,
          variantsWithInventoryQuantity,
          ordersPersisted,
          lineItemsPersisted,
          customersPersisted,
          inventoryLevelRows,
          priceRows,
          findingsOpen,
        },
        // ---- the answer -----------------------------------------------------
        productDiagnosis,
        // ---- the canonical module verdict ------------------------------------
        health: await getStoreHealth({ storeId: store.id, shopDomain: store.shop }),
      },
    });
  } catch (error) {
    logEvent("error", "diagnostics.sync_failed", {
      shop,
      error: error instanceof Error ? error.message : String(error),
    });
    return res.status(500).json({
      error: { message: "Diagnostics could not be loaded." },
    });
  }
});

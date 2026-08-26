// Assembles the canonical module state for one store.
//
// The ONE place that turns a store's real data into moduleStateModel's
// vocabulary. Every surface — Action Center, Store Overview, refresh summaries
// — consumes this rather than asking its own version of "is this ready?".
//
// That duplication is what produced the staging contradiction: four surfaces
// each decided readiness independently, and two of them were wrong.

import { prisma } from "../db/prismaClient";
import { logEvent } from "./observabilityService";
import { CUSTOMER_LOSS } from "./customerLossCalc";
import { isCurrentEvidence } from "./competitorFetchStatus";
import {
  deriveGlobalHealth,
  deriveModuleStates,
  type EntitlementFlags,
  type GlobalHealthResult,
  type ModuleStateResult,
  type StateModule,
} from "./moduleStateModel";
import { getCurrentSubscription } from "./subscriptionService";
import { profitRowProvenance } from "./evidenceEligibility";

/** Statuses that mean the connection itself is broken. */
const AUTH_FAILURE_STATUSES = new Set([
  "SHOPIFY_AUTH_REQUIRED",
  "SHOPIFY_RECONNECT_REQUIRED",
  "MISSING_ACCESS_TOKEN",
]);

export interface StoreHealth {
  modules: ModuleStateResult[];
  global: GlobalHealthResult;
}

/**
 * Reads a store's real evidence and derives every module's state.
 *
 * Counts only — this never mutates, and never triggers a sync.
 */
export async function getStoreHealth(input: {
  storeId: string;
  shopDomain: string;
}): Promise<StoreHealth> {
  const [store, subscription] = await Promise.all([
    prisma.store.findUnique({
      where: { id: input.storeId },
      select: {
        lastConnectionStatus: true,
        lastSyncAt: true,
        syncJobs: {
          where: { jobType: "shopify_sync" },
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { status: true },
        },
      },
    }),
    getCurrentSubscription(input.shopDomain),
  ]);

  const [
    products,
    variantsWithSku,
    orders,
    customers,
    priceRows,
    profitRows,
    competitorDomains,
    reconciliationRuns,
    findingRows,
  ] = await Promise.all([
    prisma.productSnapshot.count({ where: { storeId: input.storeId } }),
    prisma.variantSnapshot.count({
      where: { product: { storeId: input.storeId }, NOT: { sku: null } },
    }),
    prisma.order.count({ where: { storeId: input.storeId } }),
    prisma.customer.count({ where: { storeId: input.storeId } }),
    prisma.priceHistory.count({ where: { storeId: input.storeId } }),
    prisma.profitOptimizationData.findMany({
      where: { storeId: input.storeId },
      select: { productCost: true, costSource: true, salesVelocity: true, velocitySource: true },
      take: 500,
    }),
    prisma.competitorDomain.findMany({
      where: { storeId: input.storeId },
      select: { lastAttemptStatus: true },
    }),
    prisma.reconciliationRun.count({ where: { storeId: input.storeId } }),
    prisma.intelligenceFinding.groupBy({
      by: ["module"],
      where: {
        storeId: input.storeId,
        status: { in: ["new", "seen", "in_review"] },
      },
      _count: { _all: true },
    }),
  ]);

  const latestJobStatus = store?.syncJobs[0]?.status ?? null;

  // Findings are counted by MODULE, so "Customer Loss found nothing" and
  // "Customer Loss could not run" are answered from different facts.
  const findingCounts: Partial<Record<StateModule, number>> = {};
  const moduleOf: Record<string, StateModule> = {
    fraud: "customerLoss",
    trust: "customerLoss",
    return_abuse: "customerLoss",
    pricing: "pricing",
    profit: "productProfit",
    competitor: "marketSignals",
    reconciliation: "reconciliation",
  };
  for (const row of findingRows) {
    const key = moduleOf[row.module];
    if (!key) continue;
    findingCounts[key] = (findingCounts[key] ?? 0) + row._count._all;
  }

  const entitlements: EntitlementFlags = {
    customerLoss: subscription.capabilities["module.trustAbuse"] === true,
    pricing: subscription.capabilities["module.pricingProfit"] === true,
    productProfit: subscription.capabilities["pricing.profitLeakDetector"] === true,
    marketSignals: subscription.capabilities["module.competitorIntel"] === true,
    reconciliation:
      subscription.capabilities["reconciliation.inventory"] === true ||
      subscription.capabilities["reconciliation.supplier"] === true ||
      subscription.capabilities["reconciliation.invoice"] === true,
  };

  const modules = deriveModuleStates({
    evidence: {
      authFailed: AUTH_FAILURE_STATUSES.has(store?.lastConnectionStatus ?? ""),
      syncFailed: latestJobStatus === "FAILED",
      // One Shopify dimension entirely absent while another has data. This is
      // precisely the 75-orders/0-products case, and it is a PARTIAL sync.
      syncPartial:
        products + orders + customers > 0 &&
        [products > 0, orders > 0, customers > 0].filter(Boolean).length < 3,
      neverSynced: !store?.lastSyncAt,
      products,
      variantsWithSku,
      orders,
      // Customer Loss compares against the store baseline, which is the same
      // order population it analyses.
      eligibleOrders: orders,
      customers,
      competitorDomainsConfigured: competitorDomains.length,
      competitorRowsFresh: competitorDomains.filter((domain) =>
        isCurrentEvidence(domain.lastAttemptStatus)
      ).length,
      priceRows,
      // Only OBSERVED cost counts. An assumed cost cannot make Product Profit
      // runnable, for the same reason it cannot fund a monetary claim.
      profitRowsWithObservedCost: profitRows.filter(
        (row) => profitRowProvenance(row).costObserved
      ).length,
      reconciliationRuns,
    },
    entitlements,
    thresholds: { customerLossMinOrders: CUSTOMER_LOSS.minStoreOrders },
    findingCounts,
  });

  return { modules, global: deriveGlobalHealth(modules) };
}

/**
 * getStoreHealth, but unable to take a page down with it.
 *
 * WHY THIS WRAPPER EXISTS. Store Overview and Action Center both render the
 * canonical verdict, so a throw inside the derivation would blank the page a
 * merchant uses to find out something is wrong — the worst possible moment for
 * it to be unavailable.
 *
 * A failure degrades to an explicit UNKNOWN. It never degrades to HEALTHY:
 * "VedaSuite could not work out your store's status" is a true statement, and
 * "everything is fine" would be a guess in exactly the direction that hides
 * problems.
 */
export async function getStoreHealthSafe(input: {
  storeId: string;
  shopDomain: string;
}): Promise<StoreHealth> {
  try {
    return await getStoreHealth(input);
  } catch (error) {
    logEvent("error", "store_health.derivation_failed", {
      storeId: input.storeId,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      modules: [],
      global: {
        health: "NOT_READY",
        headline:
          "VedaSuite could not work out the current status of your checks. Refresh in a moment.",
        detail: [],
        ran: [],
        couldNotRun: [],
        awaitingMerchant: [],
        modules: [],
      },
    };
  }
}

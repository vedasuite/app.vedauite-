import { prisma } from "../db/prismaClient";
import { getOnboardingState } from "./onboardingService";
import {
  deriveModuleReadiness,
  deriveSyncStatus,
  getStoreOperationalSnapshot,
} from "./storeOperationalStateService";

export async function getDashboardMetrics(shopDomain: string) {
  const [store, operational, onboarding] = await Promise.all([
    prisma.store.findUnique({
      where: { shop: shopDomain },
      include: {
        syncJobs: {
          orderBy: { createdAt: "desc" },
          take: 1,
        },
        timelineEvents: {
          orderBy: { createdAt: "desc" },
          take: 50,
        },
      },
    }),
    getStoreOperationalSnapshot(shopDomain).catch(() => null),
    getOnboardingState(shopDomain).catch(() => null),
  ]);
  if (!store) {
    return null;
  }

  const [
    todayHighRiskOrders,
    serialReturners,
    competitorChanges,
    pricingSuggestions,
    profitOpportunities,
  ] =
    await Promise.all([
      prisma.order.count({
        where: {
          storeId: store.id,
          fraudRiskLevel: "High",
          createdAt: {
            gte: new Date(new Date().setHours(0, 0, 0, 0)),
          },
        },
      }),
      prisma.customer.count({
        where: {
          storeId: store.id,
          refundRate: { gt: 0.3 },
        },
      }),
      prisma.competitorData.count({
        where: {
          storeId: store.id,
          collectedAt: {
            gte: new Date(Date.now() - 24 * 60 * 60 * 1000),
          },
        },
      }),
      prisma.priceHistory.count({
        where: {
          storeId: store.id,
          createdAt: {
            gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
          },
        },
      }),
      prisma.profitOptimizationData.count({
        where: {
          storeId: store.id,
          createdAt: {
            gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
          },
        },
      }),
    ]);

  const syncState = operational
    ? deriveSyncStatus({
        connectionStatus: operational.store.lastConnectionStatus,
        latestSyncJobStatus: operational.latestSyncJob?.status ?? null,
        lastSyncStatus: operational.store.lastSyncStatus,
        products: operational.counts.products,
        orders: operational.counts.orders,
        customers: operational.counts.customers,
        priceRows: operational.counts.pricingRows,
        profitRows: operational.counts.profitRows,
        timelineEvents: operational.counts.timelineEvents,
      })
    : {
        status: "SYNC_REQUIRED" as const,
        reason: "Run the first live sync to populate the store.",
      };

  const trustReadiness = operational
    ? deriveModuleReadiness({
        syncStatus: syncState.status,
        rawCount: operational.counts.orders + operational.counts.customers,
        processedCount: operational.counts.timelineEvents,
        lastUpdatedAt: operational.latestProcessingAt,
        failureReason: operational.store.lastConnectionError,
      })
    : null;
  const pricingReadiness = operational
    ? deriveModuleReadiness({
        syncStatus: syncState.status,
        rawCount: operational.counts.products + operational.counts.orders,
        processedCount: operational.counts.pricingRows + operational.counts.profitRows,
        lastUpdatedAt: operational.latestProcessingAt,
        failureReason: operational.store.lastConnectionError,
      })
    : null;
  const competitorReadiness = operational
    ? deriveModuleReadiness({
        syncStatus:
          operational.counts.competitorDomains > 0 &&
          operational.counts.competitorRows === 0 &&
          syncState.status === "READY_WITH_DATA"
            ? "SYNC_COMPLETED_PROCESSING_PENDING"
            : syncState.status,
        rawCount: operational.counts.competitorDomains,
        processedCount: operational.counts.competitorRows,
        lastUpdatedAt: operational.latestCompetitorAt,
        failureReason: operational.store.lastConnectionError,
      })
    : null;
  const lastRefreshedAt = operational
    ? (
        operational.latestProcessingAt ??
        operational.latestCompetitorAt ??
        operational.store.lastSyncAt ??
        null
      )?.toISOString() ?? null
    : null;

  return {
    fraudAlertsToday: todayHighRiskOrders,
    highRiskOrders: todayHighRiskOrders,
    serialReturners: serialReturners,
    competitorPriceChanges: competitorChanges,
    promotionAlerts: competitorChanges,
    aiPricingSuggestions: pricingSuggestions,
    profitOptimizationOpportunities: profitOpportunities,
    lastSyncStatus: store.syncJobs[0]?.status ?? "NOT_RUN",
    lastSyncAt: store.syncJobs[0]?.finishedAt?.toISOString() ?? null,
    timelineEventsGenerated: store.timelineEvents.length,
    dataState: syncState.status,
    lastRefreshedAt,
    summaryTitle:
      syncState.status === "READY_WITH_DATA"
        ? "Store data and module outputs are ready"
        : syncState.status === "SYNC_COMPLETED_PROCESSING_PENDING"
        ? "Sync completed, processing is still catching up"
        : syncState.status === "EMPTY_STORE_DATA"
        ? "Sync completed, but the store returned no usable data"
        : syncState.status === "FAILED"
        ? "Latest sync failed"
        : syncState.status === "SYNC_IN_PROGRESS"
        ? "Shopify sync is running"
        : "Run first sync to populate store signals",
    summaryDetail: syncState.reason,
    recentInsights: store.timelineEvents.slice(0, 5).map((event) => ({
      id: event.id,
      title: event.title,
      detail: event.detail,
      severity: event.severity,
      createdAt: event.createdAt.toISOString(),
      route:
        event.category === "competitor"
          ? "/app/competitor-intelligence"
          : event.category === "pricing" || event.category === "profit"
          ? "/app/ai-pricing-engine"
          : "/app/fraud-intelligence",
    })),
    moduleReadiness: {
      trustAbuse: trustReadiness,
      competitor: competitorReadiness,
      pricingProfit: pricingReadiness,
    },
    persistedCounts: operational?.counts ?? null,
    onboarding,
  };
}


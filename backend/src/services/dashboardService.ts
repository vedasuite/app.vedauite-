import { prisma } from "../db/prismaClient";
import { getOnboardingState } from "./onboardingService";
import { getUnifiedReadinessState } from "./readinessEngineService";
import {
  deriveSyncStatus,
  getStoreOperationalSnapshot,
} from "./storeOperationalStateService";
import { toIsoString } from "./unifiedModuleStateService";

function latestIsoTimestamp(...values: Array<Date | string | null | undefined>) {
  const timestamps = values
    .map((value) => (value ? new Date(value).getTime() : null))
    .filter((value): value is number => value != null && !Number.isNaN(value));

  if (timestamps.length === 0) {
    return null;
  }

  return new Date(Math.max(...timestamps)).toISOString();
}

function buildDashboardSummaryTitle(status: string) {
  if (status === "READY_WITH_DATA") {
    return "Store data and module outputs are ready";
  }

  if (status === "SYNC_COMPLETED_PROCESSING_PENDING") {
    return "Sync completed, processing is still catching up";
  }

  if (status === "EMPTY_STORE_DATA") {
    return "Sync completed, but the store returned no usable data";
  }

  if (status === "FAILED") {
    return "Latest sync failed";
  }

  if (status === "SYNC_IN_PROGRESS") {
    return "Shopify sync is running";
  }

  return "Run first sync to populate store signals";
}

export async function getDashboardMetrics(shopDomain: string) {
  const [store, operational, onboarding, readiness] = await Promise.all([
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
    getUnifiedReadinessState(shopDomain).catch(() => null),
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

  const lastRefreshedAt = operational
    ? latestIsoTimestamp(
        operational.latestProcessingAt,
        operational.latestCompetitorAt,
        operational.latestSyncJob?.finishedAt ??
          operational.latestSyncJob?.startedAt ??
          null,
        operational.store.lastSyncAt
      )
    : null;
  const moduleStates = readiness?.moduleStates ?? null;
  const summaryTitle = buildDashboardSummaryTitle(syncState.status);
  const recentInsights = store.timelineEvents.slice(0, 5).map((event) => ({
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
  }));
  const quickAccess = readiness?.quickAccess ?? null;
  const syncHealthReason = readiness?.setup.summaryDescription ?? syncState.reason;
  const dashboardState = {
    refreshedAt: lastRefreshedAt,
    syncHealth: {
      status: readiness?.initialSync.syncStatus ?? syncState.status,
      title: readiness?.setup.summaryTitle ?? summaryTitle,
      reason: syncHealthReason,
    },
    kpis: {
      fraudAlerts: todayHighRiskOrders,
      competitorChanges,
      pricingOpportunities: pricingSuggestions,
      profitOpportunities,
    },
    recentInsights,
    quickAccess,
    refreshSummary: {
      visibleKpiChanged: false,
      recentInsightsChanged: false,
      quickAccessChanged: false,
      changedSections: [],
      unchangedSections: ["KPI cards", "Recent insights", "Quick access", "Sync health"],
    },
  };

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
    summaryTitle,
    summaryDetail: syncHealthReason,
    recentInsights,
    moduleReadiness: readiness
      ? {
          trustAbuse: {
            readinessState: readiness.modules.fraud.state,
            reason: readiness.modules.fraud.description,
          },
          competitor: {
            readinessState: readiness.modules.competitor.state,
            reason: readiness.modules.competitor.description,
          },
          pricingProfit: {
            readinessState: readiness.modules.pricing.state,
            reason: readiness.modules.pricing.description,
          },
        }
      : null,
    moduleStates,
    dashboardState,
    persistedCounts: operational?.counts ?? null,
    onboarding,
    readiness,
  };
}


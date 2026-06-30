import { prisma } from "../db/prismaClient";
import { getCompetitorOverview } from "./competitorService";
import { getOnboardingState } from "./onboardingService";
import { getPricingProfitOverview } from "./pricingProfitService";
import { getUnifiedReadinessState } from "./readinessEngineService";
import {
  deriveSyncStatus,
  getStoreOperationalSnapshot,
} from "./storeOperationalStateService";
import { getTrustAbuseOverview } from "./trustAbuseService";
import { toIsoString } from "./unifiedModuleStateService";
import {
  formatMerchantInsightDetail,
  formatMerchantInsightTitle,
  isInternalOrderLabel,
} from "../lib/merchantLabels";

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
    return "Your store is connected and ready";
  }

  if (status === "SYNC_COMPLETED_PROCESSING_PENDING") {
    return "Your store activity is being analyzed";
  }

  if (status === "EMPTY_STORE_DATA") {
    return "More store activity is needed for insights";
  }

  if (status === "FAILED") {
    return "Store connection needs attention";
  }

  if (status === "SYNC_IN_PROGRESS") {
    return "Updating store insights";
  }

  return "Connect store activity to begin insights";
}

function isActionableDashboardEvent(input: {
  category: string;
  eventType: string;
  severity: string;
  orderLabel: string | null;
}) {
  if (input.category === "orders" || input.eventType === "refund_requested") {
    return !!input.orderLabel && ["critical", "warning"].includes(input.severity);
  }

  if (input.category === "abuse" || input.category === "trust") {
    return ["critical", "warning"].includes(input.severity);
  }

  if (input.category === "competitor") {
    return input.eventType.includes("price") || input.eventType.includes("promotion");
  }

  if (input.category === "pricing" || input.category === "profit") {
    return ["critical", "warning", "success"].includes(input.severity);
  }

  return ["critical", "warning"].includes(input.severity);
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
    trustOverview,
    competitorOverview,
    pricingOverview,
    serialReturners,
  ] =
    await Promise.all([
      getTrustAbuseOverview(shopDomain).catch(() => null),
      getCompetitorOverview(shopDomain).catch(() => null),
      getPricingProfitOverview(shopDomain).catch(() => null),
      prisma.customer.count({
        where: {
          storeId: store.id,
          refundRate: { gt: 0.3 },
        },
      }).catch(() => 0),
    ]);

  const todayHighRiskOrders = trustOverview?.summary?.highRiskOrders ?? 0;
  const competitorChanges =
    (competitorOverview?.competitorState?.detectedPriceChangesCount ?? 0) +
    (competitorOverview?.competitorState?.detectedPromotionChangesCount ?? 0);
  const pricingSuggestions = pricingOverview?.summary?.recommendationCount ?? 0;
  const profitOpportunities = pricingOverview?.summary?.profitOpportunityCount ?? 0;

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
  const recentInsights = store.timelineEvents.flatMap((event) => {
    const metadata = (() => {
      if (!event.metadataJson) {
        return {};
      }
      try {
        return JSON.parse(event.metadataJson) as Record<string, unknown>;
      } catch {
        return {};
      }
    })();
    const orderLabel =
      typeof metadata.orderLabel === "string" && !isInternalOrderLabel(metadata.orderLabel)
        ? metadata.orderLabel
        : null;

    if (
      !isActionableDashboardEvent({
        category: event.category,
        eventType: event.eventType,
        severity: event.severity,
        orderLabel,
      })
    ) {
      return [];
    }

    return [{
      id: event.id,
      title: formatMerchantInsightTitle({
        category: event.category,
        eventType: event.eventType,
        orderLabel,
        severity: event.severity,
      }),
      detail: formatMerchantInsightDetail({
        category: event.category,
        eventType: event.eventType,
        orderLabel,
        detail: event.detail,
      }),
      severity: event.severity,
      createdAt: event.createdAt.toISOString(),
      route:
        event.category === "competitor"
          ? "/app/competitor-intelligence"
          : event.category === "pricing" || event.category === "profit"
          ? "/app/ai-pricing-engine"
          : "/app/fraud-intelligence",
    }];
  }).slice(0, 5);
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


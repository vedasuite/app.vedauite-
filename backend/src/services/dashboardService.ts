import { prisma } from "../db/prismaClient";
import { getOnboardingState } from "./onboardingService";
import {
  deriveModuleReadiness,
  deriveSyncStatus,
  getStoreOperationalSnapshot,
} from "./storeOperationalStateService";
import {
  createUnifiedModuleState,
  deriveDashboardQuickAccessState,
  isStaleTimestamp,
  toIsoString,
} from "./unifiedModuleStateService";

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
    ? latestIsoTimestamp(
        operational.latestProcessingAt,
        operational.latestCompetitorAt,
        operational.latestSyncJob?.finishedAt ??
          operational.latestSyncJob?.startedAt ??
          null,
        operational.store.lastSyncAt
      )
    : null;
  const lastCompetitorAt = toIsoString(operational?.latestCompetitorAt ?? null);
  const lastProcessingAt = toIsoString(operational?.latestProcessingAt ?? null);
  const moduleStates = operational
    ? {
        fraud:
          syncState.status === "FAILED"
            ? createUnifiedModuleState({
                setupStatus: "complete",
                syncStatus: "failed",
                dataStatus: "failed",
                lastSuccessfulSyncAt: lastProcessingAt,
                lastAttemptAt: toIsoString(operational.latestSyncJob?.finishedAt ?? operational.latestSyncJob?.startedAt ?? null),
                coverage: operational.counts.timelineEvents > 0 ? "partial" : "none",
                dependencies: {
                  fraud: operational.counts.timelineEvents > 0 ? "ready" : "missing",
                  competitor: operational.counts.competitorRows > 0 ? "ready" : "missing",
                  pricing: operational.counts.pricingRows > 0 ? "ready" : "missing",
                },
                title: "Fraud data needs attention",
                description: trustReadiness?.reason ?? syncState.reason,
                nextAction: "Retry sync",
              })
            : syncState.status === "SYNC_IN_PROGRESS"
            ? createUnifiedModuleState({
                setupStatus: "complete",
                syncStatus: "running",
                dataStatus: "processing",
                lastSuccessfulSyncAt: lastProcessingAt,
                lastAttemptAt: toIsoString(operational.latestSyncJob?.startedAt ?? null),
                coverage: operational.counts.timelineEvents > 0 ? "partial" : "none",
                dependencies: {
                  fraud: operational.counts.timelineEvents > 0 ? "ready" : "missing",
                  competitor: operational.counts.competitorRows > 0 ? "ready" : "missing",
                  pricing: operational.counts.pricingRows > 0 ? "ready" : "missing",
                },
                title: "Fraud data is updating",
                description: "VedaSuite is refreshing refund abuse and order-risk data.",
                nextAction: "Wait for refresh",
              })
            : operational.counts.timelineEvents === 0
            ? createUnifiedModuleState({
                setupStatus: "complete",
                syncStatus: "completed",
                dataStatus: "empty",
                lastSuccessfulSyncAt: lastProcessingAt,
                lastAttemptAt: toIsoString(operational.latestSyncJob?.finishedAt ?? null),
                coverage: "none",
                dependencies: {
                  fraud: "missing",
                  competitor: operational.counts.competitorRows > 0 ? "ready" : "missing",
                  pricing: operational.counts.pricingRows > 0 ? "ready" : "missing",
                },
                title: "No fraud alerts found yet",
                description:
                  "VedaSuite is working normally, but no fraud or refund-abuse alerts were detected from the latest data.",
                nextAction: "Refresh after more order activity",
              })
            : createUnifiedModuleState({
                setupStatus: "complete",
                syncStatus: "completed",
                dataStatus: isStaleTimestamp(operational.latestProcessingAt)
                  ? "stale"
                  : "ready",
                lastSuccessfulSyncAt: lastProcessingAt,
                lastAttemptAt: toIsoString(operational.latestSyncJob?.finishedAt ?? null),
                dataChanged: todayHighRiskOrders > 0 || serialReturners > 0,
                coverage: "full",
                dependencies: {
                  fraud: "ready",
                  competitor: operational.counts.competitorRows > 0 ? "ready" : "missing",
                  pricing: operational.counts.pricingRows > 0 ? "ready" : "missing",
                },
                title: "Fraud data is ready",
                description:
                  "Refund abuse and order-risk checks are available from the latest store data.",
                nextAction: "Open Fraud Intelligence",
              }),
        competitor:
          operational.counts.competitorDomains === 0
            ? createUnifiedModuleState({
                setupStatus: "incomplete",
                syncStatus: "idle",
                dataStatus: "empty",
                lastSuccessfulSyncAt: lastCompetitorAt,
                lastAttemptAt: toIsoString(operational.latestCompetitorIngestJob?.finishedAt ?? operational.latestCompetitorIngestJob?.startedAt ?? null),
                coverage: "none",
                dependencies: {
                  fraud: operational.counts.timelineEvents > 0 ? "ready" : "missing",
                  competitor: "missing",
                  pricing: operational.counts.pricingRows > 0 ? "ready" : "missing",
                },
                title: "Competitor setup is incomplete",
                description: "Add competitor domains before competitor updates can appear.",
                nextAction: "Add competitor domains",
              })
            : operational.latestCompetitorIngestJob?.status === "FAILED"
            ? createUnifiedModuleState({
                setupStatus: "complete",
                syncStatus: "failed",
                dataStatus: "failed",
                lastSuccessfulSyncAt: lastCompetitorAt,
                lastAttemptAt: toIsoString(operational.latestCompetitorIngestJob?.finishedAt ?? operational.latestCompetitorIngestJob?.startedAt ?? null),
                coverage: operational.counts.competitorRows > 0 ? "partial" : "none",
                dependencies: {
                  fraud: operational.counts.timelineEvents > 0 ? "ready" : "missing",
                  competitor: operational.counts.competitorRows > 0 ? "ready" : "missing",
                  pricing: operational.counts.pricingRows > 0 ? "ready" : "missing",
                },
                title: "Competitor data needs attention",
                description:
                  operational.latestCompetitorIngestJob.errorMessage ??
                  "The latest competitor refresh failed.",
                nextAction: "Retry refresh",
              })
            : operational.latestCompetitorIngestJob?.status === "RUNNING"
            ? createUnifiedModuleState({
                setupStatus: "complete",
                syncStatus: "running",
                dataStatus: "processing",
                lastSuccessfulSyncAt: lastCompetitorAt,
                lastAttemptAt: toIsoString(operational.latestCompetitorIngestJob.startedAt ?? null),
                coverage: operational.counts.competitorRows > 0 ? "partial" : "none",
                dependencies: {
                  fraud: operational.counts.timelineEvents > 0 ? "ready" : "missing",
                  competitor: operational.counts.competitorRows > 0 ? "ready" : "missing",
                  pricing: operational.counts.pricingRows > 0 ? "ready" : "missing",
                },
                title: "Competitor data is updating",
                description: "VedaSuite is checking competitor domains and matched products.",
                nextAction: "Wait for refresh",
              })
            : operational.counts.competitorRows === 0
            ? createUnifiedModuleState({
                setupStatus: "complete",
                syncStatus: "completed",
                dataStatus: "empty",
                lastSuccessfulSyncAt: lastCompetitorAt,
                lastAttemptAt: toIsoString(operational.latestCompetitorIngestJob?.finishedAt ?? null),
                coverage: "none",
                dependencies: {
                  fraud: operational.counts.timelineEvents > 0 ? "ready" : "missing",
                  competitor: "missing",
                  pricing: operational.counts.pricingRows > 0 ? "ready" : "missing",
                },
                title: "No competitor matches found yet",
                description:
                  "Competitor monitoring is configured, but no comparable competitor products were matched.",
                nextAction: "Review domains or tracked products",
              })
            : createUnifiedModuleState({
                setupStatus: "complete",
                syncStatus: "completed",
                dataStatus: isStaleTimestamp(operational.latestCompetitorAt)
                  ? "stale"
                  : "ready",
                lastSuccessfulSyncAt: lastCompetitorAt,
                lastAttemptAt: toIsoString(operational.latestCompetitorIngestJob?.finishedAt ?? null),
                dataChanged: competitorChanges > 0,
                coverage: "full",
                dependencies: {
                  fraud: operational.counts.timelineEvents > 0 ? "ready" : "missing",
                  competitor: "ready",
                  pricing: operational.counts.pricingRows > 0 ? "ready" : "missing",
                },
                title: "Competitor data is ready",
                description:
                  competitorChanges > 0
                    ? "Competitor updates are available for review."
                    : "Competitor monitoring is active with no new visible changes.",
                nextAction: "Open Competitor Intelligence",
              }),
        pricing:
          syncState.status === "FAILED"
            ? createUnifiedModuleState({
                setupStatus: "complete",
                syncStatus: "failed",
                dataStatus: "failed",
                lastSuccessfulSyncAt: lastProcessingAt,
                lastAttemptAt: toIsoString(operational.latestSyncJob?.finishedAt ?? operational.latestSyncJob?.startedAt ?? null),
                coverage: operational.counts.pricingRows + operational.counts.profitRows > 0 ? "partial" : "none",
                dependencies: {
                  fraud: operational.counts.timelineEvents > 0 ? "ready" : "missing",
                  competitor: operational.counts.competitorRows > 0 ? "ready" : "missing",
                  pricing: operational.counts.pricingRows + operational.counts.profitRows > 0 ? "ready" : "missing",
                },
                title: "Pricing data needs attention",
                description: pricingReadiness?.reason ?? syncState.reason,
                nextAction: "Retry sync",
              })
            : syncState.status === "SYNC_IN_PROGRESS"
            ? createUnifiedModuleState({
                setupStatus: "complete",
                syncStatus: "running",
                dataStatus: "processing",
                lastSuccessfulSyncAt: lastProcessingAt,
                lastAttemptAt: toIsoString(operational.latestSyncJob?.startedAt ?? null),
                coverage: operational.counts.pricingRows + operational.counts.profitRows > 0 ? "partial" : "none",
                dependencies: {
                  fraud: operational.counts.timelineEvents > 0 ? "ready" : "missing",
                  competitor: operational.counts.competitorRows > 0 ? "ready" : "missing",
                  pricing: operational.counts.pricingRows + operational.counts.profitRows > 0 ? "ready" : "missing",
                },
                title: "Pricing data is updating",
                description:
                  "VedaSuite is refreshing pricing recommendations and profit data.",
                nextAction: "Wait for refresh",
              })
            : operational.counts.pricingRows + operational.counts.profitRows === 0
            ? createUnifiedModuleState({
                setupStatus: "complete",
                syncStatus: "completed",
                dataStatus: "empty",
                lastSuccessfulSyncAt: lastProcessingAt,
                lastAttemptAt: toIsoString(operational.latestSyncJob?.finishedAt ?? null),
                coverage: "none",
                dependencies: {
                  fraud: operational.counts.timelineEvents > 0 ? "ready" : "missing",
                  competitor: operational.counts.competitorRows > 0 ? "ready" : "missing",
                  pricing: "missing",
                },
                title: "No pricing opportunities found yet",
                description:
                  "Pricing logic is active, but the latest data did not surface visible pricing or profit opportunities.",
                nextAction: "Refresh after more sales activity",
              })
            : createUnifiedModuleState({
                setupStatus: "complete",
                syncStatus: "completed",
                dataStatus:
                  operational.counts.competitorRows === 0
                    ? "partial"
                    : isStaleTimestamp(operational.latestProcessingAt)
                    ? "stale"
                    : "ready",
                lastSuccessfulSyncAt: lastProcessingAt,
                lastAttemptAt: toIsoString(operational.latestSyncJob?.finishedAt ?? null),
                dataChanged: pricingSuggestions > 0 || profitOpportunities > 0,
                coverage:
                  operational.counts.competitorRows === 0 ? "partial" : "full",
                dependencies: {
                  fraud: operational.counts.timelineEvents > 0 ? "ready" : "missing",
                  competitor: operational.counts.competitorRows > 0 ? "ready" : "missing",
                  pricing: "ready",
                },
                title:
                  operational.counts.competitorRows === 0
                    ? "Pricing data is ready with partial coverage"
                    : "Pricing data is ready",
                description:
                  operational.counts.competitorRows === 0
                    ? "Pricing recommendations are available while competitor comparisons are still missing."
                    : "Pricing recommendations and profit opportunities are ready to review.",
                nextAction: "Open AI Pricing Engine",
              }),
      }
    : null;
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
  const quickAccess = moduleStates
    ? {
        fraud: deriveDashboardQuickAccessState(moduleStates.fraud),
        competitor: deriveDashboardQuickAccessState(moduleStates.competitor),
        pricing: deriveDashboardQuickAccessState(moduleStates.pricing),
      }
    : null;
  const staleModules = quickAccess
    ? [
        quickAccess.fraud.status === "Stale" ? "Fraud" : null,
        quickAccess.competitor.status === "Stale" ? "Competitor" : null,
        quickAccess.pricing.status === "Stale" ? "Pricing" : null,
      ].filter((value): value is string => !!value)
    : [];
  const syncHealthReason =
    syncState.status === "READY_WITH_DATA" && staleModules.length > 0
      ? `${syncState.reason} ${staleModules.join(" and ")} data has not refreshed recently.`
      : syncState.reason;
  const dashboardState = {
    refreshedAt: lastRefreshedAt,
    syncHealth: {
      status: syncState.status,
      title: summaryTitle,
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
    moduleReadiness: {
      trustAbuse: trustReadiness,
      competitor: competitorReadiness,
      pricingProfit: pricingReadiness,
    },
    moduleStates,
    dashboardState,
    persistedCounts: operational?.counts ?? null,
    onboarding,
  };
}


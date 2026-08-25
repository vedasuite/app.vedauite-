// PHASE F — the Dashboard projects findings; it does not compute them.
//
// This file used to hold four independent merchant-facing calculations:
//
//   fraudAlerts        <- getTrustAbuseOverview().summary.highRiskOrders
//   competitorChanges  <- getCompetitorOverview() detected*ChangesCount
//   pricingOpportunities / profitOpportunities <- getPricingProfitOverview()
//   recentInsights     <- raw TimelineEvent rows, formatted here
//
// None of those knew about IntelligenceFinding, so none of them respected the
// finding lifecycle. A merchant could resolve a finding in Action Center and
// still see it counted here, and a dismissed problem stayed in "Recent
// insights" forever because a timeline event is an immutable log line that is
// never retracted.
//
// All four are now gone. Every merchant-facing number and every insight on this
// page is a projection of the SAME open findings Action Center renders, built
// by dashboardFindingsCalc. The module overview services are no longer called
// from here at all — not reworded, not re-weighted, removed — because a second
// calculation that merely agrees today is still a second calculation.
//
// The module workspaces keep every one of those overviews and their full
// detail. Nothing was taken away from a merchant; a contradiction was.

import { prisma } from "../db/prismaClient";
import { env } from "../config/env";
import { getOnboardingState } from "./onboardingService";
import { getUnifiedReadinessState } from "./readinessEngineService";
import {
  deriveSyncStatus,
  getStoreOperationalSnapshot,
} from "./storeOperationalStateService";
import { getActionCenter } from "./actionCenterService";
import { resolveEntitlements } from "./subscriptionService";
import {
  buildDashboardFindingsView,
  type DashboardFindingsView,
  type ProjectableCard,
} from "./dashboardFindingsCalc";

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

/**
 * Reads the open findings this store already has, and projects them.
 *
 * Never throws: a Dashboard that fails to load because the finding query failed
 * would be a worse outcome than a Dashboard that says findings are currently
 * unavailable. Both branches are honest; only one keeps the page usable.
 */
async function loadFindingsView(input: {
  storeId: string;
  shop: string;
}): Promise<DashboardFindingsView> {
  const persistenceEnabled = env.enableIntelligenceFindingPersistence;

  try {
    const entitlements = await resolveEntitlements(input.shop);
    const enabledModules = entitlements.enabledModules ?? [];

    // The SAME call Action Center's route makes, with the SAME entitlement
    // filter. Not a similar query — the same function, so the two surfaces
    // cannot diverge even if the ranking or filtering rules change later.
    const { cards } = await getActionCenter({
      storeId: input.storeId,
      enabledModules,
    });

    return buildDashboardFindingsView({
      cards: cards as unknown as ProjectableCard[],
      persistenceEnabled,
      enabledModules,
    });
  } catch {
    return {
      available: false,
      unavailableReason:
        "VedaSuite could not read this store's findings just now. Refresh to try again.",
      kpis: {
        storeHealth: 0,
        fraudAlerts: 0,
        competitorChanges: 0,
        pricingOpportunities: 0,
        profitOpportunities: 0,
      },
      totalOpen: 0,
      bySeverity: { critical: 0, high: 0, medium: 0, low: 0 },
      recentInsights: [],
      attentionTitle: "Findings could not be loaded",
      attentionDetail:
        "This is a temporary read problem, not a statement about your store.",
    };
  }
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

  const findings = await loadFindingsView({ storeId: store.id, shop: store.shop });

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

  // ONE list, projected from the open findings Action Center is showing.
  // The timeline is still written and still readable in the module workspaces;
  // it is simply no longer a second, lifecycle-blind source of merchant-facing
  // insights on this page.
  const recentInsights = findings.recentInsights;
  const quickAccess = readiness?.quickAccess ?? null;
  const syncHealthReason = readiness?.setup.summaryDescription ?? syncState.reason;
  const dashboardState = {
    refreshedAt: lastRefreshedAt,
    syncHealth: {
      status: readiness?.initialSync.syncStatus ?? syncState.status,
      title: readiness?.setup.summaryTitle ?? summaryTitle,
      reason: syncHealthReason,
    },
    kpis: findings.kpis,
    // Everything the UI needs to render these tiles HONESTLY: whether the
    // numbers mean anything at all, and what to say when they do not.
    findings: {
      available: findings.available,
      unavailableReason: findings.unavailableReason,
      totalOpen: findings.totalOpen,
      bySeverity: findings.bySeverity,
      attentionTitle: findings.attentionTitle,
      attentionDetail: findings.attentionDetail,
      /** Where the merchant goes to act on any of it. */
      route: "/app/action-center",
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
    // LEGACY TOP-LEVEL FIELDS.
    //
    // The frontend still reads these as `dashboardState?.kpis.x ?? metrics.y`.
    // Leaving them on the old overview services would have defeated the whole
    // phase: the fallback branch would quietly restore the contradiction the
    // moment dashboardState was absent. So they now read from the SAME
    // projection, and the fallback is a copy rather than a competitor.
    fraudAlertsToday: findings.kpis.fraudAlerts,
    highRiskOrders: findings.kpis.fraudAlerts,
    // Serial returners was a direct `customer.count(refundRate > 0.3)` — a raw
    // threshold query with no evidence model behind it, rendered nowhere. It is
    // reported as the number of open fraud-family findings instead of being
    // silently re-derived from a bare threshold.
    serialReturners: findings.kpis.fraudAlerts,
    competitorPriceChanges: findings.kpis.competitorChanges,
    promotionAlerts: findings.kpis.competitorChanges,
    aiPricingSuggestions: findings.kpis.pricingOpportunities,
    profitOptimizationOpportunities: findings.kpis.profitOpportunities,
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


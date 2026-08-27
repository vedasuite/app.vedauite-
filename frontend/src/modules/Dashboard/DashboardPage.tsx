import {
  Badge,
  Banner,
  BlockStack,
  Button,
  Card,
  InlineGrid,
  InlineStack,
  Layout,
  List,
  Page,
  SkeletonBodyText,
  SkeletonDisplayText,
  Spinner,
  Text,
  Toast,
  Tooltip,
} from "@shopify/polaris";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useEmbeddedNavigation } from "../../hooks/useEmbeddedNavigation";
import "./dashboard.css";
import { embeddedShopRequest } from "../../lib/embeddedShopRequest";
import { readModuleCache, writeModuleCache } from "../../lib/moduleCache";
import { useAppBridge } from "../../shopifyAppBridge";
import { useSubscriptionPlan } from "../../hooks/useSubscriptionPlan";
import { useOnboardingState } from "../../hooks/useOnboardingState";
import { InsightsDashboardSections } from "./components/InsightsDashboardSections";
import { ChoosePlanBanner, TrialStatusBanner } from "../../components/billing/TrialStatus";
import { useAppState } from "../../hooks/useAppState";

type Metrics = {
  fraudAlertsToday: number;
  highRiskOrders: number;
  serialReturners: number;
  competitorPriceChanges: number;
  promotionAlerts: number;
  aiPricingSuggestions: number;
  profitOptimizationOpportunities: number;
  dataState?: string;
  summaryTitle?: string;
  summaryDetail?: string;
  lastRefreshedAt?: string | null;
  moduleStates?: {
    fraud?: {
      dataStatus: string;
      title: string;
      description: string;
    } | null;
    competitor?: {
      dataStatus: string;
      title: string;
      description: string;
    } | null;
    pricing?: {
      dataStatus: string;
      title: string;
      description: string;
    } | null;
  };
  moduleReadiness?: {
    trustAbuse?: {
      readinessState: string;
      reason: string;
    } | null;
    competitor?: {
      readinessState: string;
      reason: string;
    } | null;
    pricingProfit?: {
      readinessState: string;
      reason: string;
    } | null;
  };
  recentInsights?: Array<{
    id: string;
    title: string;
    detail: string;
    severity: string;
    createdAt: string;
    route: string;
  }>;
  dashboardState?: DashboardState;
};

type DashboardQuickAccessStatus =
  | "Locked"
  | "Setup needed"
  | "Collecting data"
  | "Ready"
  | "Partial"
  | "Needs setup"
  | "Refreshing"
  | "Stale"
  | "Error";

type DashboardInsight = {
  id: string;
  title: string;
  detail: string;
  severity: string;
  createdAt: string;
  route: string;
};

type DashboardQuickAccessItem = {
  status: DashboardQuickAccessStatus;
  freshnessAt: string | null;
  reason: string;
};

type DashboardState = {
  refreshedAt: string | null;
  syncHealth: {
    status: string;
    title: string;
    reason: string;
  };
  kpis: {
    storeHealth: number;
    fraudAlerts: number;
    competitorChanges: number;
    pricingOpportunities: number;
    profitOpportunities: number;
    reconciliation: number;
  };
  /**
   * PHASE F. Every tile above is now a projection of the OPEN findings Action
   * Center shows, so the two pages cannot disagree. `available` is false when
   * VedaSuite is not recording findings — in that case the counts are all zero
   * but mean nothing, and the tiles must render a dash rather than a "0" the
   * merchant would read as "no problems".
   */
  findings?: {
    available: boolean;
    unavailableReason: string | null;
    totalOpen: number;
    bySeverity: { critical: number; high: number; medium: number; low: number };
    attentionTitle: string;
    attentionDetail: string;
    route: string;
  };
  recentInsights: DashboardInsight[];
  quickAccess: {
    fraud: DashboardQuickAccessItem;
    competitor: DashboardQuickAccessItem;
    pricing: DashboardQuickAccessItem;
  } | null;
  refreshSummary?: {
    visibleKpiChanged: boolean;
    recentInsightsChanged: boolean;
    quickAccessChanged: boolean;
    changedSections: string[];
    unchangedSections: string[];
  };
};

/**
 * Strips finding COUNTS from a cache-seeded payload.
 *
 * A cached number and a current number look identical on screen, and Store
 * Overview is the one surface that can be opened minutes after a
 * reconciliation run created findings on another page — no sync involved, so
 * nothing invalidated the entry. That is how Store Overview showed one older
 * finding as the current state while Action Center, which has no cache, showed
 * the three the latest run produced.
 *
 * The cached payload still seeds the page shell so the layout does not flash.
 * Only the numbers are withheld, and the existing `available: false` path
 * renders them as "—" until the live fetch lands. Nothing here invents a value.
 */
function withheldFindings(payload: DashboardPayload | null): DashboardPayload | null {
  if (!payload) return null;
  const state = payload.metrics.dashboardState;
  if (!state) return payload;

  return {
    ...payload,
    metrics: {
      ...payload.metrics,
      recentInsights: [],
      dashboardState: {
        ...state,
        kpis: {
          storeHealth: 0,
          fraudAlerts: 0,
          competitorChanges: 0,
          pricingOpportunities: 0,
          profitOpportunities: 0,
          reconciliation: 0,
        },
        findings: state.findings
          ? {
              ...state.findings,
              available: false,
              unavailableReason:
                "Checking for the latest findings — these counts are not current yet.",
              totalOpen: 0,
              bySeverity: { critical: 0, high: 0, medium: 0, low: 0 },
            }
          : state.findings,
        recentInsights: [],
      },
    },
  };
}

type Diagnostics = {
  connection: {
    healthy: boolean;
    webhookCoverageReady: boolean;
    code: string;
    message: string;
    reauthRequired: boolean;
    reauthorizeUrl?: string;
  };
  webhooks: {
    registeredAt: string | null;
    lastStatus: string | null;
    liveStatus: {
      registeredCount: number;
      totalTracked: number;
    } | null;
  };
  sync: {
    syncHealth?: {
      status: string;
      reason: string;
    } | null;
  };
};

type SyncJobResponse = {
  result: {
    id?: string;
    jobId?: string;
    status: string;
    summaryJson?: string | null;
    summary?: {
      activitySummary?: {
        ordersProcessed: number;
        customersEvaluated: number;
        competitorPagesChecked: number;
        pricingRecordsAnalyzed: number;
        fraudSignalsGenerated: number;
        newInsightsCount: number;
        updatedInsightsCount: number;
        errorsCount: number;
        noChangeReasons?: string[];
        moduleProcessing?: {
          fraud?: ModuleProcessingResult;
          competitor?: ModuleProcessingResult;
          pricing?: ModuleProcessingResult;
        };
      } | null;
    } | null;
    startedAt?: string | null;
    finishedAt?: string | null;
    errorMessage?: string | null;
  } | null;
};

type SyncActivitySummary = NonNullable<
  NonNullable<NonNullable<SyncJobResponse["result"]>["summary"]>["activitySummary"]
>;

/**
 * One module's processing outcome from a sync.
 *
 * Named explicitly because the obvious indexed access silently produced
 * `never`: `moduleProcessing` is an OPTIONAL property, so
 * `SyncActivitySummary["moduleProcessing"]` includes `undefined`, and
 * `keyof (T | undefined)` is `never` — which collapses
 * `...[keyof ...]` to `never` too.
 *
 * The consequence was not a crash, it was silence: `deriveQuickAccessDisplay`
 * took a parameter of type `never | null`, so TypeScript checked nothing about
 * the object it actually receives, on the path that decides what each Quick
 * Access card tells the merchant. A shape change upstream would have been
 * caught by nobody.
 */
type ModuleProcessingResult = {
  processed: boolean;
  status: string;
  reason: string;
};

type DashboardPayload = {
  metrics: Metrics;
  diagnostics: Diagnostics | null;
};

type DashboardRefreshResult = {
  startedAt: string;
  finishedAt: string;
  refreshStatus: "success" | "partial" | "failure";
  visibleDataChanged: boolean;
  changedSections: string[];
  unchangedSections: string[];
  lastRefreshedAt: string | null;
  moduleRefreshResults: {
    fraud: "updated" | "unchanged" | "failed";
    competitor: "updated" | "unchanged" | "failed";
    pricing: "updated" | "unchanged" | "failed";
  };
  activitySummary: SyncActivitySummary | null;
  noChangeExplanation: string | null;
  previousSnapshot: DashboardVisibleSnapshot | null;
  nextSnapshot: DashboardVisibleSnapshot;
  summary: string;
};

/**
 * The backend's canonical store verdict.
 *
 * Rendered, never re-derived: the moment a surface computes its own version
 * of this it can contradict every other surface, which is exactly what
 * happened.
 */
type CanonicalHealth = {
  health:
    | "HEALTHY"
    | "ATTENTION_REQUIRED"
    | "PARTIAL"
    | "AWAITING_SETUP"
    | "BLOCKED"
    | "NOT_READY";
  headline: string;
  detail: string[];
  ran: string[];
  couldNotRun: string[];
  awaitingMerchant: string[];
};

type DashboardVisibleSnapshot = {
  kpis: {
    storeHealth: number;
    fraudAlerts: number;
    competitorChanges: number;
    pricingOpportunities: number;
    profitOpportunities: number;
    reconciliation: number;
  };
  recentInsightKeys: string[];
  quickAccess: {
    fraud: string | null;
    competitor: string | null;
    pricing: string | null;
  };
  syncHealth: {
    status: string | null;
    title: string | null;
    reason: string | null;
  };
  lastRefreshedAt: string | null;
};

function toneForReadiness(value?: string | null) {
  switch (value) {
    case "READY_WITH_DATA":
      return "success";
    case "SYNC_IN_PROGRESS":
    case "SYNC_COMPLETED_PROCESSING_PENDING":
      return "attention";
    case "FAILED":
    case "NOT_CONNECTED":
      return "critical";
    default:
      return "info";
  }
}

/**
 * The same readiness state, expressed as a tone a Banner actually accepts.
 *
 * Polaris Badge and Banner have DIFFERENT tone unions: Badge allows
 * "attention", Banner allows only success | info | warning | critical. One tone
 * function was feeding both, so every Banner rendered for a syncing store
 * passed tone="attention" — a value Polaris does not recognise, which silently
 * falls back to the default. The banner meant to stand out looked ordinary.
 *
 * "warning" is Banner's equivalent of Badge's "attention": something in
 * progress that the merchant should notice, but not a failure.
 */
function bannerToneForReadiness(
  value?: string | null
): "success" | "info" | "warning" | "critical" {
  const tone = toneForReadiness(value);
  return tone === "attention" ? "warning" : tone;
}

function labelForReadiness(value?: string | null) {
  switch (value) {
    case "READY_WITH_DATA":
      return "Ready";
    case "SYNC_IN_PROGRESS":
      return "Analyzing store";
    case "SYNC_COMPLETED_PROCESSING_PENDING":
      return "Insights preparing";
    case "EMPTY_STORE_DATA":
      return "Waiting for store activity";
    case "FAILED":
      return "Needs attention";
    case "NOT_CONNECTED":
      return "Reconnect Shopify";
    default:
      return "Connect store";
  }
}

function toneForDataStatus(value?: string | null) {
  switch (value) {
    case "ready":
      return "success";
    case "partial":
    case "stale":
      return "attention";
    case "failed":
      return "critical";
    case "processing":
    case "empty":
    default:
      return "info";
  }
}

function labelForDataStatus(value?: string | null) {
  switch (value) {
    case "ready":
      return "Ready";
    case "partial":
      return "Limited insights";
    case "empty":
      return "Waiting for activity";
    case "stale":
      return "Update recommended";
    case "failed":
      return "Failed";
    case "processing":
      return "Preparing insights";
    default:
      return "Unknown";
  }
}

function toneForQuickAccessStatus(value?: DashboardQuickAccessStatus | string | null) {
  switch (value) {
    case "Ready":
    case "Updated":
    case "Ready (no changes)":
      return "success";
    case "Collecting data":
    case "Partial":
    case "Stale":
      return "attention";
    case "Locked":
    case "Setup needed":
    case "Needs setup":
    case "Not refreshed":
      return "info";
    case "Refreshing":
      return "info";
    case "Error":
      return "critical";
    default:
      return "info";
  }
}

function labelForQuickAccessStatus(value?: DashboardQuickAccessStatus | string | null) {
  switch (value) {
    case "Collecting data":
      return "Preparing insights";
    case "Stale":
      return "Update recommended";
    case "Setup needed":
    case "Needs setup":
      return "Action needed";
    case "Not refreshed":
      return "Ready after next analysis";
    case "Refreshing":
      return "Updating";
    case "Error":
      return "Needs attention";
    default:
      return value ?? "Available";
  }
}

function deriveQuickAccessDisplay(args: {
  baseStatus?: DashboardQuickAccessStatus | string | null;
  baseReason?: string | null;
  baseFreshnessAt?: string | null;
  processing?: ModuleProcessingResult | null;
}) {
  if (!args.processing) {
    return {
      status: args.baseStatus ?? "Unknown",
      reason: args.baseReason ?? "",
      freshnessAt: args.baseFreshnessAt ?? null,
    };
  }

  switch (args.processing.status) {
    case "not_refreshed":
      return {
        status: "Ready after next analysis",
        reason: args.processing.reason,
        freshnessAt: args.baseFreshnessAt ?? null,
      };
    case "processed_no_changes":
      return {
        status: "Ready (no changes)",
        reason: args.processing.reason,
        freshnessAt: args.baseFreshnessAt ?? null,
      };
    case "updated":
      return {
        status: "Updated",
        reason: args.processing.reason,
        freshnessAt: args.baseFreshnessAt ?? null,
      };
    case "failed":
      return {
        status: "Error",
        reason: args.processing.reason,
        freshnessAt: args.baseFreshnessAt ?? null,
      };
    default:
      return {
        status: args.baseStatus ?? "Unknown",
        reason: args.baseReason ?? "",
        freshnessAt: args.baseFreshnessAt ?? null,
      };
  }
}

function normalizeModuleRefreshStatus(
  value?: string | null
): "updated" | "unchanged" | "failed" {
  if (!value) return "unchanged";
  if (value === "updated") return "updated";
  if (value === "failed") return "failed";
  return "unchanged";
}

function formatRelativeTimestamp(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
}

function equalJson(value: unknown, nextValue: unknown) {
  return JSON.stringify(value) === JSON.stringify(nextValue);
}

function buildDashboardSnapshot(
  payload: DashboardPayload | null
): DashboardVisibleSnapshot | null {
  if (!payload) {
    return null;
  }

  const dashboardState = payload.metrics.dashboardState;

  return {
    kpis: {
      // Both branches now read the same server-side projection: the top-level
      // fields are a copy of dashboardState.kpis, not a rival calculation.
      storeHealth: dashboardState?.kpis.storeHealth ?? 0,
      fraudAlerts:
        dashboardState?.kpis.fraudAlerts ?? payload.metrics.fraudAlertsToday,
      competitorChanges:
        dashboardState?.kpis.competitorChanges ??
        payload.metrics.competitorPriceChanges,
      pricingOpportunities:
        dashboardState?.kpis.pricingOpportunities ??
        payload.metrics.aiPricingSuggestions,
      profitOpportunities:
        dashboardState?.kpis.profitOpportunities ??
        payload.metrics.profitOptimizationOpportunities,
      // No legacy `metrics` fallback: reconciliation postdates that shape, and
      // inventing a zero here would be a claim rather than a reading.
      reconciliation: dashboardState?.kpis.reconciliation ?? 0,
    },
    recentInsightKeys:
      (
        dashboardState?.recentInsights ?? payload.metrics.recentInsights ?? []
      ).map((item) => `${item.id}:${item.createdAt}`),
    quickAccess: {
      fraud:
        dashboardState?.quickAccess?.fraud.status ??
        payload.metrics.moduleStates?.fraud?.dataStatus ??
        payload.metrics.moduleReadiness?.trustAbuse?.readinessState ??
        null,
      competitor:
        dashboardState?.quickAccess?.competitor.status ??
        payload.metrics.moduleStates?.competitor?.dataStatus ??
        payload.metrics.moduleReadiness?.competitor?.readinessState ??
        null,
      pricing:
        dashboardState?.quickAccess?.pricing.status ??
        payload.metrics.moduleStates?.pricing?.dataStatus ??
        payload.metrics.moduleReadiness?.pricingProfit?.readinessState ??
        null,
    },
    syncHealth: {
      status:
        dashboardState?.syncHealth.status ??
        payload.diagnostics?.sync.syncHealth?.status ??
        payload.metrics.dataState ??
        null,
      title:
        dashboardState?.syncHealth.title ?? payload.metrics.summaryTitle ?? null,
      reason:
        dashboardState?.syncHealth.reason ??
        payload.diagnostics?.sync.syncHealth?.reason ??
        payload.metrics.summaryDetail ??
        null,
    },
    lastRefreshedAt:
      dashboardState?.refreshedAt ?? payload.metrics.lastRefreshedAt ?? null,
  };
}

function parseTimestamp(value?: string | null) {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : time;
}

function hasSnapshotChanged(
  previous: DashboardVisibleSnapshot | null,
  next: DashboardVisibleSnapshot | null
) {
  if (!previous || !next) {
    return true;
  }

  return !equalJson(previous, next);
}

async function wait(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function deriveRefreshResult(args: {
  previous: DashboardPayload | null;
  next: DashboardPayload;
  job: SyncJobResponse["result"];
}): DashboardRefreshResult {
  const previousSnapshot = buildDashboardSnapshot(args.previous);
  const nextSnapshot = buildDashboardSnapshot(args.next)!;
  // The server's verdict, carried on the payload. Never recomputed here.
  const canonicalHealth =
    (args.next?.metrics?.dashboardState as { health?: CanonicalHealth } | undefined)
      ?.health ?? null;
  const kpiChanged =
    !previousSnapshot || !equalJson(previousSnapshot.kpis, nextSnapshot.kpis);
  const recentInsightsChanged =
    !previousSnapshot ||
    !equalJson(previousSnapshot.recentInsightKeys, nextSnapshot.recentInsightKeys);
  const quickAccessChanged =
    !previousSnapshot || !equalJson(previousSnapshot.quickAccess, nextSnapshot.quickAccess);
  const syncHealthChanged =
    !previousSnapshot || !equalJson(previousSnapshot.syncHealth, nextSnapshot.syncHealth);
  const freshnessChanged =
    !previousSnapshot ||
    previousSnapshot.lastRefreshedAt !== nextSnapshot.lastRefreshedAt;

  const changedSections = [
    kpiChanged ? "KPI cards" : null,
    recentInsightsChanged ? "Recent insights" : null,
    quickAccessChanged ? "Quick access" : null,
    syncHealthChanged ? "Sync health" : null,
    freshnessChanged ? "Last refreshed" : null,
  ].filter((value): value is string => !!value);
  const unchangedSections = [
    !kpiChanged ? "KPI cards" : null,
    !recentInsightsChanged ? "Recent insights" : null,
    !quickAccessChanged ? "Quick access" : null,
    !syncHealthChanged ? "Sync health" : null,
    !freshnessChanged ? "Last refreshed" : null,
  ].filter((value): value is string => !!value);

  /**
   * Describes one KPI movement.
   *
   * WHY THIS IS NOT `previous ?? 0`. With no earlier reading to compare
   * against, the old code still printed "changed from 0 to 6" — a transition
   * that was never observed. Zero was a placeholder for "unknown", and the
   * sentence presented it as a measurement. When the accompanying activity
   * list also read "0 orders processed", the merchant was being told six
   * opportunities had appeared out of nothing.
   *
   * A first reading is stated as a reading. Only a genuine before-and-after is
   * described as a change.
   */
  const describeMetric = (
    label: string,
    previous: number | undefined,
    next: number
  ) =>
    previous === undefined
      ? `${label}: ${next}`
      : `${label} changed from ${previous} to ${next}`;

  const metricDiffs: string[] = [];
  if (
    !previousSnapshot ||
    previousSnapshot.kpis.fraudAlerts !== nextSnapshot.kpis.fraudAlerts
  ) {
    metricDiffs.push(
      describeMetric(
        "Customer Loss",
        previousSnapshot?.kpis.fraudAlerts,
        nextSnapshot.kpis.fraudAlerts
      )
    );
  }
  if (
    !previousSnapshot ||
    previousSnapshot.kpis.competitorChanges !==
      nextSnapshot.kpis.competitorChanges
  ) {
    metricDiffs.push(
      describeMetric(
        "Market Signals",
        previousSnapshot?.kpis.competitorChanges,
        nextSnapshot.kpis.competitorChanges
      )
    );
  }
  if (
    !previousSnapshot ||
    previousSnapshot.kpis.pricingOpportunities !==
      nextSnapshot.kpis.pricingOpportunities
  ) {
    metricDiffs.push(
      describeMetric(
        "Pricing opportunities",
        previousSnapshot?.kpis.pricingOpportunities,
        nextSnapshot.kpis.pricingOpportunities
      )
    );
  }
  if (
    !previousSnapshot ||
    previousSnapshot.kpis.profitOpportunities !==
      nextSnapshot.kpis.profitOpportunities
  ) {
    metricDiffs.push(
      describeMetric(
        "Profit opportunities",
        previousSnapshot?.kpis.profitOpportunities,
        nextSnapshot.kpis.profitOpportunities
      )
    );
  }
  if (
    !previousSnapshot ||
    previousSnapshot.kpis.reconciliation !== nextSnapshot.kpis.reconciliation
  ) {
    metricDiffs.push(
      describeMetric(
        "Reconciliation",
        previousSnapshot?.kpis.reconciliation,
        nextSnapshot.kpis.reconciliation
      )
    );
  }

  const fraudChanged =
    !previousSnapshot ||
    previousSnapshot.quickAccess.fraud !== nextSnapshot.quickAccess.fraud ||
    previousSnapshot.kpis.fraudAlerts !== nextSnapshot.kpis.fraudAlerts;
  const competitorChanged =
    !previousSnapshot ||
    previousSnapshot.quickAccess.competitor !== nextSnapshot.quickAccess.competitor ||
    previousSnapshot.kpis.competitorChanges !== nextSnapshot.kpis.competitorChanges;
  const pricingChanged =
    !previousSnapshot ||
    previousSnapshot.quickAccess.pricing !== nextSnapshot.quickAccess.pricing ||
    previousSnapshot.kpis.pricingOpportunities !== nextSnapshot.kpis.pricingOpportunities ||
    previousSnapshot.kpis.profitOpportunities !== nextSnapshot.kpis.profitOpportunities;

  const refreshStatus =
    args.job?.status === "FAILED"
      ? "failure"
      : args.job?.status === "SUCCEEDED_PROCESSING_PENDING" ||
        args.job?.status === "SUCCEEDED_NO_DATA"
      ? "partial"
      : "success";
  const activitySummary = args.job?.summary?.activitySummary ?? null;

  const visibleDataChanged =
    kpiChanged || recentInsightsChanged || quickAccessChanged || syncHealthChanged;
  const unchangedModuleNames = [
    // Module names as the merchant sees them everywhere else.
    !fraudChanged ? "Customer Loss" : null,
    !competitorChanged ? "Market Signals" : null,
    !pricingChanged ? "Pricing & Product Profit" : null,
  ].filter((value): value is string => !!value);
  const summary =
    refreshStatus === "failure"
      ? "Update failed. Try again to refresh your store insights."
      : metricDiffs.length > 0
      ? `Analysis completed. ${metricDiffs.join(". ")}.`
      : recentInsightsChanged && !quickAccessChanged && !syncHealthChanged
      ? "Analysis completed. Recent insights were updated."
      : quickAccessChanged && !recentInsightsChanged && !kpiChanged
      ? "Analysis completed. Feature readiness was updated."
      : syncHealthChanged && !recentInsightsChanged && !quickAccessChanged && !kpiChanged
      ? "Analysis completed. Store connection was rechecked."
      : visibleDataChanged
      ? `Analysis completed${refreshStatus === "partial" ? " with partial updates" : ""}. Updated ${changedSections
          .filter((section) => section !== "Last refreshed")
          .join(", ")}.${unchangedModuleNames.length > 0 ? ` ${unchangedModuleNames.join(" and ")} remained unchanged.` : ""}`
      // THE CONTRADICTION THIS REMOVES.
      //
      // This said "Everything looks healthy right now" whenever no KPI number
      // had changed since the last refresh — a question about DIFFS, not about
      // whether the checks ran. A store whose product sync delivered nothing
      // showed it while Pricing said it had no products and Action Center
      // correctly reported that three checks could not be evaluated.
      //
      // The backend verdict is authoritative. The diff-based wording survives
      // only for the case where something genuinely changed.
      : canonicalHealth
      ? `Analysis completed. ${canonicalHealth.headline}`
      : `Analysis completed${refreshStatus === "partial" ? " with partial updates" : ""}. No changes were detected.`;
  // Only offered when the canonical verdict actually IS healthy. Previously
  // this asserted health from the sync's own no-change reasons, which know
  // nothing about whether a module could run.
  const noChangeExplanation =
    canonicalHealth?.health === "HEALTHY" &&
    !kpiChanged &&
    activitySummary?.noChangeReasons?.length
      ? `Nothing changed because ${activitySummary.noChangeReasons.join(", ")}.`
      : canonicalHealth && canonicalHealth.detail.length > 0
      ? canonicalHealth.detail[0]
      : null;

  return {
    startedAt: args.job?.startedAt ?? new Date().toISOString(),
    finishedAt: args.job?.finishedAt ?? new Date().toISOString(),
    refreshStatus,
    visibleDataChanged,
    changedSections,
    unchangedSections,
    lastRefreshedAt: nextSnapshot.lastRefreshedAt ?? args.job?.finishedAt ?? new Date().toISOString(),
    moduleRefreshResults: {
      fraud:
        refreshStatus === "failure"
          ? "failed"
          : activitySummary?.moduleProcessing?.fraud
          ? normalizeModuleRefreshStatus(activitySummary.moduleProcessing.fraud.status)
          : fraudChanged
          ? "updated"
          : "unchanged",
      competitor:
        refreshStatus === "failure"
          ? "failed"
          : activitySummary?.moduleProcessing?.competitor
          ? normalizeModuleRefreshStatus(activitySummary.moduleProcessing.competitor.status)
          : competitorChanged
          ? "updated"
          : "unchanged",
      pricing:
        refreshStatus === "failure"
          ? "failed"
          : activitySummary?.moduleProcessing?.pricing
          ? normalizeModuleRefreshStatus(activitySummary.moduleProcessing.pricing.status)
          : pricingChanged
          ? "updated"
          : "unchanged",
    },
    activitySummary,
    noChangeExplanation,
    previousSnapshot,
    nextSnapshot,
    summary,
  };
}

export function DashboardPage() {
  const { navigateEmbedded } = useEmbeddedNavigation();
  // Canonical billing/trial state, shared with Onboarding and Billing.
  const { appState } = useAppState();
  const { host, shop } = useAppBridge();
  const cachedDashboard = useMemo(
    () => withheldFindings(readModuleCache<DashboardPayload>("dashboard-overview") ?? null),
    []
  );
  const { subscription } = useSubscriptionPlan();
  const { onboarding, refresh: refreshOnboarding } = useOnboardingState();
  const [metrics, setMetrics] = useState<Metrics | null>(cachedDashboard?.metrics ?? null);
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(
    cachedDashboard?.diagnostics ?? null
  );
  const [loading, setLoading] = useState(!cachedDashboard?.metrics);
  const [syncing, setSyncing] = useState(false);
  const [registeringWebhooks, setRegisteringWebhooks] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshResult, setRefreshResult] = useState<DashboardRefreshResult | null>(
    null
  );
  const cachedDashboardRef = useRef<DashboardPayload | null>(cachedDashboard);
  const diagnosticsRef = useRef<Diagnostics | null>(cachedDashboard?.diagnostics ?? null);

  useEffect(() => {
    diagnosticsRef.current = diagnostics;
  }, [diagnostics]);

  const fallbackReauthorizeUrl = shop
    ? `/auth/reconnect?shop=${encodeURIComponent(shop)}${
        host ? `&host=${encodeURIComponent(host)}` : ""
      }&returnTo=${encodeURIComponent("/app/dashboard")}`
    : null;

  const fetchDashboardMetrics = useCallback(
    async () =>
      embeddedShopRequest<Metrics>("/api/dashboard/metrics", { timeoutMs: 20000 }),
    []
  );

  const fetchDashboardDiagnostics = useCallback(
    async () =>
      embeddedShopRequest<Diagnostics>("/api/shopify/diagnostics", {
        timeoutMs: 12000,
      }),
    []
  );

  const loadDashboard = useCallback(
    async (options?: { includeDiagnostics?: boolean }): Promise<DashboardPayload> => {
      const metricsResponse = await fetchDashboardMetrics();
      const diagnosticsResponse =
        options?.includeDiagnostics === false
          ? diagnosticsRef.current ?? cachedDashboardRef.current?.diagnostics ?? null
          : await fetchDashboardDiagnostics().catch(
              () => diagnosticsRef.current ?? cachedDashboardRef.current?.diagnostics ?? null
            );

      return {
        metrics: metricsResponse,
        diagnostics: diagnosticsResponse,
      };
    },
    [fetchDashboardDiagnostics, fetchDashboardMetrics]
  );

  const applyDashboardPayload = useCallback((payload: DashboardPayload) => {
    setMetrics((current) => (equalJson(current, payload.metrics) ? current : payload.metrics));
    if (payload.diagnostics) {
      diagnosticsRef.current = payload.diagnostics;
      setDiagnostics((current) =>
        equalJson(current, payload.diagnostics) ? current : payload.diagnostics
      );
    }
    const nextCachedPayload = {
      metrics: payload.metrics,
      diagnostics: payload.diagnostics ?? diagnosticsRef.current ?? null,
    };
    cachedDashboardRef.current = nextCachedPayload;
    writeModuleCache("dashboard-overview", {
      metrics: nextCachedPayload.metrics,
      diagnostics: nextCachedPayload.diagnostics,
    });
    setError(null);
  }, []);

  const loadVerifiedDashboardPayload = useCallback(
    async (
      previous: DashboardPayload | null,
      job: SyncJobResponse["result"]
    ): Promise<DashboardPayload> => {
      const previousSnapshot = buildDashboardSnapshot(previous);
      const previousRefreshTime = parseTimestamp(
        previous?.metrics.lastRefreshedAt ?? null
      );
      const jobFinishedAt = parseTimestamp(job?.finishedAt ?? null);

      for (let attempt = 0; attempt < 8; attempt += 1) {
        const nextPayload = await loadDashboard({ includeDiagnostics: false });
        const nextSnapshot = buildDashboardSnapshot(nextPayload);
        const nextRefreshTime = parseTimestamp(
          nextPayload.metrics.lastRefreshedAt ?? null
        );

        const hasFreshTimestamp =
          (jobFinishedAt != null &&
            nextRefreshTime != null &&
            nextRefreshTime >= jobFinishedAt) ||
          (previousRefreshTime != null &&
            nextRefreshTime != null &&
            nextRefreshTime > previousRefreshTime);

        const snapshotChanged = hasSnapshotChanged(previousSnapshot, nextSnapshot);

        if (hasFreshTimestamp || snapshotChanged || attempt === 7) {
          return nextPayload;
        }

        await wait(1500);
      }

      return loadDashboard({ includeDiagnostics: false });
    },
    [loadDashboard]
  );

  useEffect(() => {
    let mounted = true;
    if (!cachedDashboardRef.current?.metrics) {
      setLoading(true);
    }

    fetchDashboardMetrics()
      .then((metricsResponse) => {
        if (!mounted) return;
        const basePayload = {
          metrics: metricsResponse,
          diagnostics: diagnosticsRef.current ?? cachedDashboardRef.current?.diagnostics ?? null,
        };
        applyDashboardPayload(basePayload);
        setLoading(false);

        return fetchDashboardDiagnostics()
          .then((diagnosticsResponse) => {
            if (!mounted) return;
            applyDashboardPayload({
              metrics: metricsResponse,
              diagnostics: diagnosticsResponse,
            });
          })
          .catch(() => undefined);
      })
      .catch((nextError) => {
        if (!mounted) return;
        setError(
          nextError instanceof Error
            ? nextError.message
            : "Unable to load Store Overview."
        );
        setLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, [
    applyDashboardPayload,
    fetchDashboardDiagnostics,
    fetchDashboardMetrics,
  ]);

  const pollSyncJob = useCallback(
    async (jobId?: string | null) => {
      const startedAt = Date.now();

      while (Date.now() - startedAt < 180000) {
        const response = await embeddedShopRequest<SyncJobResponse>(
          "/api/shopify/sync-jobs/latest",
          { timeoutMs: 15000 }
        );
        const latestJob = response.result;
        if (!latestJob) {
          await new Promise((resolve) => setTimeout(resolve, 1500));
          continue;
        }

        const latestJobId = latestJob.id ?? latestJob.jobId;
        if (jobId && latestJobId && latestJobId !== jobId) {
          await new Promise((resolve) => setTimeout(resolve, 1500));
          continue;
        }

        if (
          latestJob.status === "READY_WITH_DATA" ||
          latestJob.status === "SUCCEEDED_NO_DATA" ||
          latestJob.status === "SUCCEEDED_PROCESSING_PENDING"
        ) {
          const previousPayload =
            metrics && diagnostics
              ? {
                  metrics,
                  diagnostics,
                }
              : null;
          const nextPayload = await loadVerifiedDashboardPayload(
            previousPayload,
            latestJob
          );
          applyDashboardPayload(nextPayload);
          await refreshOnboarding();
          const nextRefreshResult = deriveRefreshResult({
            previous: previousPayload,
            next: nextPayload,
            job: latestJob,
          });
          setRefreshResult(nextRefreshResult);
          setToast(nextRefreshResult.summary);
          return;
        }

        if (latestJob.status === "FAILED") {
          throw new Error(latestJob.errorMessage ?? "Sync failed.");
        }

        await new Promise((resolve) => setTimeout(resolve, 1500));
      }

      throw new Error("Sync is still running. Check back in a moment.");
    },
    [
      applyDashboardPayload,
      diagnostics,
      loadVerifiedDashboardPayload,
      metrics,
      refreshOnboarding,
    ]
  );

  const dashboardState = metrics?.dashboardState ?? null;
  const dashboardLastRefreshedAt =
    dashboardState?.refreshedAt ?? metrics?.lastRefreshedAt ?? null;
  const dashboardSyncHealth = dashboardState?.syncHealth ?? null;
  const dashboardRecentInsights =
    dashboardState?.recentInsights ?? metrics?.recentInsights ?? [];
  const dashboardQuickAccess = dashboardState?.quickAccess ?? null;
  const fraudQuickAccessDisplay = deriveQuickAccessDisplay({
    baseStatus: dashboardQuickAccess?.fraud.status,
    baseReason: dashboardQuickAccess?.fraud.reason,
    baseFreshnessAt: dashboardQuickAccess?.fraud.freshnessAt,
    processing: refreshResult?.activitySummary?.moduleProcessing?.fraud ?? null,
  });
  const competitorQuickAccessDisplay = deriveQuickAccessDisplay({
    baseStatus: dashboardQuickAccess?.competitor.status,
    baseReason: dashboardQuickAccess?.competitor.reason,
    baseFreshnessAt: dashboardQuickAccess?.competitor.freshnessAt,
    processing: refreshResult?.activitySummary?.moduleProcessing?.competitor ?? null,
  });
  const pricingQuickAccessDisplay = deriveQuickAccessDisplay({
    baseStatus: dashboardQuickAccess?.pricing.status,
    baseReason: dashboardQuickAccess?.pricing.reason,
    baseFreshnessAt: dashboardQuickAccess?.pricing.freshnessAt,
    processing: refreshResult?.activitySummary?.moduleProcessing?.pricing ?? null,
  });

  const syncLiveStoreData = useCallback(async () => {
    setSyncing(true);
    setError(null);
    setRefreshResult(null);
    // Toast/error banners render near the top of the page or bottom of the
    // frame — invisible without scrolling back up if the dashboard was
    // scrolled down when this was triggered.
    window.scrollTo({ top: 0, behavior: "smooth" });
    const startedAt = new Date().toISOString();
    try {
      const response = await embeddedShopRequest<SyncJobResponse>("/api/shopify/sync", {
        method: "POST",
        body: {
          host,
          returnTo: "/app/dashboard",
        },
        timeoutMs: 20000,
      });
      await pollSyncJob(response.result?.jobId ?? response.result?.id ?? null);
    } catch (nextError) {
      setError(
        nextError instanceof Error
          ? nextError.message
          : "Unable to sync Shopify data right now."
      );
      setRefreshResult({
        startedAt,
        finishedAt: new Date().toISOString(),
        refreshStatus: "failure",
        visibleDataChanged: false,
        changedSections: [],
        unchangedSections: ["KPI cards", "Recent insights", "Quick access", "Sync health"],
        lastRefreshedAt: dashboardLastRefreshedAt,
        moduleRefreshResults: {
          fraud: "failed",
          competitor: "failed",
          pricing: "failed",
        },
        activitySummary: null,
        noChangeExplanation: null,
        previousSnapshot: buildDashboardSnapshot(
          metrics && diagnostics ? { metrics, diagnostics } : null
        ),
        nextSnapshot:
          buildDashboardSnapshot(
            metrics && diagnostics ? { metrics, diagnostics } : null
          ) ?? {
            kpis: {
              storeHealth: 0,
              fraudAlerts: 0,
              competitorChanges: 0,
              pricingOpportunities: 0,
              profitOpportunities: 0,
              reconciliation: 0,
            },
            recentInsightKeys: [],
            quickAccess: {
              fraud: null,
              competitor: null,
              pricing: null,
            },
            syncHealth: {
              status: null,
              title: null,
              reason: null,
            },
            lastRefreshedAt: dashboardLastRefreshedAt,
          },
        summary: "Refresh failed. Retry the sync to update Store Overview.",
      });
    } finally {
      setSyncing(false);
    }
  }, [dashboardLastRefreshedAt, diagnostics, host, metrics, pollSyncJob]);

  const registerWebhooks = useCallback(async () => {
    setRegisteringWebhooks(true);
    setError(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
    try {
      await embeddedShopRequest("/api/shopify/register-webhooks", {
        method: "POST",
        body: {
          host,
          returnTo: "/app/dashboard",
        },
        timeoutMs: 90000,
      });
      const nextPayload = await loadDashboard();
      applyDashboardPayload(nextPayload);
      setToast("Shopify connection verified successfully.");
    } catch (nextError) {
      setError(
        nextError instanceof Error
          ? nextError.message
          : "Unable to verify the Shopify connection."
      );
    } finally {
      setRegisteringWebhooks(false);
    }
  }, [applyDashboardPayload, host, loadDashboard]);

  const dashboardFindings = dashboardState?.findings ?? null;
  // When findings are not being recorded, the counts are all zero but say
  // nothing about the store. A "0" would be read as "no problems found", which
  // is a claim VedaSuite has not earned, so the tiles show a dash instead.
  //
  // The same reasoning applies to a count restored from the session cache: on
  // screen it is indistinguishable from a current one. A reconciliation run
  // happens on another page and creates findings without a sync, so the cached
  // payload could be minutes out of date while Action Center — which has no
  // cache — showed the new findings. `withheldFindings` marks a cache-seeded
  // payload unavailable, so the tiles read "—" until the live fetch lands
  // rather than presenting a stale number as the state of the store.
  const findingsAvailable = dashboardFindings ? dashboardFindings.available : true;
  const kpiValue = (n: number) => (findingsAvailable ? n : "—");

  const metricsCards = useMemo(
    () => [
      {
        title: "Store health",
        value: kpiValue(dashboardState?.kpis.storeHealth ?? 0),
        note: "Connection and sync issues",
      },
      {
        title: "Customer Loss",
        value: kpiValue(dashboardState?.kpis.fraudAlerts ?? 0),
        note: "Open refund-abuse and risky-order findings",
      },
      {
        title: "Market Signals",
        value: kpiValue(dashboardState?.kpis.competitorChanges ?? 0),
        note: "Open findings from monitored competitors",
      },
      {
        title: "Pricing opportunities",
        value: kpiValue(dashboardState?.kpis.pricingOpportunities ?? 0),
        note: "Open pricing findings to review",
      },
      {
        title: "Profit opportunities",
        value: kpiValue(dashboardState?.kpis.profitOpportunities ?? 0),
        note: "Open product-profit findings",
      },
      {
        // Without this tile a reconciliation finding was counted in the total
        // but shown on no tile, so the Dashboard read as zero while the
        // Reconciliation workspace read as one.
        title: "Reconciliation",
        value: kpiValue(dashboardState?.kpis.reconciliation ?? 0),
        note: "Open inventory, invoice and shipment mismatches",
      },
    ],
    [dashboardState, metrics, findingsAvailable]
  );
  const currentRefreshSummary =
    syncing
      ? "Refreshing Store Overview and checking for updated findings."
      : refreshResult?.summary ??
    (dashboardLastRefreshedAt
      ? `Refreshed at ${formatRelativeTimestamp(dashboardLastRefreshedAt)}.`
      : "Refresh Store Overview to pull the latest Shopify data.");

  const syncHealthLabel =
    dashboardSyncHealth?.status
      ? labelForReadiness(dashboardSyncHealth.status)
      : diagnostics?.sync.syncHealth?.status
      ? labelForReadiness(diagnostics.sync.syncHealth.status)
      : labelForReadiness(metrics?.dataState);
  const syncHealthTone =
    dashboardSyncHealth?.status
      ? toneForReadiness(dashboardSyncHealth.status)
      : diagnostics?.sync.syncHealth?.status
      ? toneForReadiness(diagnostics.sync.syncHealth.status)
      : toneForReadiness(metrics?.dataState);
  const showSyncHealthBanner = dashboardSyncHealth?.status
    ? dashboardSyncHealth.status !== "READY_WITH_DATA"
    : metrics?.dataState !== "READY_WITH_DATA";

  if (loading) {
    return (
      <Page title="Store Overview" subtitle="Loading store metrics and findings.">
        <Card>
          <InlineStack align="center">
            <Spinner accessibilityLabel="Loading Store Overview" size="large" />
          </InlineStack>
        </Card>
      </Page>
    );
  }

  return (
    // fullWidth reclaims the ~31% of viewport Polaris's default page cap left
    // unused on desktop, letting the KPI grids run wider and cutting the
    // dashboard's vertical scroll. `.veda-page-wide` re-caps it at 1400px so
    // ultrawide screens don't get uncomfortably long line lengths.
    <div className="veda-page-wide">
      <Page
        fullWidth
        title="Store Overview"
        subtitle="A summary of the open findings in your Action Center, plus store health and direct access to each workspace."
        primaryAction={{
          content: "Update insights",
          onAction: () => void syncLiveStoreData(),
          loading: syncing,
          disabled: syncing,
        }}
      >
        <Layout>
        {/* Compact plan-selected trial status, from the same canonical
            appState.billing.trialActive flag used by Onboarding and Billing.
            Before any plan is approved, trialActive is false and the
            choose-a-plan prompt renders instead — never a claim that
            anything is unlocked before a plan starts. */}
        {appState?.billing?.trialActive ? (
          <Layout.Section>
            <TrialStatusBanner
              data={{
                trialActive: true,
                trialEndsAt: appState.billing.trialEndsAt ?? null,
                planName: appState.billing.planName ?? null,
              }}
              onViewBilling={() => navigateEmbedded("/app/billing")}
            />
          </Layout.Section>
        ) : (appState?.billing?.planName ?? "NONE") === "NONE" ? (
          <Layout.Section>
            <ChoosePlanBanner
              onChoosePlan={() => navigateEmbedded("/app/billing")}
              // Server-resolved eligibility only — see ChoosePlanCard.
              trialEligible={appState?.billing?.trialEligible}
            />
          </Layout.Section>
        ) : null}

        {error ? (
          <Layout.Section>
            <Banner title="Store Overview action failed" tone="critical">
              <p>{error}</p>
            </Banner>
          </Layout.Section>
        ) : null}

        {onboarding && !onboarding.canAccessDashboard ? (
          <Layout.Section>
            <Banner title="Store Overview available after onboarding" tone="info">
              <BlockStack gap="200">
                <p>
                  VedaSuite is still preparing this store. The view below stays simple until connection, billing, and the first workflow are ready.
                </p>
                <InlineStack gap="300">
                  <Button variant="primary" onClick={() => navigateEmbedded("/app/onboarding")}>
                    Return to onboarding
                  </Button>
                </InlineStack>
              </BlockStack>
            </Banner>
          </Layout.Section>
        ) : null}

        {diagnostics && !diagnostics.connection.healthy ? (
          <Layout.Section>
            <Banner title="Shopify connection needs attention" tone="critical">
              <BlockStack gap="200">
                <p>{diagnostics.connection.message}</p>
                <InlineStack gap="300">
                  <Button
                    variant="primary"
                    url={
                      diagnostics.connection.reauthorizeUrl ??
                      fallbackReauthorizeUrl ??
                      "/auth"
                    }
                    target="_top"
                  >
                    Reconnect Shopify
                  </Button>
                </InlineStack>
              </BlockStack>
            </Banner>
          </Layout.Section>
        ) : diagnostics && diagnostics.connection.healthy && !diagnostics.connection.webhookCoverageReady ? (
          <Layout.Section>
            <Banner title="Finishing Shopify setup" tone="info">
              <BlockStack gap="200">
                <p>
                  Your Shopify connection is working. VedaSuite is still
                  registering background sync webhooks — this usually
                  finishes on its own within a minute of install.
                </p>
                <InlineStack gap="300">
                  <Button onClick={() => void registerWebhooks()} loading={registeringWebhooks}>
                    Finish setup now
                  </Button>
                </InlineStack>
              </BlockStack>
            </Banner>
          </Layout.Section>
        ) : null}

        {showSyncHealthBanner ? (
          <Layout.Section>
            {/*
              `metrics?.` throughout, not `metrics.`.
              This block is reached whenever showSyncHealthBanner is true, and
              that flag is true when metrics is NULL: it falls through to
              `metrics?.dataState !== "READY_WITH_DATA"`, and undefined is not
              READY_WITH_DATA. The only early return on this page is for
              `loading`, so a failed metrics fetch left metrics null, loading
              false, and this banner rendering — where `metrics.summaryTitle`
              threw and white-screened the page into the route error boundary.
              The page already has an honest error banner above; it never got
              the chance to show it.
            */}
            <Banner
              title={
                dashboardSyncHealth?.title ??
                metrics?.summaryTitle ??
                "Store Overview is still settling"
              }
              tone={bannerToneForReadiness(dashboardSyncHealth?.status ?? metrics?.dataState)}
            >
              <BlockStack gap="200">
                <p>
                  {dashboardSyncHealth?.reason ??
                    metrics?.summaryDetail ??
                    "VedaSuite is still preparing this store."}
                </p>
                <InlineStack gap="300">
                  <Button variant="primary" onClick={() => void syncLiveStoreData()} loading={syncing}>
                    Update insights
                  </Button>
                  {!diagnostics?.webhooks.liveStatus ||
                  diagnostics.webhooks.liveStatus.registeredCount <
                    diagnostics.webhooks.liveStatus.totalTracked ? (
                    <Button onClick={() => void registerWebhooks()} loading={registeringWebhooks}>
                      Fix Shopify connection
                    </Button>
                  ) : null}
                </InlineStack>
              </BlockStack>
            </Banner>
          </Layout.Section>
        ) : null}

        {/* Phase 1 explainability — additive sections in the required order
            (Executive Summary → Where to focus → Critical attention → Revenue
            Leak → Data coverage), rendered above the existing metric cards.
            Existing dashboard functionality below is unchanged. */}
        <InsightsDashboardSections />

        <Layout.Section>
          <Card>
            <InlineGrid columns={{ xs: 1, md: 3 }} gap="300">
              <BlockStack gap="100">
                <Text as="p" variant="bodySm" tone="subdued">
                  Last updated
                </Text>
                <Text as="p" variant="headingMd">
                  {dashboardLastRefreshedAt
                    ? formatRelativeTimestamp(dashboardLastRefreshedAt)
                    : "Ready after first analysis"}
                </Text>
              </BlockStack>
              <BlockStack gap="100">
                <Text as="p" variant="bodySm" tone="subdued">
                  Sync health
                </Text>
                <InlineStack gap="200" blockAlign="center">
                  <Badge tone={syncHealthTone}>{syncHealthLabel}</Badge>
                  <Text as="p" tone="subdued">
                    {dashboardSyncHealth?.reason ??
                      diagnostics?.sync.syncHealth?.reason ??
                      metrics?.summaryDetail}
                  </Text>
                </InlineStack>
              </BlockStack>
              <BlockStack gap="100">
                <Text as="p" variant="bodySm" tone="subdued">
                  Refresh result
                </Text>
                <Text as="p">{currentRefreshSummary}</Text>
              </BlockStack>
            </InlineGrid>
          </Card>
        </Layout.Section>

        {refreshResult ? (
          <Layout.Section>
            <Banner
              title={
                refreshResult.refreshStatus === "success"
                  ? "Store analysis completed"
                  : refreshResult.refreshStatus === "partial"
                  ? "Store analysis completed with partial updates"
                  : "Store analysis needs attention"
              }
              tone={
                refreshResult.refreshStatus === "success"
                  ? "success"
                  : refreshResult.refreshStatus === "partial"
                  ? "warning"
                  : "critical"
              }
            >
              <BlockStack gap="200">
                <p>{refreshResult.summary}</p>
                {refreshResult.activitySummary ? (
                  <BlockStack gap="100">
                    <Text as="p" variant="bodySm" tone="subdued">
                      Refresh activity
                    </Text>
                    <List type="bullet">
                      <List.Item>
                        {refreshResult.activitySummary.ordersProcessed} orders processed
                      </List.Item>
                      <List.Item>
                        {refreshResult.activitySummary.customersEvaluated} customers evaluated
                      </List.Item>
                      {/*
                        Competitor analysis does not run inside this sync — it
                        is driven from Market Signals. Printing "0 competitor
                        pages reviewed" reported a measurement of zero for work
                        that was never attempted, which reads as "we looked and
                        found nothing".
                      */}
                      <List.Item>
                        {refreshResult.activitySummary.moduleProcessing?.competitor
                          ?.processed
                          ? `${refreshResult.activitySummary.competitorPagesChecked} competitor pages reviewed`
                          : "Competitor pages: not part of this update"}
                      </List.Item>
                      <List.Item>
                        {refreshResult.activitySummary.pricingRecordsAnalyzed} pricing records analyzed
                      </List.Item>
                      {/*
                        Only newly created timeline events are counted; there is
                        no "updated" count behind updatedInsightsCount, so the
                        label says added rather than implying both.
                      */}
                      <List.Item>
                        {refreshResult.activitySummary.newInsightsCount +
                          refreshResult.activitySummary.updatedInsightsCount}{" "}
                        insights added
                      </List.Item>
                      <List.Item>
                        {refreshResult.visibleDataChanged
                          ? "New findings are ready."
                          : refreshResult.summary}
                      </List.Item>
                    </List>
                  </BlockStack>
                ) : null}
                {refreshResult.noChangeExplanation ? (
                  <Text as="p" variant="bodySm" tone="subdued">
                    {refreshResult.noChangeExplanation}
                  </Text>
                ) : null}
                <InlineStack gap="300">
                  <Text as="p" variant="bodySm" tone="subdued">
                    Fraud: {labelForQuickAccessStatus(refreshResult.moduleRefreshResults.fraud)}
                  </Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    Competitor: {labelForQuickAccessStatus(refreshResult.moduleRefreshResults.competitor)}
                  </Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    Pricing: {labelForQuickAccessStatus(refreshResult.moduleRefreshResults.pricing)}
                  </Text>
                </InlineStack>
              </BlockStack>
            </Banner>
          </Layout.Section>
        ) : null}

        {/*
          PHASE F. One statement of what needs attention, derived from the same
          open findings Action Center shows — so this band and that page can
          never disagree, and every tile below it is a breakdown of this number.
        */}
        {!syncing && dashboardFindings ? (
          <Layout.Section>
            <Banner
              title={dashboardFindings.attentionTitle}
              tone={
                !dashboardFindings.available
                  ? "warning"
                  : dashboardFindings.bySeverity.critical > 0
                  ? "critical"
                  : dashboardFindings.totalOpen > 0
                  ? "info"
                  : "success"
              }
              action={
                dashboardFindings.available && dashboardFindings.totalOpen > 0
                  ? {
                      content: "Open Action Center",
                      onAction: () => navigateEmbedded(dashboardFindings.route),
                    }
                  : undefined
              }
            >
              <p>
                {dashboardFindings.unavailableReason ??
                  dashboardFindings.attentionDetail}
              </p>
            </Banner>
          </Layout.Section>
        ) : null}

        <Layout.Section>
          {/*
            Six tiles, each previously carrying an explanatory sentence: six
            sentences of chrome above the findings the merchant came for. The
            number is the fact; the sentence explains what it counts, which is
            worth reading once, not on every visit. It moves into a tooltip on
            the label, and a dot marks the tiles that are non-zero so the eye
            lands on them without reading a digit.
          */}
          <InlineGrid columns={{ xs: 2, sm: 3, md: 6 }} gap="300">
            {syncing
              ? metricsCards.map((item) => (
                  <Card key={item.title}>
                    <BlockStack gap="150">
                      <Text as="p" variant="bodySm" tone="subdued">
                        {item.title}
                      </Text>
                      <SkeletonDisplayText size="medium" />
                    </BlockStack>
                  </Card>
                ))
              : metricsCards.map((item) => (
                  <Card key={item.title}>
                    <div className="vs-kpi">
                      <BlockStack gap="100">
                        <Tooltip content={item.note} dismissOnMouseOut>
                          <span className="vs-kpi__label">{item.title}</span>
                        </Tooltip>
                        <InlineStack gap="150" blockAlign="center" wrap={false}>
                          <Text as="p" variant="heading2xl">
                            {item.value}
                          </Text>
                          {typeof item.value === "number" && item.value > 0 ? (
                            <span
                              className="vs-kpi__dot"
                              aria-label="Needs attention"
                              role="img"
                            />
                          ) : null}
                        </InlineStack>
                      </BlockStack>
                    </div>
                  </Card>
                ))}
          </InlineGrid>
        </Layout.Section>

        <Layout.Section>
          <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingLg">
                    Top findings
                  </Text>
                  <Badge tone={toneForReadiness(metrics?.dataState)}>
                    {labelForReadiness(metrics?.dataState)}
                  </Badge>
                </InlineStack>
                <BlockStack gap="300">
                  {syncing ? (
                    <Card>
                      <BlockStack gap="300">
                        <SkeletonBodyText lines={3} />
                        <SkeletonBodyText lines={3} />
                      </BlockStack>
                    </Card>
                  ) : dashboardRecentInsights.length > 0 ? (
                    dashboardRecentInsights.map((insight) => (
                      <div key={insight.id} className="vs-action-card">
                        <InlineStack align="space-between" blockAlign="start" gap="300">
                          <BlockStack gap="100">
                            <InlineStack gap="200" blockAlign="center">
                              <Text as="h3" variant="headingMd">
                                {insight.title}
                              </Text>
                              <Badge tone={insight.severity === "critical" ? "critical" : "info"}>
                                {insight.severity}
                              </Badge>
                            </InlineStack>
                            <Text as="p" tone="subdued">
                              {insight.detail}
                            </Text>
                            <Text as="p" variant="bodySm" tone="subdued">
                              {formatRelativeTimestamp(insight.createdAt)}
                            </Text>
                          </BlockStack>
                          <Button onClick={() => navigateEmbedded(insight.route)}>
                            Open
                          </Button>
                        </InlineStack>
                      </div>
                    ))
                  ) : !findingsAvailable ? (
                    // Not the same as "nothing is wrong". Saying so would be a
                    // claim about the store that VedaSuite cannot currently make.
                    <Banner title="Findings are not available" tone="warning">
                      <p>
                        {dashboardFindings?.unavailableReason ??
                          "VedaSuite cannot show findings for this store right now."}
                      </p>
                    </Banner>
                  ) : (
                    <Banner title="Nothing needs your attention right now" tone="success">
                      <p>
                        VedaSuite found no open findings for this store. This is a
                        real result, not a loading state.
                      </p>
                    </Banner>
                  )}
                </BlockStack>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingLg">
                  Quick access
                </Text>
                <BlockStack gap="300">
                  <div className="vs-action-card">
                    <InlineStack align="space-between" blockAlign="start" gap="300">
                      <BlockStack gap="100">
                        <Text as="h3" variant="headingMd">
                          Customer Loss
                        </Text>
                        <Text as="p" tone="subdued">
                          {fraudQuickAccessDisplay.reason ??
                            metrics?.moduleStates?.fraud?.description ??
                            "Review risky orders, refund abuse, and trust signals."}
                        </Text>
                        <Badge
                          tone={
                            fraudQuickAccessDisplay.status
                              ? toneForQuickAccessStatus(fraudQuickAccessDisplay.status)
                              : metrics?.moduleStates?.fraud?.dataStatus
                              ? toneForDataStatus(metrics.moduleStates.fraud.dataStatus)
                              : toneForReadiness(metrics?.moduleReadiness?.trustAbuse?.readinessState)
                          }
                        >
                          {fraudQuickAccessDisplay.status
                            ? labelForQuickAccessStatus(fraudQuickAccessDisplay.status)
                            : metrics?.moduleStates?.fraud?.dataStatus
                            ? labelForDataStatus(metrics.moduleStates.fraud.dataStatus)
                            : labelForReadiness(metrics?.moduleReadiness?.trustAbuse?.readinessState)}
                        </Badge>
                        {fraudQuickAccessDisplay.freshnessAt ? (
                          <Text as="p" variant="bodySm" tone="subdued">
                            Last updated: {formatRelativeTimestamp(fraudQuickAccessDisplay.freshnessAt)}
                          </Text>
                        ) : null}
                      </BlockStack>
                      <Button onClick={() => navigateEmbedded("/app/fraud-intelligence")}>
                        Open
                      </Button>
                    </InlineStack>
                  </div>

                  <div className="vs-action-card">
                    <InlineStack align="space-between" blockAlign="start" gap="300">
                      <BlockStack gap="100">
                        <Text as="h3" variant="headingMd">
                          Market Signals
                        </Text>
                        <Text as="p" tone="subdued">
                          {competitorQuickAccessDisplay.reason ??
                            metrics?.moduleStates?.competitor?.description ??
                            "Review competitor pricing, promotions, and market moves."}
                        </Text>
                        <Badge
                          tone={
                            competitorQuickAccessDisplay.status
                              ? toneForQuickAccessStatus(competitorQuickAccessDisplay.status)
                              : metrics?.moduleStates?.competitor?.dataStatus
                              ? toneForDataStatus(metrics.moduleStates.competitor.dataStatus)
                              : toneForReadiness(metrics?.moduleReadiness?.competitor?.readinessState)
                          }
                        >
                          {competitorQuickAccessDisplay.status
                            ? labelForQuickAccessStatus(competitorQuickAccessDisplay.status)
                            : metrics?.moduleStates?.competitor?.dataStatus
                            ? labelForDataStatus(metrics.moduleStates.competitor.dataStatus)
                            : labelForReadiness(metrics?.moduleReadiness?.competitor?.readinessState)}
                        </Badge>
                        {competitorQuickAccessDisplay.freshnessAt ? (
                          <Text as="p" variant="bodySm" tone="subdued">
                            Last updated: {formatRelativeTimestamp(competitorQuickAccessDisplay.freshnessAt)}
                          </Text>
                        ) : null}
                      </BlockStack>
                      <Button onClick={() => navigateEmbedded("/app/competitor-intelligence")}>
                        Open
                      </Button>
                    </InlineStack>
                  </div>

                  <div className="vs-action-card">
                    <InlineStack align="space-between" blockAlign="start" gap="300">
                      <BlockStack gap="100">
                        <Text as="h3" variant="headingMd">
                          Pricing & Product Profit
                        </Text>
                        <Text as="p" tone="subdued">
                          {pricingQuickAccessDisplay.reason ??
                            metrics?.moduleStates?.pricing?.description ??
                            "Review pricing opportunities and profit optimization records."}
                        </Text>
                        <Badge
                          tone={
                            pricingQuickAccessDisplay.status
                              ? toneForQuickAccessStatus(pricingQuickAccessDisplay.status)
                              : metrics?.moduleStates?.pricing?.dataStatus
                              ? toneForDataStatus(metrics.moduleStates.pricing.dataStatus)
                              : toneForReadiness(metrics?.moduleReadiness?.pricingProfit?.readinessState)
                          }
                        >
                          {pricingQuickAccessDisplay.status
                            ? labelForQuickAccessStatus(pricingQuickAccessDisplay.status)
                            : metrics?.moduleStates?.pricing?.dataStatus
                            ? labelForDataStatus(metrics.moduleStates.pricing.dataStatus)
                            : labelForReadiness(metrics?.moduleReadiness?.pricingProfit?.readinessState)}
                        </Badge>
                        {pricingQuickAccessDisplay.freshnessAt ? (
                          <Text as="p" variant="bodySm" tone="subdued">
                            Last updated: {formatRelativeTimestamp(pricingQuickAccessDisplay.freshnessAt)}
                          </Text>
                        ) : null}
                      </BlockStack>
                      <Button
                        disabled={syncing}
                        onClick={() =>
                          navigateEmbedded(
                            subscription?.enabledModules?.pricingProfit
                              || subscription?.enabledModules?.pricing
                              ? "/app/ai-pricing-engine"
                              : "/app/billing"
                          )
                        }
                      >
                        {subscription?.enabledModules?.pricingProfit ||
                        subscription?.enabledModules?.pricing
                          ? "Open"
                          : "Upgrade to unlock"}
                      </Button>
                    </InlineStack>
                  </div>
                </BlockStack>
              </BlockStack>
            </Card>
          </InlineGrid>
          </Layout.Section>
        </Layout>
        {toast ? <Toast content={toast} onDismiss={() => setToast(null)} /> : null}
      </Page>
    </div>
  );
}

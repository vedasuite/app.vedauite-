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
} from "@shopify/polaris";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useEmbeddedNavigation } from "../../hooks/useEmbeddedNavigation";
import { embeddedShopRequest } from "../../lib/embeddedShopRequest";
import { readModuleCache, writeModuleCache } from "../../lib/moduleCache";
import { useAppBridge } from "../../shopifyAppBridge";
import { useSubscriptionPlan } from "../../hooks/useSubscriptionPlan";
import { useOnboardingState } from "../../hooks/useOnboardingState";

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
    fraudAlerts: number;
    competitorChanges: number;
    pricingOpportunities: number;
    profitOpportunities: number;
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

type Diagnostics = {
  connection: {
    healthy: boolean;
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
          fraud?: { processed: boolean; status: string; reason: string };
          competitor?: { processed: boolean; status: string; reason: string };
          pricing?: { processed: boolean; status: string; reason: string };
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

type DashboardVisibleSnapshot = {
  kpis: {
    fraudAlerts: number;
    competitorChanges: number;
    pricingOpportunities: number;
    profitOpportunities: number;
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
  processing?: SyncActivitySummary["moduleProcessing"][keyof SyncActivitySummary["moduleProcessing"]] | null;
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

function redirectTopLevel(url: string) {
  if (window.top && window.top !== window) {
    window.top.location.href = url;
    return;
  }
  window.location.href = url;
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

  const metricDiffs: string[] = [];
  if (
    !previousSnapshot ||
    previousSnapshot.kpis.fraudAlerts !== nextSnapshot.kpis.fraudAlerts
  ) {
    metricDiffs.push(
      `Fraud alerts changed from ${
        previousSnapshot?.kpis.fraudAlerts ?? 0
      } to ${nextSnapshot.kpis.fraudAlerts}`
    );
  }
  if (
    !previousSnapshot ||
    previousSnapshot.kpis.competitorChanges !==
      nextSnapshot.kpis.competitorChanges
  ) {
    metricDiffs.push(
      `Competitor changes changed from ${
        previousSnapshot?.kpis.competitorChanges ?? 0
      } to ${nextSnapshot.kpis.competitorChanges}`
    );
  }
  if (
    !previousSnapshot ||
    previousSnapshot.kpis.pricingOpportunities !==
      nextSnapshot.kpis.pricingOpportunities
  ) {
    metricDiffs.push(
      `Pricing opportunities changed from ${
        previousSnapshot?.kpis.pricingOpportunities ?? 0
      } to ${nextSnapshot.kpis.pricingOpportunities}`
    );
  }
  if (
    !previousSnapshot ||
    previousSnapshot.kpis.profitOpportunities !==
      nextSnapshot.kpis.profitOpportunities
  ) {
    metricDiffs.push(
      `Profit opportunities changed from ${
        previousSnapshot?.kpis.profitOpportunities ?? 0
      } to ${nextSnapshot.kpis.profitOpportunities}`
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
    !fraudChanged ? "Fraud" : null,
    !competitorChanged ? "Competitor" : null,
    !pricingChanged ? "Pricing" : null,
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
      : `Analysis completed${refreshStatus === "partial" ? " with partial updates" : ""}. Everything looks healthy right now.`;
  const noChangeExplanation =
    !kpiChanged && activitySummary?.noChangeReasons?.length
      ? `Everything looks healthy because ${activitySummary.noChangeReasons.join(", ")}.`
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
  const { host, shop } = useAppBridge();
  const cachedDashboard = useMemo(
    () => readModuleCache<DashboardPayload>("dashboard-overview") ?? null,
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
            : "Unable to load the dashboard."
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
              fraudAlerts: 0,
              competitorChanges: 0,
              pricingOpportunities: 0,
              profitOpportunities: 0,
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
        summary: "Refresh failed. Retry the sync to update dashboard signals.",
      });
    } finally {
      setSyncing(false);
    }
  }, [dashboardLastRefreshedAt, diagnostics, host, metrics, pollSyncJob]);

  const registerWebhooks = useCallback(async () => {
    setRegisteringWebhooks(true);
    setError(null);
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

  const metricsCards = useMemo(
    () => [
      {
        title: "Fraud alerts",
        value: dashboardState?.kpis.fraudAlerts ?? metrics?.fraudAlertsToday ?? 0,
        note: "Refund abuse and risky orders",
      },
      {
        title: "Competitor changes",
        value:
          dashboardState?.kpis.competitorChanges ??
          metrics?.competitorPriceChanges ??
          0,
        note: "Latest monitored price moves",
      },
      {
        title: "Pricing opportunities",
        value:
          dashboardState?.kpis.pricingOpportunities ??
          metrics?.aiPricingSuggestions ??
          0,
        note: "Pricing records ready to review",
      },
      {
        title: "Profit opportunities",
        value:
          dashboardState?.kpis.profitOpportunities ??
          metrics?.profitOptimizationOpportunities ??
          0,
        note: "Optimization records available",
      },
    ],
    [dashboardState, metrics]
  );
  const currentRefreshSummary =
    syncing
      ? "Refreshing dashboard data and checking for updated metrics."
      : refreshResult?.summary ??
    (dashboardLastRefreshedAt
      ? `Refreshed at ${formatRelativeTimestamp(dashboardLastRefreshedAt)}.`
      : "Refresh the dashboard to pull the latest Shopify data.");

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
      <Page title="Dashboard" subtitle="Loading store metrics and insights.">
        <Card>
          <InlineStack align="center">
            <Spinner accessibilityLabel="Loading dashboard" size="large" />
          </InlineStack>
        </Card>
      </Page>
    );
  }

  return (
    <Page
      title="Your store intelligence overview"
      subtitle="Key alerts, recommendations, and direct access to each VedaSuite workflow."
      primaryAction={{
        content: "Update insights",
        onAction: () => void syncLiveStoreData(),
        loading: syncing,
        disabled: syncing,
      }}
    >
      <Layout>
        {error ? (
          <Layout.Section>
            <Banner title="Dashboard action failed" tone="critical">
              <p>{error}</p>
            </Banner>
          </Layout.Section>
        ) : null}

        {onboarding && !onboarding.canAccessDashboard ? (
          <Layout.Section>
            <Banner title="Dashboard available after onboarding" tone="info">
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

        {!diagnostics?.connection.healthy ? (
          <Layout.Section>
            <Banner title="Shopify connection needs attention" tone="critical">
              <BlockStack gap="200">
                <p>{diagnostics?.connection.message}</p>
                <InlineStack gap="300">
                  <Button
                    variant="primary"
                    onClick={() =>
                      redirectTopLevel(
                        diagnostics?.connection.reauthorizeUrl ??
                          fallbackReauthorizeUrl ??
                          "/auth"
                      )
                    }
                  >
                    Reconnect Shopify
                  </Button>
                  <Button onClick={() => void registerWebhooks()} loading={registeringWebhooks}>
                    Verify Shopify connection
                  </Button>
                </InlineStack>
              </BlockStack>
            </Banner>
          </Layout.Section>
        ) : null}

        {showSyncHealthBanner ? (
          <Layout.Section>
            <Banner
              title={
                dashboardSyncHealth?.title ??
                metrics.summaryTitle ??
                "Dashboard insights are still settling"
              }
              tone={toneForReadiness(dashboardSyncHealth?.status ?? metrics.dataState)}
            >
              <BlockStack gap="200">
                <p>
                  {dashboardSyncHealth?.reason ??
                    metrics.summaryDetail ??
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
                  ? "attention"
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
                      <List.Item>
                        {refreshResult.activitySummary.competitorPagesChecked} competitor pages reviewed
                      </List.Item>
                      <List.Item>
                        {refreshResult.activitySummary.pricingRecordsAnalyzed} pricing records analyzed
                      </List.Item>
                      <List.Item>
                        {refreshResult.activitySummary.newInsightsCount +
                          refreshResult.activitySummary.updatedInsightsCount}{" "}
                        insights updated
                      </List.Item>
                      <List.Item>
                        {refreshResult.visibleDataChanged
                          ? "New dashboard insights are ready."
                          : "Everything looks healthy right now."}
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

        <Layout.Section>
          <InlineGrid columns={{ xs: 1, sm: 2, md: 4 }} gap="300">
            {syncing
              ? metricsCards.map((item) => (
                  <Card key={item.title}>
                    <BlockStack gap="150">
                      <Text as="p" variant="bodySm" tone="subdued">
                        {item.title}
                      </Text>
                      <SkeletonDisplayText size="medium" />
                      <SkeletonBodyText lines={1} />
                    </BlockStack>
                  </Card>
                ))
              : metricsCards.map((item) => (
                  <Card key={item.title}>
                    <BlockStack gap="150">
                      <Text as="p" variant="bodySm" tone="subdued">
                        {item.title}
                      </Text>
                      <Text as="p" variant="heading2xl">
                        {item.value}
                      </Text>
                      <Text as="p" tone="subdued">
                        {item.note}
                      </Text>
                    </BlockStack>
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
                    Recent insights
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
                  ) : (
                    <Banner title="No urgent alerts right now" tone="success">
                      <p>
                        No refund reviews, pricing actions, or competitor alerts currently require attention.
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
                          Fraud Intelligence
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
                          Competitor Intelligence
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
                          AI Pricing Engine
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
  );
}

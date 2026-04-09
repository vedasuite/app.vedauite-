import {
  Badge,
  Banner,
  BlockStack,
  Button,
  Card,
  InlineGrid,
  InlineStack,
  Layout,
  Page,
  SkeletonBodyText,
  SkeletonDisplayText,
  Spinner,
  Text,
  Toast,
} from "@shopify/polaris";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useEmbeddedNavigation } from "../../hooks/useEmbeddedNavigation";
import { embeddedShopRequest } from "../../lib/embeddedShopRequest";
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
    startedAt?: string | null;
    finishedAt?: string | null;
    errorMessage?: string | null;
  } | null;
};

type DashboardPayload = {
  metrics: Metrics;
  diagnostics: Diagnostics;
};

type DashboardRefreshResult = {
  startedAt: string;
  finishedAt: string;
  refreshStatus: "success" | "partial" | "failure";
  dashboardDataChanged: boolean;
  changedSections: string[];
  unchangedSections: string[];
  lastRefreshedAt: string | null;
  moduleRefreshResults: {
    fraud: "updated" | "unchanged" | "partial" | "failed";
    competitor: "updated" | "unchanged" | "partial" | "failed";
    pricing: "updated" | "unchanged" | "partial" | "failed";
  };
  summary: string;
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
      return "Ready with data";
    case "SYNC_IN_PROGRESS":
      return "Analyzing store";
    case "SYNC_COMPLETED_PROCESSING_PENDING":
      return "Limited insights";
    case "EMPTY_STORE_DATA":
      return "No store data";
    case "FAILED":
      return "Needs attention";
    case "NOT_CONNECTED":
      return "Reconnect Shopify";
    default:
      return "Sync required";
  }
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

function deriveRefreshResult(args: {
  previous: DashboardPayload | null;
  next: DashboardPayload;
  job: SyncJobResponse["result"];
}): DashboardRefreshResult {
  const previousMetrics = args.previous?.metrics ?? null;
  const previousDiagnostics = args.previous?.diagnostics ?? null;
  const nextMetrics = args.next.metrics;
  const nextDiagnostics = args.next.diagnostics;

  const sections = [
    {
      label: "KPI cards",
      changed:
        !previousMetrics ||
        !equalJson(
          {
            fraudAlertsToday: previousMetrics.fraudAlertsToday,
            competitorPriceChanges: previousMetrics.competitorPriceChanges,
            aiPricingSuggestions: previousMetrics.aiPricingSuggestions,
            profitOptimizationOpportunities:
              previousMetrics.profitOptimizationOpportunities,
          },
          {
            fraudAlertsToday: nextMetrics.fraudAlertsToday,
            competitorPriceChanges: nextMetrics.competitorPriceChanges,
            aiPricingSuggestions: nextMetrics.aiPricingSuggestions,
            profitOptimizationOpportunities:
              nextMetrics.profitOptimizationOpportunities,
          }
        ),
    },
    {
      label: "Recent insights",
      changed:
        !previousMetrics ||
        !equalJson(
          previousMetrics.recentInsights?.map((item) => item.id) ?? [],
          nextMetrics.recentInsights?.map((item) => item.id) ?? []
        ),
    },
    {
      label: "Quick access readiness",
      changed:
        !previousMetrics ||
        !equalJson(previousMetrics.moduleReadiness, nextMetrics.moduleReadiness),
    },
    {
      label: "Sync health",
      changed:
        !previousMetrics ||
        !previousDiagnostics ||
        !equalJson(
          {
            dataState: previousMetrics.dataState,
            summaryTitle: previousMetrics.summaryTitle,
            summaryDetail: previousMetrics.summaryDetail,
            syncHealth: previousDiagnostics.sync.syncHealth,
          },
          {
            dataState: nextMetrics.dataState,
            summaryTitle: nextMetrics.summaryTitle,
            summaryDetail: nextMetrics.summaryDetail,
            syncHealth: nextDiagnostics.sync.syncHealth,
          }
        ),
    },
  ];

  const changedSections = sections.filter((item) => item.changed).map((item) => item.label);
  const unchangedSections = sections
    .filter((item) => !item.changed)
    .map((item) => item.label);

  const fraudChanged =
    !previousMetrics ||
    !equalJson(
      {
        fraudAlertsToday: previousMetrics.fraudAlertsToday,
        highRiskOrders: previousMetrics.highRiskOrders,
        serialReturners: previousMetrics.serialReturners,
        readiness: previousMetrics.moduleReadiness?.trustAbuse,
      },
      {
        fraudAlertsToday: nextMetrics.fraudAlertsToday,
        highRiskOrders: nextMetrics.highRiskOrders,
        serialReturners: nextMetrics.serialReturners,
        readiness: nextMetrics.moduleReadiness?.trustAbuse,
      }
    );
  const competitorChanged =
    !previousMetrics ||
    !equalJson(
      {
        competitorPriceChanges: previousMetrics.competitorPriceChanges,
        promotionAlerts: previousMetrics.promotionAlerts,
        readiness: previousMetrics.moduleReadiness?.competitor,
      },
      {
        competitorPriceChanges: nextMetrics.competitorPriceChanges,
        promotionAlerts: nextMetrics.promotionAlerts,
        readiness: nextMetrics.moduleReadiness?.competitor,
      }
    );
  const pricingChanged =
    !previousMetrics ||
    !equalJson(
      {
        aiPricingSuggestions: previousMetrics.aiPricingSuggestions,
        profitOptimizationOpportunities:
          previousMetrics.profitOptimizationOpportunities,
        readiness: previousMetrics.moduleReadiness?.pricingProfit,
      },
      {
        aiPricingSuggestions: nextMetrics.aiPricingSuggestions,
        profitOptimizationOpportunities:
          nextMetrics.profitOptimizationOpportunities,
        readiness: nextMetrics.moduleReadiness?.pricingProfit,
      }
    );

  const refreshStatus =
    args.job?.status === "FAILED"
      ? "failure"
      : args.job?.status === "SUCCEEDED_PROCESSING_PENDING" ||
        args.job?.status === "SUCCEEDED_NO_DATA"
      ? "partial"
      : "success";

  const dashboardDataChanged = changedSections.length > 0;
  const summary =
    refreshStatus === "failure"
      ? "Refresh failed. Retry the sync to update dashboard signals."
      : refreshStatus === "partial"
      ? dashboardDataChanged
        ? `Refresh completed with limited changes. Updated ${changedSections.join(", ")}.`
        : "Refresh completed with limited updates. Some module outputs are still catching up."
      : dashboardDataChanged
      ? `Last refresh updated ${changedSections.join(", ")}.`
      : "Store data refreshed successfully. No new alerts or metric changes were detected.";

  return {
    startedAt: args.job?.startedAt ?? new Date().toISOString(),
    finishedAt: args.job?.finishedAt ?? new Date().toISOString(),
    refreshStatus,
    dashboardDataChanged,
    changedSections,
    unchangedSections,
    lastRefreshedAt:
      nextMetrics.lastRefreshedAt ?? args.job?.finishedAt ?? new Date().toISOString(),
    moduleRefreshResults: {
      fraud:
        refreshStatus === "failure"
          ? "failed"
          : refreshStatus === "partial" && fraudChanged
          ? "partial"
          : fraudChanged
          ? "updated"
          : "unchanged",
      competitor:
        refreshStatus === "failure"
          ? "failed"
          : refreshStatus === "partial" && competitorChanged
          ? "partial"
          : competitorChanged
          ? "updated"
          : "unchanged",
      pricing:
        refreshStatus === "failure"
          ? "failed"
          : refreshStatus === "partial" && pricingChanged
          ? "partial"
          : pricingChanged
          ? "updated"
          : "unchanged",
    },
    summary,
  };
}

export function DashboardPage() {
  const { navigateEmbedded } = useEmbeddedNavigation();
  const { host, shop } = useAppBridge();
  const { subscription } = useSubscriptionPlan();
  const { onboarding, refresh: refreshOnboarding } = useOnboardingState();
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [registeringWebhooks, setRegisteringWebhooks] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshResult, setRefreshResult] = useState<DashboardRefreshResult | null>(
    null
  );

  const fallbackReauthorizeUrl = shop
    ? `/auth/reconnect?shop=${encodeURIComponent(shop)}${
        host ? `&host=${encodeURIComponent(host)}` : ""
      }&returnTo=${encodeURIComponent("/app/dashboard")}`
    : null;

  const loadDashboard = useCallback(async (): Promise<DashboardPayload> => {
    const [metricsResponse, diagnosticsResponse] = await Promise.all([
      embeddedShopRequest<Metrics>("/api/dashboard/metrics", { timeoutMs: 30000 }),
      embeddedShopRequest<Diagnostics>("/api/shopify/diagnostics", {
        timeoutMs: 20000,
      }),
    ]);

    return {
      metrics: metricsResponse,
      diagnostics: diagnosticsResponse,
    };
  }, []);

  const applyDashboardPayload = useCallback((payload: DashboardPayload) => {
    setMetrics(payload.metrics);
    setDiagnostics(payload.diagnostics);
    setError(null);
  }, []);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    loadDashboard()
      .then((payload) => {
        if (!mounted) return;
        applyDashboardPayload(payload);
      })
      .catch((nextError) => {
        if (!mounted) return;
        setError(
          nextError instanceof Error
            ? nextError.message
            : "Unable to load the dashboard."
        );
      })
      .finally(() => {
        if (!mounted) return;
        setLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, [applyDashboardPayload, loadDashboard]);

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
          const nextPayload = await loadDashboard();
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
    [applyDashboardPayload, diagnostics, loadDashboard, metrics, refreshOnboarding]
  );

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
        dashboardDataChanged: false,
        changedSections: [],
        unchangedSections: ["KPI cards", "Recent insights", "Quick access readiness", "Sync health"],
        lastRefreshedAt: metrics?.lastRefreshedAt ?? null,
        moduleRefreshResults: {
          fraud: "failed",
          competitor: "failed",
          pricing: "failed",
        },
        summary: "Refresh failed. Retry the sync to update dashboard signals.",
      });
    } finally {
      setSyncing(false);
    }
  }, [host, metrics?.lastRefreshedAt, pollSyncJob]);

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
      setToast("Shopify webhooks verified successfully.");
    } catch (nextError) {
      setError(
        nextError instanceof Error
          ? nextError.message
          : "Unable to register webhooks."
      );
    } finally {
      setRegisteringWebhooks(false);
    }
  }, [applyDashboardPayload, host, loadDashboard]);

  const metricsCards = useMemo(
    () => [
      {
        title: "Fraud alerts",
        value: metrics?.fraudAlertsToday ?? 0,
        note: "Refund abuse and risky orders",
      },
      {
        title: "Competitor changes",
        value: metrics?.competitorPriceChanges ?? 0,
        note: "Latest monitored price moves",
      },
      {
        title: "Pricing opportunities",
        value: metrics?.aiPricingSuggestions ?? 0,
        note: "Pricing records ready to review",
      },
      {
        title: "Profit opportunities",
        value: metrics?.profitOptimizationOpportunities ?? 0,
        note: "Optimization records available",
      },
    ],
    [metrics]
  );
  const currentRefreshSummary =
    syncing
      ? "Refreshing dashboard data and checking for updated metrics."
      : refreshResult?.summary ??
    (metrics?.lastRefreshedAt
      ? `Refreshed at ${formatRelativeTimestamp(metrics.lastRefreshedAt)}.`
      : "Refresh the dashboard to pull the latest Shopify data.");

  const syncHealthLabel =
    diagnostics?.sync.syncHealth?.status
      ? labelForReadiness(diagnostics.sync.syncHealth.status)
      : labelForReadiness(metrics?.dataState);
  const syncHealthTone =
    diagnostics?.sync.syncHealth?.status
      ? toneForReadiness(diagnostics.sync.syncHealth.status)
      : toneForReadiness(metrics?.dataState);

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
      subtitle="Key monitoring metrics, readiness status, recent alerts, and direct access to each VedaSuite intelligence workflow."
      primaryAction={{
        content: "Sync Data",
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
            <Banner title="Finish onboarding to unlock the full dashboard" tone="info">
              <BlockStack gap="200">
                <p>
                  Dashboard reporting is available now, but the guided setup is not
                  complete yet. Finish onboarding to mark the store ready and lock
                  in the first workflow.
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
                    Verify webhooks
                  </Button>
                </InlineStack>
              </BlockStack>
            </Banner>
          </Layout.Section>
        ) : null}

        {metrics?.dataState && metrics.dataState !== "READY_WITH_DATA" ? (
          <Layout.Section>
            <Banner
              title={metrics.summaryTitle ?? "Dashboard insights are still settling"}
              tone={toneForReadiness(metrics.dataState)}
            >
              <BlockStack gap="200">
                <p>{metrics.summaryDetail ?? "VedaSuite is still preparing this store."}</p>
                <InlineStack gap="300">
                  <Button variant="primary" onClick={() => void syncLiveStoreData()} loading={syncing}>
                    Sync Data
                  </Button>
                  {!diagnostics?.webhooks.liveStatus ||
                  diagnostics.webhooks.liveStatus.registeredCount <
                    diagnostics.webhooks.liveStatus.totalTracked ? (
                    <Button onClick={() => void registerWebhooks()} loading={registeringWebhooks}>
                      Fix webhooks
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
                  Last refreshed
                </Text>
                <Text as="p" variant="headingMd">
                  {metrics?.lastRefreshedAt
                    ? formatRelativeTimestamp(metrics.lastRefreshedAt)
                    : "Not refreshed yet"}
                </Text>
              </BlockStack>
              <BlockStack gap="100">
                <Text as="p" variant="bodySm" tone="subdued">
                  Sync health
                </Text>
                <InlineStack gap="200" blockAlign="center">
                  <Badge tone={syncHealthTone}>{syncHealthLabel}</Badge>
                  <Text as="p" tone="subdued">
                    {diagnostics?.sync.syncHealth?.reason ?? metrics?.summaryDetail}
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
                  ? "Dashboard refresh completed"
                  : refreshResult.refreshStatus === "partial"
                  ? "Dashboard refresh completed with partial updates"
                  : "Dashboard refresh failed"
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
                <InlineStack gap="300">
                  <Text as="p" variant="bodySm" tone="subdued">
                    Fraud: {refreshResult.moduleRefreshResults.fraud}
                  </Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    Competitor: {refreshResult.moduleRefreshResults.competitor}
                  </Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    Pricing: {refreshResult.moduleRefreshResults.pricing}
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
                  ) : (metrics?.recentInsights?.length ?? 0) > 0 ? (
                    metrics?.recentInsights?.map((insight) => (
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
                    <Banner title="Analyzing store" tone="info">
                      <p>
                        VedaSuite is still preparing real insights for this dashboard. Use the module shortcuts below while sync and processing continue.
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
                          Review risky orders, refund abuse, and trust signals.
                        </Text>
                        <Badge tone={toneForReadiness(metrics?.moduleReadiness?.trustAbuse?.readinessState)}>
                          {labelForReadiness(metrics?.moduleReadiness?.trustAbuse?.readinessState)}
                        </Badge>
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
                          Review competitor pricing, promotions, and market moves.
                        </Text>
                        <Badge tone={toneForReadiness(metrics?.moduleReadiness?.competitor?.readinessState)}>
                          {labelForReadiness(metrics?.moduleReadiness?.competitor?.readinessState)}
                        </Badge>
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
                          Review pricing opportunities and profit optimization records.
                        </Text>
                        <Badge tone={toneForReadiness(metrics?.moduleReadiness?.pricingProfit?.readinessState)}>
                          {labelForReadiness(metrics?.moduleReadiness?.pricingProfit?.readinessState)}
                        </Badge>
                      </BlockStack>
                      <Button
                        disabled={syncing}
                        onClick={() =>
                          navigateEmbedded(
                            subscription?.enabledModules?.pricingProfit
                              ? "/app/ai-pricing-engine"
                              : "/app/billing"
                          )
                        }
                      >
                        {subscription?.enabledModules?.pricingProfit ? "Open" : "Upgrade to unlock"}
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

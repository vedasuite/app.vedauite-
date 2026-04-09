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
    errorMessage?: string | null;
  } | null;
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

export function DashboardPage() {
  const { navigateEmbedded } = useEmbeddedNavigation();
  const { host, shop } = useAppBridge();
  const { subscription } = useSubscriptionPlan();
  const { refresh: refreshOnboarding } = useOnboardingState();
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [registeringWebhooks, setRegisteringWebhooks] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fallbackReauthorizeUrl = shop
    ? `/auth/reconnect?shop=${encodeURIComponent(shop)}${
        host ? `&host=${encodeURIComponent(host)}` : ""
      }&returnTo=${encodeURIComponent("/app/dashboard")}`
    : null;

  const loadDashboard = useCallback(async () => {
    const [metricsResponse, diagnosticsResponse] = await Promise.all([
      embeddedShopRequest<Metrics>("/api/dashboard/metrics", { timeoutMs: 30000 }),
      embeddedShopRequest<Diagnostics>("/api/shopify/diagnostics", {
        timeoutMs: 20000,
      }),
    ]);

    setMetrics(metricsResponse);
    setDiagnostics(diagnosticsResponse);
    setError(null);
  }, []);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    loadDashboard()
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
  }, [loadDashboard]);

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
          await Promise.all([loadDashboard(), refreshOnboarding()]);
          setToast(
            latestJob.status === "READY_WITH_DATA"
              ? "Store analysis refreshed successfully."
              : latestJob.status === "SUCCEEDED_PROCESSING_PENDING"
              ? "Store synced. Some insights are still being processed."
              : "Store synced, but Shopify returned limited historical data."
          );
          return;
        }

        if (latestJob.status === "FAILED") {
          throw new Error(latestJob.errorMessage ?? "Sync failed.");
        }

        await new Promise((resolve) => setTimeout(resolve, 1500));
      }

      throw new Error("Sync is still running. Check back in a moment.");
    },
    [loadDashboard, refreshOnboarding]
  );

  const syncLiveStoreData = useCallback(async () => {
    setSyncing(true);
    setError(null);
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
    } finally {
      setSyncing(false);
    }
  }, [host, pollSyncJob]);

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
      await loadDashboard();
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
  }, [host, loadDashboard]);

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
          <InlineGrid columns={{ xs: 1, sm: 2, md: 4 }} gap="300">
            {metricsCards.map((item) => (
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
                  {(metrics?.recentInsights?.length ?? 0) > 0 ? (
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

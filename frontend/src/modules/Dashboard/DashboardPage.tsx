import {
  Banner,
  Badge,
  BlockStack,
  Button,
  Box,
  Card,
  InlineGrid,
  InlineStack,
  Layout,
  List,
  Page,
  Tabs,
  Text,
  Toast,
} from "@shopify/polaris";
import { useEffect, useMemo, useState } from "react";
import { useEmbeddedNavigation } from "../../hooks/useEmbeddedNavigation";
import { embeddedShopRequest } from "../../lib/embeddedShopRequest";
import { useAppBridge } from "../../shopifyAppBridge";
import { useSubscriptionPlan } from "../../hooks/useSubscriptionPlan";
import { readModuleCache, writeModuleCache } from "../../lib/moduleCache";

type Metrics = {
  fraudAlertsToday: number;
  highRiskOrders: number;
  serialReturners: number;
  competitorPriceChanges: number;
  promotionAlerts: number;
  aiPricingSuggestions: number;
  profitOptimizationOpportunities: number;
  lastSyncStatus?: string;
  lastSyncAt?: string | null;
  timelineEventsGenerated?: number;
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
  persistedCounts?: {
    products: number;
    orders: number;
    customers: number;
    pricingRows: number;
    profitRows: number;
    timelineEvents: number;
    competitorDomains: number;
    competitorRows: number;
  } | null;
  onboarding?: {
    stage: string;
    dashboardEntryState: string;
    isCompleted: boolean;
    isDismissed: boolean;
    canDismiss: boolean;
    showPersistentNextStep: boolean;
    title: string;
    description: string;
    nextAction: {
      key: string;
      label: string;
      route: string;
    };
    steps: Array<{
      key: string;
      label: string;
      complete: boolean;
      active: boolean;
      description: string;
    }>;
    currentPlan: string;
    limitedDataReason: string | null;
    recommendedModuleRoute: string;
  } | null;
};

type WebhookStatus = {
  registeredCount: number;
  totalTracked: number;
};

type LaunchAudit = {
  checks: Array<{
    key: string;
    ok: boolean;
    detail: string;
  }>;
  reviewerReminders?: string[];
};

type DecisionCenter = {
  summary: {
    activeModules: number;
    priorityLevel: string;
    automationReadiness: string;
  };
  decisions: Array<{
    id: string;
    title: string;
    module: string;
    severity: string;
    rationale: string;
    route: string;
    confidence: number;
    recommendedAction: string;
    explanationPoints: string[];
    automationPosture: string;
  }>;
};

type SyncJobPayload = {
  id?: string;
  jobId?: string;
  status: string;
  errorMessage?: string | null;
  reusedExisting?: boolean;
  finishedAt?: string | null;
  summaryJson?: string | null;
};

type SyncJobResponse = {
  result: SyncJobPayload | null;
};

type ConnectionHealth = {
  shop: string | null;
  code: string;
  healthy: boolean;
  installationFound: boolean;
  hasOfflineToken: boolean;
  webhooksRegistered: boolean;
  webhookCoverageReady: boolean;
  lastSyncStatus: string | null;
  lastSyncAt: string | null;
  lastConnectionStatus: string | null;
  lastConnectionError: string | null;
  reauthRequired: boolean;
  message: string;
  reauthorizeUrl?: string;
};

type Diagnostics = {
  generatedAt: string;
  shop: string;
  installation: {
    found: boolean;
    offlineTokenPresent: boolean;
    refreshTokenPresent: boolean;
    accessTokenExpiresAt: string | null;
    refreshTokenExpiresAt: string | null;
    uninstalledAt: string | null;
  };
  connection: ConnectionHealth;
  reviewerSummary: {
    installExists: boolean;
    tokenPresent: boolean;
    tokenRefreshHealthy: boolean;
    webhookCoverageReady: boolean;
    reconnectRequired: boolean;
    uninstallState: boolean;
    billingStatus: string | null;
  };
  webhooks: {
    registeredAt: string | null;
    lastStatus: string | null;
    liveStatus: WebhookStatus | null;
  };
  sync: {
    lastSyncAt: string | null;
    lastSyncStatus: string | null;
    latestJob: SyncJobPayload | null;
    syncHealth?: {
      status: string;
      reason: string;
    } | null;
    operationalCounts?: Metrics["persistedCounts"];
  };
  billing: {
    planName: string;
    status: string;
    billingStatus: string | null;
    active: boolean;
    starterModule: string | null;
    endsAt: string | null;
    trialEndsAt: string | null;
  } | null;
};

function getApiErrorMessage(error: unknown, fallback: string) {
  const candidate = error as {
    message?: string;
    response?: {
      data?: {
        error?: string | { message?: string; reauthorizeUrl?: string };
        message?: string;
      };
    };
  };

  const responseError = candidate.response?.data?.error;
  if (typeof responseError === "string" && responseError.trim()) {
    return responseError;
  }

  if (
    responseError &&
    typeof responseError === "object" &&
    typeof responseError.message === "string" &&
    responseError.message.trim()
  ) {
    return responseError.message;
  }

  const responseMessage = candidate.response?.data?.message;
  if (typeof responseMessage === "string" && responseMessage.trim()) {
    return responseMessage;
  }

  if (typeof candidate.message === "string" && candidate.message.trim()) {
    return candidate.message;
  }

  return fallback;
}

function getApiReauthorizeUrl(error: unknown) {
  const candidate = error as {
    reauthorizeUrl?: string | null;
    response?: {
      data?: {
        error?: {
          reauthorizeUrl?: string;
        };
      };
    };
  };

  return (
    candidate.reauthorizeUrl ??
    candidate.response?.data?.error?.reauthorizeUrl ??
    null
  );
}

function redirectTopLevel(url: string) {
  if (window.top && window.top !== window) {
    window.top.location.href = url;
    return;
  }

  window.location.href = url;
}

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
      return "Syncing";
    case "SYNC_COMPLETED_PROCESSING_PENDING":
      return "Processing";
    case "EMPTY_STORE_DATA":
      return "No store data";
    case "FAILED":
      return "Failed";
    case "NOT_CONNECTED":
      return "Reconnect";
    default:
      return "Setup required";
  }
}

const EMPTY_METRICS: Metrics = {
  fraudAlertsToday: 0,
  highRiskOrders: 0,
  serialReturners: 0,
  competitorPriceChanges: 0,
  promotionAlerts: 0,
  aiPricingSuggestions: 0,
  profitOptimizationOpportunities: 0,
};

export function DashboardPage() {
  const { navigateEmbedded } = useEmbeddedNavigation();
  const { shop, host } = useAppBridge();
  const { subscription } = useSubscriptionPlan();
  const cachedMetrics = readModuleCache<Metrics>("dashboard-metrics");
  const [metrics, setMetrics] = useState<Metrics>(cachedMetrics ?? EMPTY_METRICS);
  const [loading, setLoading] = useState(!cachedMetrics);
  const [selectedTab, setSelectedTab] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [registeringWebhooks, setRegisteringWebhooks] = useState(false);
  const [webhookStatus, setWebhookStatus] = useState<WebhookStatus | null>(null);
  const [launchAudit, setLaunchAudit] = useState<LaunchAudit | null>(null);
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);
  const [decisionCenter, setDecisionCenter] = useState<DecisionCenter | null>(null);
  const [connectionHealth, setConnectionHealth] = useState<ConnectionHealth | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [actionError, setActionError] = useState<{
    title: string;
    detail: string;
    reauthorizeUrl?: string | null;
  } | null>(null);
  const fallbackReauthorizeUrl = shop
    ? `/auth/reconnect?shop=${encodeURIComponent(shop)}${
        host ? `&host=${encodeURIComponent(host)}` : ""
      }&returnTo=${encodeURIComponent(window.location.pathname)}`
    : null;

  const effectiveConnectionHealth = diagnostics?.connection ?? connectionHealth;
  const effectiveWebhookStatus = diagnostics?.webhooks.liveStatus ?? webhookStatus;
  const syncHealthState = diagnostics?.sync.syncHealth ?? null;
  const trustReadiness = metrics.moduleReadiness?.trustAbuse?.readinessState ?? "SYNC_REQUIRED";
  const competitorReadiness = metrics.moduleReadiness?.competitor?.readinessState ?? "SYNC_REQUIRED";
  const pricingReadiness = metrics.moduleReadiness?.pricingProfit?.readinessState ?? "SYNC_REQUIRED";
  const onboarding = metrics.onboarding ?? null;

  const pollSyncJob = async (jobId?: string | null) => {
    const startedAt = Date.now();

    while (Date.now() - startedAt < 180000) {
      const response = await embeddedShopRequest<SyncJobResponse>(
        "/api/shopify/sync-jobs/latest",
        {
          timeoutMs: 15000,
        }
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
        loadMetrics();
        void loadDiagnostics();
        setToast(
          latestJob.status === "READY_WITH_DATA"
            ? "Shopify sync completed and VedaSuite now has live processed store data."
            : latestJob.status === "SUCCEEDED_PROCESSING_PENDING"
            ? "Shopify sync completed. Processing is still catching up in the background."
            : "Shopify sync completed, but the store currently has no synced merchant data to process."
        );
        return;
      }

      if (latestJob.status === "FAILED") {
        throw new Error(latestJob.errorMessage ?? "Shopify sync job failed.");
      }

      await new Promise((resolve) => setTimeout(resolve, 1500));
    }

    throw new Error(
      "Sync is still running in the background. Check back in a moment."
    );
  };

  const loadMetrics = () => {
    setLoading(true);
    embeddedShopRequest<Metrics>("/api/dashboard/metrics", {
      timeoutMs: 30000,
    })
      .then((res) => {
        setMetrics(res);
        writeModuleCache("dashboard-metrics", res);
      })
      .catch((error) => {
        setActionError({
          title: "Dashboard data needs attention",
          detail: getApiErrorMessage(
            error,
            "VedaSuite could not load persisted dashboard metrics."
          ),
        });
      })
      .finally(() => setLoading(false));
  };

  const loadDiagnostics = () => {
    const query = host
      ? `?host=${encodeURIComponent(host)}&returnTo=${encodeURIComponent(
          window.location.pathname
        )}`
      : "";

    return embeddedShopRequest<Diagnostics>(`/api/shopify/diagnostics${query}`, {
      timeoutMs: 20000,
    })
      .then((res) => {
        setDiagnostics(res);
        setConnectionHealth(res.connection);
        setWebhookStatus(res.webhooks.liveStatus);

        if (!res.connection.healthy) {
          setActionError({
            title: res.connection.reauthRequired
              ? "Shopify connection needs reauthorization"
              : res.connection.code === "WEBHOOKS_MISSING"
              ? "Shopify webhook setup needs attention"
              : "Live sync needs attention",
            detail: res.connection.message,
            reauthorizeUrl: res.connection.reauthRequired
              ? res.connection.reauthorizeUrl ?? fallbackReauthorizeUrl
              : null,
          });
          return;
        }

        setActionError(null);
      })
      .catch(() => undefined);
  };

  useEffect(() => {
    loadMetrics();
    void loadDiagnostics();
    embeddedShopRequest<LaunchAudit>("/launch/sanity", {
      timeoutMs: 30000,
    })
      .then((res) => setLaunchAudit(res))
      .catch(() => setLaunchAudit(null));
    embeddedShopRequest<DecisionCenter>("/api/dashboard/decision-center", {
      timeoutMs: 30000,
    })
      .then((res) => setDecisionCenter(res))
      .catch(() => setDecisionCenter(null));
  }, [host]);

  useEffect(() => {
    if (!shop) {
      return;
    }

    embeddedShopRequest<SyncJobResponse>("/api/shopify/sync-jobs/latest", {
      timeoutMs: 15000,
    })
      .then((response) => {
        const latestJob = response.result;
        if (
          latestJob &&
          (latestJob.status === "PENDING" || latestJob.status === "RUNNING")
        ) {
          setSyncing(true);
          return pollSyncJob(latestJob.id ?? latestJob.jobId ?? null)
            .catch((error) => {
              const message = getApiErrorMessage(
                error,
                "Sync is still running in the background."
              );
              setActionError({
                title: "Live sync needs attention",
                detail: message,
              });
              setToast(message);
            })
            .finally(() => setSyncing(false));
        }

        return undefined;
      })
      .catch(() => undefined);
  }, [shop]);

  const syncLiveStoreData = async () => {
    try {
      setSyncing(true);
      setActionError(null);
      const response = await embeddedShopRequest<SyncJobResponse>("/api/shopify/sync", {
        method: "POST",
        body: {
          host,
          returnTo: window.location.pathname,
        },
        timeoutMs: 20000,
      });
      void loadDiagnostics();
      await pollSyncJob(response.result?.jobId ?? response.result?.id ?? null);
    } catch (error) {
      const message = getApiErrorMessage(error, "Unable to sync Shopify data right now.");
      const reauthorizeUrl =
        getApiReauthorizeUrl(error) ??
        (/reauthorize|access token|unauthorized|invalid api key|invalid access token|wrong password|unrecognized login|embedded session|reconnect shopify/i.test(
          message
        )
          ? fallbackReauthorizeUrl
          : null);
      if (reauthorizeUrl) {
        setActionError({
          title: "Shopify connection needs reauthorization",
          detail:
            "Your stored Shopify app connection looks stale. Reconnect VedaSuite, then retry sync and webhook setup.",
          reauthorizeUrl,
        });
        setToast("Shopify connection needs reauthorization.");
        return;
      }

      setActionError({
        title: "Live sync needs attention",
        detail: message,
      });
      setToast(message);
    } finally {
      setSyncing(false);
    }
  };

  const registerWebhooks = async () => {
    try {
      setRegisteringWebhooks(true);
      setActionError(null);
      const response = await embeddedShopRequest<{
        result: { created: string[]; totalTracked: number };
      }>("/api/shopify/register-webhooks", {
        method: "POST",
        body: {
          host,
          returnTo: window.location.pathname,
        },
        timeoutMs: 90000,
      });
      setToast(
        response.result.created.length > 0
          ? `Registered ${response.result.created.length} Shopify sync webhooks.`
          : "Shopify sync webhooks are already registered."
      );
      void loadDiagnostics();
    } catch (error) {
      const message = getApiErrorMessage(error, "Unable to register Shopify sync webhooks.");
      const reauthorizeUrl =
        getApiReauthorizeUrl(error) ??
        (/reauthorize|access token|unauthorized|invalid api key|invalid access token|wrong password|unrecognized login|embedded session|reconnect shopify/i.test(
          message
        )
          ? fallbackReauthorizeUrl
          : null);
      if (reauthorizeUrl) {
        setActionError({
          title: "Reconnect Shopify before registering webhooks",
          detail:
            "Webhook registration needs a fresh Shopify app authorization. Reconnect VedaSuite and retry once Shopify brings you back into the app.",
          reauthorizeUrl,
        });
        setToast("Reconnect Shopify before registering webhooks.");
        return;
      }

      setActionError({
        title: "Webhook registration needs attention",
        detail: message,
      });
      setToast(message);
    } finally {
      setRegisteringWebhooks(false);
    }
  };

  const tabs = [
    { id: "overview", content: "Overview" },
    { id: "signals", content: "Signals" },
    { id: "actions", content: "Action plan" },
  ];
  const reportsEnabled = !!subscription?.capabilities?.["reports.view"];

  const quickActions = [
      {
        title: "Review fraud queue",
        description: "Inspect risky orders, chargeback exposure, and return abuse flags.",
        route: "/trust-abuse?focus=high-risk",
        cta: "Open trust & abuse",
        tone: "critical" as const,
        readiness: trustReadiness,
      },
      {
        title: "Watch the market",
        description:
          "Review monitored competitor website signals and current market-response suggestions.",
        route: "/competitor?focus=promotions",
        cta: "Open competitor intelligence",
        tone: "info" as const,
        readiness: competitorReadiness,
      },
      {
        title: "Review pricing baseline",
        description:
          "Validate the latest pricing baseline or recommendation before taking merchant action.",
        route: "/pricing-profit?focus=simulation",
        cta: "Open pricing & profit",
        tone: "success" as const,
        locked: !subscription?.enabledModules?.pricingProfit,
        readiness: pricingReadiness,
      },
    ];

  const kpis = useMemo(
    () => [
      {
        title: "Fraud alerts today",
        value: metrics.fraudAlertsToday,
        tone: "critical" as const,
        note: "High-priority review queue",
      },
      {
        title: "High-risk orders",
        value: metrics.highRiskOrders,
        tone: "critical" as const,
        note: "Orders above 70 risk score",
      },
      {
        title: "Serial returners",
        value: metrics.serialReturners,
        tone: "warning" as const,
        note: "Refund-heavy customer profiles",
      },
      {
        title: "Competitor price changes",
        value: metrics.competitorPriceChanges,
        tone: "info" as const,
        note: "Tracked in the last 24 hours",
      },
      {
        title: "Promotion alerts",
        value: metrics.promotionAlerts,
        tone: "success" as const,
        note: "New offer or campaign movement",
      },
      {
        title: "Pricing records",
        value: metrics.aiPricingSuggestions,
        tone: "success" as const,
        note: "Baseline or live recommendation rows",
      },
      {
        title: "Profit records",
        value: metrics.profitOptimizationOpportunities,
        tone: "attention" as const,
        note: "Available profit-engine rows",
      },
    ],
    [metrics]
  );

  const runOnboardingAction = () => {
    if (!onboarding) {
      navigateEmbedded("/onboarding");
      return;
    }

    switch (onboarding.nextAction.key) {
      case "RECONNECT_SHOPIFY":
        if (fallbackReauthorizeUrl) {
          redirectTopLevel(fallbackReauthorizeUrl);
        }
        return;
      case "SYNC_LIVE_DATA":
        void syncLiveStoreData();
        return;
      default:
        navigateEmbedded(onboarding.nextAction.route);
        return;
    }
  };

  return (
    <Page
      title="VedaSuite AI Dashboard"
      subtitle="A single control center for trust, competition, pricing, reporting, and profit intelligence."
      primaryAction={{
        content: syncing ? "Syncing..." : "Sync live Shopify data",
        onAction: syncLiveStoreData,
        disabled: syncing,
      }}
      secondaryActions={[
        {
          content: registeringWebhooks
            ? "Registering webhooks..."
            : "Register sync webhooks",
          onAction: registerWebhooks,
          disabled: registeringWebhooks,
        },
      ]}
    >
      <Layout>
        <Layout.Section>
          {loading ? (
            <Banner title="Refreshing store intelligence" tone="info">
              <p>Dashboard metrics are loading in the background.</p>
            </Banner>
          ) : null}
        </Layout.Section>

        <Layout.Section>
          {actionError ? (
            <Banner
              title={actionError.title}
              tone={actionError.reauthorizeUrl ? "warning" : "critical"}
            >
              <BlockStack gap="300">
                <Text as="p">{actionError.detail}</Text>
                <InlineStack gap="300">
                  {actionError.reauthorizeUrl ? (
                    <Button onClick={() => redirectTopLevel(actionError.reauthorizeUrl ?? "")}>
                      Reconnect Shopify
                    </Button>
                  ) : (
                    <Button onClick={syncLiveStoreData}>Retry live sync</Button>
                  )}
                  <Button variant="secondary" onClick={registerWebhooks}>
                    Retry webhook setup
                  </Button>
                </InlineStack>
              </BlockStack>
            </Banner>
          ) : null}
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingLg">
                    {onboarding?.title ??
                      metrics.summaryTitle ??
                      "VedaSuite dashboard"}
                  </Text>
                  <Text as="p" tone="subdued">
                    {onboarding?.description ??
                      metrics.summaryDetail ??
                      "Sync Shopify store data, process trust, pricing, and competitor signals, and then move into the next best workflow."}
                  </Text>
                </BlockStack>
                <Badge tone={toneForReadiness(onboarding?.dashboardEntryState ?? syncHealthState?.status ?? metrics.dataState)}>
                  {labelForReadiness(onboarding?.dashboardEntryState ?? syncHealthState?.status ?? metrics.dataState)}
                </Badge>
              </InlineStack>
              <InlineStack gap="300">
                <Button variant="primary" onClick={runOnboardingAction}>
                  {onboarding?.nextAction.label ?? "Continue setup"}
                </Button>
                <Button onClick={() => navigateEmbedded("/onboarding")}>
                  Open guided onboarding
                </Button>
                <Button onClick={() => navigateEmbedded("/subscription")}>
                  View pricing plans
                </Button>
              </InlineStack>
              <InlineGrid columns={{ xs: 1, md: 3 }} gap="300">
                <div className="vs-signal-stat">
                  <Text as="p" variant="bodySm" tone="subdued">
                    What VedaSuite does
                  </Text>
                  <Text as="p">
                    Syncs Shopify data, processes store signals, and turns them into module guidance.
                  </Text>
                </div>
                <div className="vs-signal-stat">
                  <Text as="p" variant="bodySm" tone="subdued">
                    Current plan
                  </Text>
                  <Text as="p">{onboarding?.currentPlan ?? subscription?.planName ?? "NONE"}</Text>
                </div>
                <div className="vs-signal-stat">
                  <Text as="p" variant="bodySm" tone="subdued">
                    What to do first
                  </Text>
                  <Text as="p">{onboarding?.nextAction.label ?? "Run first sync"}</Text>
                </div>
              </InlineGrid>
              {onboarding?.limitedDataReason ? (
                <Banner title="Why some insights may still look limited" tone="info">
                  <p>{onboarding.limitedDataReason}</p>
                </Banner>
              ) : null}
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <div>
                    <Text as="h2" variant="headingLg">
                      Suite posture
                    </Text>
                    <Text as="p" tone="subdued">
                      {subscription?.planName ?? "NONE"} plan coverage is resolved from
                      the current backend billing state for this Shopify store.
                    </Text>
                  </div>
                  <InlineStack gap="200">
                    <Badge tone={toneForReadiness(syncHealthState?.status ?? metrics.dataState)}>
                      {labelForReadiness(syncHealthState?.status ?? metrics.dataState)}
                    </Badge>
                    {effectiveConnectionHealth && !effectiveConnectionHealth.healthy ? (
                      <Badge tone="attention">{effectiveConnectionHealth.code}</Badge>
                    ) : null}
                  </InlineStack>
                </InlineStack>
                <div className="vs-analytics-strip" aria-hidden="true">
                  {[52, 68, 61, 82, 74, 88, 79].map((width, index) => (
                    <span
                      key={`analytics-${index}`}
                      style={{ width: `${width}%` }}
                    />
                  ))}
                </div>
                <InlineGrid columns={{ xs: 1, sm: 3 }} gap="300">
                  <div className="vs-signal-stat">
                    <Text as="p" variant="bodySm" tone="subdued">
                        Timeline events
                    </Text>
                    <Text as="p" variant="headingLg">
                      {metrics.timelineEventsGenerated ?? 0}
                    </Text>
                  </div>
                  <div className="vs-signal-stat">
                    <Text as="p" variant="bodySm" tone="subdued">
                      Active modules
                    </Text>
                    <Text as="p" variant="headingLg">
                      {
                        [
                          subscription?.enabledModules?.trustAbuse,
                          subscription?.enabledModules?.competitor,
                          subscription?.enabledModules?.pricingProfit,
                        ].filter(Boolean).length
                      }
                    </Text>
                  </div>
                  <div className="vs-signal-stat">
                    <Text as="p" variant="bodySm" tone="subdued">
                      Webhook coverage
                    </Text>
                    <Text as="p" variant="headingLg">
                      {effectiveWebhookStatus
                        ? `${effectiveWebhookStatus.registeredCount}/${effectiveWebhookStatus.totalTracked}`
                        : "-"}
                    </Text>
                  </div>
                </InlineGrid>
              </BlockStack>
            </Card>
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingLg">
                  Quick actions
                </Text>
                <Text as="p" tone="subdued">
                  Move directly into the next high-leverage workflow.
                </Text>
                <BlockStack gap="300">
                  {quickActions.map((action) => (
                    <div key={action.title} className="vs-action-card">
                      <InlineStack align="space-between" blockAlign="start" gap="300">
                        <BlockStack gap="100">
                          <InlineStack gap="200" blockAlign="center">
                            <Text as="h3" variant="headingMd">
                              {action.title}
                            </Text>
                            <Badge tone={action.locked ? "attention" : toneForReadiness(action.readiness)}>
                              {action.locked
                                ? "Upgrade required"
                                : labelForReadiness(action.readiness)}
                            </Badge>
                          </InlineStack>
                          <Text as="p" tone="subdued">
                            {action.description}
                          </Text>
                          {!action.locked ? (
                            <Text as="p" variant="bodySm" tone="subdued">
                              {action.readiness === trustReadiness
                                ? metrics.moduleReadiness?.trustAbuse?.reason
                                : action.readiness === competitorReadiness
                                ? metrics.moduleReadiness?.competitor?.reason
                                : metrics.moduleReadiness?.pricingProfit?.reason}
                            </Text>
                          ) : null}
                        </BlockStack>
                        <Button
                          variant={action.locked ? "secondary" : "primary"}
                          onClick={() =>
                            navigateEmbedded(
                              action.locked ? "/subscription" : action.route
                            )
                          }
                        >
                          {action.locked ? "View plans" : action.cta}
                        </Button>
                      </InlineStack>
                    </div>
                  ))}
                </BlockStack>
              </BlockStack>
            </Card>
            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <div>
                    <Text as="h2" variant="headingLg">
                      Setup progress
                    </Text>
                    <Text as="p" tone="subdued">
                      Backend-driven onboarding steps for this store.
                    </Text>
                  </div>
                  <Badge tone="info">
                    {`${onboarding?.steps.filter((item) => item.complete).length ?? 0}/${onboarding?.steps.length ?? 0} complete`}
                  </Badge>
                </InlineStack>
                <BlockStack gap="300">
                  {(onboarding?.steps ?? []).map((item) => (
                    <div key={item.label} className="vs-action-card">
                      <InlineStack align="space-between" blockAlign="center">
                        <BlockStack gap="100">
                          <Text as="h3" variant="headingMd">
                            {item.label}
                          </Text>
                          <Text as="p" tone="subdued">
                            {item.description}
                          </Text>
                          <Badge tone={item.complete ? "success" : "attention"}>
                            {item.complete ? "Complete" : item.active ? "Current" : "Upcoming"}
                          </Badge>
                        </BlockStack>
                        <Button
                          variant={item.complete ? "secondary" : "primary"}
                          onClick={() => navigateEmbedded("/onboarding")}
                        >
                          {item.complete ? "Review" : "Continue"}
                        </Button>
                      </InlineStack>
                    </div>
                  ))}
                </BlockStack>
                {launchAudit?.reviewerReminders?.length ? (
                  <Banner title="Reviewer notes" tone="info">
                    <List type="bullet">
                      {launchAudit.reviewerReminders.map((item) => (
                        <List.Item key={item}>{item}</List.Item>
                      ))}
                    </List>
                  </Banner>
                ) : null}
              </BlockStack>
            </Card>
            {decisionCenter ? (
              <Card>
                <BlockStack gap="300">
                  <InlineStack align="space-between" blockAlign="center">
                    <div>
                      <Text as="h2" variant="headingLg">
                        Unified decision center
                      </Text>
                      <Text as="p" tone="subdued">
                        One operating layer connecting fraud, trust, market pressure, pricing, and profit.
                      </Text>
                    </div>
                    <Badge
                      tone={
                        decisionCenter.summary.priorityLevel === "High"
                          ? "critical"
                          : "info"
                      }
                    >
                      {`${decisionCenter.summary.priorityLevel} priority`}
                    </Badge>
                  </InlineStack>
                  <Text as="p" variant="bodySm" tone="subdued">
                    {decisionCenter.summary.automationReadiness}
                  </Text>
                  <BlockStack gap="300">
                    {decisionCenter.decisions.map((decision) => (
                      <div key={decision.id} className="vs-action-card">
                        <InlineStack align="space-between" blockAlign="start" gap="300">
                          <BlockStack gap="100">
                            <InlineStack gap="200" blockAlign="center">
                              <Text as="h3" variant="headingMd">
                                {decision.title}
                              </Text>
                              <Badge tone={decision.severity === "High" ? "critical" : "attention"}>
                                {decision.module}
                              </Badge>
                            </InlineStack>
                            <Text as="p" tone="subdued">
                              {decision.rationale}
                            </Text>
                            <Text as="p" variant="bodySm">
                              {decision.recommendedAction}
                            </Text>
                            <Text as="p" variant="bodySm" tone="subdued">
                              {`${decision.confidence}% confidence | ${decision.automationPosture}`}
                            </Text>
                            <BlockStack gap="100">
                              {decision.explanationPoints.map((point) => (
                                <Text
                                  key={`${decision.id}-${point}`}
                                  as="p"
                                  variant="bodySm"
                                  tone="subdued"
                                >
                                  {point}
                                </Text>
                              ))}
                            </BlockStack>
                          </BlockStack>
                          <Button onClick={() => navigateEmbedded(decision.route)}>
                            Open
                          </Button>
                        </InlineStack>
                      </div>
                    ))}
                  </BlockStack>
                </BlockStack>
              </Card>
            ) : null}
          </InlineGrid>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <Tabs tabs={tabs} selected={selectedTab} onSelect={setSelectedTab}>
              <Box paddingBlockStart="400">
                {selectedTab === 0 ? (
                  <BlockStack gap="400">
                    <InlineGrid columns={{ xs: 1, sm: 2, md: 3 }} gap="400">
                      {kpis.map((kpi, index) => (
                        <Card key={kpi.title}>
                          <BlockStack gap="300">
                            <div className="vs-kpi-card">
                              <BlockStack gap="300">
                                <div className="vs-kpi-meta">
                                  <Text as="h3" variant="headingMd">
                                    {kpi.title}
                                  </Text>
                                  <Badge tone={kpi.tone}>{kpi.note}</Badge>
                                </div>
                                <div className="vs-kpi-value">{kpi.value}</div>
                                <div className="vs-mini-chart" aria-hidden="true">
                                  {[18, 30, 24, 38, 28].map((height, barIndex) => (
                                    <span
                                      key={`${index}-${barIndex}`}
                                      style={{ height: `${height + index * 2}px` }}
                                    />
                                  ))}
                                </div>
                              </BlockStack>
                            </div>
                          </BlockStack>
                        </Card>
                      ))}
                    </InlineGrid>
                    <Card>
                      <BlockStack gap="300">
                        <InlineStack align="space-between" blockAlign="center">
                          <Text as="h3" variant="headingMd">
                            Module drilldowns
                          </Text>
                          <Badge tone={toneForReadiness(syncHealthState?.status ?? metrics.dataState)}>
                            {labelForReadiness(syncHealthState?.status ?? metrics.dataState)}
                          </Badge>
                        </InlineStack>
                        <InlineGrid columns={{ xs: 1, md: 3 }} gap="300">
                          <Button
                            onClick={() => navigateEmbedded("/trust-abuse?focus=high-risk")}
                          >
                            Open trust & abuse
                          </Button>
                          <Button
                            onClick={() =>
                              navigateEmbedded("/competitor?focus=promotions")
                            }
                          >
                            Review market alerts
                          </Button>
                          <Button
                            onClick={() =>
                              navigateEmbedded(
                                subscription?.enabledModules?.pricingProfit
                                  ? "/pricing-profit?focus=simulation"
                                  : "/subscription"
                              )
                            }
                          >
                            {subscription?.enabledModules?.pricingProfit
                              ? "Open pricing & profit"
                              : "Unlock pricing & profit"}
                          </Button>
                        </InlineGrid>
                      </BlockStack>
                    </Card>
                  </BlockStack>
                ) : selectedTab === 1 ? (
                  <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
                    <Card>
                      <BlockStack gap="300">
                        <Text as="h3" variant="headingMd">
                          Current synced signals
                        </Text>
                        <List type="bullet">
                          <List.Item>
                            {metrics.highRiskOrders} orders currently exceed the
                            high-risk threshold.
                          </List.Item>
                          <List.Item>
                            {metrics.serialReturners} customer profiles currently show elevated
                            refund behavior based on synced order history.
                          </List.Item>
                          <List.Item>
                            {metrics.competitorPriceChanges} competitor monitoring
                            records were captured in the last 24 hours.
                          </List.Item>
                        </List>
                      </BlockStack>
                    </Card>
                    <Card>
                      <BlockStack gap="300">
                        <Text as="h3" variant="headingMd">
                          Recommended next steps
                        </Text>
                        <List type="bullet">
                          <List.Item>Review medium and high-risk orders first.</List.Item>
                          <List.Item>
                              Check whether live competitor website monitoring shows enough pressure to justify a pricing response.
                          </List.Item>
                          <List.Item>
                              Sync store data again before relying on report exports or pricing baselines.
                          </List.Item>
                        </List>
                        <InlineStack gap="300">
                          <Button
                            onClick={() =>
                              navigateEmbedded(
                                reportsEnabled
                                  ? "/reports?focus=summary"
                                  : "/subscription"
                              )
                            }
                          >
                            {reportsEnabled ? "Open weekly report" : "Unlock reports"}
                          </Button>
                          <Button
                            onClick={() =>
                              navigateEmbedded(
                                subscription?.enabledModules?.pricingProfit
                                  ? "/pricing-profit?focus=profit"
                                  : "/subscription"
                              )
                            }
                          >
                            {subscription?.enabledModules?.pricingProfit
                              ? "Review pricing & profit"
                              : "Unlock pricing & profit"}
                          </Button>
                        </InlineStack>
                      </BlockStack>
                    </Card>
                  </InlineGrid>
                ) : (
                  <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
                    <Card>
                      <BlockStack gap="300">
                        <Text as="h3" variant="headingMd">
                          Suggested next actions
                        </Text>
                        <List type="number">
                          <List.Item>Open Trust & Abuse and review flagged orders.</List.Item>
                          <List.Item>
                            Compare competitor promotions against your margin floor.
                          </List.Item>
                          <List.Item>
                            Validate AI price changes before publishing.
                          </List.Item>
                        </List>
                        <Button onClick={() => navigateEmbedded("/onboarding")}>
                          Open onboarding
                        </Button>
                      </BlockStack>
                    </Card>
                    <Card>
                      <BlockStack gap="300">
                        <Text as="h3" variant="headingMd">
                          Current suite posture
                        </Text>
                        <Text as="p" tone="subdued">
                          {metrics.summaryDetail ??
                            "This panel reflects the latest persisted sync and processing status for the store."}
                        </Text>
                      </BlockStack>
                    </Card>
                  </InlineGrid>
                )}
              </Box>
            </Tabs>
          </Card>
        </Layout.Section>
      </Layout>
      {toast ? <Toast content={toast} onDismiss={() => setToast(null)} /> : null}
    </Page>
  );
}

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
  Modal,
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

const fallbackMetrics: Metrics = {
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
  const [metrics, setMetrics] = useState<Metrics>(cachedMetrics ?? fallbackMetrics);
  const [loading, setLoading] = useState(false);
  const [selectedTab, setSelectedTab] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [registeringWebhooks, setRegisteringWebhooks] = useState(false);
  const [webhookStatus, setWebhookStatus] = useState<WebhookStatus | null>(null);
  const [launchAudit, setLaunchAudit] = useState<LaunchAudit | null>(null);
  const [decisionCenter, setDecisionCenter] = useState<DecisionCenter | null>(null);
  const [connectionHealth, setConnectionHealth] = useState<ConnectionHealth | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [actionError, setActionError] = useState<{
    title: string;
    detail: string;
    reauthorizeUrl?: string | null;
  } | null>(null);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [onboardingStep, setOnboardingStep] = useState(0);

  const fallbackReauthorizeUrl = shop
    ? `/auth/reconnect?shop=${encodeURIComponent(shop)}${
        host ? `&host=${encodeURIComponent(host)}` : ""
      }&returnTo=${encodeURIComponent(window.location.pathname)}`
    : null;

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

      if (latestJob.status === "SUCCEEDED") {
        loadMetrics();
        loadWebhookStatus();
        loadConnectionHealth();
        setToast("Live Shopify data synced into VedaSuite.");
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
    embeddedShopRequest<Metrics>("/api/dashboard/metrics", {
      timeoutMs: 30000,
    })
      .then((res) => {
        setMetrics(res);
        writeModuleCache("dashboard-metrics", res);
      })
      .catch(() => setMetrics(fallbackMetrics))
      .finally(() => setLoading(false));
  };

  const loadWebhookStatus = () => {
    embeddedShopRequest<{ result: WebhookStatus }>("/api/shopify/webhook-status", {
      timeoutMs: 30000,
    })
      .then((res) => setWebhookStatus(res.result))
      .catch(() => setWebhookStatus(null));
  };

  const loadConnectionHealth = () => {
    embeddedShopRequest<{ result: ConnectionHealth }>(
      `/api/shopify/connection-health${
        host
          ? `?host=${encodeURIComponent(host)}&returnTo=${encodeURIComponent(
              window.location.pathname
            )}`
          : ""
      }`,
      { timeoutMs: 20000 }
    )
      .then((res) => {
        setConnectionHealth(res.result);
        if (!res.result.healthy) {
          setActionError({
            title: res.result.reauthRequired
              ? "Shopify connection needs reauthorization"
              : res.result.code === "WEBHOOKS_MISSING"
              ? "Shopify webhook setup needs attention"
                : "Live sync needs attention",
            detail: res.result.message,
            reauthorizeUrl:
              res.result.reauthRequired
                ? res.result.reauthorizeUrl ?? fallbackReauthorizeUrl
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
    loadWebhookStatus();
    loadConnectionHealth();
    embeddedShopRequest<LaunchAudit>("/launch/audit", {
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
      loadConnectionHealth();
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
      loadWebhookStatus();
      loadConnectionHealth();
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

  const onboardingChecklist = useMemo(
    () => [
      {
        label: "Shopify sync webhooks are registered",
        done:
          webhookStatus != null &&
          webhookStatus.totalTracked > 0 &&
          webhookStatus.registeredCount === webhookStatus.totalTracked,
        action: "Register webhooks",
        route: null as string | null,
        run: registerWebhooks,
      },
      {
        label: "Reports and weekly intelligence are available",
        done: reportsEnabled,
        action: "Review plans",
        route: "/subscription",
      },
      {
        label: "Pricing and profit modules are enabled",
        done: !!subscription?.enabledModules?.pricingProfit,
        action: "Unlock Pro",
        route: "/subscription",
      },
      {
        label: "Launch-facing configuration checks are green",
        done: launchAudit?.checks.every((item) => item.ok) ?? false,
        action: "Open settings",
        route: "/settings",
      },
    ],
    [
      launchAudit?.checks,
      reportsEnabled,
      subscription?.enabledModules?.pricingProfit,
      webhookStatus,
    ]
  );

  const quickActions = [
    {
      title: "Review fraud queue",
      description: "Inspect risky orders, chargeback exposure, and return abuse flags.",
      route: "/trust-abuse?focus=high-risk",
      cta: "Open trust & abuse",
      tone: "critical" as const,
    },
    {
      title: "Watch the market",
      description:
        "Review monitored competitor website signals and current market-response suggestions.",
      route: "/competitor?focus=promotions",
      cta: "Open competitor intelligence",
      tone: "info" as const,
    },
    {
      title: "Review pricing baseline",
      description:
        "Validate the latest pricing baseline or recommendation before taking merchant action.",
      route: "/pricing-profit?focus=simulation",
      cta: "Open pricing & profit",
      tone: "success" as const,
      locked: !subscription?.enabledModules?.pricingProfit,
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

  const onboardingSteps = useMemo(
    () => [
      {
        title: "Connect live store signals",
        body: "Run a live sync so the suite reflects recent orders, products, and customer activity from Shopify.",
        action: "Sync live Shopify data",
        onAction: syncLiveStoreData,
      },
      {
        title: "Register background coverage",
        body: "Register Shopify sync webhooks so VedaSuite keeps refreshing signals after order and customer changes.",
        action: "Register webhooks",
        onAction: registerWebhooks,
      },
      {
        title: "Configure monitoring depth",
        body: "Open settings to tune fraud sensitivity, competitor domains, and AI operating preferences for this store.",
        action: "Open settings",
        onAction: () => navigateEmbedded("/settings"),
      },
      {
        title: "Unlock full-suite workflows",
        body: "Review plans if you want pricing, shopper credit, reports, or profit optimization available to the team.",
        action: "Review plans",
        onAction: () => navigateEmbedded("/subscription"),
      },
    ],
    [navigateEmbedded]
  );

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
          <Banner
            title={
              metrics.summaryTitle ??
              (metrics.lastSyncStatus === "SUCCEEDED"
                ? "Store signals are synced"
                : "Run first sync to populate store signals")
            }
            tone={metrics.lastSyncStatus === "SUCCEEDED" ? "info" : "warning"}
          >
            <p>
              {metrics.summaryDetail ??
                (metrics.lastSyncStatus === "SUCCEEDED"
                  ? `VedaSuite is showing live order, pricing, and timeline outputs${metrics.lastSyncAt ? ` from the latest sync at ${new Date(metrics.lastSyncAt).toLocaleString()}` : ""}.`
                  : "The dashboard is connected, but merchant intelligence remains limited until the first successful sync completes.")}
            </p>
            <Box paddingBlockStart="300">
              <Button onClick={() => setOnboardingOpen(true)}>Open onboarding guide</Button>
            </Box>
          </Banner>
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
                      {subscription?.planName ?? "TRIAL"} plan coverage is active for
                      your connected Shopify store.
                    </Text>
                  </div>
                  <InlineStack gap="200">
                    <Badge tone="success">Connected</Badge>
                    {connectionHealth && !connectionHealth.healthy ? (
                      <Badge tone="attention">{connectionHealth.code}</Badge>
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
                      {webhookStatus
                        ? `${webhookStatus.registeredCount}/${webhookStatus.totalTracked}`
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
                            <Badge tone={action.tone}>
                              {action.locked ? "Upgrade required" : "Ready"}
                            </Badge>
                          </InlineStack>
                          <Text as="p" tone="subdued">
                            {action.description}
                          </Text>
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
                      Launch readiness checklist
                    </Text>
                    <Text as="p" tone="subdued">
                      Keep this store configured for review, sync health, and full-suite operations.
                    </Text>
                  </div>
                  <Badge tone="info">
                    {`${onboardingChecklist.filter((item) => item.done).length}/${onboardingChecklist.length} complete`}
                  </Badge>
                </InlineStack>
                <BlockStack gap="300">
                  {onboardingChecklist.map((item) => (
                    <div key={item.label} className="vs-action-card">
                      <InlineStack align="space-between" blockAlign="center">
                        <BlockStack gap="100">
                          <Text as="h3" variant="headingMd">
                            {item.label}
                          </Text>
                          <Badge tone={item.done ? "success" : "attention"}>
                            {item.done ? "Complete" : "Needs attention"}
                          </Badge>
                        </BlockStack>
                        <Button
                          variant={item.done ? "secondary" : "primary"}
                          onClick={() => {
                            if (item.run) {
                              void item.run();
                              return;
                            }

                            if (item.route) {
                              navigateEmbedded(item.route);
                            }
                          }}
                        >
                          {item.done ? "Reviewed" : item.action}
                        </Button>
                      </InlineStack>
                    </div>
                  ))}
                </BlockStack>
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
                          <Badge tone="info">Connected suite</Badge>
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
                        <Button onClick={() => setOnboardingOpen(true)}>
                          Revisit onboarding guide
                        </Button>
                      </BlockStack>
                    </Card>
                    <Card>
                      <BlockStack gap="300">
                        <Text as="h3" variant="headingMd">
                          Current suite posture
                        </Text>
                        <Text as="p" tone="subdued">
                          Your store is connected. Outputs become more specific as syncs, webhook coverage, and competitor monitoring complete.
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
      <Modal
        open={onboardingOpen}
        onClose={() => setOnboardingOpen(false)}
        title="VedaSuite onboarding guide"
        primaryAction={{
          content: onboardingSteps[onboardingStep]?.action ?? "Continue",
          onAction: () => {
            onboardingSteps[onboardingStep]?.onAction();
          },
        }}
        secondaryActions={[
          ...(onboardingStep > 0
            ? [
                {
                  content: "Back",
                  onAction: () => setOnboardingStep((step) => Math.max(0, step - 1)),
                },
              ]
            : []),
          ...(onboardingStep < onboardingSteps.length - 1
            ? [
                {
                  content: "Next step",
                  onAction: () =>
                    setOnboardingStep((step) =>
                      Math.min(onboardingSteps.length - 1, step + 1)
                    ),
                },
              ]
            : []),
        ]}
      >
        <Modal.Section>
          <BlockStack gap="400">
            <InlineStack align="space-between" blockAlign="center">
              <Text as="p" variant="bodySm" tone="subdued">
                {`Step ${onboardingStep + 1} of ${onboardingSteps.length}`}
              </Text>
              <Badge tone="info">Embedded setup</Badge>
            </InlineStack>
            <Text as="h3" variant="headingLg">
              {onboardingSteps[onboardingStep]?.title}
            </Text>
            <Text as="p" tone="subdued">
              {onboardingSteps[onboardingStep]?.body}
            </Text>
            <InlineGrid columns={{ xs: 1, sm: 4 }} gap="200">
              {onboardingSteps.map((step, index) => (
                <div key={step.title} className="vs-signal-stat">
                  <Text as="p" variant="bodySm" tone="subdued">
                    {`Step ${index + 1}`}
                  </Text>
                  <Text as="p">{step.title}</Text>
                  <Badge tone={index === onboardingStep ? "info" : "success"}>
                    {index === onboardingStep ? "Current" : "Guide"}
                  </Badge>
                </div>
              ))}
            </InlineGrid>
          </BlockStack>
        </Modal.Section>
      </Modal>
      {toast ? <Toast content={toast} onDismiss={() => setToast(null)} /> : null}
    </Page>
  );
}

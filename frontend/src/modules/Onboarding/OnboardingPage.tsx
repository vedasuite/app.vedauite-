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
  ProgressBar,
  Spinner,
  Text,
  Toast,
} from "@shopify/polaris";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useEmbeddedNavigation } from "../../hooks/useEmbeddedNavigation";
import { embeddedShopRequest } from "../../lib/embeddedShopRequest";
import { useAppBridge } from "../../shopifyAppBridge";

type OnboardingState = {
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
  progress: {
    completedSteps: number;
    totalSteps: number;
    percent: number;
  };
  steps: Array<{
    key: string;
    label: string;
    complete: boolean;
    active: boolean;
    locked: boolean;
    description: string;
    helper: string;
    ctaLabel: string;
  }>;
  hero: {
    headline: string;
    subtext: string;
    benefits: string[];
  };
  stateSummary: {
    tone: "success" | "info" | "attention" | "critical";
    title: string;
    description: string;
    badge: string;
  };
  moduleAvailability: Array<{
    key: "trustAbuse" | "competitor" | "pricingProfit";
    title: string;
    summary: string;
    route: string;
    available: boolean;
    lockReason: string | null;
  }>;
  sampleInsights: Array<{
    key: string;
    module: string;
    badge: string;
    title: string;
    detail: string;
  }>;
  planSummary: {
    planName: string;
    billingActive: boolean;
    starterModule: string | null;
    unlockedFeatures: string[];
    lockedFeatures: string[];
    manageRoute: string;
  };
  privacySummary: {
    title: string;
    description: string;
    bullets: string[];
  };
  connectionHealthy: boolean;
  webhooksReady: boolean;
  syncStatus: string;
  syncReason: string;
  hasAnyRawData: boolean;
  hasAnyProcessedData: boolean;
  currentPlan: string;
  billingActive: boolean;
  limitedDataReason: string | null;
  recommendedModuleRoute: string;
};

type OnboardingResponse = {
  onboarding: OnboardingState;
};

type SyncJobResponse = {
  result: {
    id?: string;
    jobId?: string;
    status: string;
    errorMessage?: string | null;
  } | null;
};

function redirectTopLevel(url: string) {
  if (window.top && window.top !== window) {
    window.top.location.href = url;
    return;
  }
  window.location.href = url;
}

function scrollToSection(id: string) {
  document.getElementById(id)?.scrollIntoView({
    behavior: "smooth",
    block: "start",
  });
}

function toneForStep(step: OnboardingState["steps"][number]) {
  if (step.complete) {
    return "success";
  }
  if (step.locked) {
    return "info";
  }
  return step.active ? "attention" : "info";
}

function labelForStep(step: OnboardingState["steps"][number]) {
  if (step.complete) {
    return "Complete";
  }
  if (step.locked) {
    return "Locked";
  }
  return step.active ? "Current" : "Next";
}

function ModuleIcon({ moduleKey }: { moduleKey: string }) {
  const path =
    moduleKey === "trustAbuse"
      ? "M18 5l7 4v6c0 5-3.4 9.4-8 10.8C12.4 24.4 9 20 9 15V9l9-4zm0 5l-4 1.8V15c0 2.8 1.7 5.4 4 6.6 2.3-1.2 4-3.8 4-6.6v-3.2L18 10zm0 2.2 1.7 3.1 3.3.5-2.4 2.3.6 3.3-3-1.6-3 1.6.6-3.3-2.4-2.3 3.3-.5L18 12.2z"
      : moduleKey === "competitor"
      ? "M6 7h12l2 5v8H4v-8l2-5zm2 2-1.2 3H19.2L18 9H8zm-1 5v4h10v-4H7zm12 0v4h2v-4h-2z"
      : "M6 6h16v4H6V6zm2 6h12v8H8v-8zm3 2v4h2v-4h-2zm4-3h2v7h-2v-7z";

  return (
    <span
      aria-hidden="true"
      style={{
        display: "inline-flex",
        width: 40,
        height: 40,
        borderRadius: 12,
        alignItems: "center",
        justifyContent: "center",
        background:
          moduleKey === "trustAbuse"
            ? "#fde68a"
            : moduleKey === "competitor"
            ? "#bfdbfe"
            : "#bbf7d0",
      }}
    >
      <svg viewBox="0 0 28 28" width="22" height="22" fill="#111827">
        <path d={path} />
      </svg>
    </span>
  );
}

export function OnboardingPage() {
  const { navigateEmbedded } = useEmbeddedNavigation();
  const { host, shop } = useAppBridge();
  const [onboarding, setOnboarding] = useState<OnboardingState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reauthorizeUrl = shop
    ? `/auth/reconnect?shop=${encodeURIComponent(shop)}${
        host ? `&host=${encodeURIComponent(host)}` : ""
      }&returnTo=${encodeURIComponent("/onboarding")}`
    : null;

  const loadOnboarding = useCallback(async () => {
    const response = await embeddedShopRequest<OnboardingResponse>(
      "/api/dashboard/onboarding",
      { timeoutMs: 30000 }
    );
    setOnboarding(response.onboarding);
    return response.onboarding;
  }, []);

  useEffect(() => {
    let mounted = true;

    loadOnboarding()
      .catch((nextError) => {
        if (!mounted) return;
        setError(
          nextError instanceof Error
            ? nextError.message
            : "Unable to load the onboarding state."
        );
      })
      .finally(() => {
        if (!mounted) return;
        setLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, [loadOnboarding]);

  const pollSync = useCallback(
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
          await loadOnboarding();
          setToast(
            latestJob.status === "READY_WITH_DATA"
              ? "Analysis started successfully. VedaSuite is ready with live store signals."
              : latestJob.status === "SUCCEEDED_PROCESSING_PENDING"
              ? "Data sync completed. VedaSuite is still finalizing the first insights."
              : "Sync completed, but Shopify returned limited store history. Some insights will stay limited for now."
          );
          return;
        }

        if (latestJob.status === "FAILED") {
          throw new Error(latestJob.errorMessage ?? "Shopify sync job failed.");
        }

        await new Promise((resolve) => setTimeout(resolve, 1500));
      }

      throw new Error("Sync is still running. Check back in a moment.");
    },
    [loadOnboarding]
  );

  const syncLiveStoreData = useCallback(async () => {
    setBusyAction("SYNC_LIVE_DATA");
    setError(null);

    try {
      const response = await embeddedShopRequest<SyncJobResponse>("/api/shopify/sync", {
        method: "POST",
        body: {
          host,
          returnTo: "/onboarding",
        },
        timeoutMs: 20000,
      });
      await pollSync(response.result?.jobId ?? response.result?.id ?? null);
    } catch (nextError) {
      setError(
        nextError instanceof Error
          ? nextError.message
          : "Unable to sync Shopify data right now."
      );
    } finally {
      setBusyAction(null);
    }
  }, [host, pollSync]);

  const handleStartAnalysis = useCallback(async () => {
    if (!onboarding) return;

    if (!onboarding.connectionHealthy && reauthorizeUrl) {
      redirectTopLevel(reauthorizeUrl);
      return;
    }

    if (
      onboarding.syncStatus === "SYNC_REQUIRED" ||
      onboarding.syncStatus === "NOT_CONNECTED" ||
      onboarding.syncStatus === "FAILED"
    ) {
      await syncLiveStoreData();
      return;
    }

    if (
      onboarding.syncStatus === "SYNC_IN_PROGRESS" ||
      onboarding.syncStatus === "SYNC_COMPLETED_PROCESSING_PENDING"
    ) {
      scrollToSection("onboarding-progress");
      return;
    }

    navigateEmbedded(onboarding.recommendedModuleRoute);
  }, [navigateEmbedded, onboarding, reauthorizeUrl, syncLiveStoreData]);

  const markComplete = useCallback(async () => {
    setBusyAction("COMPLETE");
    setError(null);
    try {
      const response = await embeddedShopRequest<OnboardingResponse>(
        "/api/dashboard/onboarding/complete",
        {
          method: "POST",
          timeoutMs: 20000,
        }
      );
      setOnboarding(response.onboarding);
      setToast("Onboarding completed.");
    } catch (nextError) {
      setError(
        nextError instanceof Error
          ? nextError.message
          : "Unable to update onboarding state."
      );
    } finally {
      setBusyAction(null);
    }
  }, []);

  const dismiss = useCallback(async () => {
    setBusyAction("DISMISS");
    setError(null);
    try {
      const response = await embeddedShopRequest<OnboardingResponse>(
        "/api/dashboard/onboarding/dismiss",
        {
          method: "POST",
          timeoutMs: 20000,
        }
      );
      setOnboarding(response.onboarding);
      setToast("Onboarding guide dismissed for now.");
    } catch (nextError) {
      setError(
        nextError instanceof Error
          ? nextError.message
          : "Unable to update onboarding state."
      );
    } finally {
      setBusyAction(null);
    }
  }, []);

  const recommendedModule = useMemo(() => {
    if (!onboarding) {
      return null;
    }

    return (
      onboarding.moduleAvailability.find(
        (module) => module.route === onboarding.recommendedModuleRoute
      ) ?? onboarding.moduleAvailability[0] ?? null
    );
  }, [onboarding]);

  if (loading) {
    return (
      <Page
        title="Getting started"
        subtitle="Loading the current VedaSuite onboarding state for this store."
      >
        <Card>
          <InlineStack align="center">
            <Spinner accessibilityLabel="Loading onboarding state" size="large" />
          </InlineStack>
        </Card>
      </Page>
    );
  }

  if (!onboarding) {
    return (
      <Page title="Getting started" subtitle="Unable to load onboarding state.">
        <Banner title="Onboarding unavailable" tone="critical">
          <p>{error ?? "The backend did not return onboarding guidance."}</p>
        </Banner>
      </Page>
    );
  }

  return (
    <Page
      title="Guided onboarding"
      subtitle="Understand what VedaSuite does, sync live store data, review the first insights, and confirm the right plan."
    >
      <Layout>
        {error ? (
          <Layout.Section>
            <Banner title="Onboarding action failed" tone="critical">
              <BlockStack gap="200">
                <p>{error}</p>
                <InlineStack gap="300">
                  <Button onClick={() => void loadOnboarding()}>Retry</Button>
                  {reauthorizeUrl ? (
                    <Button
                      variant="primary"
                      onClick={() => redirectTopLevel(reauthorizeUrl)}
                    >
                      Reconnect Shopify
                    </Button>
                  ) : null}
                </InlineStack>
              </BlockStack>
            </Banner>
          </Layout.Section>
        ) : null}

        <Layout.Section>
          <Card>
            <BlockStack gap="500">
              <BlockStack gap="300">
                <Badge tone="info">Shopify onboarding</Badge>
                <Text as="h1" variant="heading2xl">
                  {onboarding.hero.headline}
                </Text>
                <Text as="p" tone="subdued" variant="bodyLg">
                  {onboarding.hero.subtext}
                </Text>
              </BlockStack>

              <InlineGrid columns={{ xs: 1, md: 3 }} gap="300">
                {onboarding.hero.benefits.map((benefit) => (
                  <div key={benefit} className="vs-signal-stat">
                    <Text as="p" variant="headingSm">
                      {benefit}
                    </Text>
                  </div>
                ))}
              </InlineGrid>

              <InlineStack gap="300" wrap>
                <Button
                  variant="primary"
                  onClick={() => void handleStartAnalysis()}
                  loading={busyAction === "SYNC_LIVE_DATA"}
                  disabled={onboarding.syncStatus === "SYNC_IN_PROGRESS"}
                >
                  Start Analysis
                </Button>
                <Button onClick={() => scrollToSection("sample-insights")}>
                  View Demo Insights
                </Button>
                <Button onClick={() => navigateEmbedded("/subscription")}>
                  View Pricing
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Banner title={onboarding.stateSummary.title} tone={onboarding.stateSummary.tone}>
            <BlockStack gap="200">
              <Text as="p">{onboarding.stateSummary.description}</Text>
              <InlineStack gap="300">
                <Badge tone={onboarding.stateSummary.tone}>
                  {onboarding.stateSummary.badge}
                </Badge>
                <Badge tone={onboarding.connectionHealthy ? "success" : "critical"}>
                  {onboarding.connectionHealthy ? "Connection healthy" : "Reconnect Shopify"}
                </Badge>
                <Badge tone={onboarding.webhooksReady ? "success" : "attention"}>
                  {onboarding.webhooksReady ? "Webhooks ready" : "Webhook setup pending"}
                </Badge>
                <Badge tone="info">{`Plan: ${onboarding.currentPlan}`}</Badge>
              </InlineStack>
            </BlockStack>
          </Banner>
        </Layout.Section>

        <Layout.Section>
          <InlineGrid columns={{ xs: 1, md: 3 }} gap="400">
            {onboarding.moduleAvailability.map((module) => (
              <Card key={module.key}>
                <BlockStack gap="300">
                  <InlineStack gap="300" blockAlign="center">
                    <ModuleIcon moduleKey={module.key} />
                    <BlockStack gap="100">
                      <Text as="h2" variant="headingMd">
                        {module.title}
                      </Text>
                      <Badge tone={module.available ? "success" : "attention"}>
                        {module.available ? "Included in your plan" : "Plan locked"}
                      </Badge>
                    </BlockStack>
                  </InlineStack>

                  <List type="bullet">
                    {module.key === "trustAbuse" ? (
                      <>
                        <List.Item>Detect refund abuse</List.Item>
                        <List.Item>Flag risky customers</List.Item>
                        <List.Item>Reduce chargebacks</List.Item>
                      </>
                    ) : module.key === "competitor" ? (
                      <>
                        <List.Item>Track competitor pricing</List.Item>
                        <List.Item>Monitor promotions</List.Item>
                        <List.Item>Detect ad activity</List.Item>
                      </>
                    ) : (
                      <>
                        <List.Item>Suggest optimal pricing</List.Item>
                        <List.Item>Balance margin vs demand</List.Item>
                        <List.Item>Improve conversion</List.Item>
                      </>
                    )}
                  </List>

                  <Text as="p" tone="subdued">
                    {module.available ? module.summary : module.lockReason}
                  </Text>

                  <InlineStack gap="300">
                    <Button onClick={() => scrollToSection(`insight-${module.key}`)}>
                      View Sample Insight
                    </Button>
                    <Button
                      disabled={!module.available}
                      onClick={() =>
                        navigateEmbedded(module.available ? module.route : "/subscription")
                      }
                    >
                      {module.available ? "Open module" : "Manage plan"}
                    </Button>
                  </InlineStack>
                </BlockStack>
              </Card>
            ))}
          </InlineGrid>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingLg">
                    Guided onboarding flow
                  </Text>
                  <Text as="p" tone="subdued">
                    VedaSuite progresses through one step at a time based on live backend state.
                  </Text>
                </BlockStack>
                <Badge tone="info">
                  {`${onboarding.progress.completedSteps}/${onboarding.progress.totalSteps} complete`}
                </Badge>
              </InlineStack>

              <div id="onboarding-progress">
                <ProgressBar progress={onboarding.progress.percent} size="small" />
              </div>

              <InlineGrid columns={{ xs: 1, md: 2 }} gap="300">
                {onboarding.steps.map((step) => (
                  <Card key={step.key}>
                    <BlockStack gap="200">
                      <InlineStack align="space-between" blockAlign="start">
                        <BlockStack gap="100">
                          <Text as="h3" variant="headingMd">
                            {step.label}
                          </Text>
                          <Text as="p" tone="subdued">
                            {step.description}
                          </Text>
                        </BlockStack>
                        <Badge tone={toneForStep(step)}>{labelForStep(step)}</Badge>
                      </InlineStack>
                      <Text as="p" variant="bodySm" tone="subdued">
                        {step.helper}
                      </Text>
                    </BlockStack>
                  </Card>
                ))}
              </InlineGrid>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingLg">
                    Sample Insights Preview
                  </Text>
                  <Text as="p" tone="subdued">
                    These examples show the kinds of insights VedaSuite surfaces once sync and processing are complete.
                  </Text>
                </BlockStack>
                {onboarding.limitedDataReason ? (
                  <Badge tone="warning">Limited Data</Badge>
                ) : null}
              </InlineStack>

              <div id="sample-insights" />

              <InlineGrid columns={{ xs: 1, md: 3 }} gap="300">
                {onboarding.sampleInsights.map((insight) => (
                  <Card key={insight.key}>
                    <BlockStack gap="200">
                      <InlineStack align="space-between" blockAlign="center">
                        <Text as="p" variant="bodySm" tone="subdued">
                          {insight.module}
                        </Text>
                        <Badge tone={insight.badge === "Sample" ? "info" : "success"}>
                          {insight.badge}
                        </Badge>
                      </InlineStack>
                      <div
                        id={`insight-${
                          insight.module === "Fraud Intelligence"
                            ? "trustAbuse"
                            : insight.module === "Competitor Intelligence"
                            ? "competitor"
                            : "pricingProfit"
                        }`}
                      />
                      <Text as="h3" variant="headingMd">
                        {insight.title}
                      </Text>
                      <Text as="p" tone="subdued">
                        {insight.detail}
                      </Text>
                    </BlockStack>
                  </Card>
                ))}
              </InlineGrid>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <BlockStack gap="100">
                    <Text as="h2" variant="headingLg">
                      Current plan
                    </Text>
                    <Text as="p" tone="subdued">
                      Plan state comes from backend-confirmed Shopify billing data.
                    </Text>
                  </BlockStack>
                  <Badge tone={onboarding.planSummary.billingActive ? "success" : "attention"}>
                    {onboarding.planSummary.planName}
                  </Badge>
                </InlineStack>

                {onboarding.planSummary.starterModule ? (
                  <Text as="p" tone="subdued">
                    Starter module: {onboarding.planSummary.starterModule}
                  </Text>
                ) : null}

                <BlockStack gap="100">
                  <Text as="h3" variant="headingSm">
                    Features unlocked
                  </Text>
                  <List type="bullet">
                    {onboarding.planSummary.unlockedFeatures.length > 0 ? (
                      onboarding.planSummary.unlockedFeatures.map((feature) => (
                        <List.Item key={feature}>{feature}</List.Item>
                      ))
                    ) : (
                      <List.Item>
                        Guided onboarding and plan management remain available while you evaluate the app.
                      </List.Item>
                    )}
                  </List>
                </BlockStack>

                <BlockStack gap="100">
                  <Text as="h3" variant="headingSm">
                    Features locked
                  </Text>
                  <List type="bullet">
                    {onboarding.planSummary.lockedFeatures.length > 0 ? (
                      onboarding.planSummary.lockedFeatures.map((feature) => (
                        <List.Item key={feature}>{feature}</List.Item>
                      ))
                    ) : (
                      <List.Item>No core modules are locked on this plan.</List.Item>
                    )}
                  </List>
                </BlockStack>

                <InlineStack gap="300">
                  <Button
                    variant="primary"
                    onClick={() => navigateEmbedded(onboarding.planSummary.manageRoute)}
                  >
                    Manage Plan
                  </Button>
                  {recommendedModule ? (
                    <Button
                      onClick={() => navigateEmbedded(recommendedModule.route)}
                      disabled={!recommendedModule.available}
                    >
                      {recommendedModule.available
                        ? `Open ${recommendedModule.title}`
                        : "Open locked module"}
                    </Button>
                  ) : null}
                </InlineStack>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingLg">
                  {onboarding.privacySummary.title}
                </Text>
                <Text as="p" tone="subdued">
                  {onboarding.privacySummary.description}
                </Text>
                <List type="bullet">
                  {onboarding.privacySummary.bullets.map((bullet) => (
                    <List.Item key={bullet}>{bullet}</List.Item>
                  ))}
                </List>
              </BlockStack>
            </Card>
          </InlineGrid>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <InlineStack align="space-between" blockAlign="center">
              <BlockStack gap="100">
                <Text as="h2" variant="headingMd">
                  Finish onboarding
                </Text>
                <Text as="p" tone="subdued">
                  Complete onboarding once you have synced the store, reviewed the first workflow, and confirmed the current plan.
                </Text>
              </BlockStack>
              <InlineStack gap="300">
                <Button
                  variant="primary"
                  onClick={() => void markComplete()}
                  loading={busyAction === "COMPLETE"}
                  disabled={!onboarding.hasAnyRawData}
                >
                  Complete onboarding
                </Button>
                {onboarding.canDismiss ? (
                  <Button
                    onClick={() => void dismiss()}
                    loading={busyAction === "DISMISS"}
                  >
                    Hide for now
                  </Button>
                ) : null}
              </InlineStack>
            </InlineStack>
          </Card>
        </Layout.Section>
      </Layout>
      {toast ? <Toast content={toast} onDismiss={() => setToast(null)} /> : null}
    </Page>
  );
}

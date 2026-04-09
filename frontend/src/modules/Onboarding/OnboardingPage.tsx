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
import { useCallback, useMemo, useState } from "react";
import { useEmbeddedNavigation } from "../../hooks/useEmbeddedNavigation";
import { useOnboardingState } from "../../hooks/useOnboardingState";
import type { OnboardingModuleKey } from "../../providers/OnboardingProvider";
import { embeddedShopRequest } from "../../lib/embeddedShopRequest";
import { useAppBridge } from "../../shopifyAppBridge";

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

function ModuleIcon({ moduleKey }: { moduleKey: OnboardingModuleKey }) {
  const path =
    moduleKey === "trustAbuse"
      ? "M18 5l7 4v6c0 5-3.4 9.4-8 10.8C12.4 24.4 9 20 9 15V9l9-4zm0 5l-4 1.8V15c0 2.8 1.7 5.4 4 6.6 2.3-1.2 4-3.8 4-6.6v-3.2L18 10z"
      : moduleKey === "competitor"
      ? "M6 7h12l2 5v8H4v-8l2-5zm2 2-1.2 3H19.2L18 9H8zm-1 5v4h10v-4H7z"
      : "M6 6h16v4H6V6zm2 6h12v8H8v-8zm3 2v4h2v-4h-2zm4-3h2v7h-2v-7z";

  const background =
    moduleKey === "trustAbuse"
      ? "#fde68a"
      : moduleKey === "competitor"
      ? "#bfdbfe"
      : "#bbf7d0";

  return (
    <span
      aria-hidden="true"
      style={{
        display: "inline-flex",
        width: 42,
        height: 42,
        borderRadius: 12,
        alignItems: "center",
        justifyContent: "center",
        background,
      }}
    >
      <svg viewBox="0 0 28 28" width="22" height="22" fill="#111827">
        <path d={path} />
      </svg>
    </span>
  );
}

function stepTone(step: {
  complete: boolean;
  locked: boolean;
  active: boolean;
}) {
  if (step.complete) return "success";
  if (step.locked) return "info";
  return step.active ? "attention" : "info";
}

function stepLabel(step: {
  complete: boolean;
  locked: boolean;
  active: boolean;
}) {
  if (step.complete) return "Complete";
  if (step.locked) return "Locked";
  return step.active ? "Current" : "Next";
}

export function OnboardingPage() {
  const { navigateEmbedded } = useEmbeddedNavigation();
  const { host, shop } = useAppBridge();
  const {
    onboarding,
    loading,
    error,
    refresh,
    selectModule,
    markInsightViewed,
    confirmPlan,
  } = useOnboardingState();
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const reauthorizeUrl = shop
    ? `/auth/reconnect?shop=${encodeURIComponent(shop)}${
        host ? `&host=${encodeURIComponent(host)}` : ""
      }&returnTo=${encodeURIComponent("/onboarding")}`
    : null;

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
          await refresh();
          setToast(
            latestJob.status === "READY_WITH_DATA"
              ? "Store synced successfully. Continue to choose your first workflow."
              : latestJob.status === "SUCCEEDED_PROCESSING_PENDING"
              ? "Store synced. VedaSuite is still preparing the first insights."
              : "Store synced, but Shopify returned limited historical data."
          );
          return;
        }

        if (latestJob.status === "FAILED") {
          throw new Error(latestJob.errorMessage ?? "Shopify sync failed.");
        }

        await new Promise((resolve) => setTimeout(resolve, 1500));
      }

      throw new Error("Sync is still running. Check back in a moment.");
    },
    [refresh]
  );

  const syncLiveStoreData = useCallback(async () => {
    setBusyAction("SYNC_LIVE_DATA");
    setActionError(null);

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
      setActionError(
        nextError instanceof Error
          ? nextError.message
          : "Unable to sync Shopify data right now."
      );
    } finally {
      setBusyAction(null);
    }
  }, [host, pollSync]);

  const registerWebhooks = useCallback(async () => {
    setBusyAction("REGISTER_WEBHOOKS");
    setActionError(null);

    try {
      await embeddedShopRequest("/api/shopify/register-webhooks", {
        method: "POST",
        body: {
          host,
          returnTo: "/onboarding",
        },
        timeoutMs: 90000,
      });
      await refresh();
      setToast("Required Shopify webhooks are now registered.");
    } catch (nextError) {
      setActionError(
        nextError instanceof Error
          ? nextError.message
          : "Unable to register required Shopify webhooks."
      );
    } finally {
      setBusyAction(null);
    }
  }, [host, refresh]);

  const handleSelectModule = useCallback(
    async (moduleKey: OnboardingModuleKey) => {
      setBusyAction(`SELECT_${moduleKey}`);
      setActionError(null);
      try {
        await selectModule(moduleKey);
        setToast("Starting module selected.");
      } catch (nextError) {
        setActionError(
          nextError instanceof Error
            ? nextError.message
            : "Unable to select the starting module."
        );
      } finally {
        setBusyAction(null);
      }
    },
    [selectModule]
  );

  const openFirstInsight = useCallback(
    async (moduleKey?: OnboardingModuleKey | null, route?: string | null) => {
      if (!route) {
        return;
      }

      setBusyAction("VIEW_FIRST_INSIGHT");
      setActionError(null);
      try {
        await markInsightViewed(moduleKey ?? undefined);
        navigateEmbedded(route);
      } catch (nextError) {
        setActionError(
          nextError instanceof Error
            ? nextError.message
            : "Unable to open the first insight."
        );
      } finally {
        setBusyAction(null);
      }
    },
    [markInsightViewed, navigateEmbedded]
  );

  const handleConfirmPlan = useCallback(async () => {
    setBusyAction("CONFIRM_PLAN");
    setActionError(null);
    try {
      const nextOnboarding = await confirmPlan();
      setToast("Onboarding complete. Redirecting to the dashboard.");
      navigateEmbedded(nextOnboarding.canAccessDashboard ? "/dashboard" : "/onboarding");
    } catch (nextError) {
      setActionError(
        nextError instanceof Error
          ? nextError.message
          : "Unable to confirm the current plan."
      );
    } finally {
      setBusyAction(null);
    }
  }, [confirmPlan, navigateEmbedded]);

  const handlePrimaryAction = useCallback(async () => {
    if (!onboarding) return;

    switch (onboarding.primaryAction.key) {
      case "RECONNECT_SHOPIFY":
        if (reauthorizeUrl) {
          redirectTopLevel(reauthorizeUrl);
        }
        return;
      case "SYNC_LIVE_DATA":
        await syncLiveStoreData();
        return;
      case "CHOOSE_MODULE":
        scrollToSection("module-selection");
        return;
      case "VIEW_FIRST_INSIGHT":
        await openFirstInsight(
          onboarding.selectedModule,
          onboarding.selectedModuleRoute
        );
        return;
      case "CONFIRM_PLAN":
        await handleConfirmPlan();
        return;
      default:
        navigateEmbedded("/dashboard");
        return;
    }
  }, [
    handleConfirmPlan,
    navigateEmbedded,
    onboarding,
    openFirstInsight,
    reauthorizeUrl,
    syncLiveStoreData,
  ]);

  const activeStep = useMemo(
    () => onboarding?.steps.find((step) => step.active) ?? null,
    [onboarding]
  );

  if (loading) {
    return (
      <Page title="Onboarding" subtitle="Loading the store onboarding state.">
        <Card>
          <InlineStack align="center">
            <Spinner accessibilityLabel="Loading onboarding" size="large" />
          </InlineStack>
        </Card>
      </Page>
    );
  }

  if (!onboarding) {
    return (
      <Page title="Onboarding" subtitle="Unable to load onboarding state.">
        <Banner title="Onboarding unavailable" tone="critical">
          <p>{error ?? "The onboarding state could not be loaded."}</p>
        </Banner>
      </Page>
    );
  }

  const heroSecondaryAction =
    onboarding.primaryAction.key === "CONFIRM_PLAN"
      ? {
          label: "Manage Plan",
          onClick: () => navigateEmbedded("/subscription"),
        }
      : onboarding.primaryAction.key === "VIEW_FIRST_INSIGHT" &&
        onboarding.selectedModuleRoute
      ? {
          label: "Manage Plan",
          onClick: () => navigateEmbedded("/subscription"),
        }
      : null;

  return (
    <Page
      title="Onboarding"
      subtitle="A guided setup flow for connection, module selection, first insight review, and plan confirmation."
    >
      <Layout>
        {actionError ? (
          <Layout.Section>
            <Banner title="Onboarding action failed" tone="critical">
              <BlockStack gap="200">
                <p>{actionError}</p>
                <InlineStack gap="300">
                  <Button onClick={() => void refresh()}>Refresh state</Button>
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
                <Badge tone="info">Guided onboarding</Badge>
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

              <InlineStack gap="300">
                <Button
                  variant="primary"
                  onClick={() => void handlePrimaryAction()}
                  loading={
                    busyAction === "SYNC_LIVE_DATA" ||
                    busyAction === "VIEW_FIRST_INSIGHT" ||
                    busyAction === "CONFIRM_PLAN"
                  }
                >
                  {onboarding.primaryAction.key === "CHOOSE_MODULE"
                    ? "Choose a module"
                    : onboarding.primaryAction.label}
                </Button>
                {heroSecondaryAction ? (
                  <Button onClick={heroSecondaryAction.onClick}>
                    {heroSecondaryAction.label}
                  </Button>
                ) : null}
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Banner title={onboarding.stateSummary.title} tone={onboarding.stateSummary.tone}>
            <p>{onboarding.stateSummary.description}</p>
          </Banner>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h2" variant="headingLg">
                  Onboarding progress
                </Text>
                <Badge tone="info">
                  {`${onboarding.progress.completedSteps}/${onboarding.progress.totalSteps} complete`}
                </Badge>
              </InlineStack>
              <ProgressBar progress={onboarding.progress.percent} size="small" />
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
                        <Badge tone={stepTone(step)}>{stepLabel(step)}</Badge>
                      </InlineStack>
                      <Text as="p" variant="bodySm" tone="subdued">
                        {step.helper}
                      </Text>
                      {step.active ? (
                        <Button
                          variant="primary"
                          onClick={() => void handlePrimaryAction()}
                          loading={
                            busyAction === "SYNC_LIVE_DATA" ||
                            busyAction === "VIEW_FIRST_INSIGHT" ||
                            busyAction === "CONFIRM_PLAN"
                          }
                        >
                          {onboarding.primaryAction.key === "CHOOSE_MODULE"
                            ? "Choose a module"
                            : step.ctaLabel}
                        </Button>
                      ) : null}
                    </BlockStack>
                  </Card>
                ))}
              </InlineGrid>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <div id="module-selection" />
          <InlineGrid columns={{ xs: 1, md: 3 }} gap="400">
            {onboarding.moduleOverview.map((module) => (
              <Card key={module.key}>
                <BlockStack gap="300">
                  <InlineStack gap="300" blockAlign="center">
                    <ModuleIcon moduleKey={module.key} />
                    <BlockStack gap="100">
                      <Text as="h2" variant="headingMd">
                        {module.title}
                      </Text>
                      <Badge tone={module.available ? "success" : "attention"}>
                        {module.available ? "Available" : "Locked"}
                      </Badge>
                    </BlockStack>
                  </InlineStack>
                  <List type="bullet">
                    {module.benefits.map((benefit) => (
                      <List.Item key={benefit}>{benefit}</List.Item>
                    ))}
                  </List>
                  <Text as="p" tone="subdued">
                    {module.available ? module.summary : module.lockReason}
                  </Text>
                  <Button
                    variant={onboarding.selectedModule === module.key ? "primary" : "secondary"}
                    loading={busyAction === `SELECT_${module.key}`}
                    onClick={() =>
                      module.available
                        ? void handleSelectModule(module.key)
                        : navigateEmbedded("/subscription")
                    }
                  >
                    {module.available
                      ? onboarding.selectedModule === module.key
                        ? "Selected starting module"
                        : `Start with ${module.title}`
                      : "Manage plan"}
                  </Button>
                </BlockStack>
              </Card>
            ))}
          </InlineGrid>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingLg">
                Sample insights
              </Text>
              <Text as="p" tone="subdued">
                Onboarding shows sample insights only. Real insights appear in the modules and dashboard after sync and processing.
              </Text>
              <InlineGrid columns={{ xs: 1, md: 3 }} gap="300">
                {onboarding.sampleInsights.map((insight) => (
                  <Card key={insight.key}>
                    <BlockStack gap="200">
                      <Badge tone="info">Sample Insight</Badge>
                      <Text as="p" variant="bodySm" tone="subdued">
                        {insight.module}
                      </Text>
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
                  <Text as="h2" variant="headingLg">
                    Current plan
                  </Text>
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
                    {(onboarding.planSummary.unlockedFeatures.length > 0
                      ? onboarding.planSummary.unlockedFeatures
                      : ["Billing management and onboarding access"]).map((feature) => (
                      <List.Item key={feature}>{feature}</List.Item>
                    ))}
                  </List>
                </BlockStack>
                <BlockStack gap="100">
                  <Text as="h3" variant="headingSm">
                    Features locked
                  </Text>
                  <List type="bullet">
                    {(onboarding.planSummary.lockedFeatures.length > 0
                      ? onboarding.planSummary.lockedFeatures
                      : ["No core onboarding blockers on this plan"]).map((feature) => (
                      <List.Item key={feature}>{feature}</List.Item>
                    ))}
                  </List>
                </BlockStack>
                <InlineStack gap="300">
                  <Button
                    variant="primary"
                    onClick={() => navigateEmbedded(onboarding.planSummary.manageRoute)}
                  >
                    Manage Plan
                  </Button>
                  {activeStep?.key === "PLAN_CONFIRMATION" ? (
                    <Button
                      onClick={() => void handleConfirmPlan()}
                      loading={busyAction === "CONFIRM_PLAN"}
                    >
                      Confirm current plan
                    </Button>
                  ) : null}
                </InlineStack>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingLg">
                  Data readiness
                </Text>
                <InlineGrid columns={{ xs: 1, sm: 2 }} gap="300">
                  <div className="vs-signal-stat">
                    <Text as="p" variant="bodySm" tone="subdued">
                      Sync status
                    </Text>
                    <Text as="p">{onboarding.dataReadiness.stateLabel}</Text>
                  </div>
                  <div className="vs-signal-stat">
                    <Text as="p" variant="bodySm" tone="subdued">
                      Webhooks
                    </Text>
                    <Text as="p">
                      {onboarding.dataReadiness.webhooksReady ? "Registered" : "Action needed"}
                    </Text>
                  </div>
                </InlineGrid>
                <Text as="p" tone="subdued">
                  {onboarding.dataReadiness.syncReason}
                </Text>
                {onboarding.limitedDataReason ? (
                  <Banner title="Limited insights" tone="attention">
                    <p>{onboarding.limitedDataReason}</p>
                  </Banner>
                ) : null}
                {!onboarding.dataReadiness.webhooksReady ? (
                  <Button
                    onClick={() => void registerWebhooks()}
                    loading={busyAction === "REGISTER_WEBHOOKS"}
                  >
                    Fix webhooks
                  </Button>
                ) : null}
              </BlockStack>
            </Card>
          </InlineGrid>
        </Layout.Section>

        <Layout.Section>
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
        </Layout.Section>
      </Layout>
      {toast ? <Toast content={toast} onDismiss={() => setToast(null)} /> : null}
    </Page>
  );
}

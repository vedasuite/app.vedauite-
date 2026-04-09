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
  RadioButton,
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
  const [pendingModule, setPendingModule] = useState<OnboardingModuleKey>("trustAbuse");

  const reauthorizeUrl = shop
    ? `/auth/reconnect?shop=${encodeURIComponent(shop)}${
        host ? `&host=${encodeURIComponent(host)}` : ""
      }&returnTo=${encodeURIComponent("/app/onboarding")}`
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
              ? "Store synced successfully. Continue setup below."
              : latestJob.status === "SUCCEEDED_PROCESSING_PENDING"
              ? "Store synced. VedaSuite is still preparing operational insights."
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
          returnTo: "/app/onboarding",
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
          returnTo: "/app/onboarding",
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

  const activateSelectedModule = useCallback(async () => {
    setBusyAction(`SELECT_${pendingModule}`);
    setActionError(null);
    try {
      await selectModule(pendingModule);
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
  }, [pendingModule, selectModule]);

  const openFirstInsight = useCallback(async () => {
    if (!onboarding?.selectedModuleRoute) {
      return;
    }

    setBusyAction("VIEW_FIRST_INSIGHT");
    setActionError(null);
    try {
      await markInsightViewed(onboarding.selectedModule ?? undefined);
      navigateEmbedded(onboarding.selectedModuleRoute);
    } catch (nextError) {
      setActionError(
        nextError instanceof Error
          ? nextError.message
          : "Unable to open the first insight."
      );
    } finally {
      setBusyAction(null);
    }
  }, [markInsightViewed, navigateEmbedded, onboarding]);

  const handleConfirmPlan = useCallback(async () => {
    setBusyAction("CONFIRM_PLAN");
    setActionError(null);
    try {
      const nextOnboarding = await confirmPlan();
      setToast("Onboarding completed. Redirecting to your dashboard.");
      navigateEmbedded(nextOnboarding.canAccessDashboard ? "/app/dashboard" : "/app/onboarding");
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
        await openFirstInsight();
        return;
      case "CONFIRM_PLAN":
        await handleConfirmPlan();
        return;
      default:
        navigateEmbedded("/app/dashboard");
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

  const selectedModuleDetails = useMemo(
    () =>
      onboarding?.moduleOverview.find((module) => module.key === pendingModule) ??
      null,
    [onboarding, pendingModule]
  );

  const primaryLabel =
    onboarding?.primaryAction.key === "CHOOSE_MODULE"
      ? "Activate selected module"
      : onboarding?.primaryAction.label ?? "Start setup";

  const runPrimaryAction = async () => {
    if (!onboarding) return;
    if (onboarding.primaryAction.key === "CHOOSE_MODULE") {
      await activateSelectedModule();
      return;
    }
    await handlePrimaryAction();
  };

  if (loading) {
    return (
      <Page title="Get VedaSuite ready for your store" subtitle="Loading setup state.">
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
      <Page title="Get VedaSuite ready for your store" subtitle="Unable to load setup.">
        <Banner title="Onboarding unavailable" tone="critical">
          <p>{error ?? "The onboarding state could not be loaded."}</p>
        </Banner>
      </Page>
    );
  }

  return (
    <Page
      title="Get VedaSuite ready for your store"
      subtitle="A dedicated setup page for connection, sync, billing readiness, and first workflow activation."
    >
      <Layout>
        {actionError ? (
          <Layout.Section>
            <Banner title="Setup action failed" tone="critical">
              <BlockStack gap="200">
                <p>{actionError}</p>
                <InlineStack gap="300">
                  <Button onClick={() => void refresh()}>Refresh state</Button>
                  {reauthorizeUrl ? (
                    <Button variant="primary" onClick={() => redirectTopLevel(reauthorizeUrl)}>
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
            <BlockStack gap="400">
              <BlockStack gap="200">
                <Badge tone="info">Setup</Badge>
                <Text as="h1" variant="heading2xl">
                  Get VedaSuite ready for your store
                </Text>
                <Text as="p" tone="subdued" variant="bodyLg">
                  VedaSuite connects Shopify orders, customers, and products, then helps merchants detect fraud abuse, track competitor moves, and optimize pricing.
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
                  onClick={() => void runPrimaryAction()}
                  loading={
                    busyAction === "SYNC_LIVE_DATA" ||
                    busyAction === "VIEW_FIRST_INSIGHT" ||
                    busyAction === "CONFIRM_PLAN" ||
                    busyAction === `SELECT_${pendingModule}`
                  }
                >
                  {primaryLabel}
                </Button>
                <Button onClick={() => navigateEmbedded("/app/billing")}>
                  Go to billing
                </Button>
                {onboarding.canAccessDashboard ? (
                  <Button onClick={() => navigateEmbedded("/app/dashboard")}>
                    Skip to dashboard
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
                  Onboarding checklist
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
                          onClick={() => void runPrimaryAction()}
                          loading={
                            busyAction === "SYNC_LIVE_DATA" ||
                            busyAction === "VIEW_FIRST_INSIGHT" ||
                            busyAction === "CONFIRM_PLAN" ||
                            busyAction === `SELECT_${pendingModule}`
                          }
                        >
                          {primaryLabel}
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
          <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingLg">
                  Explore each VedaSuite module
                </Text>
                <Text as="p" tone="subdued">
                  Each module has its own operational page. Use these links to understand where each workflow lives while you finish setup.
                </Text>
                <BlockStack gap="300">
                  {onboarding.moduleOverview.map((module) => (
                    <div key={module.key} className="vs-action-card">
                      <BlockStack gap="300">
                        <InlineStack align="space-between" blockAlign="start" gap="300">
                          <InlineStack gap="300" blockAlign="start">
                            <ModuleIcon moduleKey={module.key} />
                            <BlockStack gap="100">
                              <Text as="h3" variant="headingMd">
                                {module.title}
                              </Text>
                              <Text as="p" tone="subdued">
                                {module.available ? module.summary : module.lockReason}
                              </Text>
                              <List type="bullet">
                                {module.benefits.map((benefit) => (
                                  <List.Item key={benefit}>{benefit}</List.Item>
                                ))}
                              </List>
                            </BlockStack>
                          </InlineStack>
                          <Badge tone={module.available ? "success" : "attention"}>
                            {module.available ? "Available" : "Locked"}
                          </Badge>
                        </InlineStack>
                        <InlineStack gap="300">
                          <Button
                            onClick={() => navigateEmbedded(module.route)}
                            disabled={!module.available}
                          >
                            Open module page
                          </Button>
                          {!module.available ? (
                            <Button onClick={() => navigateEmbedded("/app/billing")}>
                              Manage plan
                            </Button>
                          ) : null}
                        </InlineStack>
                      </BlockStack>
                    </div>
                  ))}
                </BlockStack>
              </BlockStack>
            </Card>

            <Card>
              <div id="module-selection" />
              <BlockStack gap="300">
                <Text as="h2" variant="headingLg">
                  Choose your starting module
                </Text>
                <Text as="p" tone="subdued">
                  Pick one starting workflow. This sets the first module VedaSuite opens during setup.
                </Text>
                <BlockStack gap="200">
                  {onboarding.moduleOverview.map((module) => (
                    <RadioButton
                      key={module.key}
                      id={`module-${module.key}`}
                      name="starting-module"
                      label={module.title}
                      helpText={
                        module.available
                          ? module.summary
                          : module.lockReason ?? "This module is unavailable on the current plan."
                      }
                      checked={pendingModule === module.key}
                      disabled={!module.available}
                      onChange={() => setPendingModule(module.key)}
                    />
                  ))}
                </BlockStack>
                {selectedModuleDetails ? (
                  <Banner title="Selected starting workflow" tone="info">
                    <p>{selectedModuleDetails.title} will open when you review the first insight.</p>
                  </Banner>
                ) : null}
              </BlockStack>
            </Card>
          </InlineGrid>
        </Layout.Section>

        <Layout.Section>
          <InlineGrid columns={{ xs: 1, md: 3 }} gap="400">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingLg">
                  How setup works
                </Text>
                <List type="number">
                  <List.Item>Connect store data</List.Item>
                  <List.Item>Sync orders, products, and customers</List.Item>
                  <List.Item>Choose plan</List.Item>
                  <List.Item>Activate modules</List.Item>
                  <List.Item>Review first insights</List.Item>
                </List>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingLg">
                    Billing summary
                  </Text>
                  <Badge tone={onboarding.planSummary.billingActive ? "success" : "attention"}>
                    {onboarding.planSummary.planName}
                  </Badge>
                </InlineStack>
                <Text as="p" tone="subdued">
                  Billing is managed on a separate page. Use it to confirm the active plan and unlock additional modules.
                </Text>
                <List type="bullet">
                  <List.Item>
                    Unlocked areas:{" "}
                    {(onboarding.planSummary.unlockedFeatures.length > 0
                      ? onboarding.planSummary.unlockedFeatures
                      : ["Onboarding and billing access"]).join(", ")}
                  </List.Item>
                  <List.Item>
                    Locked areas:{" "}
                    {(onboarding.planSummary.lockedFeatures.length > 0
                      ? onboarding.planSummary.lockedFeatures
                      : ["No current setup blockers"]).join(", ")}
                  </List.Item>
                </List>
                <Button onClick={() => navigateEmbedded("/app/billing")}>
                  Go to billing
                </Button>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingLg">
                  Data requirements
                </Text>
                <Text as="p" tone="subdued">
                  VedaSuite needs Shopify orders, customers, and products before it can generate fraud, competitor, and pricing insights.
                </Text>
                <List type="bullet">
                  <List.Item>Orders support fraud and refund-abuse detection.</List.Item>
                  <List.Item>Customers help connect repeated behavior and shopper risk.</List.Item>
                  <List.Item>Products support competitor monitoring and pricing workflows.</List.Item>
                </List>
                <Text as="p" tone="subdued">
                  {onboarding.dataReadiness.syncReason}
                </Text>
              </BlockStack>
            </Card>
          </InlineGrid>
        </Layout.Section>

        <Layout.Section>
          <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingLg">
                  Permissions and access
                </Text>
                <Text as="p" tone="subdued">
                  VedaSuite requests Shopify permissions so it can read products, customers, and orders and turn them into operational guidance inside the app.
                </Text>
                <List type="bullet">
                  <List.Item>Products help power competitor and pricing workflows.</List.Item>
                  <List.Item>Orders and customers help detect refund abuse and risky behavior.</List.Item>
                  <List.Item>Data remains inside the app experience and is used to generate insights for this store.</List.Item>
                </List>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingLg">
                  Setup health
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
      </Layout>
      {toast ? <Toast content={toast} onDismiss={() => setToast(null)} /> : null}
    </Page>
  );
}

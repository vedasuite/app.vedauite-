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
    onboarding?.canAccessDashboard
      ? "Open dashboard"
      : onboarding?.primaryAction.key === "CHOOSE_MODULE"
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
      subtitle="Complete the key setup steps so VedaSuite can start turning Shopify data into useful store guidance."
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
                <Text as="p" tone="subdued" variant="bodyLg">
                  Follow the setup steps below to confirm store connection, sync Shopify data, choose the first workflow, and unlock the right module access.
                </Text>
              </BlockStack>
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
                  Setup progress
                </Text>
                <Badge tone="info">
                  {`${onboarding.progress.percent}% complete`}
                </Badge>
              </InlineStack>
              <Text as="p" tone="subdued">
                Current step:{" "}
                {
                  onboarding.steps.find((step) => step.active)?.label ??
                  (onboarding.canAccessDashboard ? "Setup complete" : "Continue setup")
                }
              </Text>
              <ProgressBar progress={onboarding.progress.percent} size="small" />
              <BlockStack gap="250">
                {onboarding.steps.map((step) => (
                  <div key={step.key} className="vs-action-card">
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
                          {step.key === "DATA_SYNC" && !onboarding.dataReadiness.webhooksReady ? (
                            <Button
                              onClick={() => void registerWebhooks()}
                              loading={busyAction === "REGISTER_WEBHOOKS"}
                            >
                              Fix webhooks
                            </Button>
                          ) : null}
                        </InlineStack>
                      ) : null}
                    </BlockStack>
                  </div>
                ))}
              </BlockStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingLg">
                  What VedaSuite helps with
                </Text>
                <Text as="p" tone="subdued">
                  Each module has its own page after setup. This summary is here to help you decide which workflow to start with first.
                </Text>
                <BlockStack gap="250">
                  {onboarding.moduleOverview.map((module) => (
                    <div key={module.key} className="vs-action-card">
                      <InlineStack align="space-between" blockAlign="start" gap="300">
                        <InlineStack gap="300" blockAlign="start">
                          <ModuleIcon moduleKey={module.key} />
                          <BlockStack gap="100">
                            <Text as="h3" variant="headingMd">
                              {module.title}
                            </Text>
                            <Text as="p" tone="subdued">
                              {module.summary}
                            </Text>
                            <List type="bullet">
                              {module.benefits.map((benefit) => (
                                <List.Item key={benefit}>{benefit}</List.Item>
                              ))}
                            </List>
                          </BlockStack>
                        </InlineStack>
                        <Badge tone={module.available ? "success" : "attention"}>
                          {module.available ? "Included" : "Locked"}
                        </Badge>
                      </InlineStack>
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
                  Pick one workflow to review first after setup finishes. This keeps the first experience focused instead of opening every module at once.
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
                    <p>{selectedModuleDetails.title} will be the first workflow VedaSuite opens after setup.</p>
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
                  Data and permissions
                </Text>
                <Text as="p" tone="subdued">
                  VedaSuite reads Shopify products, customers, and orders so it can prepare fraud, competitor, and pricing guidance inside the app.
                </Text>
                <List type="bullet">
                  <List.Item>
                    Products support competitor monitoring and pricing recommendations.
                  </List.Item>
                  <List.Item>
                    Customers and orders help detect refund abuse and risky behavior.
                  </List.Item>
                  <List.Item>Synced store data is used to generate insights for this store inside VedaSuite.</List.Item>
                </List>
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
                  Billing stays on its own page. Use this summary to confirm what is already unlocked before you continue setup.
                </Text>
                <List type="bullet">
                  <List.Item>
                    Unlocked:{" "}
                    {(onboarding.planSummary.unlockedFeatures.length > 0
                      ? onboarding.planSummary.unlockedFeatures
                      : ["Onboarding and billing access"]).join(", ")}
                  </List.Item>
                  <List.Item>
                    Locked:{" "}
                    {(onboarding.planSummary.lockedFeatures.length > 0
                      ? onboarding.planSummary.lockedFeatures
                      : ["No current blockers"]).join(", ")}
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
                  How setup works
                </Text>
                <List type="number">
                  <List.Item>Connect Shopify and confirm sync health.</List.Item>
                  <List.Item>Sync products, customers, and orders.</List.Item>
                  <List.Item>Choose the first module to review.</List.Item>
                  <List.Item>Confirm the current plan and open the dashboard.</List.Item>
                </List>
              </BlockStack>
            </Card>
          </InlineGrid>
        </Layout.Section>

        {onboarding.canAccessDashboard ? (
          <Layout.Section>
            <Banner title="Setup complete" tone="success">
              <BlockStack gap="200">
                <p>
                  VedaSuite is ready for normal use. Open the dashboard to review the latest store signals and continue with your selected starting workflow.
                </p>
                <InlineStack gap="300">
                  <Button variant="primary" onClick={() => navigateEmbedded("/app/dashboard")}>
                    Open dashboard
                  </Button>
                  {onboarding.selectedModuleRoute ? (
                    <Button onClick={() => navigateEmbedded(onboarding.selectedModuleRoute!)}>
                      Open {onboarding.selectedModuleTitle}
                    </Button>
                  ) : null}
                </InlineStack>
              </BlockStack>
            </Banner>
          </Layout.Section>
        ) : null}
      </Layout>
      {toast ? <Toast content={toast} onDismiss={() => setToast(null)} /> : null}
    </Page>
  );
}

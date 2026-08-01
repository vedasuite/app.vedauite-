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
import { TrialStatusCard } from "../../components/billing/TrialStatus";
import "../../components/intelligence/intelligence.css";
import { useAppState } from "../../hooks/useAppState";
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

function scrollToSection(id: string) {
  document.getElementById(id)?.scrollIntoView({
    behavior: "smooth",
    block: "start",
  });
}

function ModuleIcon({ moduleKey }: { moduleKey: OnboardingModuleKey }) {
  const path =
    moduleKey === "fraud"
      ? "M18 5l7 4v6c0 5-3.4 9.4-8 10.8C12.4 24.4 9 20 9 15V9l9-4zm0 5l-4 1.8V15c0 2.8 1.7 5.4 4 6.6 2.3-1.2 4-3.8 4-6.6v-3.2L18 10z"
      : moduleKey === "competitor"
      ? "M6 7h12l2 5v8H4v-8l2-5zm2 2-1.2 3H19.2L18 9H8zm-1 5v4h10v-4H7z"
      : "M6 6h16v4H6V6zm2 6h12v8H8v-8zm3 2v4h2v-4h-2zm4-3h2v7h-2v-7z";

  const background =
    moduleKey === "fraud"
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
  // Canonical billing/trial state, shared with the Billing page.
  const { appState } = useAppState();
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
  const [pendingModule, setPendingModule] = useState<OnboardingModuleKey>("fraud");

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
    // The action-error banner renders at the top of the page — invisible
    // without scrolling back up if this was triggered from a step card
    // further down the setup checklist.
    window.scrollTo({ top: 0, behavior: "smooth" });

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
    window.scrollTo({ top: 0, behavior: "smooth" });
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
      setToast("Shopify connection is ready.");
    } catch (nextError) {
      setActionError(
        nextError instanceof Error
          ? nextError.message
          : "Unable to verify the Shopify connection."
      );
    } finally {
      setBusyAction(null);
    }
  }, [host, refresh]);

  const activateSelectedModule = useCallback(async () => {
    setBusyAction(`SELECT_${pendingModule}`);
    setActionError(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
    try {
      await selectModule(pendingModule);
      setToast("Starting workflow selected.");
    } catch (nextError) {
      setActionError(
        nextError instanceof Error
          ? nextError.message
          : "Unable to select the starting workflow."
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
    window.scrollTo({ top: 0, behavior: "smooth" });
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
    window.scrollTo({ top: 0, behavior: "smooth" });
    try {
      const nextOnboarding = await confirmPlan();
      if (nextOnboarding.canAccessDashboard) {
        setToast("Onboarding completed. Redirecting to your dashboard.");
        navigateEmbedded("/app/dashboard");
      } else {
        setToast("Plan confirmed. Finish the remaining setup steps below.");
      }
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
        // Handled by rendering a real <a target="_top"> button instead —
        // script-driven cross-origin iframe navigation is blocked by
        // browsers (especially Incognito) when it isn't a direct user
        // click. This case is only reached as a no-op safety net.
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
      case "GOTO_BILLING":
        navigateEmbedded("/app/billing");
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

  const featureName =
    pendingModule === "fraud"
      ? "Fraud Intelligence"
      : pendingModule === "competitor"
      ? "Competitor Intelligence"
      : "AI Pricing Engine";

  const primaryLabel =
    onboarding?.canAccessDashboard
      ? "Open dashboard"
      : onboarding?.primaryAction.key === "CHOOSE_MODULE"
      ? `Start with ${featureName}`
      : onboarding?.primaryAction.label ?? "Start setup";

  const runPrimaryAction = async () => {
    if (!onboarding) return;
    if (onboarding.primaryAction.key === "CHOOSE_MODULE") {
      await activateSelectedModule();
      return;
    }
    await handlePrimaryAction();
  };

  // Reconnect needs to escape the Shopify admin iframe. A real
  // <a target="_top"> click is the only navigation browsers never block
  // (Incognito enforces this strictly) — so this renders as a genuine link
  // via Polaris Button's `url`/`target` props instead of an onClick handler.
  const primaryButtonProps =
    !onboarding?.canAccessDashboard &&
    onboarding?.primaryAction.key === "RECONNECT_SHOPIFY" &&
    reauthorizeUrl
      ? { url: reauthorizeUrl, target: "_top" as const }
      : { onClick: () => void runPrimaryAction() };

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
        {/* Full-access trial summary. Rendered from the canonical
            appState.billing.trialActive flag — the same entitlement state the
            Billing page uses — so it can never disagree with Billing or imply
            access from a date alone. */}
        <Layout.Section>
          <TrialStatusCard
            data={{
              trialActive: !!appState?.billing?.trialActive,
              trialEndsAt: appState?.billing?.trialEndsAt ?? null,
              planName: appState?.billing?.planName ?? null,
            }}
            onViewBilling={() => navigateEmbedded("/app/billing")}
          />
        </Layout.Section>

        {actionError ? (
          <Layout.Section>
            {(() => {
              // Only offer "Reconnect Shopify" when the failure actually
              // indicates a connection/session problem — showing it for
              // every action failure (e.g. "choose a plan first") is
              // confusing since reconnecting Shopify doesn't fix those.
              const isConnectionIssue = /reconnect|session|reauthoriz|expired/i.test(
                actionError
              );
              // Billing/plan messages are guided next steps, not errors —
              // use info tone so they don't read as something broken.
              const isBillingStep = /billing|plan|subscri/i.test(actionError);
              const bannerTone = isConnectionIssue ? "critical" : isBillingStep ? "info" : "warning";
              const bannerTitle = isConnectionIssue
                ? "Shopify connection needs attention"
                : isBillingStep
                ? "Select a plan to continue"
                : "Step could not be completed";
              return (
                <Banner title={bannerTitle} tone={bannerTone}>
                  <BlockStack gap="200">
                    <p>{actionError}</p>
                    <InlineStack gap="300">
                      {isBillingStep ? (
                        <Button variant="primary" onClick={() => navigateEmbedded("/app/billing")}>
                          Go to billing
                        </Button>
                      ) : (
                        <Button onClick={() => void refresh()}>Try again</Button>
                      )}
                      {isConnectionIssue && reauthorizeUrl ? (
                        <Button variant="primary" url={reauthorizeUrl} target="_top">
                          Reconnect Shopify
                        </Button>
                      ) : null}
                    </InlineStack>
                  </BlockStack>
                </Banner>
              );
            })()}
          </Layout.Section>
        ) : null}

        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <BlockStack gap="200">
                <Text as="p" tone="subdued" variant="bodyLg">
                  Follow the setup steps below to confirm store connection, sync Shopify data, choose the first workflow, and unlock the right features.
                </Text>
              </BlockStack>
              <InlineStack gap="300">
                <Button
                  variant="primary"
                  {...primaryButtonProps}
                  loading={
                    busyAction === "SYNC_LIVE_DATA" ||
                    busyAction === "VIEW_FIRST_INSIGHT" ||
                    busyAction === "CONFIRM_PLAN" ||
                    busyAction === `SELECT_${pendingModule}`
                  }
                >
                  {primaryLabel}
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
          <Card padding="400">
            <BlockStack gap="400">
              {/* Header: eyebrow + title + progress, matching the section
                  header pattern used on the Dashboard. */}
              <div className="veda-section-head">
                <div className="veda-clamp">
                  <div className="veda-eyebrow">Setup</div>
                  <Text as="h2" variant="headingMd">
                    Setup progress
                  </Text>
                </div>
                <Badge tone={onboarding.canAccessDashboard ? "success" : "info"}>
                  {onboarding.canAccessDashboard
                    ? "Complete"
                    : `Step ${onboarding.progress.completedSteps + 1} of ${onboarding.progress.totalSteps}`}
                </Badge>
              </div>

              <BlockStack gap="150">
                <InlineStack align="space-between" blockAlign="center" gap="200" wrap>
                  <Text as="p" variant="bodySm" tone="subdued">
                    {onboarding.canAccessDashboard
                      ? "All steps done — open the dashboard to get started."
                      : onboarding.steps.find((step) => step.active)?.label ?? "Continue setup"}
                  </Text>
                  <Text as="span" variant="bodySm" fontWeight="semibold">
                    {`${onboarding.progress.completedSteps} / ${onboarding.progress.totalSteps}`}
                  </Text>
                </InlineStack>
                <ProgressBar progress={onboarding.progress.percent} size="small" />
              </BlockStack>

              <BlockStack gap="300">
                {onboarding.steps.map((step) => {
                  // Completed / active / pending are visually distinct: the
                  // active step keeps full detail and the primary action,
                  // finished and upcoming steps compress to a single line so
                  // the next thing to do stays the focus.
                  const rail = step.complete
                    ? "veda-rail--healthy"
                    : step.active
                    ? "veda-rail--info"
                    : "veda-rail--neutral";

                  return (
                    <div key={step.key} className={`veda-rail ${rail}`}>
                      <BlockStack gap={step.active ? "200" : "100"}>
                        <InlineStack align="space-between" blockAlign="start" gap="200" wrap>
                          <div className="veda-clamp">
                            <Text
                              as="h3"
                              variant={step.active ? "headingSm" : "bodyMd"}
                              tone={step.complete && !step.active ? "subdued" : undefined}
                            >
                              {step.label}
                            </Text>
                          </div>
                          <Badge tone={stepTone(step)}>{stepLabel(step)}</Badge>
                        </InlineStack>

                        {step.active ? (
                          <>
                            <Text as="p" variant="bodySm" tone="subdued">
                              {step.description}
                            </Text>
                            <Text as="p" variant="bodySm" tone="subdued">
                              {step.helper}
                            </Text>
                            <InlineStack gap="300" wrap>
                              <Button
                                variant="primary"
                                {...primaryButtonProps}
                                loading={
                                  busyAction === "SYNC_LIVE_DATA" ||
                                  busyAction === "VIEW_FIRST_INSIGHT" ||
                                  busyAction === "CONFIRM_PLAN" ||
                                  busyAction === `SELECT_${pendingModule}`
                                }
                              >
                                {primaryLabel}
                              </Button>
                              {step.key === "DATA_SYNC" &&
                              !onboarding.dataReadiness.webhooksReady ? (
                                <Button
                                  onClick={() => void registerWebhooks()}
                                  loading={busyAction === "REGISTER_WEBHOOKS"}
                                >
                                  Verify Shopify connection
                                </Button>
                              ) : null}
                            </InlineStack>
                          </>
                        ) : (
                          <Text as="p" variant="bodySm" tone="subdued">
                            {step.description}
                          </Text>
                        )}
                      </BlockStack>
                    </div>
                  );
                })}
              </BlockStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingLg">
                  What each feature does
                </Text>
                <Text as="p" tone="subdued">
                  Three features, each on its own page. Pick one to open first.
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
                            <Text as="p" variant="bodySm" tone="subdued">
                              Plans: {module.planLabel}
                            </Text>
                          </BlockStack>
                        </InlineStack>
                        <Badge tone={module.available ? "success" : "info"}>
                          {module.available ? "Included in your plan" : "Requires plan upgrade"}
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
                  Pick a feature to start with
                </Text>
                <Text as="p" tone="subdued">
                  Choose one feature to open first. You can use all features later — this just sets your starting point.
                </Text>
                <BlockStack gap="200">
                  {onboarding.moduleOverview.map((module) => (
                    <RadioButton
                      key={module.key}
                      id={`module-${module.key}`}
                      name="starting-module"
                      label={`${module.title} — ${module.planLabel}`}
                      helpText={
                        module.available
                          ? module.summary
                          : module.lockReason ?? "Not included in the current plan. Go to Billing to upgrade."
                      }
                      checked={pendingModule === module.key}
                      disabled={!module.available}
                      onChange={() => setPendingModule(module.key)}
                    />
                  ))}
                </BlockStack>
                {selectedModuleDetails ? (
                  <Banner title={`Starting with ${selectedModuleDetails.title}`} tone="info">
                    <p>VedaSuite will open {selectedModuleDetails.title} after setup completes. You can switch features any time from the dashboard.</p>
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
                    Products support competitor analysis and pricing recommendations.
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
                      Shopify connection
                    </Text>
                    <Text as="p">
                      {onboarding.dataReadiness.webhooksReady ? "Connected" : "Action needed"}
                    </Text>
                  </div>
                </InlineGrid>
                <Text as="p" tone="subdued">
                  {onboarding.dataReadiness.syncReason}
                </Text>
                {onboarding.limitedDataReason ? (
                  <Banner title="Limited insights" tone="info">
                    <p>{onboarding.limitedDataReason}</p>
                  </Banner>
                ) : null}
                {!onboarding.dataReadiness.webhooksReady ? (
                  <Button
                    onClick={() => void registerWebhooks()}
                    loading={busyAction === "REGISTER_WEBHOOKS"}
                  >
                    Verify Shopify connection
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
                  <Badge tone={onboarding.planSummary.billingActive ? "success" : "info"}>
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
                <Banner title="Testing on a development store?" tone="info">
                  <p>
                    Development stores create test charges only — no real billing applies.
                    Select any plan to activate full feature access and complete setup.
                  </p>
                </Banner>
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
                  <List.Item>Choose the first workflow to review.</List.Item>
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

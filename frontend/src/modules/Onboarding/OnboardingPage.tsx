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
  Spinner,
  Text,
  Toast,
} from "@shopify/polaris";
import { useCallback, useEffect, useState } from "react";
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
  steps: Array<{
    key: string;
    label: string;
    complete: boolean;
    active: boolean;
    description: string;
  }>;
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

  const pollSync = useCallback(async (jobId?: string | null) => {
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
            ? "Sync completed. VedaSuite now has live store signals to work with."
            : latestJob.status === "SUCCEEDED_PROCESSING_PENDING"
            ? "Sync completed. Processing is still catching up in the background."
            : "Sync completed, but Shopify returned little or no historical store data yet."
        );
        return;
      }

      if (latestJob.status === "FAILED") {
        throw new Error(latestJob.errorMessage ?? "Shopify sync job failed.");
      }

      await new Promise((resolve) => setTimeout(resolve, 1500));
    }

    throw new Error("Sync is still running. Check back in a moment.");
  }, [loadOnboarding]);

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

  const handlePrimaryAction = useCallback(async () => {
    if (!onboarding) return;

    switch (onboarding.nextAction.key) {
      case "RECONNECT_SHOPIFY":
        if (reauthorizeUrl) {
          redirectTopLevel(reauthorizeUrl);
        }
        return;
      case "SYNC_LIVE_DATA":
        await syncLiveStoreData();
        return;
      default:
        navigateEmbedded(onboarding.nextAction.route);
        return;
    }
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

  if (loading) {
    return (
      <Page title="Getting started" subtitle="Loading your current store setup state.">
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
      title="Getting started with VedaSuite"
      subtitle="Connect your store, sync live Shopify data, understand the current app state, and unlock the next best workflow."
    >
      <Layout>
        {error ? (
          <Layout.Section>
            <Banner title="Onboarding action failed" tone="critical">
              <p>{error}</p>
            </Banner>
          </Layout.Section>
        ) : null}

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingLg">
                    {onboarding.title}
                  </Text>
                  <Text as="p" tone="subdued">
                    {onboarding.description}
                  </Text>
                </BlockStack>
                <Badge tone={onboarding.isCompleted ? "success" : "info"}>
                  {onboarding.stage}
                </Badge>
              </InlineStack>
              <InlineStack gap="300">
                <Button
                  variant="primary"
                  onClick={() => void handlePrimaryAction()}
                  loading={busyAction === onboarding.nextAction.key}
                  disabled={
                    onboarding.nextAction.key === "SYNC_LIVE_DATA" &&
                    onboarding.syncStatus === "SYNC_IN_PROGRESS"
                  }
                >
                  {onboarding.nextAction.label}
                </Button>
                <Button onClick={() => navigateEmbedded("/subscription")}>
                  View pricing plans
                </Button>
                <Button onClick={() => navigateEmbedded(onboarding.recommendedModuleRoute)}>
                  Open recommended module
                </Button>
              </InlineStack>
              {onboarding.limitedDataReason ? (
                <Banner title="Why some dashboards may still look limited" tone="info">
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
                <Text as="h3" variant="headingMd">
                  How VedaSuite works
                </Text>
                <List type="bullet">
                  <List.Item>Syncs Shopify store data.</List.Item>
                  <List.Item>Processes trust, pricing, and competitor signals.</List.Item>
                  <List.Item>Shows actionable guidance in dashboards and modules.</List.Item>
                  <List.Item>Improves some recommendations as more order and product history becomes available.</List.Item>
                </List>
              </BlockStack>
            </Card>
            <Card>
              <BlockStack gap="300">
                <Text as="h3" variant="headingMd">
                  Current store state
                </Text>
                <InlineGrid columns={{ xs: 1, sm: 2 }} gap="300">
                  <div className="vs-signal-stat">
                    <Text as="p" variant="bodySm" tone="subdued">
                      Connection
                    </Text>
                    <Text as="p">{onboarding.connectionHealthy ? "Healthy" : "Needs attention"}</Text>
                  </div>
                  <div className="vs-signal-stat">
                    <Text as="p" variant="bodySm" tone="subdued">
                      Webhooks
                    </Text>
                    <Text as="p">{onboarding.webhooksReady ? "Registered" : "Pending"}</Text>
                  </div>
                  <div className="vs-signal-stat">
                    <Text as="p" variant="bodySm" tone="subdued">
                      Sync state
                    </Text>
                    <Text as="p">{onboarding.syncStatus}</Text>
                  </div>
                  <div className="vs-signal-stat">
                    <Text as="p" variant="bodySm" tone="subdued">
                      Current plan
                    </Text>
                    <Text as="p">{onboarding.currentPlan}</Text>
                  </div>
                </InlineGrid>
              </BlockStack>
            </Card>
          </InlineGrid>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h3" variant="headingMd">
                  Guided setup steps
                </Text>
                <Badge tone="info">
                  {`${onboarding.steps.filter((step) => step.complete).length}/${onboarding.steps.length} complete`}
                </Badge>
              </InlineStack>
              <BlockStack gap="300">
                {onboarding.steps.map((step) => (
                  <div key={step.key} className="vs-action-card">
                    <InlineStack align="space-between" blockAlign="center">
                      <BlockStack gap="100">
                        <Text as="h4" variant="headingMd">
                          {step.label}
                        </Text>
                        <Text as="p" tone="subdued">
                          {step.description}
                        </Text>
                      </BlockStack>
                      <Badge tone={step.complete ? "success" : step.active ? "attention" : "info"}>
                        {step.complete ? "Complete" : step.active ? "Current" : "Upcoming"}
                      </Badge>
                    </InlineStack>
                  </div>
                ))}
              </BlockStack>
              <InlineStack gap="300">
                <Button
                  variant="primary"
                  onClick={() => void markComplete()}
                  loading={busyAction === "COMPLETE"}
                  disabled={!onboarding.hasAnyRawData}
                >
                  Mark onboarding complete
                </Button>
                {onboarding.canDismiss ? (
                  <Button
                    onClick={() => void dismiss()}
                    loading={busyAction === "DISMISS"}
                  >
                    Dismiss for now
                  </Button>
                ) : null}
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
      {toast ? <Toast content={toast} onDismiss={() => setToast(null)} /> : null}
    </Page>
  );
}

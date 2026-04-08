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
  RadioButton,
  Spinner,
  Text,
  Toast,
} from "@shopify/polaris";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { BillingPlanName, StarterModule, SubscriptionInfo } from "../../hooks/useSubscriptionPlan";
import { useSubscriptionPlan } from "../../hooks/useSubscriptionPlan";
import { embeddedShopRequest } from "../../lib/embeddedShopRequest";
import { useAppBridge } from "../../shopifyAppBridge";

type BillingPlanCard = {
  planName: BillingPlanName;
  price: number;
  shortSummary: string;
  current: boolean;
  recommendedForCurrentState: boolean;
  action: "CURRENT_PLAN" | "CHOOSE_PLAN" | "UPGRADE" | "DOWNGRADE" | "SWITCH";
  requiresStarterModule: boolean;
};

type BillingManagementState = {
  subscription: SubscriptionInfo;
  billing: {
    planName: BillingPlanName;
    normalizedBillingStatus: string | null;
    active: boolean;
    status: string;
    starterModule: StarterModule | null;
    endsAt: string | null;
    subscriptionId: string | null;
    shopifyChargeId: string | null;
    planSource: string;
    dbPlanName: BillingPlanName;
    dbBillingStatus: string | null;
    mismatchWarnings: string[];
  };
  pendingIntent: {
    id: string;
    requestedPlanName: BillingPlanName;
    requestedStarterModule: StarterModule | null;
    actionType: string;
    status: string;
    confirmationUrl: string | null;
    errorMessage: string | null;
    createdAt: string;
    expiresAt: string | null;
  } | null;
  availableActions: {
    canManagePlans: boolean;
    canCancelSubscription: boolean;
    canChangeStarterModule: boolean;
    awaitingApproval: boolean;
  };
  plans: BillingPlanCard[];
};

type BillingStateResponse = {
  billing: BillingManagementState;
};

type BillingChangeResponse = {
  result:
    | {
        outcome: "NOOP" | "UPDATED";
        message: string;
        state: BillingManagementState;
      }
    | {
        outcome: "REDIRECT_REQUIRED";
        confirmationUrl: string;
        pendingIntent: BillingManagementState["pendingIntent"];
        state: BillingManagementState;
      };
};

function starterLabel(moduleKey: StarterModule | null) {
  return moduleKey === "trustAbuse"
    ? "Trust & Abuse Intelligence"
    : moduleKey === "competitor"
    ? "Competitor Intelligence"
    : "Not selected";
}

function redirectTopLevel(url: string) {
  if (window.top && window.top !== window) {
    window.top.location.href = url;
    return;
  }
  window.location.href = url;
}

function actionLabel(action: BillingPlanCard["action"]) {
  switch (action) {
    case "CURRENT_PLAN":
      return "Current plan";
    case "CHOOSE_PLAN":
      return "Choose plan";
    case "UPGRADE":
      return "Upgrade";
    case "DOWNGRADE":
      return "Downgrade";
    default:
      return "Switch";
  }
}

function cleanupBillingQueryParams() {
  const url = new URL(window.location.href);
  url.searchParams.delete("billingResult");
  url.searchParams.delete("billingMessage");
  url.searchParams.delete("intentId");
  url.searchParams.delete("plan");
  url.searchParams.delete("starterModule");
  window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
}

function formatDate(value: string | null | undefined) {
  if (!value) {
    return "Not set";
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function SubscriptionPage() {
  const { host } = useAppBridge();
  const { refresh } = useSubscriptionPlan();
  const [searchParams] = useSearchParams();
  const [management, setManagement] = useState<BillingManagementState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starterModule, setStarterModule] = useState<StarterModule>("trustAbuse");
  const [confirmCancel, setConfirmCancel] = useState(false);

  const loadBillingState = useCallback(async () => {
    const response = await embeddedShopRequest<BillingStateResponse>("/api/billing/state", {
      timeoutMs: 45000,
    });
    setManagement(response.billing);
    return response.billing;
  }, []);

  useEffect(() => {
    let mounted = true;

    Promise.all([loadBillingState(), refresh()])
      .then(([billingState]) => {
        if (!mounted) return;
        if (billingState.subscription.starterModule) {
          setStarterModule(billingState.subscription.starterModule);
        }
      })
      .catch((nextError) => {
        if (!mounted) return;
        setError(
          nextError instanceof Error
            ? nextError.message
            : "Unable to load billing management state."
        );
      })
      .finally(() => {
        if (!mounted) return;
        setLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, [loadBillingState, refresh]);

  useEffect(() => {
    const billingResult = searchParams.get("billingResult");
    const billingMessage = searchParams.get("billingMessage");
    const intentId = searchParams.get("intentId");

    if (!billingResult) {
      return;
    }

    let mounted = true;

    const finalize = async () => {
      if (billingResult === "confirmed") {
        setBusyAction("confirm-return");
        setError(null);
        try {
          const response = await embeddedShopRequest<{ result: BillingManagementState }>(
            "/api/billing/confirm-return",
            {
              method: "POST",
              body: {
                intentId,
              },
              timeoutMs: 45000,
            }
          );
          if (!mounted) return;
          setManagement(response.result);
          await refresh();
          setToast(billingMessage ?? "Subscription updated.");
        } catch (nextError) {
          if (!mounted) return;
          setError(
            nextError instanceof Error
              ? nextError.message
              : "Unable to confirm the Shopify billing return."
          );
        } finally {
          if (!mounted) return;
          setBusyAction(null);
          cleanupBillingQueryParams();
        }
        return;
      }

      if (billingResult === "failed") {
        setError(billingMessage ?? "Shopify billing approval was not confirmed.");
        void loadBillingState();
        cleanupBillingQueryParams();
        return;
      }

      if (billingResult === "noop") {
        setToast(billingMessage ?? "No billing change was needed.");
        void loadBillingState();
        cleanupBillingQueryParams();
      }
    };

    void finalize();

    return () => {
      mounted = false;
    };
  }, [loadBillingState, refresh, searchParams]);

  useEffect(() => {
    if (management?.subscription.starterModule) {
      setStarterModule(management.subscription.starterModule);
    }
  }, [management?.subscription.starterModule]);

  const handlePlanChange = useCallback(
    async (planName: BillingPlanName) => {
      setBusyAction(planName);
      setError(null);

      try {
        const response = await embeddedShopRequest<BillingChangeResponse>(
          "/api/billing/change-plan",
          {
            method: "POST",
            body: {
              plan: planName,
              starterModule: planName === "STARTER" ? starterModule : null,
              host,
              returnPath: "/subscription",
            },
            timeoutMs: 45000,
          }
        );

        if (response.result.outcome === "REDIRECT_REQUIRED") {
          setManagement(response.result.state);
          redirectTopLevel(response.result.confirmationUrl);
          return;
        }

        setManagement(response.result.state);
        await refresh();
        setToast(response.result.message);
      } catch (nextError) {
        setError(
          nextError instanceof Error
            ? nextError.message
            : "Unable to change the billing plan."
        );
      } finally {
        setBusyAction(null);
      }
    },
    [host, refresh, starterModule]
  );

  const handleCancel = useCallback(async () => {
    setBusyAction("cancel");
    setError(null);
    try {
      const response = await embeddedShopRequest<{ result: BillingManagementState }>(
        "/api/billing/cancel-plan",
        {
          method: "POST",
          body: { confirm: true },
          timeoutMs: 45000,
        }
      );
      setManagement(response.result);
      setConfirmCancel(false);
      await refresh();
      setToast("Subscription cancellation recorded.");
    } catch (nextError) {
      setError(
        nextError instanceof Error
          ? nextError.message
          : "Unable to cancel the subscription."
      );
    } finally {
      setBusyAction(null);
    }
  }, [refresh]);

  const handleResumeApproval = useCallback(() => {
    if (management?.pendingIntent?.confirmationUrl) {
      redirectTopLevel(management.pendingIntent.confirmationUrl);
    }
  }, [management?.pendingIntent?.confirmationUrl]);

  const currentSummary = useMemo(() => {
    if (!management) {
      return null;
    }

    const { subscription, billing } = management;
    return {
      planName: subscription.planName,
      billingStatus: billing.normalizedBillingStatus ?? subscription.billingStatus ?? "INACTIVE",
      active: billing.active,
      endsAt: billing.endsAt ?? subscription.endsAt,
      trialEndsAt: subscription.trialEndsAt,
      starterModule: billing.starterModule ?? subscription.starterModule,
      status: billing.status ?? subscription.status,
    };
  }, [management]);

  if (loading) {
    return (
      <Page title="Billing management" subtitle="Loading the current Shopify billing state.">
        <Card>
          <InlineStack align="center">
            <Spinner accessibilityLabel="Loading billing state" size="large" />
          </InlineStack>
        </Card>
      </Page>
    );
  }

  if (!management || !currentSummary) {
    return (
      <Page title="Billing management" subtitle="Unable to load the current billing state.">
        <Banner title="Billing state unavailable" tone="critical">
          <p>{error ?? "The backend did not return a billing management response."}</p>
        </Banner>
      </Page>
    );
  }

  return (
    <Page
      title="Billing management"
      subtitle="Choose a plan, confirm Shopify approval, and manage ongoing billing for this Shopify store."
    >
      <Layout>
        {error ? (
          <Layout.Section>
            <Banner title="Billing action failed" tone="critical">
              <p>{error}</p>
            </Banner>
          </Layout.Section>
        ) : null}

        {management.pendingIntent &&
        (management.pendingIntent.status === "CREATING" ||
          management.pendingIntent.status === "PENDING_APPROVAL") ? (
          <Layout.Section>
            <Banner title="Plan change pending confirmation" tone="warning">
              <BlockStack gap="200">
                <p>
                  VedaSuite is waiting for Shopify approval for{" "}
                  <strong>{management.pendingIntent.requestedPlanName}</strong>.
                </p>
                {management.pendingIntent.requestedStarterModule ? (
                  <p>
                    Starter module requested:{" "}
                    <strong>
                      {starterLabel(management.pendingIntent.requestedStarterModule)}
                    </strong>
                  </p>
                ) : null}
                <InlineStack gap="300">
                  <Button
                    variant="primary"
                    disabled={!management.pendingIntent.confirmationUrl}
                    onClick={handleResumeApproval}
                  >
                    Resume Shopify approval
                  </Button>
                </InlineStack>
              </BlockStack>
            </Banner>
          </Layout.Section>
        ) : null}

        {confirmCancel ? (
          <Layout.Section>
            <Banner title="Confirm subscription cancellation" tone="critical">
              <BlockStack gap="200">
                <p>
                  This cancels the current Shopify app subscription. If Shopify keeps
                  the subscription active until the end of the period, VedaSuite will
                  reflect that end date truthfully.
                </p>
                <InlineStack gap="300">
                  <Button
                    tone="critical"
                    variant="primary"
                    loading={busyAction === "cancel"}
                    onClick={handleCancel}
                  >
                    Confirm cancellation
                  </Button>
                  <Button onClick={() => setConfirmCancel(false)}>Keep subscription</Button>
                </InlineStack>
              </BlockStack>
            </Banner>
          </Layout.Section>
        ) : null}

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingMd">
                    Current plan
                  </Text>
                  <Text as="p" tone="subdued">
                    Backend-confirmed billing state for this Shopify store.
                  </Text>
                </BlockStack>
                <Badge tone={currentSummary.active ? "success" : "attention"}>
                  {currentSummary.active ? "Active" : "Inactive"}
                </Badge>
              </InlineStack>
              <InlineGrid columns={{ xs: 1, md: 3 }} gap="300">
                <div className="vs-signal-stat">
                  <Text as="p" variant="bodySm" tone="subdued">
                    Plan
                  </Text>
                  <Text as="p" variant="headingLg">
                    {currentSummary.planName}
                  </Text>
                </div>
                <div className="vs-signal-stat">
                  <Text as="p" variant="bodySm" tone="subdued">
                    Billing status
                  </Text>
                  <Text as="p">{currentSummary.billingStatus ?? "INACTIVE"}</Text>
                </div>
                <div className="vs-signal-stat">
                  <Text as="p" variant="bodySm" tone="subdued">
                    Lifecycle
                  </Text>
                  <Text as="p">{currentSummary.status}</Text>
                </div>
                <div className="vs-signal-stat">
                  <Text as="p" variant="bodySm" tone="subdued">
                    Renewal / end date
                  </Text>
                  <Text as="p">{formatDate(currentSummary.endsAt)}</Text>
                </div>
                <div className="vs-signal-stat">
                  <Text as="p" variant="bodySm" tone="subdued">
                    Trial ends
                  </Text>
                  <Text as="p">{formatDate(currentSummary.trialEndsAt)}</Text>
                </div>
                <div className="vs-signal-stat">
                  <Text as="p" variant="bodySm" tone="subdued">
                    Starter module
                  </Text>
                  <Text as="p">{starterLabel(currentSummary.starterModule)}</Text>
                </div>
              </InlineGrid>
              {management.billing.mismatchWarnings.length ? (
                <Banner title="Billing mismatch warnings" tone="warning">
                  <ul>
                    {management.billing.mismatchWarnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                </Banner>
              ) : null}
              {management.availableActions.canCancelSubscription ? (
                <InlineStack gap="300">
                  <Button
                    tone="critical"
                    disabled={busyAction === "cancel"}
                    onClick={() => setConfirmCancel(true)}
                  >
                    Cancel subscription
                  </Button>
                </InlineStack>
              ) : null}
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <InlineGrid columns={{ xs: 1, md: 3 }} gap="400">
            {management.plans.map((plan) => {
              const starterCardSelected =
                plan.planName === "STARTER"
                  ? management.subscription.starterModule ?? starterModule
                  : null;

              return (
                <Card key={plan.planName}>
                  <BlockStack gap="300">
                    <InlineStack align="space-between">
                      <Text as="h3" variant="headingMd">
                        {plan.planName}
                      </Text>
                      <Badge tone={plan.current ? "success" : "info"}>
                        {plan.current ? "Current" : `$${plan.price}/month`}
                      </Badge>
                    </InlineStack>
                    <Text as="p">{plan.shortSummary}</Text>
                    {plan.requiresStarterModule ? (
                      <BlockStack gap="200">
                        <RadioButton
                          label="Trust & Abuse Intelligence"
                          id="starter-trust-abuse"
                          name="starter-module"
                          checked={starterModule === "trustAbuse"}
                          onChange={() => setStarterModule("trustAbuse")}
                        />
                        <RadioButton
                          label="Competitor Intelligence"
                          id="starter-competitor"
                          name="starter-module"
                          checked={starterModule === "competitor"}
                          onChange={() => setStarterModule("competitor")}
                        />
                        <Text as="p" tone="subdued">
                          Current Starter module: {starterLabel(starterCardSelected)}
                        </Text>
                      </BlockStack>
                    ) : null}
                    <InlineStack gap="300">
                      <Button
                        variant={plan.current ? "secondary" : "primary"}
                        disabled={busyAction === plan.planName || plan.current}
                        loading={busyAction === plan.planName}
                        onClick={() => handlePlanChange(plan.planName)}
                      >
                        {actionLabel(plan.action)}
                      </Button>
                      {plan.planName === "STARTER" &&
                      plan.current &&
                      management.availableActions.canChangeStarterModule &&
                      management.subscription.starterModule !== starterModule ? (
                        <Button
                          disabled={busyAction === "STARTER"}
                          onClick={() => handlePlanChange("STARTER")}
                        >
                          Update Starter module
                        </Button>
                      ) : null}
                    </InlineStack>
                  </BlockStack>
                </Card>
              );
            })}
          </InlineGrid>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="200">
              <Text as="h3" variant="headingMd">
                Billing truth and approval behavior
              </Text>
              <Text as="p" tone="subdued">
                VedaSuite only switches the effective plan after backend verification
                against Shopify billing state. Redirect return alone is not treated as
                a successful plan change.
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
      {toast ? <Toast content={toast} onDismiss={() => setToast(null)} /> : null}
    </Page>
  );
}

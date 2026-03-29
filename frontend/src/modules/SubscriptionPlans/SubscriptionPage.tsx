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
  Text,
  Toast,
} from "@shopify/polaris";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useSubscriptionPlan } from "../../hooks/useSubscriptionPlan";
import {
  buildOptimisticSubscription,
  fallbackSubscription,
} from "../../lib/subscriptionState";
import { useAppBridge } from "../../shopifyAppBridge";
import { embeddedShopRequest } from "../../lib/embeddedShopRequest";

function getApiErrorMessage(error: unknown, fallback: string) {
  const candidate = error as {
    message?: string;
    response?: {
      data?: {
        error?: string | { message?: string };
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
    response?: {
      data?: {
        error?: {
          reauthorizeUrl?: string;
        };
      };
    };
  };

  return candidate.response?.data?.error?.reauthorizeUrl ?? null;
}

function redirectTopLevel(url: string) {
  if (window.top && window.top !== window) {
    window.top.location.href = url;
    return;
  }

  window.location.href = url;
}

export function SubscriptionPage() {
  const { shop, host } = useAppBridge();
  const {
    subscription,
    refresh: refreshSubscriptionContext,
    applyOptimistic,
  } = useSubscriptionPlan();
  const [searchParams] = useSearchParams();
  const [toast, setToast] = useState<string | null>(null);
  const [actionBanner, setActionBanner] = useState<{
    title: string;
    detail: string;
    reauthorizeUrl?: string | null;
  } | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [starterModule, setStarterModule] = useState<"fraud" | "competitor">(
    "fraud"
  );
  const billingStatus = searchParams.get("billing");
  const activatedPlan = searchParams.get("plan");
  const activatedStarterModule = searchParams.get("starterModule");
  const billingError = searchParams.get("billingError");
  const fallbackReauthorizeUrl = shop
    ? `/auth/install?shop=${encodeURIComponent(shop)}`
    : null;
  const sub = subscription ?? fallbackSubscription;

  useEffect(() => {
    if (!subscription) {
      refreshSubscriptionContext().catch(() => undefined);
    }
  }, [refreshSubscriptionContext, subscription]);

  useEffect(() => {
    if (subscription?.starterModule) {
      setStarterModule(subscription.starterModule);
    }
  }, [subscription?.starterModule]);

  useEffect(() => {
    if (billingStatus !== "activated" || !activatedPlan) {
      return;
    }

    const optimisticSubscription = buildOptimisticSubscription({
      planName: activatedPlan,
      starterModule:
        activatedStarterModule === "fraud" || activatedStarterModule === "competitor"
          ? activatedStarterModule
          : null,
    });
    applyOptimistic(optimisticSubscription);
    if (optimisticSubscription.starterModule) {
      setStarterModule(optimisticSubscription.starterModule);
    }
    refreshSubscriptionContext().catch(() => undefined);
  }, [
    activatedPlan,
    activatedStarterModule,
    applyOptimistic,
    billingStatus,
    refreshSubscriptionContext,
  ]);

  useEffect(() => {
    if (billingError) {
      setActionBanner({
        title: "Billing needs attention",
        detail: billingError,
        reauthorizeUrl:
          /reauthorize|access token|unauthorized|invalid api key|invalid access token|wrong password|unrecognized login|session token/i.test(
            billingError
          )
            ? fallbackReauthorizeUrl
            : null,
      });
      setToast(billingError);
    }
  }, [billingError, fallbackReauthorizeUrl]);

  const changePlan = (planName: string) => {
    setBusyAction(planName);
    setActionBanner(null);
    const currentParams = new URLSearchParams(window.location.search);
    const shopParam = currentParams.get("shop") || shop;
    const hostParam = currentParams.get("host") || host;
    if (!shopParam) {
      setActionBanner({
        title: "Billing action needs attention",
        detail: "Missing Shopify shop context. Reopen the embedded app and retry.",
      });
      setToast("Missing Shopify shop context.");
      setBusyAction(null);
      return;
    }

    const url = new URL("/billing/start", window.location.origin);
    url.searchParams.set("shop", shopParam);
    url.searchParams.set("planName", planName);
    if (hostParam) {
      url.searchParams.set("host", hostParam);
    }
    if (planName === "STARTER") {
      url.searchParams.set("starterModule", starterModule);
    }

    redirectTopLevel(url.toString());
  };

  const refreshSubscription = () => {
    refreshSubscriptionContext()
      .catch(() => applyOptimistic(fallbackSubscription))
      .finally(() => setBusyAction(null));
  };

  const updateStarterSelection = async () => {
    try {
      setBusyAction("starter-module");
      setActionBanner(null);
      await embeddedShopRequest("/api/subscription/starter-module", {
        method: "POST",
        body: { starterModule },
        timeoutMs: 60000,
      });
      applyOptimistic(
        buildOptimisticSubscription({
          planName: "STARTER",
          starterModule,
        })
      );
      setToast(`Starter module switched to ${starterModule}.`);
      refreshSubscription();
    } catch (error) {
      const message = getApiErrorMessage(error, "Unable to update Starter module.");
      setActionBanner({
        title: "Starter module update needs attention",
        detail: message,
      });
      setToast(message);
      setBusyAction(null);
    }
  };

  const cancelPlan = async () => {
    try {
      setBusyAction("cancel");
      setActionBanner(null);
      await embeddedShopRequest("/api/subscription/cancel", {
        method: "POST",
        timeoutMs: 60000,
      });
      applyOptimistic(fallbackSubscription);
      setToast("Subscription marked as cancelled.");
      refreshSubscription();
    } catch (error) {
      const message = getApiErrorMessage(
        error,
        "Unable to cancel the subscription."
      );
      setActionBanner({
        title: "Cancellation needs attention",
        detail: message,
      });
      setToast(message);
      setBusyAction(null);
    }
  };

  const downgradeToTrial = async () => {
    try {
      setBusyAction("trial");
      setActionBanner(null);
      await embeddedShopRequest("/api/subscription/downgrade-to-trial", {
        method: "POST",
        timeoutMs: 60000,
      });
      applyOptimistic(fallbackSubscription);
      setToast("Store downgraded to the Trial plan.");
      refreshSubscription();
    } catch (error) {
      const message = getApiErrorMessage(
        error,
        "Unable to downgrade to Trial right now."
      );
      setActionBanner({
        title: "Trial downgrade needs attention",
        detail: message,
      });
      setToast(message);
      setBusyAction(null);
    }
  };

  const planFit =
    sub?.planName === "PRO"
      ? "Full-suite merchants with margin and intelligence teams"
      : sub?.planName === "GROWTH"
      ? "Operators actively responding to fraud and market movement"
      : sub?.planName === "STARTER"
      ? "Focused merchants starting with one operational module"
      : "Stores evaluating the suite before committing";

  return (
    <Page
      title="Subscription plans"
      subtitle="Monetize the suite with module-aware plans and embedded Shopify billing."
    >
      <Layout>
        <Layout.Section>
          {billingStatus === "activated" ? (
            <Banner title="Plan activated successfully" tone="success">
              <p>
                Your store is now on <strong>{activatedPlan ?? sub?.planName ?? "the selected plan"}</strong>
                {activatedStarterModule
                  ? ` with ${activatedStarterModule} as the active Starter module.`
                  : "."}
              </p>
            </Banner>
          ) : null}
        </Layout.Section>
        <Layout.Section>
          {actionBanner ? (
            <Banner
              title={actionBanner.title}
              tone={actionBanner.reauthorizeUrl ? "warning" : "critical"}
            >
              <BlockStack gap="300">
                <p>{actionBanner.detail}</p>
                <InlineStack gap="300">
                  {actionBanner.reauthorizeUrl ? (
                    <Button
                      onClick={() =>
                        redirectTopLevel(actionBanner.reauthorizeUrl ?? "")
                      }
                    >
                      Reconnect Shopify
                    </Button>
                  ) : (
                    <Button onClick={refreshSubscription}>Retry plan refresh</Button>
                  )}
                  <Button variant="secondary" onClick={() => changePlan("STARTER")}>
                    Retry Starter checkout
                  </Button>
                </InlineStack>
              </BlockStack>
            </Banner>
          ) : null}
        </Layout.Section>
        <Layout.Section>
          <Banner title="Current subscription" tone="success">
            <p>
              Active plan: <strong>{sub?.planName ?? "TRIAL"}</strong> at $
              {sub?.price ?? 0}/month.
              {sub?.endsAt
                ? ` Scheduled end: ${new Date(sub.endsAt).toLocaleDateString()}.`
                : ""}
            </p>
          </Banner>
        </Layout.Section>
        <Layout.Section>
          <InlineGrid columns={{ xs: 1, md: 3 }} gap="400">
            <Card>
              <BlockStack gap="200">
                <Text as="h3" variant="headingMd">
                  Best fit
                </Text>
                <Text as="p">{planFit}</Text>
              </BlockStack>
            </Card>
            <Card>
              <BlockStack gap="200">
                <Text as="h3" variant="headingMd">
                  Enabled modules
                </Text>
                <Text as="p">
                  {
                    [
                      sub?.enabledModules.fraud,
                      sub?.enabledModules.competitor,
                      sub?.enabledModules.pricing,
                      sub?.enabledModules.creditScore,
                      sub?.enabledModules.profitOptimization,
                    ].filter(Boolean).length
                  }
                </Text>
              </BlockStack>
            </Card>
            <Card>
              <BlockStack gap="200">
                <Text as="h3" variant="headingMd">
                  Upgrade reason
                </Text>
                <Text as="p" tone="subdued">
                  {sub?.planName === "TRIAL"
                    ? "Unlock durable workflows and live module access."
                    : sub?.planName === "STARTER"
                    ? "Expand beyond one core module into weekly reporting and multi-signal decisions."
                    : sub?.planName === "GROWTH"
                    ? "Add pricing, shopper credit, and profit intelligence."
                    : "You already have the full suite."}
                </Text>
              </BlockStack>
            </Card>
          </InlineGrid>
        </Layout.Section>
        <Layout.Section>
          <InlineStack gap="300">
            {sub?.planName === "STARTER" ? (
              <Button
                onClick={updateStarterSelection}
                disabled={busyAction === "starter-module"}
              >
                {busyAction === "starter-module"
                  ? "Updating Starter..."
                  : "Apply Starter module choice"}
              </Button>
            ) : null}
            {sub?.planName !== "TRIAL" ? (
              <Button
                tone="critical"
                onClick={cancelPlan}
                disabled={busyAction === "cancel"}
              >
                {busyAction === "cancel" ? "Cancelling..." : "Cancel subscription"}
              </Button>
            ) : null}
            {sub?.planName !== "TRIAL" ? (
              <Button
                onClick={downgradeToTrial}
                disabled={busyAction === "trial"}
              >
                {busyAction === "trial" ? "Downgrading..." : "Downgrade to Trial"}
              </Button>
            ) : null}
          </InlineStack>
        </Layout.Section>
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h3" variant="headingMd">
                Plan coverage
              </Text>
              {sub?.planName === "STARTER" && sub.starterModule ? (
                <Text as="p" tone="subdued">
                  Starter is currently configured for the{" "}
                  <strong>{sub.starterModule}</strong> module.
                </Text>
              ) : null}
              <InlineGrid columns={{ xs: 1, md: 5 }} gap="300">
                {[
                  {
                    label: "Fraud",
                    enabled: sub?.enabledModules.fraud ?? true,
                  },
                  {
                    label: "Competitor",
                    enabled: sub?.enabledModules.competitor ?? true,
                  },
                  {
                    label: "Pricing",
                    enabled: sub?.enabledModules.pricing ?? false,
                  },
                  {
                    label: "Credit score",
                    enabled: sub?.enabledModules.creditScore ?? false,
                  },
                  {
                    label: "Profit engine",
                    enabled: sub?.enabledModules.profitOptimization ?? false,
                  },
                ].map((item) => (
                  <div key={item.label} className="vs-signal-stat">
                    <BlockStack gap="100">
                      <Text as="p" variant="bodyMd">
                        {item.label}
                      </Text>
                      <Badge tone={item.enabled ? "success" : "attention"}>
                        {item.enabled ? "Included" : "Locked"}
                      </Badge>
                    </BlockStack>
                  </div>
                ))}
              </InlineGrid>
            </BlockStack>
          </Card>
        </Layout.Section>
        <Layout.Section>
          <InlineGrid columns={{ xs: 1, md: 3 }} gap="400">
            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h3" variant="headingMd">
                    Trial
                  </Text>
                  <Badge tone="info">3 days</Badge>
                </InlineStack>
                <Text as="p">
                  Full-suite preview with limited usage so merchants can validate
                  the product before committing.
                </Text>
                <Text as="p" tone="subdued">
                  Best for onboarding and first-time evaluation.
                </Text>
              </BlockStack>
            </Card>
            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h3" variant="headingMd">
                    Starter
                  </Text>
                  <Badge tone="warning">$19/month</Badge>
                </InlineStack>
                <Text as="p">
                  Choose one core module: Fraud Intelligence or Competitor
                  Intelligence.
                </Text>
                <Text as="p" tone="subdued">
                  Basic alerts and lighter operating controls for lean teams.
                </Text>
                <BlockStack gap="200">
                  <RadioButton
                    label="Starter with Fraud Intelligence"
                    checked={starterModule === "fraud"}
                    id="starter-fraud"
                    name="starter-module"
                    onChange={() => setStarterModule("fraud")}
                  />
                  <RadioButton
                    label="Starter with Competitor Intelligence"
                    checked={starterModule === "competitor"}
                    id="starter-competitor"
                    name="starter-module"
                    onChange={() => setStarterModule("competitor")}
                  />
                </BlockStack>
                <Button
                  variant="primary"
                  disabled={busyAction === "STARTER"}
                  onClick={() => changePlan("STARTER")}
                >
                  {sub?.planName === "STARTER" ? "Update Starter selection" : "Switch to Starter"}
                </Button>
              </BlockStack>
            </Card>
            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h3" variant="headingMd">
                    Growth
                  </Text>
                  <Badge tone="success">$49/month</Badge>
                </InlineStack>
                <Text as="p">
                  Fraud scoring, competitor alerts, and weekly intelligence
                  reporting in one plan.
                </Text>
                <Text as="p" tone="subdued">
                  Best fit for merchants actively responding to market movement.
                </Text>
                <Button
                  variant="primary"
                  disabled={sub?.planName === "GROWTH"}
                  loading={busyAction === "GROWTH"}
                  onClick={() => changePlan("GROWTH")}
                >
                  {sub?.planName === "GROWTH" ? "Current Growth plan" : "Switch to Growth"}
                </Button>
              </BlockStack>
            </Card>
          </InlineGrid>
        </Layout.Section>
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h3" variant="headingMd">
                  Pro
                </Text>
                <Badge tone="attention">$99/month</Badge>
              </InlineStack>
              <Text as="p">
                Includes AI Pricing Strategy, Shopper Credit Score, Wardrobing
                Detection AI, and AI Profit Optimization Engine.
              </Text>
              <Text as="p" tone="subdued">
                Unlocks the full AI commerce intelligence suite and advanced margin tooling.
              </Text>
              <Button
                variant="primary"
                disabled={sub?.planName === "PRO"}
                loading={busyAction === "PRO"}
                onClick={() => changePlan("PRO")}
              >
                {sub?.planName === "PRO" ? "Current Pro plan" : "Switch to Pro"}
              </Button>
            </BlockStack>
          </Card>
        </Layout.Section>
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h3" variant="headingMd">
                Decision guide
              </Text>
              <InlineGrid columns={{ xs: 1, md: 3 }} gap="300">
                <div className="vs-signal-stat">
                  <Text as="p" variant="bodySm" tone="subdued">
                    Starter
                  </Text>
                  <Text as="p">
                    Best for lean teams choosing either fraud or competitor response first.
                  </Text>
                </div>
                <div className="vs-signal-stat">
                  <Text as="p" variant="bodySm" tone="subdued">
                    Growth
                  </Text>
                  <Text as="p">
                    Best for stores that need active intelligence reporting and coordinated operator workflows.
                  </Text>
                </div>
                <div className="vs-signal-stat">
                  <Text as="p" variant="bodySm" tone="subdued">
                    Pro
                  </Text>
                  <Text as="p">
                    Best for merchants optimizing pricing, customer trust, and margin in one operating system.
                  </Text>
                </div>
              </InlineGrid>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
      {toast ? <Toast content={toast} onDismiss={() => setToast(null)} /> : null}
    </Page>
  );
}

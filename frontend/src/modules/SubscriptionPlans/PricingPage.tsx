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
  RadioButton,
  Spinner,
  Text,
  Toast,
} from "@shopify/polaris";
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  BillingPlanName,
  StarterModule,
  SubscriptionInfo,
} from "../../hooks/useSubscriptionPlan";
import { useSubscriptionPlan } from "../../hooks/useSubscriptionPlan";
import { embeddedShopRequest } from "../../lib/embeddedShopRequest";
import { useAppBridge } from "../../shopifyAppBridge";

type BillingPlanCard = {
  planName: BillingPlanName;
  price: number;
  shortSummary: string;
  current: boolean;
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

type PlanCatalogEntry = {
  planName: BillingPlanName;
  priceLabel: string;
  summary: string;
  featureBullets: string[];
  moduleBullets: string[];
  idealFor: string;
  recommended?: boolean;
};

const PLAN_CATALOG: Record<"STARTER" | "GROWTH" | "PRO", PlanCatalogEntry> = {
  STARTER: {
    planName: "STARTER",
    priceLabel: "$19/month",
    summary: "Starter includes one selected module for merchants beginning with a single high-priority workflow.",
    featureBullets: [
      "One selected Starter module",
      "Backend-enforced feature gating",
      "Billing management and settings access",
    ],
    moduleBullets: [
      "Choose Trust & Abuse Intelligence",
      "Or choose Competitor Intelligence",
    ],
    idealFor: "Stores that want one focused workflow first.",
  },
  GROWTH: {
    planName: "GROWTH",
    priceLabel: "$49/month",
    summary: "Growth unlocks the main operating modules for stores that need broader merchant intelligence.",
    featureBullets: [
      "Trust & Abuse Intelligence",
      "Competitor Intelligence",
      "Pricing baseline and reports access",
    ],
    moduleBullets: [
      "Trust & Abuse",
      "Competitor Intelligence",
      "Pricing & Profit",
      "Reports",
    ],
    idealFor: "Stores that want broad coverage without full Pro depth.",
    recommended: true,
  },
  PRO: {
    planName: "PRO",
    priceLabel: "$99/month",
    summary: "Pro unlocks the full VedaSuite operating layer, including deeper pricing and advanced decision support.",
    featureBullets: [
      "All Growth capabilities",
      "Advanced pricing and profit features",
      "Full Pro-only automations and deeper strategy tooling",
    ],
    moduleBullets: [
      "Trust & Abuse",
      "Competitor Intelligence",
      "Pricing & Profit",
      "Reports",
      "Advanced Pro features",
    ],
    idealFor: "Stores that need the full operating layer and deeper optimization controls.",
  },
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

function formatDate(value: string | null | undefined) {
  if (!value) {
    return "Not set";
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function PricingPage() {
  const { host } = useAppBridge();
  const {
    refresh,
    billingFlowState,
    startBillingRedirect,
  } = useSubscriptionPlan();
  const billingBusy =
    billingFlowState === "REDIRECTING_TO_SHOPIFY" ||
    billingFlowState === "RETURNED_FROM_SHOPIFY" ||
    billingFlowState === "CONFIRMING_BACKEND_STATE";
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

    setLoading(true);
    loadBillingState()
      .then((billingState) => {
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
  }, [loadBillingState, billingFlowState]);

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
          startBillingRedirect();
          redirectTopLevel(response.result.confirmationUrl);
          return;
        }

        setManagement(response.result.state);
        await refresh({ clearCache: true });
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
    [host, refresh, starterModule, startBillingRedirect]
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
      await refresh({ clearCache: true });
      setToast("Subscription cancelled successfully.");
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
      startBillingRedirect();
      redirectTopLevel(management.pendingIntent.confirmationUrl);
    }
  }, [management?.pendingIntent?.confirmationUrl, startBillingRedirect]);

  const currentSummary = useMemo(() => {
    if (!management) {
      return null;
    }

    const { subscription, billing } = management;
    return {
      planName: subscription.planName,
      billingStatus:
        billing.normalizedBillingStatus ?? subscription.billingStatus ?? "INACTIVE",
      active: billing.active,
      endsAt: billing.endsAt ?? subscription.endsAt,
      trialEndsAt: subscription.trialEndsAt,
      starterModule: billing.starterModule ?? subscription.starterModule,
      status: billing.status ?? subscription.status,
    };
  }, [management]);

  if (loading) {
    return (
      <Page title="Pricing and billing" subtitle="Loading the current Shopify subscription state.">
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
      <Page title="Pricing and billing" subtitle="Unable to load the current billing state.">
        <Banner title="Billing state unavailable" tone="critical">
          <p>{error ?? "The backend did not return a billing management response."}</p>
        </Banner>
      </Page>
    );
  }

  return (
    <Page
      title="Pricing and billing"
      subtitle="Choose a plan, confirm Shopify approval, and manage the subscription without relying on redirect-only state."
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
            <Banner title="Awaiting Shopify approval" tone="warning">
              <BlockStack gap="200">
                <p>
                  VedaSuite is still waiting for Shopify approval for{" "}
                  <strong>{management.pendingIntent.requestedPlanName}</strong>.
                </p>
                {management.pendingIntent.requestedStarterModule ? (
                  <p>
                    Selected Starter module:{" "}
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
            <Banner title="Cancel current subscription" tone="critical">
              <BlockStack gap="200">
                <p>
                  This will cancel the current Shopify app subscription. VedaSuite
                  will keep the real end date if Shopify leaves access active until
                  the current period ends.
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
              <Text as="h2" variant="headingLg">
                Choose the VedaSuite plan that fits your store
              </Text>
              <Text as="p" tone="subdued">
                Pick the plan that matches the modules your team needs today.
                Some recommendations become stronger as VedaSuite processes more
                Shopify product and order history.
              </Text>
              <InlineGrid columns={{ xs: 1, md: 3 }} gap="300">
                <div className="vs-signal-stat">
                  <Text as="p" variant="bodySm" tone="subdued">
                    Recommended starting point
                  </Text>
                  <Text as="p" variant="headingMd">
                    Growth
                  </Text>
                </div>
                <div className="vs-signal-stat">
                  <Text as="p" variant="bodySm" tone="subdued">
                    Current billing truth
                  </Text>
                  <Text as="p">{management.billing.planSource}</Text>
                </div>
                <div className="vs-signal-stat">
                  <Text as="p" variant="bodySm" tone="subdued">
                    Honest value note
                  </Text>
                  <Text as="p">
                    Recommendations improve as more synced store history becomes available.
                  </Text>
                </div>
              </InlineGrid>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingMd">
                    Current subscription
                  </Text>
                  <Text as="p" tone="subdued">
                    This section only reflects backend-confirmed billing state.
                  </Text>
                </BlockStack>
                <Badge tone={currentSummary.active ? "success" : "attention"}>
                  {currentSummary.active ? "Active" : "Inactive"}
                </Badge>
              </InlineStack>
              <InlineGrid columns={{ xs: 1, md: 3 }} gap="300">
                <div className="vs-signal-stat">
                  <Text as="p" variant="bodySm" tone="subdued">
                    Current plan
                  </Text>
                  <Text as="p" variant="headingLg">
                    {currentSummary.planName}
                  </Text>
                </div>
                <div className="vs-signal-stat">
                  <Text as="p" variant="bodySm" tone="subdued">
                    Billing status
                  </Text>
                  <Text as="p">{currentSummary.billingStatus}</Text>
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
              const catalog = PLAN_CATALOG[plan.planName as keyof typeof PLAN_CATALOG];
              const starterCardSelected =
                plan.planName === "STARTER"
                  ? management.subscription.starterModule ?? starterModule
                  : null;

              return (
                <Card key={plan.planName}>
                  <BlockStack gap="300">
                    <InlineStack align="space-between" blockAlign="center">
                      <Text as="h3" variant="headingMd">
                        {catalog.planName}
                      </Text>
                      <InlineStack gap="200">
                        {catalog.recommended ? (
                          <Badge tone="success">Recommended</Badge>
                        ) : null}
                        <Badge tone={plan.current ? "success" : "info"}>
                          {plan.current ? "Current plan" : catalog.priceLabel}
                        </Badge>
                      </InlineStack>
                    </InlineStack>

                    <Text as="p">{catalog.summary}</Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                      Ideal for: {catalog.idealFor}
                    </Text>

                    <BlockStack gap="100">
                      <Text as="h4" variant="headingSm">
                        Features
                      </Text>
                      <List type="bullet">
                        {catalog.featureBullets.map((feature) => (
                          <List.Item key={feature}>{feature}</List.Item>
                        ))}
                      </List>
                    </BlockStack>

                    <BlockStack gap="100">
                      <Text as="h4" variant="headingSm">
                        Modules included
                      </Text>
                      <List type="bullet">
                        {catalog.moduleBullets.map((moduleName) => (
                          <List.Item key={moduleName}>{moduleName}</List.Item>
                        ))}
                      </List>
                    </BlockStack>

                    {plan.requiresStarterModule ? (
                      <BlockStack gap="200">
                        <Text as="h4" variant="headingSm">
                          Choose Starter module
                        </Text>
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
                          Selected Starter module: {starterLabel(starterCardSelected)}
                        </Text>
                      </BlockStack>
                    ) : null}

                    <InlineStack gap="300">
                      <Button
                        variant={plan.current ? "secondary" : "primary"}
                        disabled={billingBusy || busyAction === plan.planName || plan.current}
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
                          disabled={billingBusy || busyAction === "STARTER"}
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
                Plan comparison
              </Text>
              <InlineGrid columns={{ xs: 1, md: 4 }} gap="200">
                <div className="vs-signal-stat">
                  <Text as="p" variant="bodySm" tone="subdued">Capability</Text>
                  <Text as="p">Trust & Abuse</Text>
                  <Text as="p">Competitor intelligence</Text>
                  <Text as="p">Pricing recommendations</Text>
                  <Text as="p">Profit optimization</Text>
                  <Text as="p">Advanced automation</Text>
                  <Text as="p">Starter module choice</Text>
                  <Text as="p">Ideal merchant type</Text>
                </div>
                <div className="vs-signal-stat">
                  <Text as="p" variant="bodySm" tone="subdued">Starter</Text>
                  <Text as="p">One selected module</Text>
                  <Text as="p">One selected module</Text>
                  <Text as="p">Not included</Text>
                  <Text as="p">Not included</Text>
                  <Text as="p">Not included</Text>
                  <Text as="p">Required</Text>
                  <Text as="p">Focused first use case</Text>
                </div>
                <div className="vs-signal-stat">
                  <Text as="p" variant="bodySm" tone="subdued">Growth</Text>
                  <Text as="p">Included</Text>
                  <Text as="p">Included</Text>
                  <Text as="p">Included</Text>
                  <Text as="p">Baseline guidance</Text>
                  <Text as="p">Limited</Text>
                  <Text as="p">Not needed</Text>
                  <Text as="p">Balanced coverage</Text>
                </div>
                <div className="vs-signal-stat">
                  <Text as="p" variant="bodySm" tone="subdued">Pro</Text>
                  <Text as="p">Included</Text>
                  <Text as="p">Included</Text>
                  <Text as="p">Included</Text>
                  <Text as="p">Full depth</Text>
                  <Text as="p">Included</Text>
                  <Text as="p">Not needed</Text>
                  <Text as="p">Full operating layer</Text>
                </div>
              </InlineGrid>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="200">
              <Text as="h3" variant="headingMd">
                Common questions
              </Text>
              <List type="bullet">
                <List.Item>
                  Starter includes one selected module. Upgrade anytime if you need broader module coverage.
                </List.Item>
                <List.Item>
                  Growth is the clearest default choice for stores that want trust, competitor, pricing, and report coverage together.
                </List.Item>
                <List.Item>
                  Some dashboards stay limited until VedaSuite syncs and processes enough Shopify history.
                </List.Item>
                <List.Item>
                  VedaSuite only marks the plan as updated after backend confirmation from Shopify, not just after redirect return.
                </List.Item>
              </List>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
      {toast ? <Toast content={toast} onDismiss={() => setToast(null)} /> : null}
    </Page>
  );
}

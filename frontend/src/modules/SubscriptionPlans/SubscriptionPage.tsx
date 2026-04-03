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
import { useSubscriptionPlan, type StarterModule } from "../../hooks/useSubscriptionPlan";
import {
  buildOptimisticSubscription,
  fallbackSubscription,
} from "../../lib/subscriptionState";
import { embeddedShopRequest } from "../../lib/embeddedShopRequest";
import { useAppBridge } from "../../shopifyAppBridge";

function starterLabel(moduleKey: StarterModule) {
  return moduleKey === "trustAbuse"
    ? "Trust & Abuse Intelligence"
    : moduleKey === "competitor"
    ? "Competitor Intelligence"
    : "Starter module";
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
  const { subscription, refresh, applyOptimistic } = useSubscriptionPlan();
  const [searchParams] = useSearchParams();
  const [toast, setToast] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [starterModule, setStarterModule] = useState<StarterModule>("trustAbuse");
  const billingStatus = searchParams.get("billing");
  const activatedPlan = searchParams.get("plan");
  const activatedStarterModule = searchParams.get("starterModule");
  const current = subscription ?? fallbackSubscription;

  useEffect(() => {
    if (current.starterModule) {
      setStarterModule(current.starterModule);
    }
  }, [current.starterModule]);

  useEffect(() => {
    if (billingStatus !== "activated" || !activatedPlan) {
      return;
    }

    const optimistic = buildOptimisticSubscription({
      planName: activatedPlan,
      starterModule:
        activatedStarterModule === "trustAbuse" ||
        activatedStarterModule === "competitor"
          ? activatedStarterModule
          : null,
    });
    applyOptimistic(optimistic);
    setBanner(
      optimistic.starterModule
        ? `Plan activated: ${optimistic.planName} with ${starterLabel(
            optimistic.starterModule
          )}.`
        : `Plan activated: ${optimistic.planName}.`
    );
    void refresh();
  }, [
    activatedPlan,
    activatedStarterModule,
    applyOptimistic,
    billingStatus,
    refresh,
  ]);

  const createPlanCheckout = (planName: string) => {
    const url = new URL("/billing/start", window.location.origin);
    url.searchParams.set("shop", shop);
    url.searchParams.set("planName", planName);
    if (host) {
      url.searchParams.set("host", host);
    }
    if (planName === "STARTER" && starterModule) {
      url.searchParams.set("starterModule", starterModule);
    }
    redirectTopLevel(url.toString());
  };

  const changePlan = (planName: string) => {
    setBusyAction(planName);
    createPlanCheckout(planName);
  };

  const updateStarterSelection = async () => {
    if (!starterModule) {
      return;
    }
    setBusyAction("starter-module");
    await embeddedShopRequest("/api/subscription/starter-module", {
      method: "POST",
      body: { starterModule },
      timeoutMs: 30000,
    });
    applyOptimistic(buildOptimisticSubscription({ planName: "STARTER", starterModule }));
    setToast(`Starter now uses ${starterLabel(starterModule)}.`);
    await refresh();
    setBusyAction(null);
  };

  const changeToTrial = async () => {
    setBusyAction("TRIAL");
    await embeddedShopRequest("/api/subscription/downgrade-to-trial", {
      method: "POST",
      timeoutMs: 30000,
    });
    applyOptimistic(fallbackSubscription);
    setToast("Store is back on the Trial plan.");
    await refresh();
    setBusyAction(null);
  };

  const enabledModuleCount = [
    current.enabledModules.trustAbuse,
    current.enabledModules.competitor,
    current.enabledModules.pricingProfit,
  ].filter(Boolean).length;
  const coverageItems: Array<{ label: string; enabled: boolean }> = [
    { label: "Trust & Abuse", enabled: current.enabledModules.trustAbuse },
    { label: "Competitor", enabled: current.enabledModules.competitor },
    { label: "Pricing & Profit", enabled: current.enabledModules.pricingProfit },
    { label: "Reports", enabled: true },
    { label: "Settings", enabled: true },
  ];

  return (
    <Page
      title="Subscription plans"
      subtitle="Billing and access control for Trust & Abuse, Competitor Intelligence, and Pricing & Profit."
    >
      <Layout>
        {banner ? (
          <Layout.Section>
            <Banner title="Plan activation recorded" tone="success">
              <p>{banner}</p>
            </Banner>
          </Layout.Section>
        ) : null}
        <Layout.Section>
          <Banner title="Current subscription" tone="info">
            <p>
              Active plan: <strong>{current.planName}</strong> at ${current.price}/month.
              {current.starterModule
                ? ` Starter module: ${starterLabel(current.starterModule)}.`
                : ""}
            </p>
          </Banner>
        </Layout.Section>
        <Layout.Section>
          <InlineGrid columns={{ xs: 1, md: 3 }} gap="400">
            <Card>
              <BlockStack gap="200">
                <Text as="h3" variant="headingMd">Visible modules</Text>
                <Text as="p" variant="headingLg">{enabledModuleCount}</Text>
                <Text as="p" tone="subdued">
                  Settings and Reports stay available across every plan.
                </Text>
              </BlockStack>
            </Card>
            <Card>
              <BlockStack gap="200">
                <Text as="h3" variant="headingMd">Starter chooser</Text>
                <Text as="p" tone="subdued">
                  Starter merchants activate exactly one core module.
                </Text>
              </BlockStack>
            </Card>
            <Card>
              <BlockStack gap="200">
                <Text as="h3" variant="headingMd">Premium features</Text>
                <Text as="p" tone="subdued">
                  Pro unlocks full profit automation, evidence exports, and the strongest decision support.
                </Text>
              </BlockStack>
            </Card>
          </InlineGrid>
        </Layout.Section>
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h3" variant="headingMd">How access works now</Text>
              <InlineGrid columns={{ xs: 1, md: 4 }} gap="300">
                <div className="vs-signal-stat">
                  <Text as="p" variant="bodySm" tone="subdued">Trial</Text>
                  <Text as="p">All 3 modules unlocked for evaluation.</Text>
                </div>
                <div className="vs-signal-stat">
                  <Text as="p" variant="bodySm" tone="subdued">Starter</Text>
                  <Text as="p">Choose Trust & Abuse or Competitor as one active core module.</Text>
                </div>
                <div className="vs-signal-stat">
                  <Text as="p" variant="bodySm" tone="subdued">Growth</Text>
                  <Text as="p">Trust & Abuse + Competitor + basic Pricing & Profit.</Text>
                </div>
                <div className="vs-signal-stat">
                  <Text as="p" variant="bodySm" tone="subdued">Pro</Text>
                  <Text as="p">All 3 modules plus the full profit engine and premium features.</Text>
                </div>
              </InlineGrid>
              <Text as="p" tone="subdued">
                Reports and Settings stay open on every plan so merchants can review weekly operating briefs and maintain plan-aware controls.
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h3" variant="headingMd">Plan coverage</Text>
              <InlineGrid columns={{ xs: 1, md: 5 }} gap="300">
                {coverageItems.map(({ label, enabled }) => (
                  <div key={label} className="vs-signal-stat">
                    <BlockStack gap="100">
                      <Text as="p">{label}</Text>
                      <Badge tone={enabled ? "success" : "attention"}>
                        {enabled ? "Included" : "Locked"}
                      </Badge>
                    </BlockStack>
                  </div>
                ))}
              </InlineGrid>
            </BlockStack>
          </Card>
        </Layout.Section>
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h3" variant="headingMd">Current access snapshot</Text>
              <InlineGrid columns={{ xs: 1, md: 3 }} gap="300">
                <div className="vs-action-card">
                  <Text as="p" variant="headingSm">Currently active modules</Text>
                  <Text as="p" tone="subdued">
                    {coverageItems
                      .filter((item) => item.enabled)
                      .map((item) => item.label)
                      .join(", ")}
                  </Text>
                </div>
                <div className="vs-action-card">
                  <Text as="p" variant="headingSm">Starter selector</Text>
                  <Text as="p" tone="subdued">
                    {current.planName === "STARTER"
                      ? `Starter is currently pointed at ${starterLabel(current.starterModule)}.`
                      : "Starter choice becomes relevant only when the Starter plan is active."}
                  </Text>
                </div>
                <div className="vs-action-card">
                  <Text as="p" variant="headingSm">Premium feature posture</Text>
                  <Text as="p" tone="subdued">
                    {current.featureAccess.fullProfitEngine
                      ? "Full profit engine, advanced automation, and evidence export are active."
                      : "Premium automation and full profit engine remain reserved for Pro."}
                  </Text>
                </div>
              </InlineGrid>
            </BlockStack>
          </Card>
        </Layout.Section>
        <Layout.Section>
          <InlineGrid columns={{ xs: 1, md: 3 }} gap="400">
            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between">
                  <Text as="h3" variant="headingMd">Trial</Text>
                  <Badge tone="info">3 days</Badge>
                </InlineStack>
                <Text as="p">
                  Full access to all three visible product modules for onboarding and evaluation.
                </Text>
                <Button
                  disabled={busyAction === "TRIAL" || current.planName === "TRIAL"}
                  onClick={changeToTrial}
                >
                  {current.planName === "TRIAL" ? "Current Trial plan" : "Return to Trial"}
                </Button>
              </BlockStack>
            </Card>
            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between">
                  <Text as="h3" variant="headingMd">Starter</Text>
                  <Badge tone="warning">$19/month</Badge>
                </InlineStack>
                <Text as="p">
                  Activate exactly one core module: Trust & Abuse or Competitor Intelligence.
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
                <InlineStack gap="300">
                  <Button
                    variant="primary"
                    disabled={busyAction === "STARTER"}
                    onClick={() => changePlan("STARTER")}
                  >
                    {current.planName === "STARTER" ? "Restart Starter checkout" : "Switch to Starter"}
                  </Button>
                  {current.planName === "STARTER" ? (
                    <Button
                      disabled={busyAction === "starter-module"}
                      onClick={updateStarterSelection}
                    >
                      Apply Starter choice
                    </Button>
                  ) : null}
                </InlineStack>
              </BlockStack>
            </Card>
            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between">
                  <Text as="h3" variant="headingMd">Growth</Text>
                  <Badge tone="success">$49/month</Badge>
                </InlineStack>
                <Text as="p">
                  Includes Trust & Abuse, Competitor Intelligence, and the basic Pricing & Profit Engine.
                </Text>
                <Text as="p" tone="subdued">
                  Full profit automation remains reserved for Pro.
                </Text>
                <Button
                  variant="primary"
                  disabled={busyAction === "GROWTH" || current.planName === "GROWTH"}
                  onClick={() => changePlan("GROWTH")}
                >
                  {current.planName === "GROWTH" ? "Current Growth plan" : "Switch to Growth"}
                </Button>
              </BlockStack>
            </Card>
          </InlineGrid>
        </Layout.Section>
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between">
                <Text as="h3" variant="headingMd">Pro</Text>
                <Badge tone="attention">$99/month</Badge>
              </InlineStack>
              <Text as="p">
                Full Trust & Abuse Intelligence, Competitor Intelligence, and the complete Pricing & Profit Engine.
              </Text>
              <Text as="p" tone="subdued">
                Unlocks advanced automation, full profit leak detection, support copilot, and evidence packs.
              </Text>
              <Button
                variant="primary"
                disabled={busyAction === "PRO" || current.planName === "PRO"}
                onClick={() => changePlan("PRO")}
              >
                {current.planName === "PRO" ? "Current Pro plan" : "Switch to Pro"}
              </Button>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
      {toast ? <Toast content={toast} onDismiss={() => setToast(null)} /> : null}
    </Page>
  );
}

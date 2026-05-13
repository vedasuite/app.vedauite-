import {
  Banner,
  Badge,
  BlockStack,
  Button,
  Card,
  InlineStack,
  Layout,
  Page,
  Text,
} from "@shopify/polaris";
import { useEmbeddedNavigation } from "../hooks/useEmbeddedNavigation";
import { useAppState } from "../hooks/useAppState";
import { useSubscriptionPlan } from "../hooks/useSubscriptionPlan";
import {
  isBackendModuleEnabled,
  resolveBackendPlan,
  resolveBackendStarterModule,
} from "../lib/backendModuleAccess";

type FeatureKey = "fraud" | "competitor" | "pricing" | "profit";

type Props = {
  title: string;
  subtitle: string;
  requiredPlan: string;
  children: React.ReactNode;
  allowed: boolean;
  featureKey?: FeatureKey;
};

export function ModuleGate({
  title,
  subtitle,
  requiredPlan,
  children,
  allowed,
  featureKey,
}: Props) {
  const { navigateEmbedded } = useEmbeddedNavigation();
  const { subscription, billingState, entitlements } = useSubscriptionPlan();
  const { appState } = useAppState();

  const backendAllowed = featureKey
    ? isBackendModuleEnabled(appState, featureKey)
    : allowed;
  const resolvedAllowed = featureKey ? backendAllowed : allowed;

  if (resolvedAllowed) {
    return <>{children}</>;
  }

  const currentPlan =
    resolveBackendPlan(appState) ?? entitlements?.planName ?? subscription?.planName ?? "NONE";
  const currentStarterModule =
    resolveBackendStarterModule(appState) ?? entitlements?.starterModule ?? null;
  const starterLabel =
    currentStarterModule === "fraud"
      ? "Fraud Intelligence"
      : currentStarterModule === "competitor"
      ? "Competitor Intelligence"
      : null;

  return (
    <Page title={title} subtitle={subtitle}>
      <Layout>
        <Layout.Section>
          <Banner title={`Upgrade required: ${requiredPlan}`} tone="info">
            <p>
              Upgrade to {requiredPlan} to unlock this module for your store.
            </p>
          </Banner>
        </Layout.Section>
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h3" variant="headingMd">
                  This feature is not included in your current plan
                </Text>
                <Badge tone="attention">{currentPlan}</Badge>
              </InlineStack>
              <Text as="p" tone="subdued">
                  {billingState?.lifecycle === "pending_approval"
                  ? "A plan change is waiting for Shopify approval. Your current features stay available until Shopify confirms the change."
                  : "Choose a plan that includes this workflow to use its analytics, actions, and reports."}
              </Text>
              {billingState?.merchantDescription ? (
                <Text as="p" variant="bodySm" tone="subdued">
                  {billingState.merchantDescription}
                </Text>
              ) : null}
              {currentPlan === "STARTER" && currentStarterModule ? (
                <Banner title="Current Starter feature" tone="info">
                  <p>
                    Your store currently includes{" "}
                    <strong>{starterLabel ?? currentStarterModule}</strong>. Upgrade
                    or choose a different Starter feature to access this workflow.
                  </p>
                </Banner>
              ) : null}
              <Button
                variant="primary"
                onClick={() => navigateEmbedded("/app/billing")}
              >
                Manage subscription plans
              </Button>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

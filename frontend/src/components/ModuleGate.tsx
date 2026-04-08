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
import { useSubscriptionPlan } from "../hooks/useSubscriptionPlan";

type Props = {
  title: string;
  subtitle: string;
  requiredPlan: string;
  children: React.ReactNode;
  allowed: boolean;
};

export function ModuleGate({
  title,
  subtitle,
  requiredPlan,
  children,
  allowed,
}: Props) {
  const { navigateEmbedded } = useEmbeddedNavigation();
  const { subscription } = useSubscriptionPlan();

  if (allowed) {
    return <>{children}</>;
  }

  const currentPlan = subscription?.planName ?? "NONE";
  const currentStarterModule = subscription?.starterModule;
  const starterLabel =
    currentStarterModule === "trustAbuse"
      ? "Trust & Abuse Intelligence"
      : currentStarterModule === "competitor"
      ? "Competitor Intelligence"
      : null;

  return (
    <Page title={title} subtitle={subtitle}>
      <Layout>
        <Layout.Section>
          <Banner title={`Upgrade required: ${requiredPlan}`} tone="info">
            <p>
              Upgrade to {requiredPlan} to unlock this module and its
              backend-confirmed features for your store.
            </p>
          </Banner>
        </Layout.Section>
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h3" variant="headingMd">
                  Module access is locked on your current plan
                </Text>
                <Badge tone="attention">{currentPlan}</Badge>
              </InlineStack>
              <Text as="p" tone="subdued">
                Move to the appropriate plan to enable this workflow and all of
                its analytics, actions, and reports.
              </Text>
              {currentPlan === "STARTER" && currentStarterModule ? (
                <Banner title="Starter module selection detected" tone="info">
                  <p>
                    Your store is currently using the{" "}
                    <strong>{starterLabel ?? currentStarterModule}</strong> Starter module. Upgrade
                    or switch the Starter module to access this workflow.
                  </p>
                </Banner>
              ) : null}
              <Button
                variant="primary"
                onClick={() => navigateEmbedded("/subscription")}
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

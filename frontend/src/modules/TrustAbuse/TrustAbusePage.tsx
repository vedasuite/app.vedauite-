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
  Text,
} from "@shopify/polaris";
import { useEffect, useState } from "react";
import { useEmbeddedNavigation } from "../../hooks/useEmbeddedNavigation";
import { useSubscriptionPlan } from "../../hooks/useSubscriptionPlan";
import { embeddedShopRequest } from "../../lib/embeddedShopRequest";

type TrustAbuseOverview = {
  subscription: {
    featureAccess: {
      supportCopilot: boolean;
      evidencePackExport: boolean;
    };
  };
  summary: {
    shopperTrustProfiles: number;
    returnAbuseProfiles: number;
    highRiskOrders: number;
    manualReviewCount: number;
    automationReadiness: string;
  };
  trustTierSummary: Array<{
    tier: string;
    count: number;
    policy: string;
  }>;
  fraudReviewQueue: Array<{
    id: string;
    shopifyOrderId: string;
    riskScore: number;
    riskLevel: string;
    status: string;
    refundRequested: boolean;
  }>;
  supportCopilot: {
    status: string;
    playbooks: string[];
  };
  evidencePack: {
    status: string;
    exports: string[];
  };
  behaviorTimeline: Array<{
    id: string;
    shopper: string;
    trustScore: number;
    tier: string;
    refundRate: number;
    eventSummary: string;
  }>;
};

const fallbackOverview: TrustAbuseOverview = {
  subscription: {
    featureAccess: {
      supportCopilot: false,
      evidencePackExport: false,
    },
  },
  summary: {
    shopperTrustProfiles: 0,
    returnAbuseProfiles: 0,
    highRiskOrders: 0,
    manualReviewCount: 0,
    automationReadiness: "Trust and abuse signals are syncing.",
  },
  trustTierSummary: [],
  fraudReviewQueue: [],
  supportCopilot: {
    status: "preview",
    playbooks: [],
  },
  evidencePack: {
    status: "preview",
    exports: [],
  },
  behaviorTimeline: [],
};

export function TrustAbusePage() {
  const { subscription } = useSubscriptionPlan();
  const { navigateEmbedded } = useEmbeddedNavigation();
  const [overview, setOverview] = useState<TrustAbuseOverview>(fallbackOverview);
  const [loading, setLoading] = useState(false);
  const [syncIssue, setSyncIssue] = useState(false);
  const allowed = !!subscription?.enabledModules.trustAbuse;

  useEffect(() => {
    if (!allowed) {
      setLoading(false);
      setSyncIssue(false);
      setOverview(fallbackOverview);
      return;
    }

    let mounted = true;
    setLoading(true);
    setSyncIssue(false);

    embeddedShopRequest<{ overview: TrustAbuseOverview }>("/api/trust-abuse/overview", {
      timeoutMs: 30000,
    })
      .then((res) => {
        if (!mounted) return;
        setOverview({
          ...fallbackOverview,
          ...res.overview,
          summary: {
            ...fallbackOverview.summary,
            ...res.overview.summary,
          },
        });
      })
      .catch(() => {
        if (!mounted) return;
        setSyncIssue(true);
      })
      .finally(() => {
        if (!mounted) return;
        setLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, [allowed]);

  if (!allowed) {
    return (
      <Page
        title="Trust & Abuse Intelligence"
        subtitle="Unified trust scoring, fraud review, return abuse, and shopper policy controls."
      >
        <Layout>
          <Layout.Section>
            <Banner title="Upgrade required: Starter, Growth, or Pro" tone="info">
              <p>
                Trust & Abuse Intelligence is available on Trial, Growth, Pro, or Starter when
                this is your selected core module.
              </p>
            </Banner>
          </Layout.Section>
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <Text as="h3" variant="headingMd">
                  Pick the right trust workflow
                </Text>
                <List type="bullet">
                  <List.Item>Shopper Trust Score and trust tiers</List.Item>
                  <List.Item>Return abuse and wardrobing risk</List.Item>
                  <List.Item>Fraud review queue and evidence exports</List.Item>
                  <List.Item>Support Copilot and policy recommendations</List.Item>
                </List>
                <Button variant="primary" onClick={() => navigateEmbedded("/subscription")}>
                  Manage subscription plans
                </Button>
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>
      </Page>
    );
  }

  return (
    <Page
      title="Trust & Abuse Intelligence"
      subtitle="Unifies fraud, shopper trust, return abuse, policy, and support decisioning."
    >
      <Layout>
        {loading ? (
          <Layout.Section>
            <Banner title="Refreshing trust and abuse signals" tone="info">
              <p>
                VedaSuite is refreshing trust, abuse, and review queue signals in the background.
              </p>
            </Banner>
          </Layout.Section>
        ) : null}
        {syncIssue ? (
          <Layout.Section>
            <Banner title="Using fallback trust and abuse view" tone="warning">
              <p>
                Live review data is still syncing. The page remains available while VedaSuite
                retries in the background.
              </p>
            </Banner>
          </Layout.Section>
        ) : null}

        <Layout.Section>
          <InlineGrid columns={{ xs: 1, md: 4 }} gap="400">
            <Card>
              <BlockStack gap="200">
                <Text as="h3" variant="headingMd">
                  Trust profiles
                </Text>
                <Text as="p" variant="heading2xl">
                  {overview.summary.shopperTrustProfiles}
                </Text>
              </BlockStack>
            </Card>
            <Card>
              <BlockStack gap="200">
                <Text as="h3" variant="headingMd">
                  Return abuse
                </Text>
                <Text as="p" variant="heading2xl">
                  {overview.summary.returnAbuseProfiles}
                </Text>
              </BlockStack>
            </Card>
            <Card>
              <BlockStack gap="200">
                <Text as="h3" variant="headingMd">
                  High-risk orders
                </Text>
                <Text as="p" variant="heading2xl">
                  {overview.summary.highRiskOrders}
                </Text>
              </BlockStack>
            </Card>
            <Card>
              <BlockStack gap="200">
                <Text as="h3" variant="headingMd">
                  Manual review
                </Text>
                <Text as="p" variant="heading2xl">
                  {overview.summary.manualReviewCount}
                </Text>
              </BlockStack>
            </Card>
          </InlineGrid>
        </Layout.Section>

        <Layout.Section>
          <Banner title="Policy engine" tone="info">
            <p>{overview.summary.automationReadiness}</p>
          </Banner>
        </Layout.Section>

        <Layout.Section>
          <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
            <Card>
              <BlockStack gap="300">
                <Text as="h3" variant="headingMd">
                  Trust tiers
                </Text>
                {overview.trustTierSummary.length === 0 ? (
                  <Text as="p" tone="subdued">
                    Trust tiers will populate after enough shopper history has been synced.
                  </Text>
                ) : (
                  overview.trustTierSummary.map((tier) => (
                    <div key={tier.tier} className="vs-action-card">
                      <InlineStack align="space-between">
                        <BlockStack gap="100">
                          <Text as="p" variant="headingSm">
                            {tier.tier}
                          </Text>
                          <Text as="p" tone="subdued">
                            {tier.policy}
                          </Text>
                        </BlockStack>
                        <Badge tone="info">{String(tier.count)}</Badge>
                      </InlineStack>
                    </div>
                  ))
                )}
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h3" variant="headingMd">
                  Fraud review queue
                </Text>
                {overview.fraudReviewQueue.length === 0 ? (
                  <Text as="p" tone="subdued">
                    No urgent fraud reviews are open right now.
                  </Text>
                ) : (
                  overview.fraudReviewQueue.map((order) => (
                    <div key={order.id} className="vs-action-card">
                      <InlineStack align="space-between" blockAlign="start">
                        <BlockStack gap="100">
                          <Text as="p" variant="headingSm">
                            {order.shopifyOrderId}
                          </Text>
                          <Text as="p" tone="subdued">
                            {order.status} | {order.riskLevel} risk | score {order.riskScore}
                          </Text>
                        </BlockStack>
                        <Badge tone={order.riskLevel === "High" ? "critical" : "warning"}>
                          {order.refundRequested ? "Refund friction" : "Review"}
                        </Badge>
                      </InlineStack>
                    </div>
                  ))
                )}
              </BlockStack>
            </Card>
          </InlineGrid>
        </Layout.Section>

        <Layout.Section>
          <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
            <Card>
              <BlockStack gap="300">
                <Text as="h3" variant="headingMd">
                  Customer behavior timeline
                </Text>
                {overview.behaviorTimeline.length === 0 ? (
                  <Text as="p" tone="subdued">
                    Shopper trust events will appear here after order and refund history is
                    available.
                  </Text>
                ) : (
                  overview.behaviorTimeline.map((item) => (
                    <div key={item.id} className="vs-action-card">
                      <InlineStack align="space-between">
                        <BlockStack gap="100">
                          <Text as="p" variant="headingSm">
                            {item.shopper}
                          </Text>
                          <Text as="p" tone="subdued">
                            {item.eventSummary}
                          </Text>
                        </BlockStack>
                        <Badge
                          tone={
                            item.trustScore >= 80
                              ? "success"
                              : item.trustScore < 50
                              ? "critical"
                              : "info"
                          }
                        >
                          {item.tier}
                        </Badge>
                      </InlineStack>
                    </div>
                  ))
                )}
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h3" variant="headingMd">
                  Support Copilot and evidence packs
                </Text>
                <Text as="p" tone="subdued">
                  {overview.supportCopilot.status === "active"
                    ? "Support Copilot is available for trust-aware merchant handling."
                    : "Support Copilot previews are visible on this plan."}
                </Text>
                <List type="bullet">
                  {overview.supportCopilot.playbooks.length === 0 ? (
                    <List.Item>Playbooks will appear once trust workflows are synced.</List.Item>
                  ) : (
                    overview.supportCopilot.playbooks.map((playbook) => (
                      <List.Item key={playbook}>{playbook}</List.Item>
                    ))
                  )}
                </List>
                <Text as="p" variant="headingSm">
                  Evidence exports
                </Text>
                <List type="bullet">
                  {overview.evidencePack.exports.length === 0 ? (
                    <List.Item>Evidence export templates will appear once review items exist.</List.Item>
                  ) : (
                    overview.evidencePack.exports.map((item) => (
                      <List.Item key={item}>{item}</List.Item>
                    ))
                  )}
                </List>
              </BlockStack>
            </Card>
          </InlineGrid>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

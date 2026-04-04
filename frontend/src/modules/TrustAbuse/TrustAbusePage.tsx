import { Badge, Banner, BlockStack, Button, Card, InlineGrid, InlineStack, Layout, List, Page, Text } from "@shopify/polaris";
import { useEffect, useMemo, useState } from "react";
import { useEmbeddedNavigation } from "../../hooks/useEmbeddedNavigation";
import { useSubscriptionPlan } from "../../hooks/useSubscriptionPlan";
import { embeddedShopRequest } from "../../lib/embeddedShopRequest";

type Overview = {
  subscription: { featureAccess: { supportCopilot: boolean; evidencePackExport: boolean } };
  summary: {
    shopperTrustProfiles: number;
    returnAbuseProfiles: number;
    highRiskOrders: number;
    manualReviewCount: number;
    sharedFraudNetworkEnabled?: boolean;
    automationReadiness: string;
  };
  scoreBands: { low: string; medium: string; high: string };
  trustTierSummary: Array<{ tier: string; count: number; policy: string }>;
  fraudReviewQueue: Array<{ id: string; shopifyOrderId: string; riskScore: number; riskLevel: string; status: string; refundRequested: boolean }>;
  returnAbuseSignals: Array<{ id: string; email: string | null; abuseScore: number; reasons: string[] }>;
  wardrobingSignals: Array<{ id: string; email: string | null; wardrobingScore: number; refundRate: number; totalRefunds: number; totalOrders: number; likely: boolean; confidence: number; recommendedAction: string; reasons: string[]; automationPosture: string }>;
  networkMatches: Array<{ id: string; orderId: string; customerId: string | null; riskLevel: string; repeatSignals: number; email: string | null; confidence: number; recommendedAction: string; reasons: string[]; automationPosture: string }>;
  chargebackCandidates: Array<{ id: string; shopifyOrderId: string; chargebackRiskScore: number; reasons: string[] }>;
  supportCopilot: { status: string; playbooks: string[]; cases?: Array<{ title: string; reason: string; recommendedHandling: string }> };
  evidencePack: { status: string; exports: string[]; templates?: Array<{ title: string; detail: string }> };
  behaviorTimeline: Array<{ id: string; shopper: string; trustScore: number; tier: string; refundRate: number; eventSummary: string }>;
  refundOutcomeSimulator?: { likelyChannel: string; merchantOutcome: string; recoveryRate: string; recommendedAction: string; options?: Array<{ channel: string; marginImpact: string; confidence: string; recommendedWhen: string }> };
  smartPolicyRecommendations?: Array<{ name: string; description: string; appliesTo: string; action: string }>;
  trustRecoveryActions?: Array<{ title: string; detail: string; eligibleProfiles: number; priority: string }>;
  automationRules?: Array<{ id: string; title: string; status: string; detail: string }>;
};

const fallbackOverview: Overview = {
  subscription: { featureAccess: { supportCopilot: false, evidencePackExport: false } },
  summary: { shopperTrustProfiles: 0, returnAbuseProfiles: 0, highRiskOrders: 0, manualReviewCount: 0, sharedFraudNetworkEnabled: false, automationReadiness: "Trust and abuse signals are syncing." },
  scoreBands: { low: "0-30", medium: "31-70", high: "71-100" },
  trustTierSummary: [],
  fraudReviewQueue: [],
  returnAbuseSignals: [],
  wardrobingSignals: [],
  networkMatches: [],
  chargebackCandidates: [],
  supportCopilot: { status: "preview", playbooks: [], cases: [] },
  evidencePack: { status: "preview", exports: [], templates: [] },
  behaviorTimeline: [],
  refundOutcomeSimulator: { likelyChannel: "Store credit or exchange", merchantOutcome: "Trust-aware refund handling becomes available once enough signals sync.", recoveryRate: "Recovery insights will appear after shopper and refund history is available.", recommendedAction: "Enable trust-aware refund routing once live signals are ready.", options: [] },
  smartPolicyRecommendations: [],
  trustRecoveryActions: [],
  automationRules: [],
};

function toneForScore(score: number) {
  if (score >= 80) return "success";
  if (score >= 50) return "attention";
  return "critical";
}

function toneForStatus(value: string) {
  const normalized = value.toLowerCase();
  if (normalized.includes("ready") || normalized.includes("active")) return "success";
  if (normalized.includes("monitor") || normalized.includes("warm")) return "attention";
  return "info";
}

function EmptyState({ text }: { text: string }) {
  return <Text as="p" tone="subdued">{text}</Text>;
}

export function TrustAbusePage() {
  const { subscription } = useSubscriptionPlan();
  const { navigateEmbedded } = useEmbeddedNavigation();
  const [overview, setOverview] = useState<Overview>(fallbackOverview);
  const [loading, setLoading] = useState(false);
  const [syncIssue, setSyncIssue] = useState(false);
  const allowed = !!subscription?.enabledModules?.trustAbuse;

  useEffect(() => {
    if (!allowed) {
      setOverview(fallbackOverview);
      setLoading(false);
      setSyncIssue(false);
      return;
    }
    let mounted = true;
    setLoading(true);
    setSyncIssue(false);
    embeddedShopRequest<{ overview: Overview }>("/api/trust-abuse/overview", { timeoutMs: 30000 })
      .then((res) => {
        if (!mounted) return;
        setOverview({
          ...fallbackOverview,
          ...res.overview,
          summary: { ...fallbackOverview.summary, ...res.overview.summary },
          scoreBands: {
            low: res.overview.scoreBands?.low ?? "0-30",
            medium: res.overview.scoreBands?.medium ?? "31-70",
            high: res.overview.scoreBands?.high ?? "71-100",
          },
          subscription: {
            ...fallbackOverview.subscription,
            ...res.overview.subscription,
            featureAccess: {
              ...fallbackOverview.subscription.featureAccess,
              ...res.overview.subscription?.featureAccess,
            },
          },
        });
      })
      .catch(() => mounted && setSyncIssue(true))
      .finally(() => mounted && setLoading(false));
    return () => {
      mounted = false;
    };
  }, [allowed]);

  const scoreBandCards = useMemo(
    () => [
      { label: "Low risk band", value: overview.scoreBands?.low ?? "0-30" },
      { label: "Medium risk band", value: overview.scoreBands?.medium ?? "31-70" },
      { label: "High risk band", value: overview.scoreBands?.high ?? "71-100" },
      { label: "Shared network", value: overview.summary.sharedFraudNetworkEnabled ? "Enabled" : "Disabled" },
    ],
    [overview.scoreBands, overview.summary.sharedFraudNetworkEnabled]
  );

  if (!allowed) {
    return (
      <Page title="Trust & Abuse Intelligence" subtitle="Unified trust scoring, fraud review, return abuse, and shopper policy controls.">
        <Layout>
          <Layout.Section>
            <Banner title="Upgrade required: Starter, Growth, or Pro" tone="info">
              <p>Trust & Abuse Intelligence is available on Trial, Growth, Pro, or Starter when this is your selected core module.</p>
            </Banner>
          </Layout.Section>
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <Text as="h3" variant="headingMd">Pick the right trust workflow</Text>
                <List type="bullet">
                  <List.Item>Shopper Trust Score and explainable trust tiers</List.Item>
                  <List.Item>Return abuse and wardrobing risk monitoring</List.Item>
                  <List.Item>Fraud review queue, policy engine, and support copilots</List.Item>
                  <List.Item>Evidence pack exports and refund outcome simulation</List.Item>
                </List>
                <Button variant="primary" onClick={() => navigateEmbedded("/subscription")}>Manage subscription plans</Button>
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>
      </Page>
    );
  }

  return (
    <Page title="Trust & Abuse Intelligence" subtitle="Unifies fraud, shopper trust, return abuse, policy, and support decisioning.">
      <Layout>
        {loading ? <Layout.Section><Banner title="Refreshing trust and abuse signals" tone="info"><p>VedaSuite is refreshing trust, abuse, and review queue signals in the background.</p></Banner></Layout.Section> : null}
        {syncIssue ? <Layout.Section><Banner title="Using fallback trust and abuse view" tone="warning"><p>Live review data is still syncing. The page remains available while VedaSuite retries in the background.</p></Banner></Layout.Section> : null}

        <Layout.Section>
          <InlineGrid columns={{ xs: 1, md: 4 }} gap="400">
            {[
              ["Trust profiles", overview.summary.shopperTrustProfiles],
              ["Return abuse", overview.summary.returnAbuseProfiles],
              ["High-risk orders", overview.summary.highRiskOrders],
              ["Manual review", overview.summary.manualReviewCount],
            ].map(([label, value]) => (
              <Card key={String(label)}><BlockStack gap="200"><Text as="h3" variant="headingMd">{String(label)}</Text><Text as="p" variant="heading2xl">{String(value)}</Text></BlockStack></Card>
            ))}
          </InlineGrid>
        </Layout.Section>

        <Layout.Section>
          <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
            <Banner title="Policy engine" tone="info"><p>{overview.summary.automationReadiness}</p></Banner>
            <Card>
              <BlockStack gap="300">
                <Text as="h3" variant="headingMd">Risk scoring framework</Text>
                <InlineGrid columns={{ xs: 1, sm: 2, md: 4 }} gap="300">
                  {scoreBandCards.map((card) => (
                    <div key={card.label} className="vs-signal-stat">
                      <Text as="p" variant="bodySm" tone="subdued">{card.label}</Text>
                      <Text as="p" variant="headingMd">{card.value}</Text>
                    </div>
                  ))}
                </InlineGrid>
              </BlockStack>
            </Card>
          </InlineGrid>
        </Layout.Section>

        <Layout.Section>
          <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
            <Card>
              <BlockStack gap="300">
                <Text as="h3" variant="headingMd">Refund Outcome Simulator</Text>
                <Text as="p" tone="subdued">{overview.refundOutcomeSimulator?.merchantOutcome}</Text>
                <InlineGrid columns={{ xs: 1, sm: 2 }} gap="300">
                  <div className="vs-signal-stat">
                    <Text as="p" variant="bodySm" tone="subdued">Likely channel</Text>
                    <Badge tone="info">{overview.refundOutcomeSimulator?.likelyChannel ?? "Pending"}</Badge>
                  </div>
                  <div className="vs-signal-stat">
                    <Text as="p" variant="bodySm" tone="subdued">Recovery guidance</Text>
                    <Text as="p">{overview.refundOutcomeSimulator?.recoveryRate ?? "Syncing"}</Text>
                  </div>
                </InlineGrid>
                <Text as="p" variant="bodySm">{overview.refundOutcomeSimulator?.recommendedAction}</Text>
                <InlineGrid columns={{ xs: 1, md: 3 }} gap="300">
                  {(overview.refundOutcomeSimulator?.options ?? []).length === 0 ? (
                    <EmptyState text="Simulation comparisons will appear once live trust signals are ready." />
                  ) : (
                    (overview.refundOutcomeSimulator?.options ?? []).map((option) => (
                      <div key={option.channel} className="vs-action-card">
                        <BlockStack gap="100">
                          <InlineStack align="space-between"><Text as="p" variant="headingSm">{option.channel}</Text><Badge tone="info">{option.confidence}</Badge></InlineStack>
                          <Text as="p" tone="subdued">{option.marginImpact}</Text>
                          <Text as="p" variant="bodySm">{option.recommendedWhen}</Text>
                        </BlockStack>
                      </div>
                    ))
                  )}
                </InlineGrid>
              </BlockStack>
            </Card>
            <Card>
              <BlockStack gap="300">
                <Text as="h3" variant="headingMd">Smart Policy Engine</Text>
                {(overview.smartPolicyRecommendations ?? []).length === 0 ? <EmptyState text="Policy recommendations will appear after trust and abuse signals are synced." /> : (
                  (overview.smartPolicyRecommendations ?? []).map((policy) => (
                    <div key={policy.name} className="vs-action-card">
                      <BlockStack gap="100">
                        <InlineStack align="space-between"><Text as="p" variant="headingSm">{policy.name}</Text><Badge tone="success">{policy.action}</Badge></InlineStack>
                        <Text as="p" tone="subdued">{policy.description}</Text>
                        <Text as="p" variant="bodySm">Applies to: {policy.appliesTo}</Text>
                      </BlockStack>
                    </div>
                  ))
                )}
                <Text as="p" variant="headingSm">Automation posture</Text>
                <BlockStack gap="200">
                  {(overview.automationRules ?? []).length === 0 ? <EmptyState text="Automation rules will populate once enough repeat trust patterns exist." /> : (
                    (overview.automationRules ?? []).map((rule) => (
                      <div key={rule.id} className="vs-action-card">
                        <InlineStack align="space-between" blockAlign="start">
                          <BlockStack gap="100"><Text as="p" variant="headingSm">{rule.title}</Text><Text as="p" tone="subdued">{rule.detail}</Text></BlockStack>
                          <Badge tone={toneForStatus(rule.status)}>{rule.status}</Badge>
                        </InlineStack>
                      </div>
                    ))
                  )}
                </BlockStack>
              </BlockStack>
            </Card>
          </InlineGrid>
        </Layout.Section>

        <Layout.Section>
          <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
            <Card>
              <BlockStack gap="300">
                <Text as="h3" variant="headingMd">Trust tiers</Text>
                {overview.trustTierSummary.length === 0 ? <EmptyState text="Trust tiers will populate after enough shopper history has been synced." /> : (
                  overview.trustTierSummary.map((tier) => (
                    <div key={tier.tier} className="vs-action-card">
                      <InlineStack align="space-between"><BlockStack gap="100"><Text as="p" variant="headingSm">{tier.tier}</Text><Text as="p" tone="subdued">{tier.policy}</Text></BlockStack><Badge tone="info">{String(tier.count)}</Badge></InlineStack>
                    </div>
                  ))
                )}
              </BlockStack>
            </Card>
            <Card>
              <BlockStack gap="300">
                <Text as="h3" variant="headingMd">Fraud review queue</Text>
                {overview.fraudReviewQueue.length === 0 ? <EmptyState text="No urgent fraud reviews are open right now." /> : (
                  overview.fraudReviewQueue.map((order) => (
                    <div key={order.id} className="vs-action-card">
                      <InlineStack align="space-between" blockAlign="start">
                        <BlockStack gap="100"><Text as="p" variant="headingSm">{order.shopifyOrderId}</Text><Text as="p" tone="subdued">{order.status} | {order.riskLevel} risk | score {order.riskScore}</Text></BlockStack>
                        <Badge tone={order.riskLevel === "High" ? "critical" : "warning"}>{order.refundRequested ? "Refund friction" : "Review"}</Badge>
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
                <Text as="h3" variant="headingMd">Return abuse and wardrobing signals</Text>
                <BlockStack gap="200">
                  {overview.returnAbuseSignals.length === 0 && overview.wardrobingSignals.length === 0 ? <EmptyState text="Return-abuse and wardrobing indicators will appear after enough refund behavior is collected." /> : null}
                  {overview.returnAbuseSignals.map((signal) => (
                    <div key={signal.id} className="vs-action-card">
                      <BlockStack gap="100">
                        <InlineStack align="space-between"><Text as="p" variant="headingSm">{signal.email ?? `profile-${signal.id.slice(-4)}`}</Text><Badge tone={toneForScore(signal.abuseScore)}>{`abuse ${signal.abuseScore}`}</Badge></InlineStack>
                        {signal.reasons.map((reason) => <Text key={reason} as="p" variant="bodySm" tone="subdued">{reason}</Text>)}
                      </BlockStack>
                    </div>
                  ))}
                  {overview.wardrobingSignals.map((signal) => (
                    <div key={signal.id} className="vs-action-card">
                      <BlockStack gap="100">
                        <InlineStack align="space-between"><Text as="p" variant="headingSm">{signal.email ?? `shopper-${signal.id.slice(-4)}`}</Text><Badge tone={signal.likely ? "critical" : "attention"}>{`wardrobing ${signal.wardrobingScore}`}</Badge></InlineStack>
                        <Text as="p" variant="bodySm" tone="subdued">{`${signal.totalRefunds} refunds across ${signal.totalOrders} orders | ${signal.refundRate}% refund rate`}</Text>
                        <Text as="p" variant="bodySm">{signal.recommendedAction}</Text>
                      </BlockStack>
                    </div>
                  ))}
                </BlockStack>
              </BlockStack>
            </Card>
            <Card>
              <BlockStack gap="300">
                <Text as="h3" variant="headingMd">Shared network and chargeback pressure</Text>
                <BlockStack gap="200">
                  {overview.networkMatches.length === 0 && overview.chargebackCandidates.length === 0 ? <EmptyState text="Shared-network matches and chargeback candidates will appear after more order-risk data syncs." /> : null}
                  {overview.networkMatches.map((match) => (
                    <div key={match.id} className="vs-action-card">
                      <InlineStack align="space-between" blockAlign="start">
                        <BlockStack gap="100"><Text as="p" variant="headingSm">Network match on {match.orderId}</Text><Text as="p" tone="subdued">{match.reasons.join(" ")}</Text><Text as="p" variant="bodySm">{match.automationPosture}</Text></BlockStack>
                        <Badge tone={match.repeatSignals >= 3 ? "critical" : "attention"}>{`${match.repeatSignals} repeats`}</Badge>
                      </InlineStack>
                    </div>
                  ))}
                  {overview.chargebackCandidates.map((candidate) => (
                    <div key={candidate.id} className="vs-action-card">
                      <InlineStack align="space-between" blockAlign="start">
                        <BlockStack gap="100"><Text as="p" variant="headingSm">{candidate.shopifyOrderId}</Text>{candidate.reasons.map((reason) => <Text key={reason} as="p" variant="bodySm" tone="subdued">{reason}</Text>)}</BlockStack>
                        <Badge tone={toneForScore(candidate.chargebackRiskScore)}>{`risk ${candidate.chargebackRiskScore}`}</Badge>
                      </InlineStack>
                    </div>
                  ))}
                </BlockStack>
              </BlockStack>
            </Card>
          </InlineGrid>
        </Layout.Section>

        <Layout.Section>
          <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
            <Card>
              <BlockStack gap="300">
                <Text as="h3" variant="headingMd">Customer behavior timeline</Text>
                {overview.behaviorTimeline.length === 0 ? <EmptyState text="Shopper trust events will appear here after order and refund history is available." /> : (
                  overview.behaviorTimeline.map((item) => (
                    <div key={item.id} className="vs-action-card">
                      <InlineStack align="space-between" blockAlign="start">
                        <BlockStack gap="100"><Text as="p" variant="headingSm">{item.shopper}</Text><Text as="p" tone="subdued">{item.eventSummary}</Text><Text as="p" variant="bodySm">Refund rate {item.refundRate}% | score {item.trustScore}</Text></BlockStack>
                        <Badge tone={toneForScore(item.trustScore)}>{item.tier}</Badge>
                      </InlineStack>
                    </div>
                  ))
                )}
              </BlockStack>
            </Card>
            <Card>
              <BlockStack gap="300">
                <Text as="h3" variant="headingMd">Support Copilot and evidence packs</Text>
                <Banner title={overview.supportCopilot.status === "active" ? "Support Copilot is available" : "Support Copilot preview"} tone={overview.supportCopilot.status === "active" ? "success" : "info"}>
                  <p>{overview.supportCopilot.status === "active" ? "Use trust score, abuse score, and policy guidance directly in merchant support workflows." : "Support Copilot previews are visible on this plan."}</p>
                </Banner>
                <Text as="p" variant="headingSm">Playbooks</Text>
                <List type="bullet">
                  {overview.supportCopilot.playbooks.length === 0 ? <List.Item>Playbooks will appear once trust workflows are synced.</List.Item> : overview.supportCopilot.playbooks.map((playbook) => <List.Item key={playbook}>{playbook}</List.Item>)}
                </List>
                <Text as="p" variant="headingSm">Suggested support cases</Text>
                <BlockStack gap="200">
                  {(overview.supportCopilot.cases ?? []).length === 0 ? <EmptyState text="Suggested support cases will appear once order-risk and shopper history overlap." /> : (
                    (overview.supportCopilot.cases ?? []).map((item) => (
                      <div key={item.title} className="vs-action-card">
                        <BlockStack gap="100"><Text as="p" variant="headingSm">{item.title}</Text><Text as="p" tone="subdued">{item.reason}</Text><Text as="p" variant="bodySm">{item.recommendedHandling}</Text></BlockStack>
                      </div>
                    ))
                  )}
                </BlockStack>
                <Text as="p" variant="headingSm">Evidence exports</Text>
                <List type="bullet">
                  {overview.evidencePack.exports.length === 0 ? <List.Item>Evidence export templates will appear once review items exist.</List.Item> : overview.evidencePack.exports.map((item) => <List.Item key={item}>{item}</List.Item>)}
                </List>
                <InlineGrid columns={{ xs: 1, md: 2 }} gap="200">
                  {(overview.evidencePack.templates ?? []).map((item) => (
                    <div key={item.title} className="vs-action-card">
                      <BlockStack gap="100"><Text as="p" variant="headingSm">{item.title}</Text><Text as="p" tone="subdued">{item.detail}</Text></BlockStack>
                    </div>
                  ))}
                </InlineGrid>
              </BlockStack>
            </Card>
          </InlineGrid>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h3" variant="headingMd">Trust Recovery Engine</Text>
              {(overview.trustRecoveryActions ?? []).length === 0 ? <EmptyState text="Trust recovery actions will appear once the shopper timeline has enough history." /> : (
                <InlineGrid columns={{ xs: 1, md: 3 }} gap="300">
                  {(overview.trustRecoveryActions ?? []).map((action) => (
                    <div key={action.title} className="vs-signal-stat">
                      <BlockStack gap="100">
                        <InlineStack align="space-between"><Text as="p" variant="headingSm">{action.title}</Text><Badge tone="attention">{action.priority}</Badge></InlineStack>
                        <Text as="p" tone="subdued">{action.detail}</Text>
                        <Text as="p" variant="bodySm">Eligible profiles: {action.eligibleProfiles}</Text>
                      </BlockStack>
                    </div>
                  ))}
                </InlineGrid>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

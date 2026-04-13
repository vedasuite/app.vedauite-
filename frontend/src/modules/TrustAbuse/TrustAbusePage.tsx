import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  InlineGrid,
  InlineStack,
  Layout,
  List,
  Modal,
  Page,
  Tabs,
  Text,
  Toast,
} from "@shopify/polaris";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useEmbeddedNavigation } from "../../hooks/useEmbeddedNavigation";
import { useShopifyAdminLinks } from "../../hooks/useShopifyAdminLinks";
import { useSubscriptionPlan } from "../../hooks/useSubscriptionPlan";
import { embeddedShopRequest } from "../../lib/embeddedShopRequest";

type Overview = {
  subscription: { featureAccess: { supportCopilot: boolean; evidencePackExport: boolean } };
  readiness?: { readinessState: string; reason: string; processingState?: string; lastUpdatedAt?: string | null };
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
  fraudReviewQueue: Array<{ id: string; shopifyOrderId: string; riskScore: number; riskLevel: string; status: string; refundRequested: boolean; createdAt?: string | null }>;
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

type QueueAction = "allow" | "flag" | "block" | "manual_review";

function createEmptyOverview(readinessState = "SYNC_REQUIRED", reason = "Run the first live sync to populate trust and abuse outputs."): Overview {
  return {
    subscription: { featureAccess: { supportCopilot: false, evidencePackExport: false } },
    readiness: { readinessState, reason, processingState: "NOT_STARTED", lastUpdatedAt: null },
    summary: { shopperTrustProfiles: 0, returnAbuseProfiles: 0, highRiskOrders: 0, manualReviewCount: 0, sharedFraudNetworkEnabled: false, automationReadiness: reason },
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
    refundOutcomeSimulator: undefined,
    smartPolicyRecommendations: [],
    trustRecoveryActions: [],
    automationRules: [],
  };
}

function normalizeStatus(value?: string | null) {
  const normalized = (value ?? "").toLowerCase();
  if (normalized.includes("high") || normalized.includes("critical") || normalized.includes("block")) return "High risk";
  if (normalized.includes("review") || normalized.includes("manual") || normalized.includes("escalate")) return "Needs review";
  if (normalized.includes("ready") || normalized.includes("active")) return "Ready";
  if (normalized.includes("monitor") || normalized.includes("warm") || normalized.includes("medium")) return "Monitor";
  return "Informational";
}

function toneForStatus(value?: string | null) {
  switch (normalizeStatus(value)) {
    case "High risk": return "critical";
    case "Needs review": return "attention";
    case "Ready": return "success";
    case "Monitor": return "warning";
    default: return "info";
  }
}

function recommendationForOrder(score: number): QueueAction {
  if (score >= 85) return "block";
  if (score >= 71) return "manual_review";
  if (score >= 45) return "flag";
  return "allow";
}

function queueActionLabel(action: QueueAction) {
  switch (action) {
    case "block": return "Block order";
    case "manual_review": return "Send to manual review";
    case "flag": return "Flag for follow-up";
    default: return "Allow order";
  }
}

function formatTimestamp(value?: string | null) {
  if (!value) return "Recent";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Recent" : date.toLocaleString();
}

function EmptyState({ text }: { text: string }) {
  return <Text as="p" tone="subdued">{text}</Text>;
}

export function TrustAbusePage() {
  const { subscription } = useSubscriptionPlan();
  const { navigateEmbedded } = useEmbeddedNavigation();
  const { getOrderUrl } = useShopifyAdminLinks();
  const [overview, setOverview] = useState<Overview>(createEmptyOverview());
  const [loading, setLoading] = useState(false);
  const [syncIssue, setSyncIssue] = useState(false);
  const [selectedEvidenceTab, setSelectedEvidenceTab] = useState(0);
  const [activeOrder, setActiveOrder] = useState<Overview["fraudReviewQueue"][number] | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const allowed = !!subscription?.enabledModules?.trustAbuse;

  const loadOverview = useCallback(async () => {
    if (!allowed) {
      setOverview(createEmptyOverview());
      setLoading(false);
      setSyncIssue(false);
      return;
    }
    setLoading(true);
    setSyncIssue(false);
    try {
      const res = await embeddedShopRequest<{ overview: Overview }>("/api/trust-abuse/overview", { timeoutMs: 30000 });
      setOverview(res.overview);
    } catch {
      setOverview(createEmptyOverview("FAILED", "VedaSuite could not load persisted trust and abuse outputs."));
      setSyncIssue(true);
    } finally {
      setLoading(false);
    }
  }, [allowed]);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  const actionQueue = useMemo(
    () => overview.fraudReviewQueue.slice(0, 5).map((order) => {
      const recommendedAction = recommendationForOrder(order.riskScore);
      return { ...order, recommendedAction, recommendedLabel: queueActionLabel(recommendedAction) };
    }),
    [overview.fraudReviewQueue]
  );

  const attentionSummary = useMemo(
    () =>
      actionQueue.length === 0
        ? [
            "No urgent fraud reviews are open right now.",
            "Use the evidence section below to monitor return abuse, network overlap, and chargeback pressure.",
          ]
        : [
            `${overview.summary.manualReviewCount} orders currently need manual review.`,
            `${overview.summary.highRiskOrders} high-risk orders are still open in the store review flow.`,
            `Highest priority order: ${actionQueue[0].shopifyOrderId} with score ${actionQueue[0].riskScore}.`,
          ],
    [actionQueue, overview.summary.highRiskOrders, overview.summary.manualReviewCount]
  );

  const topPolicyActions = useMemo(() => {
    const actions = [
      ...(overview.smartPolicyRecommendations ?? []).map((item) => ({
        key: `policy-${item.name}`,
        title: item.name,
        why: item.description,
        appliesTo: item.appliesTo,
        expectedEffect: item.action,
        status: normalizeStatus(item.action),
      })),
      ...(overview.trustRecoveryActions ?? []).map((item) => ({
        key: `recovery-${item.title}`,
        title: item.title,
        why: item.detail,
        appliesTo: `${item.eligibleProfiles} profiles in the current trust mix`,
        expectedEffect: "Reduce refund pressure while protecting good customers.",
        status: normalizeStatus(item.priority),
      })),
    ];
    return actions.slice(0, 5);
  }, [overview.smartPolicyRecommendations, overview.trustRecoveryActions]);

  const scoreBandCards = useMemo(
    () => [
      { label: "Low score band", value: overview.scoreBands.low },
      { label: "Medium score band", value: overview.scoreBands.medium },
      { label: "High score band", value: overview.scoreBands.high },
      { label: "Shared fraud network", value: overview.summary.sharedFraudNetworkEnabled ? "Ready" : "Informational" },
    ],
    [overview.scoreBands, overview.summary.sharedFraudNetworkEnabled]
  );

  const evidenceTabs = useMemo(
    () => [
      { id: "return-abuse", content: "Return abuse", panelID: "return-abuse" },
      { id: "network-chargeback", content: "Network and chargeback", panelID: "network-chargeback" },
      { id: "customer-timeline", content: "Customer timeline", panelID: "customer-timeline" },
      { id: "evidence-exports", content: "Evidence exports", panelID: "evidence-exports" },
    ],
    []
  );

  const selectedEvidenceKey = evidenceTabs[selectedEvidenceTab]?.id;

  const runAction = useCallback(async (action: QueueAction) => {
    if (!activeOrder) return;
    try {
      const response = await embeddedShopRequest<{ order?: { shopifyTagResult?: { updated?: boolean; reason?: string } } }>("/api/fraud/action", {
        method: "POST",
        body: { orderId: activeOrder.id, action },
        timeoutMs: 30000,
      });
      const tagResult = response.order?.shopifyTagResult;
      setToast(
        tagResult?.updated
          ? `Order ${activeOrder.shopifyOrderId} was updated and tagged in Shopify.`
          : `Order ${activeOrder.shopifyOrderId} was updated${tagResult?.reason ? ` (${tagResult.reason})` : "."}`
      );
      setActiveOrder(null);
      await loadOverview();
    } catch {
      setToast("Unable to update the order right now.");
    }
  }, [activeOrder, loadOverview]);

  if (!allowed) {
    return (
      <Page title="Detect refund abuse and customer risk" subtitle="Fraud Intelligence keeps refund abuse, risky customers, and order-risk review in one operational workspace.">
        <Layout>
          <Layout.Section>
            <Banner title="Upgrade required: Starter, Growth, or Pro" tone="info">
              <p>Fraud Intelligence is available on Trial, Growth, Pro, or Starter when this is your selected core module.</p>
            </Banner>
          </Layout.Section>
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <Text as="h3" variant="headingMd">What this workflow includes</Text>
                <List type="bullet">
                  <List.Item>Fraud review queue and order-level guidance</List.Item>
                  <List.Item>Return abuse and wardrobing evidence</List.Item>
                  <List.Item>Chargeback pressure and shared-network checks</List.Item>
                  <List.Item>Policy actions, support guidance, and evidence packs</List.Item>
                </List>
                <Button variant="primary" onClick={() => navigateEmbedded("/app/billing")}>Manage subscription plans</Button>
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>
      </Page>
    );
  }

  return (
    <Page
      title="Fraud Intelligence"
      subtitle="Review risky orders, customer behavior, and the policy actions VedaSuite recommends right now."
      primaryAction={{ content: "Refresh", onAction: () => void loadOverview(), loading, disabled: loading }}
    >
      <Layout>
        {loading ? (
          <Layout.Section>
            <Banner title="Refreshing fraud intelligence" tone="info">
              <p>VedaSuite is updating the review queue, customer evidence, and policy recommendations.</p>
            </Banner>
          </Layout.Section>
        ) : null}
        {syncIssue || overview.readiness?.readinessState !== "READY_WITH_DATA" ? (
          <Layout.Section>
            <Banner title={overview.readiness?.readinessState === "FAILED" ? "Fraud intelligence needs attention" : "Fraud intelligence is still preparing data"} tone={overview.readiness?.readinessState === "FAILED" ? "critical" : "warning"}>
              <p>{overview.readiness?.reason ?? "VedaSuite will populate this module after live sync and processing complete."}</p>
            </Banner>
          </Layout.Section>
        ) : null}

        <Layout.Section>
          <InlineGrid columns={{ xs: 1, sm: 2, md: 4 }} gap="300">
            {[
              ["Trust profiles", overview.summary.shopperTrustProfiles],
              ["Return abuse", overview.summary.returnAbuseProfiles],
              ["High-risk orders", overview.summary.highRiskOrders],
              ["Manual review", overview.summary.manualReviewCount],
            ].map(([label, value]) => (
              <Card key={String(label)}>
                <BlockStack gap="150">
                  <Text as="p" variant="bodySm" tone="subdued">{String(label)}</Text>
                  <Text as="p" variant="heading2xl">{String(value)}</Text>
                </BlockStack>
              </Card>
            ))}
          </InlineGrid>
        </Layout.Section>

        <Layout.Section>
          <InlineGrid columns={{ xs: 1, md: 2 }} gap="300">
            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <BlockStack gap="100">
                    <Text as="h2" variant="headingLg">Actions that need attention now</Text>
                    <Text as="p" tone="subdued">Review the highest-priority orders first, then confirm the recommended action inside Shopify.</Text>
                  </BlockStack>
                  <Badge tone="attention">{actionQueue.length > 0 ? `${actionQueue.length} open` : "Queue clear"}</Badge>
                </InlineStack>
                {actionQueue.length === 0 ? (
                  <Banner title="No urgent fraud reviews are open" tone="success">
                    <p>The queue is currently clear. Keep monitoring return abuse and chargeback signals for new activity.</p>
                  </Banner>
                ) : (
                  <BlockStack gap="200">
                    {actionQueue.map((order) => (
                      <div key={order.id} className="vs-action-card">
                        <InlineStack align="space-between" blockAlign="start" gap="300">
                          <BlockStack gap="100">
                            <InlineStack gap="200" blockAlign="center">
                              <Text as="p" variant="headingSm">{order.shopifyOrderId}</Text>
                              <Badge tone={toneForStatus(order.riskLevel)}>{normalizeStatus(order.riskLevel)}</Badge>
                            </InlineStack>
                            <Text as="p" tone="subdued">Score {order.riskScore} | {order.refundRequested ? "Refund requested" : "Order review"} | {formatTimestamp(order.createdAt)}</Text>
                            <Text as="p" variant="bodySm">Recommended action: {order.recommendedLabel}</Text>
                          </BlockStack>
                          <Button onClick={() => setActiveOrder(order)}>Review</Button>
                        </InlineStack>
                      </div>
                    ))}
                  </BlockStack>
                )}
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingLg">What to do next</Text>
                <List type="bullet">
                  {attentionSummary.map((item) => <List.Item key={item}>{item}</List.Item>)}
                </List>
                <div className="vs-action-card">
                  <BlockStack gap="100">
                    <InlineStack align="space-between" blockAlign="center">
                      <Text as="p" variant="headingSm">Recommended policy posture</Text>
                      <Badge tone={toneForStatus(overview.summary.automationReadiness)}>{normalizeStatus(overview.summary.automationReadiness)}</Badge>
                    </InlineStack>
                    <Text as="p" tone="subdued">{overview.summary.automationReadiness}</Text>
                  </BlockStack>
                </div>
                <InlineStack gap="300">
                  <Button variant="primary" onClick={() => setSelectedEvidenceTab(0)}>Review supporting evidence</Button>
                  <Button onClick={() => navigateEmbedded("/app/settings")}>Open settings</Button>
                </InlineStack>
              </BlockStack>
            </Card>
          </InlineGrid>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <BlockStack gap="100">
                <Text as="h2" variant="headingLg">Recommended policy actions</Text>
                <Text as="p" tone="subdued">Focus on the small set of policy actions VedaSuite considers most useful right now.</Text>
              </BlockStack>
              {topPolicyActions.length === 0 ? (
                <EmptyState text="Policy recommendations will appear after enough trust and abuse signals are synced." />
              ) : (
                <InlineGrid columns={{ xs: 1, md: 2, lg: 3 }} gap="300">
                  {topPolicyActions.map((action) => (
                    <div key={action.key} className="vs-action-card">
                      <BlockStack gap="150">
                        <InlineStack align="space-between" blockAlign="center">
                          <Text as="p" variant="headingSm">{action.title}</Text>
                          <Badge tone={toneForStatus(action.status)}>{action.status}</Badge>
                        </InlineStack>
                        <Text as="p" tone="subdued">{action.why}</Text>
                        <Text as="p" variant="bodySm">Applies to: {action.appliesTo}</Text>
                        <Text as="p" variant="bodySm" tone="subdued">Expected effect: {action.expectedEffect}</Text>
                      </BlockStack>
                    </div>
                  ))}
                </InlineGrid>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <BlockStack gap="100">
                <Text as="h2" variant="headingLg">Customer and order evidence</Text>
                <Text as="p" tone="subdued">Use this evidence to confirm why VedaSuite is recommending a review, escalation, or policy change.</Text>
              </BlockStack>
              <Tabs tabs={evidenceTabs} selected={selectedEvidenceTab} onSelect={setSelectedEvidenceTab}>
                <Box paddingBlockStart="400">
                  {selectedEvidenceKey === "return-abuse" ? (
                    <InlineGrid columns={{ xs: 1, md: 2 }} gap="300">
                      <Card>
                        <BlockStack gap="200">
                          <Text as="h3" variant="headingMd">Return abuse profiles</Text>
                          {overview.returnAbuseSignals.length === 0 ? <EmptyState text="Return abuse indicators will appear after enough refund behavior is collected." /> : overview.returnAbuseSignals.map((signal) => (
                            <div key={signal.id} className="vs-action-card">
                              <BlockStack gap="100">
                                <InlineStack align="space-between" blockAlign="center">
                                  <Text as="p" variant="headingSm">{signal.email ?? `profile-${signal.id.slice(-4)}`}</Text>
                                  <Badge tone={signal.abuseScore >= 70 ? "critical" : "attention"}>{signal.abuseScore >= 70 ? "High risk" : "Needs review"}</Badge>
                                </InlineStack>
                                {signal.reasons.map((reason) => <Text key={reason} as="p" variant="bodySm" tone="subdued">{reason}</Text>)}
                              </BlockStack>
                            </div>
                          ))}
                        </BlockStack>
                      </Card>
                      <Card>
                        <BlockStack gap="200">
                          <Text as="h3" variant="headingMd">Wardrobing patterns</Text>
                          {overview.wardrobingSignals.length === 0 ? <EmptyState text="Wardrobing indicators will appear after enough return behavior is collected." /> : overview.wardrobingSignals.map((signal) => (
                            <div key={signal.id} className="vs-action-card">
                              <BlockStack gap="100">
                                <InlineStack align="space-between" blockAlign="center">
                                  <Text as="p" variant="headingSm">{signal.email ?? `shopper-${signal.id.slice(-4)}`}</Text>
                                  <Badge tone={signal.likely ? "critical" : "warning"}>{signal.likely ? "High risk" : "Monitor"}</Badge>
                                </InlineStack>
                                <Text as="p" variant="bodySm" tone="subdued">{signal.totalRefunds} refunds across {signal.totalOrders} orders | {signal.refundRate}% refund rate</Text>
                                <Text as="p" variant="bodySm">{signal.recommendedAction}</Text>
                              </BlockStack>
                            </div>
                          ))}
                        </BlockStack>
                      </Card>
                    </InlineGrid>
                  ) : null}

                  {selectedEvidenceKey === "network-chargeback" ? (
                    <InlineGrid columns={{ xs: 1, md: 2 }} gap="300">
                      <Card>
                        <BlockStack gap="200">
                          <Text as="h3" variant="headingMd">Shared-network matches</Text>
                          {overview.networkMatches.length === 0 ? <EmptyState text="Shared-network matches will appear after more order-risk data is available." /> : overview.networkMatches.map((match) => (
                            <div key={match.id} className="vs-action-card">
                              <BlockStack gap="100">
                                <InlineStack align="space-between" blockAlign="center">
                                  <Text as="p" variant="headingSm">{match.orderId}</Text>
                                  <Badge tone={match.repeatSignals >= 3 ? "critical" : "attention"}>{match.repeatSignals >= 3 ? "High risk" : "Needs review"}</Badge>
                                </InlineStack>
                                <Text as="p" tone="subdued">{match.reasons.join(" ")}</Text>
                                <Text as="p" variant="bodySm">{match.recommendedAction}</Text>
                              </BlockStack>
                            </div>
                          ))}
                        </BlockStack>
                      </Card>
                      <Card>
                        <BlockStack gap="200">
                          <Text as="h3" variant="headingMd">Chargeback pressure</Text>
                          {overview.chargebackCandidates.length === 0 ? <EmptyState text="Chargeback pressure candidates will appear when order-risk and post-purchase signals overlap." /> : overview.chargebackCandidates.map((candidate) => (
                            <div key={candidate.id} className="vs-action-card">
                              <BlockStack gap="100">
                                <InlineStack align="space-between" blockAlign="center">
                                  <Text as="p" variant="headingSm">{candidate.shopifyOrderId}</Text>
                                  <Badge tone={candidate.chargebackRiskScore >= 70 ? "critical" : "attention"}>{candidate.chargebackRiskScore >= 70 ? "High risk" : "Needs review"}</Badge>
                                </InlineStack>
                                {candidate.reasons.map((reason) => <Text key={reason} as="p" variant="bodySm" tone="subdued">{reason}</Text>)}
                              </BlockStack>
                            </div>
                          ))}
                        </BlockStack>
                      </Card>
                    </InlineGrid>
                  ) : null}

                  {selectedEvidenceKey === "customer-timeline" ? (
                    <Card>
                      <BlockStack gap="200">
                        <Text as="h3" variant="headingMd">Customer behavior timeline</Text>
                        {overview.behaviorTimeline.length === 0 ? <EmptyState text="Customer behavior events will appear here after enough order and refund history is available." /> : overview.behaviorTimeline.map((item) => (
                          <div key={item.id} className="vs-action-card">
                            <InlineStack align="space-between" blockAlign="start" gap="300">
                              <BlockStack gap="100">
                                <Text as="p" variant="headingSm">{item.shopper}</Text>
                                <Text as="p" tone="subdued">{item.eventSummary}</Text>
                                <Text as="p" variant="bodySm">Trust score {item.trustScore} | Refund rate {item.refundRate}%</Text>
                              </BlockStack>
                              <Badge tone={toneForStatus(item.tier)}>{normalizeStatus(item.tier)}</Badge>
                            </InlineStack>
                          </div>
                        ))}
                      </BlockStack>
                    </Card>
                  ) : null}

                  {selectedEvidenceKey === "evidence-exports" ? (
                    <InlineGrid columns={{ xs: 1, md: 2 }} gap="300">
                      <Card>
                        <BlockStack gap="200">
                          <InlineStack align="space-between" blockAlign="center">
                            <Text as="h3" variant="headingMd">Evidence exports</Text>
                            <Badge tone={overview.evidencePack.status === "ready" ? "success" : "info"}>{overview.evidencePack.status === "ready" ? "Ready" : "Informational"}</Badge>
                          </InlineStack>
                          <List type="bullet">
                            {overview.evidencePack.exports.length === 0 ? <List.Item>Evidence export options will appear when review items exist.</List.Item> : overview.evidencePack.exports.map((item) => <List.Item key={item}>{item}</List.Item>)}
                          </List>
                        </BlockStack>
                      </Card>
                      <Card>
                        <BlockStack gap="200">
                          <Text as="h3" variant="headingMd">Evidence templates</Text>
                          {(overview.evidencePack.templates ?? []).length === 0 ? <EmptyState text="Evidence templates will appear when export-ready review items exist." /> : (overview.evidencePack.templates ?? []).map((item) => (
                            <div key={item.title} className="vs-action-card">
                              <BlockStack gap="100">
                                <Text as="p" variant="headingSm">{item.title}</Text>
                                <Text as="p" tone="subdued">{item.detail}</Text>
                              </BlockStack>
                            </div>
                          ))}
                        </BlockStack>
                      </Card>
                    </InlineGrid>
                  ) : null}
                </Box>
              </Tabs>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <InlineGrid columns={{ xs: 1, md: 2 }} gap="300">
            <Card>
              <BlockStack gap="300">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingLg">Policy and configuration summary</Text>
                  <Text as="p" tone="subdued">These settings explain how VedaSuite is classifying shoppers and where policy automation is currently active.</Text>
                </BlockStack>
                <Banner title="Current policy posture" tone="info">
                  <p>{overview.summary.automationReadiness}</p>
                </Banner>
                <BlockStack gap="200">
                  {(overview.automationRules ?? []).length === 0 ? <EmptyState text="Automation rules will populate once enough repeat trust patterns exist." /> : overview.automationRules.map((rule) => (
                    <div key={rule.id} className="vs-action-card">
                      <InlineStack align="space-between" blockAlign="start" gap="300">
                        <BlockStack gap="100">
                          <Text as="p" variant="headingSm">{rule.title}</Text>
                          <Text as="p" tone="subdued">{rule.detail}</Text>
                        </BlockStack>
                        <Badge tone={toneForStatus(rule.status)}>{normalizeStatus(rule.status)}</Badge>
                      </InlineStack>
                    </div>
                  ))}
                </BlockStack>
              </BlockStack>
            </Card>
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingLg">Trust tiers and scoring</Text>
                <InlineGrid columns={{ xs: 1, sm: 2, md: 2 }} gap="200">
                  {scoreBandCards.map((card) => (
                    <div key={card.label} className="vs-signal-stat">
                      <BlockStack gap="100">
                        <Text as="p" variant="bodySm" tone="subdued">{card.label}</Text>
                        <Text as="p" variant="headingMd">{card.value}</Text>
                      </BlockStack>
                    </div>
                  ))}
                </InlineGrid>
                <BlockStack gap="200">
                  {overview.trustTierSummary.length === 0 ? <EmptyState text="Trust tiers will populate after enough shopper history has been synced." /> : overview.trustTierSummary.map((tier) => (
                    <div key={tier.tier} className="vs-action-card">
                      <InlineStack align="space-between" blockAlign="start" gap="300">
                        <BlockStack gap="100">
                          <Text as="p" variant="headingSm">{tier.tier}</Text>
                          <Text as="p" tone="subdued">{tier.policy}</Text>
                        </BlockStack>
                        <Badge tone="info">{tier.count}</Badge>
                      </InlineStack>
                    </div>
                  ))}
                </BlockStack>
              </BlockStack>
            </Card>
          </InlineGrid>
        </Layout.Section>

        <Layout.Section>
          <InlineGrid columns={{ xs: 1, md: 2 }} gap="300">
            <Card>
              <BlockStack gap="300">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingLg">Advanced tools</Text>
                  <Text as="p" tone="subdued">These tools help support teams and policy owners go deeper once the primary review work is already clear.</Text>
                </BlockStack>
                <Text as="h3" variant="headingMd">Refund outcome simulator</Text>
                <Text as="p" tone="subdued">{overview.refundOutcomeSimulator?.merchantOutcome ?? "Simulation guidance will appear once live trust signals are ready."}</Text>
                <InlineGrid columns={{ xs: 1, sm: 2 }} gap="200">
                  <div className="vs-signal-stat"><Text as="p" variant="bodySm" tone="subdued">Likely best channel</Text><Text as="p" variant="headingMd">{overview.refundOutcomeSimulator?.likelyChannel ?? "Pending"}</Text></div>
                  <div className="vs-signal-stat"><Text as="p" variant="bodySm" tone="subdued">Guidance</Text><Text as="p" variant="headingMd">{overview.refundOutcomeSimulator?.recoveryRate ?? "Syncing"}</Text></div>
                </InlineGrid>
                <BlockStack gap="200">
                  {(overview.refundOutcomeSimulator?.options ?? []).length === 0 ? <EmptyState text="Simulation comparisons will appear once live trust signals are ready." /> : (overview.refundOutcomeSimulator?.options ?? []).map((option) => (
                    <div key={option.channel} className="vs-action-card">
                      <BlockStack gap="100">
                        <InlineStack align="space-between" blockAlign="center">
                          <Text as="p" variant="headingSm">{option.channel}</Text>
                          <Badge tone="info">{option.confidence}</Badge>
                        </InlineStack>
                        <Text as="p" tone="subdued">{option.marginImpact}</Text>
                        <Text as="p" variant="bodySm">{option.recommendedWhen}</Text>
                      </BlockStack>
                    </div>
                  ))}
                </BlockStack>
              </BlockStack>
            </Card>
            <Card>
              <BlockStack gap="300">
                <Text as="h3" variant="headingMd">Support guidance</Text>
                <Banner title={overview.supportCopilot.status === "active" ? "Support guidance is available" : "Support guidance preview"} tone={overview.supportCopilot.status === "active" ? "success" : "info"}>
                  <p>{overview.supportCopilot.status === "active" ? "Use trust scores, review reasons, and handling guidance inside support workflows." : "Support guidance previews are visible on this plan."}</p>
                </Banner>
                <Text as="p" variant="headingSm">Playbooks</Text>
                <List type="bullet">
                  {overview.supportCopilot.playbooks.length === 0 ? <List.Item>Playbooks will appear once trust workflows are synced.</List.Item> : overview.supportCopilot.playbooks.map((playbook) => <List.Item key={playbook}>{playbook}</List.Item>)}
                </List>
                <Text as="p" variant="headingSm">Suggested cases</Text>
                <BlockStack gap="200">
                  {(overview.supportCopilot.cases ?? []).length === 0 ? <EmptyState text="Suggested support cases will appear once order risk and customer history overlap." /> : (overview.supportCopilot.cases ?? []).map((item) => (
                    <div key={item.title} className="vs-action-card">
                      <BlockStack gap="100">
                        <Text as="p" variant="headingSm">{item.title}</Text>
                        <Text as="p" tone="subdued">{item.reason}</Text>
                        <Text as="p" variant="bodySm">{item.recommendedHandling}</Text>
                      </BlockStack>
                    </div>
                  ))}
                </BlockStack>
              </BlockStack>
            </Card>
          </InlineGrid>
        </Layout.Section>
      </Layout>

      <Modal
        open={!!activeOrder}
        onClose={() => setActiveOrder(null)}
        title={activeOrder ? `Order ${activeOrder.shopifyOrderId}` : "Order review"}
        primaryAction={activeOrder ? { content: "Allow order", onAction: () => void runAction("allow") } : undefined}
        secondaryActions={activeOrder ? [{ content: "Flag", onAction: () => void runAction("flag") }, { content: "Block", onAction: () => void runAction("block") }, { content: "Manual review", onAction: () => void runAction("manual_review") }] : []}
      >
        <Modal.Section>
          {activeOrder ? (
            <BlockStack gap="300">
              <Text as="p">Risk score: <strong>{activeOrder.riskScore}</strong> / 100</Text>
              <Text as="p">Recommended action: <strong>{queueActionLabel(recommendationForOrder(activeOrder.riskScore))}</strong></Text>
              <Text as="p">Decision guidance: review refund history, shipping consistency, and payment fingerprint before fulfillment.</Text>
              <InlineStack gap="200">
                <Badge tone="critical">High risk</Badge>
                <Badge tone="attention">Needs review</Badge>
                <Badge tone="info">Supporting evidence available</Badge>
              </InlineStack>
              {getOrderUrl(activeOrder.shopifyOrderId) ? <Button url={getOrderUrl(activeOrder.shopifyOrderId) ?? undefined} external>Open Shopify order</Button> : null}
            </BlockStack>
          ) : null}
        </Modal.Section>
      </Modal>

      {toast ? <Toast content={toast} onDismiss={() => setToast(null)} /> : null}
    </Page>
  );
}

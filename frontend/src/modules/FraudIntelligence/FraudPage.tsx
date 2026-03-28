import {
  Banner,
  Badge,
  BlockStack,
  Box,
  Button,
  Card,
  InlineGrid,
  IndexTable,
  InlineStack,
  Layout,
  Modal,
  Page,
  Tabs,
  Text,
  Toast,
} from "@shopify/polaris";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useApiClient } from "../../api/client";
import { useEmbeddedNavigation } from "../../hooks/useEmbeddedNavigation";
import { useShopifyAdminLinks } from "../../hooks/useShopifyAdminLinks";
import { readModuleCache, writeModuleCache } from "../../lib/moduleCache";

type OrderRow = {
  id: string;
  shopifyOrderId: string;
  totalAmount: number;
  currency: string;
  fraudScore: number;
  fraudRiskLevel: string;
  status: string;
};

type FraudOverview = {
  summary: {
    sharedFraudNetworkEnabled: boolean;
    networkMatches: number;
    wardrobingSuspects: number;
    highRiskOrders: number;
    manualReviewCount: number;
    returnAbuseProfiles: number;
    automationReadiness: string;
    chargebackCandidates: number;
  };
  automationRules: Array<{
    id: string;
    title: string;
    status: string;
    detail: string;
  }>;
  networkMatches: Array<{
    id: string;
    orderId?: string | null;
    customerId?: string | null;
    riskLevel: string;
    repeatSignals: number;
    email?: string | null;
    confidence: number;
    recommendedAction: string;
    reasons: string[];
    automationPosture: string;
  }>;
  wardrobingSignals: Array<{
    id: string;
    email?: string | null;
    wardrobingScore: number;
    refundRate: number;
    totalRefunds: number;
    totalOrders: number;
    likely: boolean;
    confidence: number;
    recommendedAction: string;
    reasons: string[];
    automationPosture: string;
  }>;
  chargebackCandidates: Array<{
    id: string;
    shopifyOrderId: string;
    chargebackRiskScore: number;
    reasons: string[];
  }>;
  returnAbuseSignals: Array<{
    id: string;
    email?: string | null;
    abuseScore: number;
    reasons: string[];
  }>;
  scoreBands: {
    low: string;
    medium: string;
    high: string;
  };
};

const resourceName = {
  singular: "order",
  plural: "orders",
};

export function FraudPage() {
  const api = useApiClient();
  const { navigateEmbedded } = useEmbeddedNavigation();
  const { getOrderUrl } = useShopifyAdminLinks();
  const [searchParams] = useSearchParams();
  const cachedOrders = readModuleCache<OrderRow[]>("fraud-orders");
  const cachedOverview = readModuleCache<FraudOverview>("fraud-overview");
  const [orders, setOrders] = useState<OrderRow[]>(cachedOrders ?? []);
  const [overview, setOverview] = useState<FraudOverview | null>(cachedOverview ?? null);
  const [selectedTab, setSelectedTab] = useState(0);
  const [activeOrder, setActiveOrder] = useState<OrderRow | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const focus = searchParams.get("focus");

  const loadOrders = () => {
    Promise.all([
      api.get<{ orders: OrderRow[] }>("/api/fraud/orders"),
      api.get<{ overview: FraudOverview }>("/api/fraud/overview"),
    ])
      .then(([ordersResponse, overviewResponse]) => {
        setOrders(ordersResponse.data.orders);
        setOverview(overviewResponse.data.overview);
        writeModuleCache("fraud-orders", ordersResponse.data.orders);
        writeModuleCache("fraud-overview", overviewResponse.data.overview);
      })
      .catch(() => {
        setOrders([]);
        setOverview(null);
      });
  };

  useEffect(() => {
    loadOrders();
  }, [api]);

  useEffect(() => {
    if (focus === "signals") {
      setSelectedTab(1);
    } else {
      setSelectedTab(0);
    }
  }, [focus]);

  const tabs = [
    { id: "queue", content: "Review queue" },
    { id: "signals", content: "Signals" },
  ];

  const signalSummary = useMemo(
    () => [
      { label: "Shared network participation", value: "Enabled-ready" },
      { label: "Risk threshold", value: "71+ = High risk" },
      { label: "Detected patterns", value: "Chargeback, refund abuse, wardrobing" },
    ],
    []
  );

  const visibleOrders = useMemo(() => {
    if (focus === "high-risk") {
      return orders.filter((order) => order.fraudScore >= 71);
    }

    if (focus === "return-abuse") {
      return orders.filter((order) => order.fraudRiskLevel !== "Low");
    }

    return orders;
  }, [focus, orders]);

  const focusMessage =
    focus === "high-risk"
      ? "Showing only the highest-risk orders so you can act on the most urgent fraud exposure first."
      : focus === "return-abuse"
      ? "Showing orders with medium and high-risk behavior to help isolate refund and wardrobing patterns."
      : null;

  const workflowCards = useMemo(
    () => [
      {
        title: "Shared Fraud Network",
        body: "Surface repeated anonymized fraud signals and identify fingerprint overlap before more orders slip through.",
        cta: "Open signals",
        action: () => setSelectedTab(1),
      },
      {
        title: "Refund & Wardrobing Watch",
        body: "Review return-abuse profiles, likely wardrobing behavior, and chargeback candidates from one module.",
        cta: "Review signals",
        action: () => setSelectedTab(1),
      },
      {
        title: "Store control actions",
        body: "Move into dashboard and reconnect Shopify sync if you want fresh orders and webhook coverage reflected here.",
        cta: "Open dashboard",
        action: () => navigateEmbedded("/"),
      },
    ],
    [navigateEmbedded]
  );

  const runAction = async (action: "allow" | "flag" | "block" | "manual_review") => {
    if (!activeOrder) return;

    try {
      const response = await api.post("/api/fraud/action", {
        orderId: activeOrder.id,
        action,
      });
      const tagResult = response.data?.order?.shopifyTagResult as
        | { updated?: boolean; reason?: string }
        | undefined;
      setToast(
        tagResult?.updated
          ? `Order ${activeOrder.shopifyOrderId} updated and tagged in Shopify: ${action}.`
          : `Order ${activeOrder.shopifyOrderId} updated locally: ${action}${
              tagResult?.reason ? ` (${tagResult.reason})` : "."
            }`
      );
      setActiveOrder(null);
      loadOrders();
    } catch {
      setToast("Unable to update the order right now.");
    }
  };

  return (
    <Page
      title="Fraud & Return Abuse Intelligence"
      subtitle="Review payment risk, return abuse, chargeback exposure, and shopper trust signals."
    >
      <Layout>
        <Layout.Section>
          <Banner title="Fraud queue is active" tone="warning">
            <p>
              Orders are scored from 0-100 using IP, email, shipping address,
              device fingerprint, payment fingerprint, refund history, and order
              frequency.
            </p>
          </Banner>
        </Layout.Section>
        <Layout.Section>
          {focusMessage ? (
            <Banner title="Focused review mode" tone="info">
              <p>{focusMessage}</p>
            </Banner>
          ) : null}
        </Layout.Section>
        <Layout.Section>
          {overview ? (
            <InlineGrid columns={{ xs: 1, md: 3 }} gap="400">
              <Card>
                <BlockStack gap="200">
                  <Text as="h3" variant="headingMd">
                    Shared Fraud Network
                  </Text>
                  <Text as="p" variant="heading2xl">
                    {overview.summary.networkMatches}
                  </Text>
                  <Badge tone={overview.summary.sharedFraudNetworkEnabled ? "success" : "attention"}>
                    {overview.summary.sharedFraudNetworkEnabled ? "Enabled" : "Not enabled"}
                  </Badge>
                </BlockStack>
              </Card>
              <Card>
                <BlockStack gap="200">
                  <Text as="h3" variant="headingMd">
                    Wardrobing suspects
                  </Text>
                  <Text as="p" variant="heading2xl">
                    {overview.summary.wardrobingSuspects}
                  </Text>
                  <Text as="p" tone="subdued">
                    Likely buy-use-return behavior requiring policy review.
                  </Text>
                </BlockStack>
              </Card>
              <Card>
                <BlockStack gap="200">
                  <Text as="h3" variant="headingMd">
                    Automation posture
                  </Text>
                  <Text as="p" variant="heading2xl">
                    {overview.summary.manualReviewCount}
                  </Text>
                  <Text as="p" tone="subdued">
                    {overview.summary.automationReadiness}
                  </Text>
                </BlockStack>
              </Card>
              <Card>
                <BlockStack gap="200">
                  <Text as="h3" variant="headingMd">
                    Chargeback candidates
                  </Text>
                  <Text as="p" variant="heading2xl">
                    {overview.summary.chargebackCandidates}
                  </Text>
                  <Text as="p" tone="subdued">
                    Orders showing elevated post-purchase dispute pressure.
                  </Text>
                </BlockStack>
              </Card>
              <Card>
                <BlockStack gap="200">
                  <Text as="h3" variant="headingMd">
                    Queue coverage
                  </Text>
                  <Text as="p" variant="heading2xl">
                    {overview.summary.highRiskOrders}
                  </Text>
                  <Text as="p" tone="subdued">
                    High-risk orders currently scored for review across the store.
                  </Text>
                </BlockStack>
              </Card>
            </InlineGrid>
          ) : null}
        </Layout.Section>
        <Layout.Section>
          <InlineGrid columns={{ xs: 1, md: 3 }} gap="400">
            {workflowCards.map((card) => (
              <Card key={card.title}>
                <BlockStack gap="300">
                  <Text as="h3" variant="headingMd">
                    {card.title}
                  </Text>
                  <Text as="p" tone="subdued">
                    {card.body}
                  </Text>
                  <Button onClick={card.action}>{card.cta}</Button>
                </BlockStack>
              </Card>
            ))}
          </InlineGrid>
        </Layout.Section>
        <Layout.Section>
          <Card>
            <Tabs tabs={tabs} selected={selectedTab} onSelect={setSelectedTab}>
              <Box paddingBlockStart="400">
                {selectedTab === 0 ? (
                  visibleOrders.length === 0 ? (
                    <Card>
                      <BlockStack gap="300">
                        <Text as="h3" variant="headingMd">
                          No matching fraud queue results
                        </Text>
                        <Text as="p" tone="subdued">
                          There are no orders in the current focused view. Try
                          another filter or return to the full review queue.
                        </Text>
                        <InlineStack gap="300">
                          {focus ? (
                            <Button onClick={() => navigateEmbedded("/fraud")}>
                              Show full review queue
                            </Button>
                          ) : null}
                          <Button variant="secondary" onClick={() => setSelectedTab(1)}>
                            Open signals
                          </Button>
                          <Button variant="secondary" onClick={() => navigateEmbedded("/")}>
                            Open dashboard
                          </Button>
                        </InlineStack>
                        <InlineGrid columns={{ xs: 1, md: 2 }} gap="300">
                          <Card>
                            <BlockStack gap="200">
                              <Text as="h4" variant="headingSm">
                                What this module covers
                              </Text>
                              <Text as="p" tone="subdued">
                                Payment fraud detection, stolen-card watch patterns, chargeback pressure, serial refunders, return abuse, and wardrobing detection AI.
                              </Text>
                            </BlockStack>
                          </Card>
                          <Card>
                            <BlockStack gap="200">
                              <Text as="h4" variant="headingSm">
                                Score bands
                              </Text>
                              <Text as="p" tone="subdued">
                                {overview
                                  ? `Low ${overview.scoreBands.low} | Medium ${overview.scoreBands.medium} | High ${overview.scoreBands.high}`
                                  : "Low 0-30 | Medium 31-70 | High 71-100"}
                              </Text>
                            </BlockStack>
                          </Card>
                        </InlineGrid>
                      </BlockStack>
                    </Card>
                  ) : (
                    <IndexTable
                      resourceName={resourceName}
                      itemCount={visibleOrders.length}
                      selectable={false}
                      headings={[
                        { title: "Order" },
                        { title: "Amount" },
                        { title: "Fraud score" },
                        { title: "Risk level" },
                        { title: "Status" },
                        { title: "Action" },
                      ]}
                    >
                      {visibleOrders.map((order, index) => (
                        <IndexTable.Row id={order.id} key={order.id} position={index}>
                          <IndexTable.Cell>
                            <Text as="span" variant="bodyMd" fontWeight="semibold">
                              {order.shopifyOrderId}
                            </Text>
                          </IndexTable.Cell>
                          <IndexTable.Cell>
                            {order.totalAmount.toFixed(2)} {order.currency}
                          </IndexTable.Cell>
                          <IndexTable.Cell>{order.fraudScore}</IndexTable.Cell>
                          <IndexTable.Cell>
                            <Badge
                              tone={
                                order.fraudRiskLevel === "High"
                                  ? "critical"
                                  : order.fraudRiskLevel === "Low"
                                  ? "success"
                                  : undefined
                              }
                            >
                              {order.fraudRiskLevel}
                            </Badge>
                          </IndexTable.Cell>
                          <IndexTable.Cell>{order.status}</IndexTable.Cell>
                          <IndexTable.Cell>
                            <Button onClick={() => setActiveOrder(order)}>Review</Button>
                          </IndexTable.Cell>
                        </IndexTable.Row>
                      ))}
                    </IndexTable>
                  )
                ) : (
                  <BlockStack gap="300">
                    {overview ? (
                      <>
                        <Card>
                          <BlockStack gap="200">
                            <InlineStack align="space-between" blockAlign="center">
                              <Text as="h3" variant="headingMd">
                                Shared fraud matches
                              </Text>
                              <Badge tone="info">
                                {`${overview.summary.networkMatches} matches`}
                              </Badge>
                            </InlineStack>
                            {overview.networkMatches.length === 0 ? (
                              <Text as="p" tone="subdued">
                                No repeated anonymized fraud fingerprints are clustered yet.
                              </Text>
                            ) : (
                              overview.networkMatches.map((match) => (
                                <InlineStack
                                  key={match.id}
                                  align="space-between"
                                  blockAlign="center"
                                >
                                <BlockStack gap="100">
                                  <Text as="p">
                                    {match.email ?? "Anonymous shopper signal"}
                                  </Text>
                                  <Text as="p" variant="bodySm" tone="subdued">
                                      {`Repeated across ${match.repeatSignals} stored signals with ${match.confidence}% confidence`}
                                  </Text>
                                  <Text as="p" variant="bodySm">
                                    {match.recommendedAction}
                                  </Text>
                                  <Text as="p" variant="bodySm" tone="subdued">
                                    {match.automationPosture}
                                  </Text>
                                </BlockStack>
                                <Badge tone={match.riskLevel === "High" ? "critical" : "attention"}>
                                  {match.riskLevel}
                                </Badge>
                              </InlineStack>
                              ))
                            )}
                          </BlockStack>
                        </Card>
                        <Card>
                          <BlockStack gap="200">
                            <InlineStack align="space-between" blockAlign="center">
                              <Text as="h3" variant="headingMd">
                                Wardrobing Detection AI
                              </Text>
                              <Badge tone="warning">
                                {`${overview.summary.wardrobingSuspects} likely`}
                              </Badge>
                            </InlineStack>
                            {overview.wardrobingSignals.length === 0 ? (
                              <Text as="p" tone="subdued">
                                No apparel-like return abuse patterns are elevated right now.
                              </Text>
                            ) : (
                              overview.wardrobingSignals.map((signal) => (
                                <InlineStack
                                  key={signal.id}
                                  align="space-between"
                                  blockAlign="center"
                                >
                                <BlockStack gap="100">
                                    <Text as="p">{signal.email ?? "Unknown shopper"}</Text>
                                    <Text as="p" variant="bodySm" tone="subdued">
                                      {`${signal.refundRate}% refund rate across ${signal.totalOrders} orders with ${signal.confidence}% confidence`}
                                    </Text>
                                    <Text as="p" variant="bodySm">
                                      {signal.recommendedAction}
                                    </Text>
                                    <Text as="p" variant="bodySm" tone="subdued">
                                      {signal.automationPosture}
                                    </Text>
                                  </BlockStack>
                                  <Badge tone={signal.likely ? "critical" : "attention"}>
                                    {`Wardrobing ${signal.wardrobingScore}`}
                                  </Badge>
                                </InlineStack>
                              ))
                            )}
                          </BlockStack>
                        </Card>
                        <Card>
                          <BlockStack gap="200">
                            <InlineStack align="space-between" blockAlign="center">
                              <Text as="h3" variant="headingMd">
                                Automation rules
                              </Text>
                              <Badge tone="success">Hardening</Badge>
                            </InlineStack>
                            {overview.automationRules.map((rule) => (
                              <BlockStack key={rule.id} gap="100">
                                <InlineStack align="space-between" blockAlign="center">
                                  <Text as="p">{rule.title}</Text>
                                  <Badge tone={rule.status === "Ready" ? "success" : "attention"}>
                                    {rule.status}
                                  </Badge>
                                </InlineStack>
                                <Text as="p" variant="bodySm" tone="subdued">
                                  {rule.detail}
                                </Text>
                              </BlockStack>
                            ))}
                          </BlockStack>
                        </Card>
                        <Card>
                          <BlockStack gap="200">
                            <Text as="h3" variant="headingMd">
                              Return abuse and chargeback watch
                            </Text>
                            {overview.returnAbuseSignals.slice(0, 2).map((signal) => (
                              <BlockStack key={signal.id} gap="100">
                                <Text as="p">{signal.email ?? "Unknown shopper"}</Text>
                                <Text as="p" variant="bodySm" tone="subdued">
                                  {`Return abuse score ${signal.abuseScore}`}
                                </Text>
                              </BlockStack>
                            ))}
                            {overview.chargebackCandidates.slice(0, 2).map((candidate) => (
                              <BlockStack key={candidate.id} gap="100">
                                <Text as="p">{candidate.shopifyOrderId}</Text>
                                <Text as="p" variant="bodySm" tone="subdued">
                                  {`Chargeback risk ${candidate.chargebackRiskScore}`}
                                </Text>
                              </BlockStack>
                            ))}
                          </BlockStack>
                        </Card>
                      </>
                    ) : null}
                    {signalSummary.map((item) => (
                      <Card key={item.label}>
                        <InlineStack align="space-between">
                          <Text as="span" variant="bodyMd">
                            {item.label}
                          </Text>
                          <Badge tone="info">{item.value}</Badge>
                        </InlineStack>
                      </Card>
                    ))}
                  </BlockStack>
                )}
              </Box>
            </Tabs>
          </Card>
        </Layout.Section>
      </Layout>

      <Modal
        open={!!activeOrder}
        onClose={() => setActiveOrder(null)}
        title={activeOrder ? `Order ${activeOrder.shopifyOrderId}` : "Order review"}
        primaryAction={
          activeOrder
            ? { content: "Allow order", onAction: () => runAction("allow") }
            : undefined
        }
        secondaryActions={
          activeOrder
            ? [
                { content: "Flag", onAction: () => runAction("flag") },
                { content: "Block", onAction: () => runAction("block") },
                {
                  content: "Manual review",
                  onAction: () => runAction("manual_review"),
                },
              ]
            : []
        }
      >
        <Modal.Section>
          {activeOrder ? (
            <BlockStack gap="300">
              <Text as="p">
                Risk score: <strong>{activeOrder.fraudScore}</strong> / 100
              </Text>
              <Text as="p">
                Recommended action:{" "}
                <strong>
                  {activeOrder.fraudScore >= 85
                    ? "Block order"
                    : activeOrder.fraudScore >= 71
                    ? "Send to manual review"
                    : activeOrder.fraudScore >= 45
                    ? "Flag order"
                    : "Allow order"}
                </strong>
              </Text>
              <Text as="p">
                Decision guidance: review refund history, shipping consistency,
                and payment fingerprint before fulfillment.
              </Text>
              <InlineStack gap="200">
                <Badge tone="critical">Chargeback risk</Badge>
                <Badge tone="info">Refund history</Badge>
                <Badge tone="warning">Wardrobing watch</Badge>
              </InlineStack>
              {getOrderUrl(activeOrder.shopifyOrderId) ? (
                <Button
                  url={getOrderUrl(activeOrder.shopifyOrderId) ?? undefined}
                  external
                >
                  Open Shopify order
                </Button>
              ) : null}
            </BlockStack>
          ) : null}
        </Modal.Section>
      </Modal>

      {toast ? <Toast content={toast} onDismiss={() => setToast(null)} /> : null}
    </Page>
  );
}

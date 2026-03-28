import {
  Badge,
  Banner,
  BlockStack,
  Button,
  Box,
  Card,
  IndexTable,
  InlineGrid,
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
import { ModuleGate } from "../../components/ModuleGate";
import { EmptyPageState } from "../../components/PageState";
import { useEmbeddedNavigation } from "../../hooks/useEmbeddedNavigation";
import { useShopifyAdminLinks } from "../../hooks/useShopifyAdminLinks";
import { useSubscriptionPlan } from "../../hooks/useSubscriptionPlan";
import { readModuleCache, writeModuleCache } from "../../lib/moduleCache";
import { withRequestTimeout } from "../../lib/requestTimeout";

type CustomerRow = {
  id: string;
  email?: string | null;
  shopifyCustomerId?: string | null;
  totalOrders: number;
  totalRefunds: number;
  refundRate: number;
  fraudSignalsCount: number;
  paymentReliability: number;
  orderCompletionRate: number;
  creditScore: number;
  creditCategory: string;
  confidence: number;
  automationPosture: string;
  reasons: string[];
};

type TrustOperatingLayer = {
  segments: {
    trusted: number;
    normal: number;
    risky: number;
  };
  policyRecommendations: Array<{
    id: string;
    title: string;
    audience: string;
    recommendation: string;
    operationalAction: string;
    automationMode: string;
    confidence: number;
  }>;
  automationRules: Array<{
    id: string;
    title: string;
    status: string;
    detail: string;
  }>;
  priorityProfiles: Array<{
    id: string;
    email?: string | null;
    shopifyCustomerId?: string | null;
    creditScore: number;
    creditCategory: string;
    refundRate: number;
    fraudSignalsCount: number;
    paymentReliability: number;
    operationalTag: string;
    reasons: string[];
    confidence: number;
    automationPosture: string;
  }>;
};

const resourceName = {
  singular: "customer",
  plural: "customers",
};

export function CreditScorePage() {
  const api = useApiClient();
  const { navigateEmbedded } = useEmbeddedNavigation();
  const { getCustomerUrl } = useShopifyAdminLinks();
  const [searchParams] = useSearchParams();
  const { subscription, loading: subscriptionLoading } = useSubscriptionPlan();
  const cachedCustomers = readModuleCache<CustomerRow[]>("credit-customers");
  const cachedOperatingLayer = readModuleCache<TrustOperatingLayer>("credit-operating-layer");
  const [customers, setCustomers] = useState<CustomerRow[]>(cachedCustomers ?? []);
  const [operatingLayer, setOperatingLayer] = useState<TrustOperatingLayer | null>(
    cachedOperatingLayer ?? null
  );
  const [loading, setLoading] = useState(false);
  const [selectedTab, setSelectedTab] = useState(0);
  const [activeCustomer, setActiveCustomer] = useState<CustomerRow | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const focus = searchParams.get("focus");

  const filteredCustomers = useMemo(() => {
    if (selectedTab === 1) {
      return customers.filter((customer) => customer.creditScore >= 80);
    }
    if (selectedTab === 2) {
      return customers.filter((customer) => customer.creditScore < 50);
    }
    return customers;
  }, [customers, selectedTab]);

  const summary = useMemo(
    () => ({
      trusted: customers.filter((customer) => customer.creditScore >= 80).length,
      normal: customers.filter(
        (customer) => customer.creditScore >= 50 && customer.creditScore < 80
      ).length,
      risky: customers.filter((customer) => customer.creditScore < 50).length,
    }),
    [customers]
  );

  const focusMessage =
    focus === "risky"
      ? "Showing the highest-risk shoppers first so you can align fraud and refund decisions."
      : focus === "trusted"
      ? "Showing your most trusted buyers first so retention and VIP handling can move quickly."
      : null;

  const loadCustomers = () => {
    Promise.all([
      withRequestTimeout(api.get<{ customers: CustomerRow[] }>("/api/credit-score/customers")),
      withRequestTimeout(api.get<{ operatingLayer: TrustOperatingLayer }>(
        "/api/credit-score/operating-layer"
      )),
    ])
      .then(([customersResponse, operatingLayerResponse]) => {
        setCustomers(customersResponse.data.customers);
        setOperatingLayer(operatingLayerResponse.data.operatingLayer);
        writeModuleCache("credit-customers", customersResponse.data.customers);
        writeModuleCache(
          "credit-operating-layer",
          operatingLayerResponse.data.operatingLayer
        );
      })
      .catch(() => {
        setCustomers([]);
        setOperatingLayer(null);
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    loadCustomers();
  }, [api]);

  useEffect(() => {
    if (focus === "trusted") {
      setSelectedTab(1);
      return;
    }

    if (focus === "risky") {
      setSelectedTab(2);
      return;
    }

    setSelectedTab(0);
  }, [focus]);

  const recomputeScore = async () => {
    if (!activeCustomer) return;

    try {
      const response = await api.post<{ customer: CustomerRow }>(
        `/api/credit-score/customer/${activeCustomer.id}/recompute`,
        {}
      );
      const updatedCustomer = response.data.customer;
      setCustomers((prev) =>
        prev.map((customer) =>
          customer.id === updatedCustomer.id ? updatedCustomer : customer
        )
      );
      setActiveCustomer(updatedCustomer);
      setToast(`Recomputed credit score for ${updatedCustomer.email ?? "customer"}.`);
    } catch {
      setToast("Unable to recompute the shopper credit score.");
    }
  };

  return (
    <ModuleGate
      title="Shopper Credit Score"
      subtitle="See trust, refund behavior, and customer reliability at a glance."
      requiredPlan="Growth or Pro"
      allowed={!!subscription?.enabledModules.creditScore}
    >
      {filteredCustomers.length === 0 ? (
        <EmptyPageState
          title="Shopper Credit Score"
          subtitle="No customer credit data yet."
          message="Customer scoring will appear here once shopper history is available."
        />
      ) : (
        <Page
          title="Shopper Credit Score"
          subtitle="See trust, refund behavior, and customer reliability at a glance."
        >
      <Layout>
        {subscriptionLoading || loading ? (
          <Layout.Section>
            <Banner title="Refreshing customer trust data" tone="info">
              <p>Customer scores are loading in the background.</p>
            </Banner>
          </Layout.Section>
        ) : null}
        <Layout.Section>
          <Banner title="Customer trust scoring is active" tone="info">
            <p>
              Scores combine refund frequency, order completion, fraud signals,
              and payment reliability into a merchant-friendly trust score.
            </p>
          </Banner>
        </Layout.Section>
        {focusMessage ? (
          <Layout.Section>
            <Banner title="Focused customer segment" tone="info">
              <p>{focusMessage}</p>
            </Banner>
          </Layout.Section>
        ) : null}
        <Layout.Section>
          {operatingLayer ? (
            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <div>
                    <Text as="h3" variant="headingMd">
                      Trust operating layer
                    </Text>
                    <Text as="p" tone="subdued">
                      Use shopper trust as an operating rule across refunds, fraud review, and fulfillment.
                    </Text>
                  </div>
                  <Badge tone="success">Operational</Badge>
                </InlineStack>
                <InlineGrid columns={{ xs: 1, md: 3 }} gap="300">
                  {operatingLayer.policyRecommendations.map((policy) => (
                    <Card key={policy.id}>
                      <BlockStack gap="200">
                        <Text as="h4" variant="headingSm">
                          {policy.title}
                        </Text>
                        <Badge tone="info">{policy.audience}</Badge>
                        <Text as="p" tone="subdued">
                          {policy.recommendation}
                        </Text>
                        <Text as="p" variant="bodySm">
                          {policy.operationalAction}
                        </Text>
                        <InlineStack align="space-between" blockAlign="center">
                          <Text as="p" variant="bodySm" tone="subdued">
                            {policy.automationMode}
                          </Text>
                          <Badge tone="success">{`${policy.confidence}% confidence`}</Badge>
                        </InlineStack>
                      </BlockStack>
                    </Card>
                  ))}
                </InlineGrid>
                <InlineGrid columns={{ xs: 1, md: 2 }} gap="300">
                  {operatingLayer.automationRules.map((rule) => (
                    <Card key={rule.id}>
                      <BlockStack gap="200">
                        <InlineStack align="space-between" blockAlign="center">
                          <Text as="h4" variant="headingSm">
                            {rule.title}
                          </Text>
                          <Badge tone={rule.status === "Ready" ? "success" : "attention"}>
                            {rule.status}
                          </Badge>
                        </InlineStack>
                        <Text as="p" tone="subdued">
                          {rule.detail}
                        </Text>
                      </BlockStack>
                    </Card>
                  ))}
                </InlineGrid>
              </BlockStack>
            </Card>
          ) : null}
        </Layout.Section>
        <Layout.Section>
          <InlineGrid columns={{ xs: 1, md: 3 }} gap="400">
            <Card>
              <BlockStack gap="200">
                <Text as="h3" variant="headingMd">
                  Trusted buyers
                </Text>
                <Text as="p" variant="heading2xl">
                  {summary.trusted}
                </Text>
              </BlockStack>
            </Card>
            <Card>
              <BlockStack gap="200">
                <Text as="h3" variant="headingMd">
                  Normal buyers
                </Text>
                <Text as="p" variant="heading2xl">
                  {summary.normal}
                </Text>
              </BlockStack>
            </Card>
            <Card>
              <BlockStack gap="200">
                <Text as="h3" variant="headingMd">
                  Risky buyers
                </Text>
                <Text as="p" variant="heading2xl">
                  {summary.risky}
                </Text>
              </BlockStack>
            </Card>
          </InlineGrid>
        </Layout.Section>
        <Layout.Section>
          <Card>
            <Tabs
              tabs={[
                { id: "all", content: "All" },
                { id: "trusted", content: "Trusted" },
                { id: "risky", content: "Risky" },
              ]}
              selected={selectedTab}
              onSelect={setSelectedTab}
            >
              <Box paddingBlockStart="400">
                <IndexTable
                  resourceName={resourceName}
                  itemCount={filteredCustomers.length}
                  selectable={false}
                  headings={[
                    { title: "Email" },
                    { title: "Orders" },
                    { title: "Refunds" },
                    { title: "Refund rate" },
                    { title: "Credit score" },
                    { title: "Category" },
                  ]}
                >
                  {filteredCustomers.map((customer, index) => (
                    <IndexTable.Row
                      id={customer.id}
                      key={customer.id}
                      position={index}
                      onClick={() => setActiveCustomer(customer)}
                    >
                      <IndexTable.Cell>{customer.email ?? "Unknown"}</IndexTable.Cell>
                      <IndexTable.Cell>{customer.totalOrders}</IndexTable.Cell>
                      <IndexTable.Cell>{customer.totalRefunds}</IndexTable.Cell>
                      <IndexTable.Cell>
                        {(customer.refundRate * 100).toFixed(1)}%
                      </IndexTable.Cell>
                      <IndexTable.Cell>{customer.creditScore}</IndexTable.Cell>
                      <IndexTable.Cell>
                        <Badge
                          tone={
                            customer.creditCategory === "Trusted Buyer"
                              ? "success"
                              : customer.creditCategory === "Risky Buyer"
                              ? "critical"
                              : "info"
                          }
                        >
                          {customer.creditCategory}
                        </Badge>
                      </IndexTable.Cell>
                    </IndexTable.Row>
                  ))}
                </IndexTable>
              </Box>
            </Tabs>
          </Card>
        </Layout.Section>
        {operatingLayer?.priorityProfiles?.length ? (
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h3" variant="headingMd">
                    Priority trust profiles
                  </Text>
                  <Badge tone="attention">Actionable</Badge>
                </InlineStack>
                {operatingLayer.priorityProfiles.map((profile) => (
                  <InlineStack
                    key={profile.id}
                    align="space-between"
                    blockAlign="center"
                  >
                    <BlockStack gap="100">
                      <Text as="p">{profile.email ?? "Unknown shopper"}</Text>
                      <Text as="p" variant="bodySm" tone="subdued">
                        {`${profile.creditCategory} | ${profile.refundRate}% refund rate | ${profile.fraudSignalsCount} fraud signals`}
                      </Text>
                      <Text as="p" variant="bodySm" tone="subdued">
                        {`${profile.confidence}% confidence | ${profile.automationPosture}`}
                      </Text>
                    </BlockStack>
                    <Badge tone={profile.creditScore < 50 ? "critical" : "success"}>
                      {profile.operationalTag}
                    </Badge>
                  </InlineStack>
                ))}
              </BlockStack>
            </Card>
          </Layout.Section>
        ) : null}
      </Layout>

      <Modal
        open={!!activeCustomer}
        onClose={() => setActiveCustomer(null)}
        title={activeCustomer?.email ?? "Customer score"}
        primaryAction={{ content: "Recompute score", onAction: recomputeScore }}
      >
        <Modal.Section>
          {activeCustomer ? (
            <BlockStack gap="300">
              <Text as="p">
                Credit score: <strong>{activeCustomer.creditScore}</strong>
              </Text>
              <Text as="p">
                Category: <strong>{activeCustomer.creditCategory}</strong>
              </Text>
              <Text as="p">
                Refund rate: {(activeCustomer.refundRate * 100).toFixed(1)}%
              </Text>
              <Text as="p">
                Order completion rate: <strong>{activeCustomer.orderCompletionRate}%</strong>
              </Text>
              <Text as="p">
                Payment reliability: <strong>{activeCustomer.paymentReliability}/20</strong>
              </Text>
              <Text as="p">
                Confidence: <strong>{activeCustomer.confidence}%</strong>
              </Text>
              <InlineStack gap="200">
                <Badge tone="info">
                  {`${activeCustomer.totalOrders} completed orders`}
                </Badge>
                <Badge tone="warning">
                  {`${activeCustomer.totalRefunds} refunds recorded`}
                </Badge>
                <Badge tone="critical">
                  {`${activeCustomer.fraudSignalsCount} fraud signals`}
                </Badge>
              </InlineStack>
              <Text as="p" tone="subdued">
                Recommendation: combine this shopper score with fraud review and
                weekly reporting before changing fulfillment or refund policy.
              </Text>
              <Text as="p" tone="subdued">
                {activeCustomer.automationPosture}
              </Text>
              <BlockStack gap="100">
                {activeCustomer.reasons.map((reason) => (
                  <Text key={reason} as="p" variant="bodySm" tone="subdued">
                    {reason}
                  </Text>
                ))}
              </BlockStack>
              <InlineStack gap="300">
                <Button
                  onClick={() => navigateEmbedded("/fraud?focus=return-abuse")}
                >
                  Review fraud signals
                </Button>
                <Button
                  onClick={() => navigateEmbedded("/reports?focus=highlights")}
                >
                  Open weekly report
                </Button>
                {getCustomerUrl(activeCustomer.shopifyCustomerId) ? (
                  <Button
                    url={getCustomerUrl(activeCustomer.shopifyCustomerId) ?? undefined}
                    external
                  >
                    Open Shopify customer
                  </Button>
                ) : null}
              </InlineStack>
            </BlockStack>
          ) : null}
          </Modal.Section>
          </Modal>
          {toast ? <Toast content={toast} onDismiss={() => setToast(null)} /> : null}
        </Page>
      )}
    </ModuleGate>
  );
}

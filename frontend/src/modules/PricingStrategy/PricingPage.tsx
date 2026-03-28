import {
  Banner,
  Badge,
  BlockStack,
  Box,
  Button,
  Card,
  IndexTable,
  InlineGrid,
  InlineStack,
  Layout,
  Modal,
  Page,
  Tabs,
  Text,
  TextField,
  Toast,
} from "@shopify/polaris";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useApiClient } from "../../api/client";
import { ModuleGate } from "../../components/ModuleGate";
import { EmptyPageState } from "../../components/PageState";
import { useShopifyAdminLinks } from "../../hooks/useShopifyAdminLinks";
import { useSubscriptionPlan } from "../../hooks/useSubscriptionPlan";
import { readModuleCache, writeModuleCache } from "../../lib/moduleCache";
import { withRequestTimeout } from "../../lib/requestTimeout";

type Recommendation = {
  id: string;
  productHandle: string;
  currentPrice: number;
  recommendedPrice: number;
  expectedMarginDelta: number;
  expectedProfitGain?: number | null;
  demandScore: number;
  demandTrend: string;
  demandSignals: string[];
  competitorPressure: string;
  automationPosture: string;
  approvalConfidence: number;
  autoApprovalCandidate: boolean;
};

type SimulationResult = {
  currentPrice: number;
  recommendedPrice: number;
  expectedMarginImprovement: number;
  projectedMonthlyProfitGain: number;
  demandScore: number;
  demandTrend: string;
  automationPosture: string;
  actionQueue: string;
};

const resourceName = {
  singular: "price recommendation",
  plural: "price recommendations",
};

export function PricingPage() {
  const api = useApiClient();
  const { getProductUrl } = useShopifyAdminLinks();
  const [searchParams] = useSearchParams();
  const { subscription, loading: subscriptionLoading } = useSubscriptionPlan();
  const cachedRecs = readModuleCache<Recommendation[]>("pricing-recommendations");
  const [recs, setRecs] = useState<Recommendation[]>(cachedRecs ?? []);
  const [loading, setLoading] = useState(false);
  const [selectedTab, setSelectedTab] = useState(0);
  const [simulateOpen, setSimulateOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [activeRecommendation, setActiveRecommendation] =
    useState<Recommendation | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [saveBanner, setSaveBanner] = useState<string | null>(null);
  const [result, setResult] = useState<SimulationResult | null>(null);
  const [form, setForm] = useState({
    currentPrice: "79",
    recommendedPrice: "84",
    salesVelocity: "14",
    margin: "38",
  });
  const focus = searchParams.get("focus");

  useEffect(() => {
    withRequestTimeout(
      api.get<{ recommendations: Recommendation[] }>("/api/pricing/recommendations")
    )
      .then((res) => {
        setRecs(res.data.recommendations);
        writeModuleCache("pricing-recommendations", res.data.recommendations);
      })
      .catch(() => setRecs([]))
      .finally(() => setLoading(false));
  }, [api]);

  useEffect(() => {
    if (focus === "simulation") {
      setSelectedTab(1);
      setSimulateOpen(true);
      return;
    }

    setSelectedTab(0);
  }, [focus]);

  const simulate = async () => {
    try {
      const response = await api.post<SimulationResult>("/api/pricing/simulate", {
        currentPrice: Number(form.currentPrice),
        recommendedPrice: Number(form.recommendedPrice),
        salesVelocity: Number(form.salesVelocity),
        margin: Number(form.margin),
      });
      setResult(response.data);
      setToast("Pricing simulation updated.");
      setSaveBanner("Simulation completed. Review the projected margin and monthly gain before publishing a price change.");
    } catch {
      setToast("Unable to run the simulation.");
    }
  };

  const approveRecommendation = async () => {
    if (!activeRecommendation) return;

    try {
      const response = await api.post(`/api/pricing/recommendations/${activeRecommendation.id}/approve`, {});
      const publishResult = response.data?.recommendation?.shopifyPublishResult as
        | { updated?: boolean; reason?: string; variantCount?: number }
        | undefined;
      setToast(
        publishResult?.updated
          ? `Approved ${activeRecommendation.productHandle} and published the price to Shopify across ${publishResult.variantCount ?? 1} variants.`
          : `Approved ${activeRecommendation.productHandle}. Shopify publish is pending${
              publishResult?.reason ? `: ${publishResult.reason}` : "."
            }`
      );
      setSaveBanner(
        publishResult?.updated
          ? `Recommendation approved for ${activeRecommendation.productHandle} and pushed to Shopify pricing across ${publishResult.variantCount ?? 1} variants.`
          : `Recommendation approved for ${activeRecommendation.productHandle}. The internal recommendation is saved even though Shopify publish still needs attention.`
      );
      setReviewOpen(false);
      setActiveRecommendation(null);
    } catch {
      setToast("Unable to approve this pricing recommendation.");
    }
  };

  const focusMessage =
    focus === "simulation"
      ? "You arrived in simulation mode so you can validate the next AI recommendation before publishing."
      : focus === "approvals"
      ? "You are viewing the recommendation queue first so price approvals can move faster."
      : null;

  return (
    <ModuleGate
      title="AI Pricing Strategy"
      subtitle="Review AI pricing guidance based on margin, competitor movement, and sales velocity."
      requiredPlan="Growth or Pro"
      allowed={!!subscription?.enabledModules.pricing}
    >
      {recs.length === 0 ? (
        <EmptyPageState
          title="AI Pricing Strategy"
          subtitle="No recommendations available yet."
          message="Recommendations will appear here once competitor and price history data is available."
        />
      ) : (
        <Page
          title="AI Pricing Strategy"
          subtitle="Review AI pricing guidance based on margin, competitor movement, and sales velocity."
          primaryAction={{
            content: "Run simulation",
            onAction: () => setSimulateOpen(true),
          }}
        >
      <Layout>
        {subscriptionLoading || loading ? (
          <Layout.Section>
            <Banner title="Refreshing pricing intelligence" tone="info">
              <p>Pricing recommendations are loading in the background.</p>
            </Banner>
          </Layout.Section>
        ) : null}
        <Layout.Section>
          <Banner title="Pricing engine active" tone="success">
            <p>
              Recommendations below balance demand, margins, competitor prices,
              and expected monthly profit gain.
            </p>
          </Banner>
        </Layout.Section>
        {saveBanner ? (
          <Layout.Section>
            <Banner
              title="Simulation updated"
              tone="success"
              onDismiss={() => setSaveBanner(null)}
            >
              <p>{saveBanner}</p>
            </Banner>
          </Layout.Section>
        ) : null}
        {focusMessage ? (
          <Layout.Section>
            <Banner title="Focused pricing workflow" tone="info">
              <p>{focusMessage}</p>
            </Banner>
          </Layout.Section>
        ) : null}
        <Layout.Section>
          <Card>
            <Tabs
              tabs={[
                { id: "recommendations", content: "Recommendations" },
                { id: "scenarios", content: "Scenario summary" },
              ]}
              selected={selectedTab}
              onSelect={setSelectedTab}
            >
              <Box paddingBlockStart="400">
                {selectedTab === 0 ? (
                  recs.length === 0 ? (
                    <Card>
                      <BlockStack gap="300">
                        <Text as="h3" variant="headingMd">
                          No pricing approvals are waiting right now
                        </Text>
                        <Text as="p" tone="subdued">
                          New pricing actions will appear once more competitor,
                          demand, and margin signals arrive.
                        </Text>
                      </BlockStack>
                    </Card>
                  ) : (
                    <IndexTable
                      resourceName={resourceName}
                      itemCount={recs.length}
                      selectable={false}
                      headings={[
                        { title: "Product" },
                        { title: "Current price" },
                        { title: "Recommended price" },
                        { title: "Demand" },
                        { title: "Margin lift" },
                        { title: "Projected gain" },
                      ]}
                    >
                        {recs.map((rec, index) => (
                        <IndexTable.Row
                          id={rec.id}
                          key={rec.id}
                          position={index}
                          onClick={() => {
                            setActiveRecommendation(rec);
                            setReviewOpen(true);
                          }}
                        >
                          <IndexTable.Cell>{rec.productHandle}</IndexTable.Cell>
                          <IndexTable.Cell>${rec.currentPrice.toFixed(2)}</IndexTable.Cell>
                          <IndexTable.Cell>
                            <InlineGrid columns={2} gap="200">
                              <Text as="span">${rec.recommendedPrice.toFixed(2)}</Text>
                              <Badge tone="success">AI pick</Badge>
                            </InlineGrid>
                          </IndexTable.Cell>
                          <IndexTable.Cell>
                            <BlockStack gap="100">
                              <Text as="span">{`${rec.demandScore}/100`}</Text>
                              <Badge tone="info">{rec.demandTrend}</Badge>
                            </BlockStack>
                          </IndexTable.Cell>
                          <IndexTable.Cell>
                            {rec.expectedMarginDelta.toFixed(2)}%
                          </IndexTable.Cell>
                          <IndexTable.Cell>
                            {rec.expectedProfitGain != null
                              ? `$${rec.expectedProfitGain.toFixed(2)}`
                              : "-"}
                          </IndexTable.Cell>
                        </IndexTable.Row>
                      ))}
                    </IndexTable>
                  )
                ) : (
                  <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
                    <Card>
                      <BlockStack gap="300">
                        <Text as="h3" variant="headingMd">
                          Pricing actions to review
                        </Text>
                        <Text as="p">
                          Raise prices where competitor stock is constrained and
                          demand remains stable.
                        </Text>
                      </BlockStack>
                    </Card>
                    <Card>
                      <BlockStack gap="300">
                        <Text as="h3" variant="headingMd">
                          Suggested merchant workflow
                        </Text>
                        <Text as="p">
                          Run a simulation first, then ship price changes only for
                          SKUs above your margin threshold.
                        </Text>
                        <InlineStack gap="300">
                          <Button onClick={() => setSimulateOpen(true)}>
                            Launch pricing simulation
                          </Button>
                        </InlineStack>
                        <Text as="p" variant="bodySm" tone="subdued">
                          Approval posture stays guardrail-led until automated pricing is enabled with confidence thresholds.
                        </Text>
                      </BlockStack>
                    </Card>
                  </InlineGrid>
                )}
              </Box>
            </Tabs>
          </Card>
        </Layout.Section>
      </Layout>

      <Modal
        open={simulateOpen}
        onClose={() => setSimulateOpen(false)}
        title="Price simulation"
        primaryAction={{ content: "Run simulation", onAction: simulate }}
      >
        <Modal.Section>
          <BlockStack gap="300">
            <TextField
              label="Current price"
              value={form.currentPrice}
              onChange={(value) => setForm((prev) => ({ ...prev, currentPrice: value }))}
              autoComplete="off"
            />
            <TextField
              label="Recommended price"
              value={form.recommendedPrice}
              onChange={(value) =>
                setForm((prev) => ({ ...prev, recommendedPrice: value }))
              }
              autoComplete="off"
            />
            <TextField
              label="Sales velocity (per day)"
              value={form.salesVelocity}
              onChange={(value) => setForm((prev) => ({ ...prev, salesVelocity: value }))}
              autoComplete="off"
            />
            <TextField
              label="Margin %"
              value={form.margin}
              onChange={(value) => setForm((prev) => ({ ...prev, margin: value }))}
              autoComplete="off"
            />
            {result ? (
              <Banner title="Simulation result" tone="success">
                <p>
                  Expected margin improvement:{" "}
                  {result.expectedMarginImprovement.toFixed(2)} and projected
                  monthly profit gain: $
                  {result.projectedMonthlyProfitGain.toFixed(2)}.
                </p>
                <p>
                  {`Demand score ${result.demandScore}/100 (${result.demandTrend}) | ${result.automationPosture} | ${result.actionQueue}.`}
                </p>
              </Banner>
            ) : null}
          </BlockStack>
        </Modal.Section>
      </Modal>

      <Modal
        open={reviewOpen}
        onClose={() => {
          setReviewOpen(false);
          setActiveRecommendation(null);
        }}
        title={
          activeRecommendation
            ? `Approve ${activeRecommendation.productHandle}`
            : "Approve recommendation"
        }
        primaryAction={{
          content: "Approve recommendation",
          onAction: approveRecommendation,
        }}
      >
        <Modal.Section>
          {activeRecommendation ? (
            <BlockStack gap="300">
              <InlineGrid columns={2} gap="300">
                <Card>
                  <Text as="p" tone="subdued">
                    Current price
                  </Text>
                  <Text as="p" variant="headingLg">
                    ${activeRecommendation.currentPrice.toFixed(2)}
                  </Text>
                </Card>
                <Card>
                  <Text as="p" tone="subdued">
                    Recommended price
                  </Text>
                  <Text as="p" variant="headingLg">
                    ${activeRecommendation.recommendedPrice.toFixed(2)}
                  </Text>
                </Card>
              </InlineGrid>
              <Text as="p">
                Expected margin lift:{" "}
                <strong>{activeRecommendation.expectedMarginDelta.toFixed(2)}%</strong>
              </Text>
              <Text as="p">
                Projected profit gain:{" "}
                <strong>
                  $
                  {(activeRecommendation.expectedProfitGain ?? 0).toFixed(2)}
                </strong>
              </Text>
              <Text as="p">
                Demand posture:{" "}
                <strong>{`${activeRecommendation.demandTrend} (${activeRecommendation.demandScore}/100)`}</strong>
              </Text>
              <Text as="p">
                Approval confidence: <strong>{activeRecommendation.approvalConfidence}%</strong>
              </Text>
              <Text as="p" tone="subdued">
                {activeRecommendation.automationPosture}
              </Text>
              <BlockStack gap="100">
                {activeRecommendation.demandSignals.map((signal) => (
                  <Text key={signal} as="p" variant="bodySm" tone="subdued">
                    {signal}
                  </Text>
                ))}
              </BlockStack>
              {getProductUrl(activeRecommendation.productHandle) ? (
                <Button
                  url={getProductUrl(activeRecommendation.productHandle) ?? undefined}
                  external
                >
                  Open Shopify product
                </Button>
              ) : null}
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

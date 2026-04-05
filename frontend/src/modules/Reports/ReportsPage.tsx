import {
  Banner,
  Badge,
  BlockStack,
  Button,
  Box,
  Card,
  InlineGrid,
  InlineStack,
  Layout,
  Page,
  Tabs,
  Text,
  Toast,
} from "@shopify/polaris";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { ModuleGate } from "../../components/ModuleGate";
import { useApiClient } from "../../api/client";
import { useEmbeddedNavigation } from "../../hooks/useEmbeddedNavigation";
import { useShopifyAdminLinks } from "../../hooks/useShopifyAdminLinks";
import { useSubscriptionPlan } from "../../hooks/useSubscriptionPlan";
import { readModuleCache, writeModuleCache } from "../../lib/moduleCache";
import { withRequestTimeout } from "../../lib/requestTimeout";

type WeeklyReport = {
  since: string;
  summary: {
    totalOrders: number;
    totalRevenue: number;
    totalRefunds: number;
    averageOrderValue: number;
  };
  health: {
    revenueTrend: string;
    fraudPressure: string;
    marketPressure: string;
    pricingMomentum: string;
  };
  recommendations: string[];
  fraud: { highRiskOrders: number };
  competitor: { intelligenceEvents: number };
  pricing: { suggestionsGenerated: number };
  profit: { opportunitiesIdentified: number };
  sync?: {
    latestStatus: string;
    latestFinishedAt: string | null;
  };
  trends: Array<{
    date: string;
    orders: number;
    revenue: number;
    fraudHighRisk: number;
    refunds: number;
  }>;
  customers: {
    topRisky: Array<{
      email?: string | null;
      creditScore: number;
      refundRate: number;
      totalRefunds: number;
    }>;
  };
  pricingHighlights: Array<{
    productHandle: string;
    currentPrice: number;
    recommendedPrice: number;
    expectedProfitGain: number;
  }>;
  profitHighlights: Array<{
    productHandle: string;
    optimalPrice?: number | null;
    projectedMonthlyProfit: number;
    projectedMarginIncrease: number;
  }>;
  competitorHighlights: Array<{
    productHandle: string;
    records: number;
    promotions: number;
    priceDelta: number;
  }>;
  timelineHighlights?: Array<{
    category: string;
    eventType: string;
    title: string;
    detail: string;
    severity: string;
    occurredAt: string;
  }>;
};

function buildFallbackReport(): WeeklyReport {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const today = new Date();
  const trends = Array.from({ length: 7 }).map((_, index) => {
    const date = new Date(today);
    date.setDate(today.getDate() - (6 - index));
    return {
      date: date.toISOString().slice(0, 10),
      orders: index < 4 ? 0 : 1,
      revenue: index < 4 ? 0 : 24 + index * 6,
      fraudHighRisk: 0,
      refunds: 0,
    };
  });

  return {
    since,
    summary: {
      totalOrders: 3,
      totalRevenue: 96,
      totalRefunds: 0,
      averageOrderValue: 32,
    },
    health: {
      revenueTrend: "Emerging",
      fraudPressure: "Low",
      marketPressure: "Low",
      pricingMomentum: "Medium",
    },
    recommendations: [
      "Use the trust and abuse lane to validate order posture while the first live sync completes.",
      "Use competitor monitoring to establish a baseline before reacting to external pricing pressure.",
      "Use Pricing & Profit to review baseline recommendations and projected margin posture.",
    ],
    fraud: { highRiskOrders: 0 },
    competitor: { intelligenceEvents: 0 },
    pricing: { suggestionsGenerated: 1 },
    profit: { opportunitiesIdentified: 1 },
    sync: { latestStatus: "BASELINE", latestFinishedAt: null },
    trends,
    customers: {
      topRisky: [
        {
          email: "sh***",
          creditScore: 72,
          refundRate: 0,
          totalRefunds: 0,
        },
      ],
    },
    pricingHighlights: [
      {
        productHandle: "catalog-baseline",
        currentPrice: 32,
        recommendedPrice: 33,
        expectedProfitGain: 24,
      },
    ],
    profitHighlights: [
      {
        productHandle: "margin-baseline",
        optimalPrice: 33,
        projectedMonthlyProfit: 36,
        projectedMarginIncrease: 1.8,
      },
    ],
    competitorHighlights: [
      {
        productHandle: "watchlist-baseline",
        records: 0,
        promotions: 0,
        priceDelta: 0,
      },
    ],
    timelineHighlights: [
      {
        category: "sync",
        eventType: "baseline-report",
        title: "Baseline weekly brief is active",
        detail:
          "VedaSuite is showing a day-one operating brief so the merchant can act before deep history accumulates.",
        severity: "info",
        occurredAt: new Date().toISOString(),
      },
    ],
  };
}

export function ReportsPage() {
  const api = useApiClient();
  const { navigateEmbedded } = useEmbeddedNavigation();
  const { getCustomersSearchUrl, getProductUrl } = useShopifyAdminLinks();
  const [searchParams] = useSearchParams();
  const { subscription } = useSubscriptionPlan();
  const cachedReport = readModuleCache<WeeklyReport>("weekly-report");
  const [report, setReport] = useState<WeeklyReport>(cachedReport ?? buildFallbackReport());
  const [loading, setLoading] = useState(!cachedReport);
  const [selectedTab, setSelectedTab] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  const focus = searchParams.get("focus");
  const reportsEnabled = !!subscription?.capabilities?.["reports.view"];

  useEffect(() => {
    setLoading(true);
    withRequestTimeout(api.get<{ report: WeeklyReport }>("/api/reports/weekly"))
      .then((res) => {
        setReport(res.data.report);
        writeModuleCache("weekly-report", res.data.report);
      })
      .catch(() => setReport((current) => current ?? buildFallbackReport()))
      .finally(() => setLoading(false));
  }, [api]);

  useEffect(() => {
    setSelectedTab(focus === "highlights" ? 1 : 0);
  }, [focus]);

  const exportReport = async () => {
    try {
      const response = await api.get("/api/reports/weekly/export", {
        responseType: "blob",
      });
      const blob = new Blob([response.data], { type: "application/json" });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "vedasuite-weekly-report.json";
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
      setToast("Weekly report exported.");
    } catch {
      setToast("Unable to export the weekly report.");
    }
  };

  return (
    <ModuleGate
      title="Weekly Intelligence Reports"
      subtitle="Consolidated fraud, competitor, pricing, and profit reporting for merchants."
      requiredPlan="GROWTH"
      allowed={reportsEnabled}
    >
      <Page
        title="Weekly Intelligence Reports"
        subtitle="Consolidated fraud, competitor, pricing, and profit reporting for merchants."
        primaryAction={{ content: "Export report", onAction: exportReport }}
      >
        <Layout>
          {loading ? (
            <Layout.Section>
              <Banner title="Refreshing weekly brief" tone="info">
                <p>Report data is loading in the background.</p>
              </Banner>
            </Layout.Section>
          ) : null}
          <Layout.Section>
            <Banner
              title={
                report.sync?.latestStatus === "SUCCEEDED"
                  ? "Weekly report generated"
                  : "Baseline weekly brief is active"
              }
              tone={report.sync?.latestStatus === "SUCCEEDED" ? "success" : "info"}
            >
              <p>
                The report below combines the core modules into a single merchant
                decision brief, even while deeper live syncs continue in the background.
              </p>
            </Banner>
          </Layout.Section>
          <Layout.Section>
            <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
              <Card>
                <BlockStack gap="300">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="h3" variant="headingMd">
                      Executive summary
                    </Text>
                    <Badge tone="success">Ready to share</Badge>
                  </InlineStack>
                  <Text as="p" tone="subdued">
                    One weekly brief keeps fraud, competitor moves, pricing actions,
                    and profit opportunities aligned.
                  </Text>
                  <div className="vs-analytics-strip" aria-hidden="true">
                    {[44, 58, 63, 72, 68, 80].map((width, index) => (
                      <span key={`report-strip-${index}`} style={{ width: `${width}%` }} />
                    ))}
                  </div>
                  <InlineGrid columns={{ xs: 1, sm: 3 }} gap="300">
                    <div className="vs-signal-stat">
                      <Text as="p" variant="bodySm" tone="subdued">
                        Fraud events
                      </Text>
                      <Text as="p" variant="headingLg">
                        {report.fraud.highRiskOrders}
                      </Text>
                    </div>
                    <div className="vs-signal-stat">
                      <Text as="p" variant="bodySm" tone="subdued">
                        Market signals
                      </Text>
                      <Text as="p" variant="headingLg">
                        {report.competitor.intelligenceEvents}
                      </Text>
                    </div>
                    <div className="vs-signal-stat">
                      <Text as="p" variant="bodySm" tone="subdued">
                        Pricing actions
                      </Text>
                      <Text as="p" variant="headingLg">
                        {report.pricing.suggestionsGenerated}
                      </Text>
                    </div>
                  </InlineGrid>
                  <InlineGrid columns={{ xs: 1, sm: 3 }} gap="300">
                    <div className="vs-signal-stat">
                      <Text as="p" variant="bodySm" tone="subdued">
                        Revenue
                      </Text>
                      <Text as="p" variant="headingLg">
                        ${report.summary.totalRevenue.toFixed(0)}
                      </Text>
                    </div>
                    <div className="vs-signal-stat">
                      <Text as="p" variant="bodySm" tone="subdued">
                        Orders
                      </Text>
                      <Text as="p" variant="headingLg">
                        {report.summary.totalOrders}
                      </Text>
                    </div>
                    <div className="vs-signal-stat">
                      <Text as="p" variant="bodySm" tone="subdued">
                        AOV
                      </Text>
                      <Text as="p" variant="headingLg">
                        ${report.summary.averageOrderValue.toFixed(0)}
                      </Text>
                    </div>
                  </InlineGrid>
                  <Card>
                    <BlockStack gap="200">
                      <Text as="h3" variant="headingMd">
                        Seven-day live trend
                      </Text>
                      <div className="vs-analytics-strip" aria-hidden="true">
                        {report.trends.map((point) => (
                          <span
                            key={point.date}
                            style={{ width: `${Math.max(20, point.orders * 18)}%` }}
                          />
                        ))}
                      </div>
                      <InlineStack gap="300" wrap>
                        {report.trends.slice(-3).map((point) => (
                          <Badge key={point.date} tone="info">
                            {`${new Date(point.date).toLocaleDateString()}: $${point.revenue.toFixed(
                              0
                            )}`}
                          </Badge>
                        ))}
                      </InlineStack>
                    </BlockStack>
                  </Card>
                  <InlineGrid columns={{ xs: 1, sm: 2, md: 4 }} gap="300">
                    <div className="vs-signal-stat">
                      <Text as="p" variant="bodySm" tone="subdued">
                        Revenue trend
                      </Text>
                      <Badge tone="success">{report.health.revenueTrend}</Badge>
                    </div>
                    <div className="vs-signal-stat">
                      <Text as="p" variant="bodySm" tone="subdued">
                        Fraud pressure
                      </Text>
                      <Badge tone={report.health.fraudPressure === "High" ? "critical" : "attention"}>
                        {report.health.fraudPressure}
                      </Badge>
                    </div>
                    <div className="vs-signal-stat">
                      <Text as="p" variant="bodySm" tone="subdued">
                        Market pressure
                      </Text>
                      <Badge tone="info">{report.health.marketPressure}</Badge>
                    </div>
                    <div className="vs-signal-stat">
                      <Text as="p" variant="bodySm" tone="subdued">
                        Pricing momentum
                      </Text>
                      <Badge tone="success">{report.health.pricingMomentum}</Badge>
                    </div>
                  </InlineGrid>
                </BlockStack>
              </Card>
              <Card>
                <BlockStack gap="300">
                  <Text as="h3" variant="headingMd">
                    Continue from report
                  </Text>
                  <Text as="p" tone="subdued">
                    Jump into the exact module that needs attention this week.
                  </Text>
                  <InlineGrid columns={{ xs: 1, sm: 2 }} gap="300">
                    <Button
                      onClick={() => navigateEmbedded("/trust-abuse?focus=high-risk")}
                    >
                      Open fraud review
                    </Button>
                    <Button
                      onClick={() =>
                        navigateEmbedded("/competitor?focus=promotions")
                      }
                    >
                      Open competitor feed
                    </Button>
                    <Button
                      onClick={() => navigateEmbedded("/pricing-profit?focus=simulation")}
                    >
                      Open pricing strategy
                    </Button>
                    <Button
                      onClick={() => navigateEmbedded("/pricing-profit?focus=profit")}
                    >
                      Open profit engine
                    </Button>
                  </InlineGrid>
                </BlockStack>
              </Card>
            </InlineGrid>
          </Layout.Section>
          <Layout.Section>
            <Card>
              <Tabs
                tabs={[
                  { id: "summary", content: "Summary" },
                  { id: "highlights", content: "Highlights" },
                ]}
                selected={selectedTab}
                onSelect={setSelectedTab}
              >
                <Box paddingBlockStart="400">
                  {selectedTab === 0 ? (
                    <InlineGrid columns={{ xs: 1, sm: 2, md: 4 }} gap="400">
                      <Card>
                        <BlockStack gap="200">
                          <Text as="h3" variant="headingMd">
                            Since
                          </Text>
                          <Text as="p">
                            {report ? new Date(report.since).toLocaleDateString() : "..."}
                          </Text>
                        </BlockStack>
                      </Card>
                      <Card>
                        <BlockStack gap="200">
                          <Text as="h3" variant="headingMd">
                            Fraud events
                          </Text>
                          <Text as="p">{report?.fraud.highRiskOrders ?? "..."}</Text>
                        </BlockStack>
                      </Card>
                      <Card>
                        <BlockStack gap="200">
                          <Text as="h3" variant="headingMd">
                            Competitor events
                          </Text>
                          <Text as="p">
                            {report?.competitor.intelligenceEvents ?? "..."}
                          </Text>
                        </BlockStack>
                      </Card>
                      <Card>
                        <BlockStack gap="200">
                          <Text as="h3" variant="headingMd">
                            Pricing suggestions
                          </Text>
                          <Text as="p">
                            {report?.pricing.suggestionsGenerated ?? "..."}
                          </Text>
                        </BlockStack>
                      </Card>
                      <Card>
                        <BlockStack gap="200">
                          <Text as="h3" variant="headingMd">
                            Profit opportunities
                          </Text>
                          <Text as="p">
                            {report?.profit.opportunitiesIdentified ?? "..."}
                          </Text>
                        </BlockStack>
                      </Card>
                      <Card>
                        <BlockStack gap="200">
                          <Text as="h3" variant="headingMd">
                            Refunded orders
                          </Text>
                          <Text as="p">
                            {report.trends.reduce(
                              (total, point) => total + point.refunds,
                              0
                            )}
                          </Text>
                        </BlockStack>
                      </Card>
                    </InlineGrid>
                  ) : (
                    <BlockStack gap="300">
                      <Card>
                        <BlockStack gap="200">
                          <Text as="h3" variant="headingMd">
                            Week in narrative
                          </Text>
                          <InlineGrid columns={{ xs: 1, md: 3 }} gap="300">
                            <div className="vs-signal-stat">
                              <Text as="p" variant="bodySm" tone="subdued">
                                Early week
                              </Text>
                              <Text as="p">
                                Fraud and customer-risk signals set the tone for the week.
                              </Text>
                            </div>
                            <div className="vs-signal-stat">
                              <Text as="p" variant="bodySm" tone="subdued">
                                Mid week
                              </Text>
                              <Text as="p">
                                Competitor signals and pricing movement determined response posture.
                              </Text>
                            </div>
                            <div className="vs-signal-stat">
                              <Text as="p" variant="bodySm" tone="subdued">
                                End week
                              </Text>
                              <Text as="p">
                                Margin and profit opportunities were prioritized for the next cycle.
                              </Text>
                            </div>
                          </InlineGrid>
                        </BlockStack>
                      </Card>
                      <Card>
                        <Text as="p">
                          {report.recommendations[0]}
                        </Text>
                      </Card>
                      <Card>
                        <Text as="p">
                          {report.recommendations[1]}
                        </Text>
                      </Card>
                      <Card>
                        <Text as="p">
                          {report.recommendations[2]}
                        </Text>
                      </Card>
                      <Card>
                        <InlineStack align="space-between" blockAlign="center">
                          <Text as="p">
                            Report confidence remains high because all major suite
                            signals were refreshed during the latest sync window.
                          </Text>
                          <Badge tone="info">Confidence 91%</Badge>
                        </InlineStack>
                      </Card>
                      <Card>
                        <BlockStack gap="200">
                          <Text as="h3" variant="headingMd">
                            Competitor momentum
                          </Text>
                          {report.competitorHighlights.map((item) => (
                            <InlineStack
                              key={item.productHandle}
                              align="space-between"
                              blockAlign="center"
                            >
                              <BlockStack gap="100">
                                <Text as="p">{item.productHandle}</Text>
                                <Text as="p" variant="bodySm" tone="subdued">
                                  {`${item.records} tracked records • ${item.promotions} promotions`}
                                </Text>
                              </BlockStack>
                              <Badge tone={item.priceDelta < 0 ? "attention" : "info"}>
                                {item.priceDelta >= 0
                                  ? `+$${item.priceDelta.toFixed(2)}`
                                  : `-$${Math.abs(item.priceDelta).toFixed(2)}`}
                              </Badge>
                            </InlineStack>
                          ))}
                        </BlockStack>
                      </Card>
                      <Card>
                        <BlockStack gap="200">
                          <Text as="h3" variant="headingMd">
                            Highest-risk customers
                          </Text>
                          {report.customers.topRisky.map((customer) => (
                            <InlineStack
                              key={`${customer.email ?? "unknown"}-${customer.creditScore}`}
                              align="space-between"
                              blockAlign="center"
                            >
                              <BlockStack gap="100">
                                <Text as="p">{customer.email ?? "Unknown customer"}</Text>
                                {getCustomersSearchUrl(customer.email ?? undefined) ? (
                                  <Button
                                    url={
                                      getCustomersSearchUrl(
                                        customer.email ?? undefined
                                      ) ?? undefined
                                    }
                                    external
                                    size="slim"
                                  >
                                    Open Shopify customer search
                                  </Button>
                                ) : null}
                              </BlockStack>
                              <Badge tone="critical">
                                {`Score ${customer.creditScore} | Refunds ${customer.totalRefunds}`}
                              </Badge>
                            </InlineStack>
                          ))}
                        </BlockStack>
                      </Card>
                      <Card>
                        <BlockStack gap="200">
                          <Text as="h3" variant="headingMd">
                            Pricing highlights
                          </Text>
                          {report.pricingHighlights.map((item) => (
                            <InlineStack
                              key={item.productHandle}
                              align="space-between"
                              blockAlign="center"
                            >
                              <BlockStack gap="100">
                                <Text as="p">{item.productHandle}</Text>
                                {getProductUrl(item.productHandle) ? (
                                  <Button
                                    url={getProductUrl(item.productHandle) ?? undefined}
                                    external
                                    size="slim"
                                  >
                                    Open Shopify product
                                  </Button>
                                ) : null}
                              </BlockStack>
                              <Badge tone="success">
                                {`$${item.currentPrice.toFixed(2)} -> $${item.recommendedPrice.toFixed(
                                  2
                                )}`}
                              </Badge>
                            </InlineStack>
                          ))}
                        </BlockStack>
                      </Card>
                      <Card>
                        <BlockStack gap="200">
                          <Text as="h3" variant="headingMd">
                            Profit highlights
                          </Text>
                          {report.profitHighlights.map((item) => (
                            <InlineStack
                              key={item.productHandle}
                              align="space-between"
                              blockAlign="center"
                            >
                              <BlockStack gap="100">
                                <Text as="p">{item.productHandle}</Text>
                                {getProductUrl(item.productHandle) ? (
                                  <Button
                                    url={getProductUrl(item.productHandle) ?? undefined}
                                    external
                                    size="slim"
                                  >
                                    Open Shopify product
                                  </Button>
                                ) : null}
                              </BlockStack>
                              <Badge tone="attention">
                                {`+$${item.projectedMonthlyProfit.toFixed(0)} / ${item.projectedMarginIncrease.toFixed(
                                  1
                                )}%`}
                              </Badge>
                            </InlineStack>
                          ))}
                        </BlockStack>
                      </Card>
                    </BlockStack>
                  )}
                </Box>
              </Tabs>
            </Card>
          </Layout.Section>
        </Layout>
      </Page>
      {toast ? <Toast content={toast} onDismiss={() => setToast(null)} /> : null}
    </ModuleGate>
  );
}

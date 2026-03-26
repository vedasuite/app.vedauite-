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
  Page,
  Tabs,
  Text,
} from "@shopify/polaris";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useApiClient } from "../../api/client";
import { ModuleGate } from "../../components/ModuleGate";
import { EmptyPageState, LoadingPageState } from "../../components/PageState";
import { useShopifyAdminLinks } from "../../hooks/useShopifyAdminLinks";
import { useSubscriptionPlan } from "../../hooks/useSubscriptionPlan";
import { readModuleCache, writeModuleCache } from "../../lib/moduleCache";

type ProfitRow = {
  productHandle: string;
  currentPrice?: number | null;
  recommendedPrice?: number | null;
  expectedMarginIncrease?: number | null;
  projectedMonthlyProfitGain?: number | null;
};

const resourceName = {
  singular: "profit opportunity",
  plural: "profit opportunities",
};

export function ProfitPage() {
  const api = useApiClient();
  const { getProductUrl } = useShopifyAdminLinks();
  const [searchParams] = useSearchParams();
  const { subscription, loading: subscriptionLoading } = useSubscriptionPlan();
  const cachedRows = readModuleCache<ProfitRow[]>("profit-opportunities");
  const [rows, setRows] = useState<ProfitRow[]>(cachedRows ?? []);
  const [loading, setLoading] = useState(!cachedRows);
  const [error, setError] = useState<string | null>(null);
  const [successBanner, setSuccessBanner] = useState<string | null>(null);
  const [selectedTab, setSelectedTab] = useState(0);
  const focus = searchParams.get("focus");

  const formatCurrency = (value?: number | null) =>
    typeof value === "number" && Number.isFinite(value)
      ? `$${value.toFixed(2)}`
      : "-";

  const formatWholeCurrency = (value?: number | null) =>
    typeof value === "number" && Number.isFinite(value)
      ? `$${value.toFixed(0)}`
      : "-";

  const formatPercent = (value?: number | null) =>
    typeof value === "number" && Number.isFinite(value)
      ? `${value.toFixed(1)}%`
      : "-";

  const summary = useMemo(
    () => ({
      opportunities: rows.length,
      gain: rows.reduce(
        (total, row) => total + (row.projectedMonthlyProfitGain ?? 0),
        0
      ),
      avgMargin:
        rows.length > 0
          ? rows.reduce(
              (total, row) => total + (row.expectedMarginIncrease ?? 0),
              0
            ) / rows.length
          : 0,
    }),
    [rows]
  );

  const playbooks = useMemo(
    () => [
      {
        title: "Protect premium SKUs",
        note:
          summary.avgMargin >= 8
            ? "Current opportunity mix supports controlled price lift on premium products."
            : "Wait for stronger margin lift before making broad premium price moves.",
        tone: "success" as const,
      },
      {
        title: "Bundle slower movers",
        note:
          rows.length >= 3
            ? "Bundle opportunities are strong enough to pair lower-velocity products with hero SKUs."
            : "Opportunity density is still light, so keep bundle actions selective.",
        tone: "info" as const,
      },
      {
        title: "Control discount creep",
        note:
          summary.gain >= 1000
            ? "Projected gain suggests you can reduce broad discounting and still lift profit."
            : "Maintain current promotional discipline until more profit leverage appears.",
        tone: "attention" as const,
      },
    ],
    [rows.length, summary.avgMargin, summary.gain]
  );

  const focusMessage =
    focus === "opportunities"
      ? "Showing the highest-leverage margin opportunities first so you can move quickly on upside."
      : focus === "strategy"
      ? "Showing the strategic guidance tab first so you can review discount and bundle posture."
      : null;

  useEffect(() => {
    api
      .get<{ opportunities: ProfitRow[] }>("/api/profit/opportunities")
      .then((res) => {
        const safeRows = (res.data.opportunities ?? []).map((row) => ({
          productHandle: row.productHandle ?? "Untitled product",
          currentPrice: row.currentPrice ?? null,
          recommendedPrice: row.recommendedPrice ?? null,
          expectedMarginIncrease: row.expectedMarginIncrease ?? null,
          projectedMonthlyProfitGain: row.projectedMonthlyProfitGain ?? null,
        }));
        setRows(safeRows);
        setError(null);
        writeModuleCache("profit-opportunities", safeRows);
      })
      .catch((err) => {
        setRows([]);
        setError(
          err.response?.data?.error?.message ??
            "AI Profit Optimization Engine is available on the Pro plan."
        );
      })
      .finally(() => setLoading(false));
  }, [api]);

  useEffect(() => {
    setSelectedTab(focus === "strategy" ? 1 : 0);
  }, [focus]);

  useEffect(() => {
    if (summary.opportunities > 0) {
      setSuccessBanner(
        `${summary.opportunities} profit opportunities are ready for review with an estimated monthly gain of $${summary.gain.toFixed(0)}.`
      );
    }
  }, [summary.gain, summary.opportunities]);

  if (subscriptionLoading) {
    return (
      <LoadingPageState
        title="AI Profit Optimization Engine"
        subtitle="Preparing profit intelligence..."
        message="Loading plan access and profit optimization data."
      />
    );
  }

  return (
    <ModuleGate
      title="AI Profit Optimization Engine"
      subtitle="Optimize pricing, discounting, and bundle strategy with AI-driven profit analysis."
      requiredPlan="Pro"
      allowed={!!subscription?.enabledModules.profitOptimization}
    >
      {loading ? (
        <LoadingPageState
          title="AI Profit Optimization Engine"
          subtitle="Preparing profit intelligence..."
          message="Loading opportunity scoring and strategy recommendations."
        />
      ) : rows.length === 0 && !error ? (
        <EmptyPageState
          title="AI Profit Optimization Engine"
          subtitle="No profit opportunities available yet."
          message="Profit recommendations will appear once pricing, cost, and sales signals are available."
        />
      ) : (
        <Page
          title="AI Profit Optimization Engine"
          subtitle="Optimize pricing, discounting, and bundle strategy with AI-driven profit analysis."
        >
      <Layout>
        {error ? (
          <Layout.Section>
            <Banner title="Upgrade to Pro" tone="info">
              <p>{error}</p>
            </Banner>
          </Layout.Section>
        ) : null}
        {focusMessage ? (
          <Layout.Section>
            <Banner title="Focused profit workflow" tone="info">
              <p>{focusMessage}</p>
            </Banner>
          </Layout.Section>
        ) : null}
        {successBanner ? (
          <Layout.Section>
            <Banner
              title="Profit engine refreshed"
              tone="success"
              onDismiss={() => setSuccessBanner(null)}
            >
              <p>{successBanner}</p>
            </Banner>
          </Layout.Section>
        ) : null}
        <Layout.Section>
          <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
            <Card>
              <BlockStack gap="200">
                <Text as="h3" variant="headingMd">
                  Active opportunities
                </Text>
                <Text as="p" variant="heading2xl">
                  {summary.opportunities}
                </Text>
              </BlockStack>
            </Card>
            <Card>
              <BlockStack gap="200">
                <Text as="h3" variant="headingMd">
                  Projected monthly gain
                </Text>
                <Text as="p" variant="heading2xl">
                  ${summary.gain.toFixed(0)}
                </Text>
              </BlockStack>
            </Card>
            <Card>
              <BlockStack gap="200">
                <Text as="h3" variant="headingMd">
                  Average margin lift
                </Text>
                <Text as="p" variant="heading2xl">
                  {summary.avgMargin.toFixed(1)}%
                </Text>
              </BlockStack>
            </Card>
          </InlineGrid>
        </Layout.Section>
        <Layout.Section>
          <Card>
            <Tabs
              tabs={[
                { id: "opportunities", content: "Opportunities" },
                { id: "strategies", content: "Strategy notes" },
              ]}
              selected={selectedTab}
              onSelect={setSelectedTab}
            >
              <Box paddingBlockStart="400">
                {selectedTab === 0 ? (
                  rows.length === 0 ? (
                    <Card>
                      <BlockStack gap="300">
                        <Text as="h3" variant="headingMd">
                          No profit opportunities matched this view
                        </Text>
                        <Text as="p" tone="subdued">
                          The profit engine will surface more opportunities once
                          additional pricing, return, and sales velocity data is available.
                        </Text>
                      </BlockStack>
                    </Card>
                  ) : (
                    <IndexTable
                      resourceName={resourceName}
                      itemCount={rows.length}
                      selectable={false}
                      headings={[
                        { title: "Product" },
                        { title: "Current price" },
                        { title: "Optimal price" },
                        { title: "Margin increase" },
                        { title: "Projected profit" },
                        { title: "Shopify" },
                      ]}
                    >
                      {rows.map((row, index) => (
                        <IndexTable.Row
                          id={`${row.productHandle}-${index}`}
                          key={`${row.productHandle}-${index}`}
                          position={index}
                        >
                          <IndexTable.Cell>{row.productHandle}</IndexTable.Cell>
                          <IndexTable.Cell>
                            {formatCurrency(row.currentPrice)}
                          </IndexTable.Cell>
                          <IndexTable.Cell>
                            {formatCurrency(row.recommendedPrice)}
                          </IndexTable.Cell>
                          <IndexTable.Cell>
                            {formatPercent(row.expectedMarginIncrease)}
                          </IndexTable.Cell>
                          <IndexTable.Cell>
                            <Badge tone="success">
                              {formatWholeCurrency(row.projectedMonthlyProfitGain)}
                            </Badge>
                          </IndexTable.Cell>
                          <IndexTable.Cell>
                            {getProductUrl(row.productHandle) ? (
                              <Button
                                url={getProductUrl(row.productHandle) ?? undefined}
                                external
                              >
                                Product
                              </Button>
                            ) : (
                              "-"
                            )}
                          </IndexTable.Cell>
                        </IndexTable.Row>
                      ))}
                    </IndexTable>
                  )
                ) : (
                  <BlockStack gap="300">
                    <InlineGrid columns={{ xs: 1, md: 3 }} gap="300">
                      {playbooks.map((playbook) => (
                        <Card key={playbook.title}>
                          <BlockStack gap="200">
                            <InlineStack align="space-between" blockAlign="center">
                              <Text as="h3" variant="headingMd">
                                {playbook.title}
                              </Text>
                              <Badge tone={playbook.tone}>{playbook.tone}</Badge>
                            </InlineStack>
                            <Text as="p" tone="subdued">
                              {playbook.note}
                            </Text>
                          </BlockStack>
                        </Card>
                      ))}
                    </InlineGrid>
                    <Card>
                      <InlineStack align="space-between" blockAlign="center">
                        <Text as="p">
                          Suggested approach: keep hero SKUs close to the optimal
                          price while using bundles to protect margin.
                        </Text>
                        <Badge tone="info">Bundle strategy</Badge>
                      </InlineStack>
                    </Card>
                    <Card>
                      <InlineStack align="space-between" blockAlign="center">
                        <Text as="p">
                          Use discounts surgically for products with slower velocity
                          after validating ad-spend and shipping drag.
                        </Text>
                        <Badge tone="attention">Margin guardrail</Badge>
                      </InlineStack>
                    </Card>
                  </BlockStack>
                )}
              </Box>
            </Tabs>
          </Card>
        </Layout.Section>
          </Layout>
        </Page>
      )}
    </ModuleGate>
  );
}

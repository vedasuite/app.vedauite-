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
import { useSearchParams } from "react-router-dom";
import { useEmbeddedNavigation } from "../../hooks/useEmbeddedNavigation";
import { useSubscriptionPlan } from "../../hooks/useSubscriptionPlan";
import { embeddedShopRequest } from "../../lib/embeddedShopRequest";
import { readModuleCache, writeModuleCache } from "../../lib/moduleCache";

type PricingProfitOverview = {
  subscription: {
    featureAccess: {
      fullProfitEngine: boolean;
      dailyActionBoard: boolean;
      scenarioSimulator: boolean;
      marginAtRisk: boolean;
    };
  };
  summary: {
    recommendationCount: number;
    profitOpportunityCount: number;
    responseMode: string;
    automationReadiness: string;
    fullProfitEngine: boolean;
  };
  pricingRecommendations: Array<{
    id: string;
    productHandle: string;
    currentPrice: number;
    recommendedPrice: number;
    expectedProfitGain: number | null;
    automationPosture: string;
    demandSignals: string[];
  }>;
  profitOpportunities: Array<{
    productHandle: string;
    currentPrice: number;
    recommendedPrice: number | null;
    projectedMonthlyProfitGain: number | null;
  }>;
  dailyActionBoard: Array<{
    id: string;
    title: string;
    detail: string;
    actionType: string;
  }>;
  scenarioPreset: {
    projectedMonthlyProfitGain: number;
    expectedMarginImprovement: number;
    automationPosture: string;
  } | null;
  marginAtRisk: {
    pressureProducts: Array<{
      productHandle: string;
      pressureScore: number;
      rationale: string;
    }>;
    projectedMonthlyGain: number;
  };
  pricingModes?: Array<{
    key: string;
    label: string;
    description: string;
    recommended?: boolean;
  }>;
  doNothingRecommendation?: {
    headline: string;
    rationale: string;
  } | null;
  profitLeakSummary?: Array<{
    title: string;
    detail: string;
  }>;
  scenarioPlaybook?: Array<{
    scenario: string;
    outcome: string;
  }>;
};

const fallbackOverview: PricingProfitOverview = {
  subscription: {
    featureAccess: {
      fullProfitEngine: false,
      dailyActionBoard: false,
      scenarioSimulator: false,
      marginAtRisk: false,
    },
  },
  summary: {
    recommendationCount: 0,
    profitOpportunityCount: 0,
    responseMode: "Monitor",
    automationReadiness: "Pricing and profit signals are syncing.",
    fullProfitEngine: false,
  },
  pricingRecommendations: [],
  profitOpportunities: [],
  dailyActionBoard: [],
  scenarioPreset: null,
  marginAtRisk: {
    pressureProducts: [],
    projectedMonthlyGain: 0,
  },
  pricingModes: [],
  doNothingRecommendation: null,
  profitLeakSummary: [],
  scenarioPlaybook: [],
};

const PRICING_PROFIT_CACHE_KEY = "pricing-profit-overview";

export function PricingProfitPage() {
  const [searchParams] = useSearchParams();
  const { subscription } = useSubscriptionPlan();
  const { navigateEmbedded } = useEmbeddedNavigation();
  const cachedOverview = readModuleCache<PricingProfitOverview>(PRICING_PROFIT_CACHE_KEY);
  const [overview, setOverview] = useState<PricingProfitOverview>(
    cachedOverview ?? fallbackOverview
  );
  const [loading, setLoading] = useState(!cachedOverview);
  const [syncIssue, setSyncIssue] = useState(false);
  const allowed = !!subscription?.enabledModules.pricingProfit;
  const focus = searchParams.get("focus");
  const showingProfitFocus = focus === "profit";

  useEffect(() => {
    if (!allowed) {
      setLoading(false);
      setSyncIssue(false);
      setOverview(cachedOverview ?? fallbackOverview);
      return;
    }

    let mounted = true;
    setLoading(true);
    setSyncIssue(false);

    embeddedShopRequest<{ overview: PricingProfitOverview }>(
      "/api/pricing-profit/overview",
      { timeoutMs: 12000 }
    )
      .then((res) => {
        if (!mounted) return;
        const nextOverview = {
          ...fallbackOverview,
          ...res.overview,
          summary: {
            ...fallbackOverview.summary,
            ...res.overview.summary,
          },
          marginAtRisk: {
            ...fallbackOverview.marginAtRisk,
            ...res.overview.marginAtRisk,
          },
        };
        setOverview(nextOverview);
        writeModuleCache(PRICING_PROFIT_CACHE_KEY, nextOverview);
      })
      .catch(() => {
        if (!mounted) return;
        setOverview((current) =>
          current.pricingRecommendations.length > 0 ||
          current.profitOpportunities.length > 0 ||
          current.dailyActionBoard.length > 0
            ? current
            : fallbackOverview
        );
        setSyncIssue(true);
      })
      .finally(() => {
        if (!mounted) return;
        setLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, [allowed, cachedOverview]);

  if (!allowed) {
    return (
      <Page
        title="Pricing & Profit Engine"
        subtitle="One decision engine for pricing, profit protection, simulations, and daily margin actions."
      >
        <Layout>
          <Layout.Section>
            <Banner title="Upgrade required: Growth or Pro" tone="info">
              <p>
                Pricing & Profit Engine unlocks on Growth and expands fully on Pro.
              </p>
            </Banner>
          </Layout.Section>
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <Text as="h3" variant="headingMd">
                  What you get when this module is active
                </Text>
                <List type="bullet">
                  <List.Item>Explainable pricing recommendations</List.Item>
                  <List.Item>Daily action board and scenario simulator</List.Item>
                  <List.Item>Margin-at-risk and profit leak detection</List.Item>
                  <List.Item>Competitor-informed pricing response playbooks</List.Item>
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
      title={showingProfitFocus ? "AI Profit Optimization Engine" : "Pricing & Profit Engine"}
      subtitle={
        showingProfitFocus
          ? "Optimize discounting, bundling, and margin protection with profit-aware decision support."
          : "Combines pricing recommendations, profit protection, market response, and daily action guidance."
      }
    >
      <Layout>
        {loading ? (
          <Layout.Section>
            <Banner
              title={
                showingProfitFocus
                  ? "Refreshing profit intelligence"
                  : "Refreshing pricing and profit signals"
              }
              tone="info"
            >
              <p>
                VedaSuite is refreshing pricing and profit signals in the background. You can stay
                on this page while the latest recommendations load.
              </p>
            </Banner>
          </Layout.Section>
        ) : null}
        {syncIssue ? (
          <Layout.Section>
            <Banner title="Using fallback pricing and profit view" tone="warning">
              <p>
                Live pricing or profit signals are still syncing. You can still review this module
                while VedaSuite retries in the background.
              </p>
            </Banner>
          </Layout.Section>
        ) : null}
        <Layout.Section>
          <InlineGrid columns={{ xs: 1, md: 4 }} gap="400">
            <Card>
              <BlockStack gap="200">
                <Text as="h3" variant="headingMd">Pricing actions</Text>
                <Text as="p" variant="heading2xl">{overview.summary.recommendationCount}</Text>
              </BlockStack>
            </Card>
            <Card>
              <BlockStack gap="200">
                <Text as="h3" variant="headingMd">Profit opportunities</Text>
                <Text as="p" variant="heading2xl">{overview.summary.profitOpportunityCount}</Text>
              </BlockStack>
            </Card>
            <Card>
              <BlockStack gap="200">
                <Text as="h3" variant="headingMd">Response mode</Text>
                <Text as="p" variant="headingMd">{overview.summary.responseMode}</Text>
              </BlockStack>
            </Card>
            <Card>
              <BlockStack gap="200">
                <Text as="h3" variant="headingMd">Projected gain</Text>
                <Text as="p" variant="heading2xl">${overview.marginAtRisk.projectedMonthlyGain}</Text>
              </BlockStack>
            </Card>
          </InlineGrid>
        </Layout.Section>
        <Layout.Section>
          {!overview.summary.fullProfitEngine ? (
            <Banner title="Growth plan: pricing intelligence is active" tone="warning">
              <p>
                Growth includes pricing recommendations and scenario guidance. Upgrade to Pro to unlock
                full profit leak detection and the advanced profit engine.
              </p>
            </Banner>
          ) : (
            <Banner title="Pro automation posture" tone="info">
              <p>{overview.summary.automationReadiness}</p>
            </Banner>
          )}
        </Layout.Section>
        {!showingProfitFocus ? (
          <Layout.Section>
          <InlineGrid columns={{ xs: 1, md: 3 }} gap="400">
            <Card>
              <BlockStack gap="300">
                <Text as="h3" variant="headingMd">Pricing mode selector</Text>
                {(overview.pricingModes ?? []).length === 0 ? (
                  <Text as="p" tone="subdued">
                    Pricing modes will appear after the pricing engine evaluates current store posture.
                  </Text>
                ) : (
                  (overview.pricingModes ?? []).map((mode) => (
                    <div key={mode.key} className="vs-action-card">
                      <InlineGrid columns={{ xs: 1, sm: 2 }} gap="200">
                        <BlockStack gap="100">
                          <Text as="p" variant="headingSm">{mode.label}</Text>
                          <Text as="p" tone="subdued">{mode.description}</Text>
                        </BlockStack>
                        <InlineStack align="end">
                          <Badge tone={mode.recommended ? "success" : "info"}>
                            {mode.recommended ? "Recommended" : "Available"}
                          </Badge>
                        </InlineStack>
                      </InlineGrid>
                    </div>
                  ))
                )}
              </BlockStack>
            </Card>
            <Card>
              <BlockStack gap="300">
                <Text as="h3" variant="headingMd">Profit leak detector</Text>
                {(overview.profitLeakSummary ?? []).length === 0 ? (
                  <Text as="p" tone="subdued">
                    Profit leak signals will appear once pricing, competitor, and order histories are ready.
                  </Text>
                ) : (
                  (overview.profitLeakSummary ?? []).map((item) => (
                    <div key={item.title} className="vs-action-card">
                      <Text as="p" variant="headingSm">{item.title}</Text>
                      <Text as="p" tone="subdued">{item.detail}</Text>
                    </div>
                  ))
                )}
              </BlockStack>
            </Card>
            <Card>
              <BlockStack gap="300">
                <Text as="h3" variant="headingMd">Do-nothing guidance</Text>
                {overview.doNothingRecommendation ? (
                  <>
                    <Badge tone="info">{overview.doNothingRecommendation.headline}</Badge>
                    <Text as="p" tone="subdued">
                      {overview.doNothingRecommendation.rationale}
                    </Text>
                  </>
                ) : (
                  <Text as="p" tone="subdued">
                    VedaSuite will explicitly tell the merchant when no price change is the better move.
                  </Text>
                )}
              </BlockStack>
            </Card>
          </InlineGrid>
          </Layout.Section>
        ) : null}
        {!showingProfitFocus ? (
          <Layout.Section>
          <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
            <Card>
              <BlockStack gap="300">
                <Text as="h3" variant="headingMd">Daily action board</Text>
                {overview.dailyActionBoard.length === 0 ? (
                  <Text as="p" tone="subdued">
                    Daily action items will appear once pricing, competitor, and order history has been synced for this store.
                  </Text>
                ) : (
                  overview.dailyActionBoard.map((item) => (
                    <div key={item.id} className="vs-action-card">
                      <Text as="p" variant="headingSm">{item.title}</Text>
                      <Text as="p" tone="subdued">{item.detail}</Text>
                      <Badge tone="info">{item.actionType}</Badge>
                    </div>
                  ))
                )}
              </BlockStack>
            </Card>
            <Card>
              <BlockStack gap="300">
                <Text as="h3" variant="headingMd">Scenario simulator</Text>
                {overview.scenarioPreset ? (
                  <>
                    <Text as="p" tone="subdued">
                      Projected monthly profit gain: ${Math.round(overview.scenarioPreset.projectedMonthlyProfitGain)}
                    </Text>
                    <Text as="p" tone="subdued">
                      Margin improvement: {overview.scenarioPreset.expectedMarginImprovement.toFixed(1)}%
                    </Text>
                    <Text as="p" tone="subdued">
                      {overview.scenarioPreset.automationPosture}
                    </Text>
                  </>
                ) : (
                  <Text as="p" tone="subdued">
                    Scenario presets will populate after enough pricing history and competitive pressure data is available.
                  </Text>
                )}
                {(overview.scenarioPlaybook ?? []).length > 0 ? (
                  <List type="bullet">
                    {(overview.scenarioPlaybook ?? []).map((scenario) => (
                      <List.Item key={scenario.scenario}>
                        <strong>{scenario.scenario}</strong>: {scenario.outcome}
                      </List.Item>
                    ))}
                  </List>
                ) : null}
              </BlockStack>
            </Card>
          </InlineGrid>
          </Layout.Section>
        ) : null}
        <Layout.Section>
          <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
            <Card>
              <BlockStack gap="300">
                <Text as="h3" variant="headingMd">
                  {showingProfitFocus ? "Profit actions" : "Pricing recommendations"}
                </Text>
                {overview.pricingRecommendations.length === 0 ? (
                  <Text as="p" tone="subdued">
                    Pricing recommendations will appear after order, competitor, and product-level signals accumulate.
                  </Text>
                ) : (
                  overview.pricingRecommendations.map((recommendation) => (
                    <div key={recommendation.id} className="vs-action-card">
                      <Text as="p" variant="headingSm">{recommendation.productHandle}</Text>
                      <Text as="p" tone="subdued">
                        ${recommendation.currentPrice} -&gt; ${recommendation.recommendedPrice}
                      </Text>
                      <Text as="p" tone="subdued">{recommendation.automationPosture}</Text>
                      <List type="bullet">
                        {recommendation.demandSignals.slice(0, 2).map((signal) => (
                          <List.Item key={`${recommendation.id}-${signal}`}>{signal}</List.Item>
                        ))}
                      </List>
                    </div>
                  ))
                )}
              </BlockStack>
            </Card>
            <Card>
              <BlockStack gap="300">
                <Text as="h3" variant="headingMd">
                  {showingProfitFocus ? "Profit engine and margin-at-risk" : "Profit engine and margin-at-risk"}
                </Text>
                {overview.profitOpportunities.length > 0 ? (
                  overview.profitOpportunities.map((item) => (
                    <div key={item.productHandle} className="vs-action-card">
                      <Text as="p" variant="headingSm">{item.productHandle}</Text>
                      <Text as="p" tone="subdued">
                        Projected monthly gain: ${Math.round(item.projectedMonthlyProfitGain ?? 0)}
                      </Text>
                    </div>
                  ))
                ) : (
                  <Text as="p" tone="subdued">
                    The full profit engine is either still warming up or there is not yet enough product margin history for recommendations.
                  </Text>
                )}
                <List type="bullet">
                  {overview.marginAtRisk.pressureProducts.map((item) => (
                    <List.Item key={item.productHandle}>
                      {item.productHandle}: pressure score {item.pressureScore}
                    </List.Item>
                  ))}
                </List>
              </BlockStack>
            </Card>
          </InlineGrid>
        </Layout.Section>
        {showingProfitFocus ? (
          <Layout.Section>
            <InlineGrid columns={{ xs: 1, md: 3 }} gap="400">
              <Card>
                <BlockStack gap="200">
                  <Text as="h3" variant="headingMd">
                    Active opportunities
                  </Text>
                  <Text as="p" variant="heading2xl">
                    {overview.profitOpportunities.length}
                  </Text>
                </BlockStack>
              </Card>
              <Card>
                <BlockStack gap="200">
                  <Text as="h3" variant="headingMd">
                    Projected monthly gain
                  </Text>
                  <Text as="p" variant="heading2xl">
                    ${Math.round(overview.marginAtRisk.projectedMonthlyGain)}
                  </Text>
                </BlockStack>
              </Card>
              <Card>
                <BlockStack gap="200">
                  <Text as="h3" variant="headingMd">
                    Average margin lift
                  </Text>
                  <Text as="p" variant="heading2xl">
                    {overview.scenarioPreset
                      ? `${overview.scenarioPreset.expectedMarginImprovement.toFixed(1)}%`
                      : "0.0%"}
                  </Text>
                </BlockStack>
              </Card>
            </InlineGrid>
          </Layout.Section>
        ) : null}
      </Layout>
    </Page>
  );
}

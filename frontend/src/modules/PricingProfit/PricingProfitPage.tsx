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
    capabilities: Record<string, boolean>;
    featureAccess: {
      fullProfitEngine: boolean;
      dailyActionBoard: boolean;
      scenarioSimulator: boolean;
      marginAtRisk: boolean;
    };
  };
  readiness?: {
    readinessState: string;
    reason: string;
    processingState?: string;
    lastUpdatedAt?: string | null;
  };
  summary: {
    recommendationCount: number;
    profitOpportunityCount: number;
    responseMode: string;
    automationReadiness: string;
    fullProfitEngine: boolean;
    advancedModesEnabled?: boolean;
    scenarioSimulatorEnabled?: boolean;
    marginAtRiskEnabled?: boolean;
    profitLeakDetectorEnabled?: boolean;
    explainableRecommendationsEnabled?: boolean;
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
    priority?: string;
    expectedImpact?: string;
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
    summary?: string;
  };
  pricingModes?: Array<{
    key: string;
    label: string;
    description: string;
    available?: boolean;
    gate?: string;
    recommended?: boolean;
  }>;
  doNothingRecommendation?: {
    headline: string;
    rationale: string;
  } | null;
  profitLeakSummary?: Array<{
    title: string;
    detail: string;
    severity?: string;
    action?: string;
  }>;
  scenarioPlaybook?: Array<{
    scenario: string;
    outcome: string;
  }>;
  explainabilityHighlights?: Array<{
    id: string;
    productHandle: string;
    recommendation: string;
    why: string;
    factors: string[];
    guardrail: string;
  }>;
  simulatorSnapshots?: Array<{
    id: string;
    title: string;
    summary: string;
    projectedMonthlyProfitGain: number;
    expectedMarginImprovement: number;
    actionQueue: string;
  }>;
  marginRiskDrivers?: Array<{
    title: string;
    detail: string;
    severity: string;
  }>;
};

const fallbackOverview: PricingProfitOverview = {
  subscription: {
    capabilities: {},
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
    automationReadiness: "Awaiting synced pricing and profit data.",
    fullProfitEngine: false,
    advancedModesEnabled: false,
    scenarioSimulatorEnabled: false,
    marginAtRiskEnabled: false,
    profitLeakDetectorEnabled: false,
    explainableRecommendationsEnabled: false,
  },
  pricingRecommendations: [],
  profitOpportunities: [],
  dailyActionBoard: [],
  scenarioPreset: null,
  marginAtRisk: {
    pressureProducts: [],
    projectedMonthlyGain: 0,
    summary: "No live margin pressure drivers are active yet.",
  },
  pricingModes: [],
  doNothingRecommendation: null,
  profitLeakSummary: [],
  scenarioPlaybook: [],
  explainabilityHighlights: [],
  simulatorSnapshots: [],
  marginRiskDrivers: [],
};

const PRICING_PROFIT_CACHE_KEY = "pricing-profit-overview";

function toneForSeverity(value?: string) {
  const normalized = (value ?? "").toLowerCase();
  if (normalized.includes("high")) return "critical";
  if (normalized.includes("medium")) return "attention";
  return "success";
}

function toneForPriority(value?: string) {
  const normalized = (value ?? "").toLowerCase();
  if (normalized.includes("high")) return "critical";
  if (normalized.includes("medium")) return "attention";
  return "info";
}

function EmptyState({ text }: { text: string }) {
  return (
    <Text as="p" tone="subdued">
      {text}
    </Text>
  );
}

export function PricingProfitPage() {
  const [searchParams] = useSearchParams();
  const { subscription } = useSubscriptionPlan();
  const { navigateEmbedded } = useEmbeddedNavigation();
  const cachedOverview = readModuleCache<PricingProfitOverview>(
    PRICING_PROFIT_CACHE_KEY
  );
  const [overview, setOverview] = useState<PricingProfitOverview>(
    cachedOverview ?? fallbackOverview
  );
  const [loading, setLoading] = useState(!cachedOverview);
  const [syncIssue, setSyncIssue] = useState(false);
  const allowed = !!subscription?.enabledModules?.pricingProfit;
  const focus = searchParams.get("focus");
  const showingProfitFocus = focus === "profit";

  const hasAdvancedModes =
    overview.summary.advancedModesEnabled ||
    !!overview.subscription.capabilities["pricing.advancedModes"];
  const hasScenarioSimulator =
    overview.summary.scenarioSimulatorEnabled ||
    !!overview.subscription.capabilities["pricing.scenarioSimulator"];
  const hasMarginAtRisk =
    overview.summary.marginAtRiskEnabled ||
    !!overview.subscription.capabilities["pricing.marginAtRisk"];
  const hasProfitLeakDetector =
    overview.summary.profitLeakDetectorEnabled ||
    !!overview.subscription.capabilities["pricing.profitLeakDetector"];
  const hasExplainableRecommendations =
    overview.summary.explainableRecommendationsEnabled ||
    !!overview.subscription.capabilities["pricing.explainableRecommendations"];
  const hasDailyActionBoard =
    overview.subscription.featureAccess.dailyActionBoard ||
    !!overview.subscription.capabilities["pricing.dailyActionBoard"];

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
      { timeoutMs: 15000 }
    )
      .then((res) => {
        if (!mounted) return;
        const nextOverview: PricingProfitOverview = {
          ...fallbackOverview,
          ...res.overview,
          subscription: {
            ...fallbackOverview.subscription,
            ...res.overview.subscription,
            capabilities: {
              ...fallbackOverview.subscription.capabilities,
              ...res.overview.subscription?.capabilities,
            },
            featureAccess: {
              ...fallbackOverview.subscription.featureAccess,
              ...res.overview.subscription?.featureAccess,
            },
          },
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
          current.dailyActionBoard.length > 0 ||
          (current.explainabilityHighlights ?? []).length > 0
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
                Pricing &amp; Profit Engine unlocks on Growth and expands fully on
                Pro.
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
                  <List.Item>Pricing mode selector and explainable recommendations</List.Item>
                  <List.Item>Daily action board and scenario simulator</List.Item>
                  <List.Item>Margin-at-risk and profit leak detection</List.Item>
                  <List.Item>Competitor-informed pricing response playbooks</List.Item>
                </List>
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

  return (
    <Page
      title={showingProfitFocus ? "AI Profit Optimization Engine" : "Pricing & Profit Engine"}
      subtitle={
        showingProfitFocus
          ? "Optimize pricing, discounting, and bundle strategy with explainable profit decision support."
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
                VedaSuite is refreshing pricing, competitor, and profit signals in
                the background.
              </p>
            </Banner>
          </Layout.Section>
        ) : null}
        {syncIssue || overview.readiness?.readinessState !== "READY_WITH_DATA" ? (
          <Layout.Section>
            <Banner
              title={
                overview.readiness?.readinessState === "FAILED"
                  ? "Pricing & profit processing needs attention"
                  : overview.readiness?.readinessState === "EMPTY_STORE_DATA"
                  ? "No store data available for pricing & profit yet"
                  : overview.readiness?.readinessState === "SYNC_COMPLETED_PROCESSING_PENDING"
                  ? "Pricing & profit processing is catching up"
                  : "Pricing & profit data is still syncing"
              }
              tone={overview.readiness?.readinessState === "FAILED" ? "critical" : "warning"}
            >
              <p>
                {overview.readiness?.reason ??
                  "VedaSuite will populate pricing and profit outputs after live sync and processing complete."}
              </p>
            </Banner>
          </Layout.Section>
        ) : null}

        <Layout.Section>
          <InlineGrid columns={{ xs: 1, md: 4 }} gap="400">
            <Card>
              <BlockStack gap="200">
                <Text as="h3" variant="headingMd">
                  Pricing actions
                </Text>
                <Text as="p" variant="heading2xl">
                  {overview.summary.recommendationCount}
                </Text>
              </BlockStack>
            </Card>
            <Card>
              <BlockStack gap="200">
                <Text as="h3" variant="headingMd">
                  Profit opportunities
                </Text>
                <Text as="p" variant="heading2xl">
                  {overview.summary.profitOpportunityCount}
                </Text>
              </BlockStack>
            </Card>
            <Card>
              <BlockStack gap="200">
                <Text as="h3" variant="headingMd">
                  Response mode
                </Text>
                <Text as="p" variant="headingMd">
                  {overview.summary.responseMode}
                </Text>
              </BlockStack>
            </Card>
            <Card>
              <BlockStack gap="200">
                <Text as="h3" variant="headingMd">
                  Projected gain
                </Text>
                <Text as="p" variant="heading2xl">
                  ${Math.round(overview.marginAtRisk.projectedMonthlyGain)}
                </Text>
              </BlockStack>
            </Card>
          </InlineGrid>
        </Layout.Section>

        <Layout.Section>
          {overview.summary.fullProfitEngine ? (
            <Banner title="Pro automation posture" tone="success">
              <p>{overview.summary.automationReadiness}</p>
            </Banner>
          ) : (
            <Banner title="Growth plan: pricing intelligence is active" tone="warning">
              <p>
                Growth includes pricing recommendations and basic scenario
                guidance. Upgrade to Pro to unlock the full profit engine,
                advanced pricing modes, and proactive margin protection.
              </p>
            </Banner>
          )}
        </Layout.Section>

        {!showingProfitFocus ? (
          <Layout.Section>
            <InlineGrid columns={{ xs: 1, md: 3 }} gap="400">
              <Card>
                <BlockStack gap="300">
                  <Text as="h3" variant="headingMd">
                    Pricing mode selector
                  </Text>
                  {(overview.pricingModes ?? []).length === 0 ? (
                    <EmptyState text="No pricing modes can be recommended yet because VedaSuite is still waiting for live pricing and profit signals." />
                  ) : (
                    (overview.pricingModes ?? []).map((mode) => (
                      <div key={mode.key} className="vs-action-card">
                        <InlineStack align="space-between" blockAlign="start">
                          <BlockStack gap="100">
                            <Text as="p" variant="headingSm">
                              {mode.label}
                            </Text>
                            <Text as="p" tone="subdued">
                              {mode.description}
                            </Text>
                          </BlockStack>
                          <Badge
                            tone={
                              mode.available
                                ? mode.recommended
                                  ? "success"
                                  : "info"
                                : "warning"
                            }
                          >
                            {mode.available
                              ? mode.recommended
                                ? "Recommended"
                                : "Available"
                              : mode.gate ?? "Pro"}
                          </Badge>
                        </InlineStack>
                      </div>
                    ))
                  )}
                  {!hasAdvancedModes ? (
                    <Banner title="Advanced pricing modes unlock on Pro" tone="warning">
                      <p>
                        Balanced guidance is available now. Profit-first,
                        market-defense, inventory-clearance, and premium
                        positioning modes become fully configurable on Pro.
                      </p>
                    </Banner>
                  ) : null}
                </BlockStack>
              </Card>

              <Card>
                <BlockStack gap="300">
                  <Text as="h3" variant="headingMd">
                    Profit leak detector
                  </Text>
                  {(overview.profitLeakSummary ?? []).length === 0 ? (
                    <EmptyState text="No profit leak has been identified yet, or the engine is still waiting for enough synced unit-economics data." />
                  ) : (
                    (overview.profitLeakSummary ?? []).map((item) => (
                      <div key={item.title} className="vs-action-card">
                        <InlineStack align="space-between" blockAlign="start">
                          <BlockStack gap="100">
                            <Text as="p" variant="headingSm">
                              {item.title}
                            </Text>
                            <Text as="p" tone="subdued">
                              {item.detail}
                            </Text>
                            {item.action ? (
                              <Text as="p" variant="bodySm">
                                {item.action}
                              </Text>
                            ) : null}
                          </BlockStack>
                          {item.severity ? (
                            <Badge tone={toneForSeverity(item.severity)}>
                              {item.severity}
                            </Badge>
                          ) : null}
                        </InlineStack>
                      </div>
                    ))
                  )}
                  {!hasProfitLeakDetector ? (
                    <Banner title="Growth plan preview" tone="info">
                      <p>
                        Growth can review pricing posture and basic margin pressure.
                        Full profit leak detection becomes actionable on Pro.
                      </p>
                    </Banner>
                  ) : null}
                </BlockStack>
              </Card>

              <Card>
                <BlockStack gap="300">
                  <Text as="h3" variant="headingMd">
                    Do-nothing recommendation
                  </Text>
                  {overview.doNothingRecommendation ? (
                    <>
                      <Badge tone="info">
                        {overview.doNothingRecommendation.headline}
                      </Badge>
                      <Text as="p" tone="subdued">
                        {overview.doNothingRecommendation.rationale}
                      </Text>
                    </>
                  ) : (
                    <EmptyState text="VedaSuite will explicitly tell the merchant when holding price is the smartest move." />
                  )}
                  <Text as="p" variant="bodySm" tone="subdued">
                    The engine should not force a price move when pressure is
                    temporary or the projected lift is too weak.
                  </Text>
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
                  Explainable recommendations
                </Text>
                {(overview.explainabilityHighlights ?? []).length === 0 ? (
                    <EmptyState text="No explainable pricing recommendation is available yet because the engine does not have enough live inputs." />
                ) : (
                  (overview.explainabilityHighlights ?? []).map((item) => (
                    <div key={item.id} className="vs-action-card">
                      <BlockStack gap="100">
                        <InlineStack align="space-between" blockAlign="start">
                          <BlockStack gap="100">
                            <Text as="p" variant="headingSm">
                              {item.productHandle}
                            </Text>
                            <Text as="p" tone="subdued">
                              {item.why}
                            </Text>
                          </BlockStack>
                          <Badge tone="success">{item.recommendation}</Badge>
                        </InlineStack>
                        <List type="bullet">
                          {item.factors.map((factor) => (
                            <List.Item key={`${item.id}-${factor}`}>
                              {factor}
                            </List.Item>
                          ))}
                        </List>
                        <Text as="p" variant="bodySm">
                          {item.guardrail}
                        </Text>
                      </BlockStack>
                    </div>
                  ))
                )}
                {!hasExplainableRecommendations ? (
                  <Banner title="Explainability is limited on this plan" tone="warning">
                    <p>
                      Upgrade to Growth or Pro to get full pricing rationale,
                      factor breakdowns, and merchant-ready approval context.
                    </p>
                  </Banner>
                ) : null}
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h3" variant="headingMd">
                  Margin-at-risk analysis
                </Text>
                <Text as="p" tone="subdued">
                  {overview.marginAtRisk.summary}
                </Text>
                {(overview.marginRiskDrivers ?? []).length === 0 ? (
                    <EmptyState text="No live margin-risk drivers are active yet." />
                ) : (
                  (overview.marginRiskDrivers ?? []).map((driver) => (
                    <div key={driver.title} className="vs-action-card">
                      <InlineStack align="space-between" blockAlign="start">
                        <BlockStack gap="100">
                          <Text as="p" variant="headingSm">
                            {driver.title}
                          </Text>
                          <Text as="p" tone="subdued">
                            {driver.detail}
                          </Text>
                        </BlockStack>
                        <Badge tone={toneForSeverity(driver.severity)}>
                          {driver.severity}
                        </Badge>
                      </InlineStack>
                    </div>
                  ))
                )}
                {!hasMarginAtRisk ? (
                  <Banner title="Advanced margin defense unlocks on Pro" tone="warning">
                    <p>
                      Growth can see baseline pricing posture. Pro unlocks full
                      margin-at-risk diagnostics and proactive protection
                      workflows.
                    </p>
                  </Banner>
                ) : null}
              </BlockStack>
            </Card>
          </InlineGrid>
        </Layout.Section>

        <Layout.Section>
          <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
            <Card>
              <BlockStack gap="300">
                <Text as="h3" variant="headingMd">
                  {showingProfitFocus ? "Profit actions" : "Pricing recommendations"}
                </Text>
                {overview.pricingRecommendations.length === 0 ? (
                  <EmptyState text="No live pricing recommendation is available yet. Sync orders, products, and competitor data to generate actions." />
                ) : (
                  overview.pricingRecommendations.map((recommendation) => (
                    <div key={recommendation.id} className="vs-action-card">
                      <Text as="p" variant="headingSm">
                        {recommendation.productHandle}
                      </Text>
                      <Text as="p" tone="subdued">
                        ${recommendation.currentPrice} -&gt; $
                        {recommendation.recommendedPrice}
                      </Text>
                      <Text as="p" tone="subdued">
                        {recommendation.automationPosture}
                      </Text>
                      <List type="bullet">
                        {recommendation.demandSignals.slice(0, 3).map((signal) => (
                          <List.Item key={`${recommendation.id}-${signal}`}>
                            {signal}
                          </List.Item>
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
                  Profit engine and margin-at-risk
                </Text>
                {overview.profitOpportunities.length > 0 ? (
                  overview.profitOpportunities.map((item) => (
                    <div key={item.productHandle} className="vs-action-card">
                      <Text as="p" variant="headingSm">
                        {item.productHandle}
                      </Text>
                      <Text as="p" tone="subdued">
                        Projected monthly gain: $
                        {Math.round(item.projectedMonthlyProfitGain ?? 0)}
                      </Text>
                      <Text as="p" variant="bodySm">
                        {item.recommendedPrice != null
                          ? `Suggested price ${item.recommendedPrice}`
                          : "Waiting for a stronger pricing target."}
                      </Text>
                    </div>
                  ))
                ) : (
                  <EmptyState text="No live profit opportunity is available yet. Profit outputs appear after synced pricing, cost, and order data are available." />
                )}
                <List type="bullet">
                  {overview.marginAtRisk.pressureProducts.map((item) => (
                    <List.Item key={item.productHandle}>
                      {item.productHandle}: pressure score {item.pressureScore} -{" "}
                      {item.rationale}
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

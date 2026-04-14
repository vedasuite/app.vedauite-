import {
  Badge,
  Banner,
  BlockStack,
  Button,
  Card,
  InlineGrid,
  InlineStack,
  Layout,
  Page,
  Text,
} from "@shopify/polaris";
import { useEffect, useRef, useState } from "react";
import { useEmbeddedNavigation } from "../../hooks/useEmbeddedNavigation";
import { useSubscriptionPlan } from "../../hooks/useSubscriptionPlan";
import { embeddedShopRequest } from "../../lib/embeddedShopRequest";
import { readModuleCache, writeModuleCache } from "../../lib/moduleCache";

type PricingPrimaryState =
  | "SETUP_INCOMPLETE"
  | "PARTIAL_READINESS"
  | "READY"
  | "EMPTY_HEALTHY"
  | "PROCESSING"
  | "FAILED";

type PricingProfitOverview = {
  subscription: {
    capabilities: Record<string, boolean>;
    enabledModules?: Record<string, boolean>;
  };
  moduleState?: {
    dataStatus: string;
    title: string;
    description: string;
    nextAction?: string | null;
  };
  pricingState?: {
    primaryState: PricingPrimaryState;
    pricingStatus: string;
    competitorDependency: string;
    profitModelStatus: string;
    recommendationCount: number;
    prioritizedRecommendationCount: number;
    projectedGainStatus: "available" | "estimated_baseline" | "not_available";
    projectedGainValue: number;
    responseMode: "baseline_only" | "competitor_informed" | "margin_protection" | "mixed";
    lastSuccessfulRunAt?: string | null;
    title: string;
    description: string;
    nextAction?: string | null;
  };
  summary: {
    recommendationCount: number;
    profitOpportunityCount: number;
    responseMode: string;
  };
  prioritizedRecommendations?: Array<{
    id: string;
    rank: number;
    productHandle: string;
    currentPrice: number;
    recommendedPrice: number;
    recommendationType: string;
    expectedImpact: string;
    confidence: string;
    confidenceScore: number;
    dataBasis: string;
    why: string;
    support: string;
    inputsUsed: string[];
    merchantActionNote: string;
  }>;
  diagnosticSummary?: Array<{
    title: string;
    detail: string;
    status: string;
  }>;
  pricingModes?: Array<{
    key: string;
    label: string;
    description: string;
    available?: boolean;
    gate?: string;
    recommended?: boolean;
  }>;
  planGateSummary?: Array<{
    title: string;
    detail: string;
  }>;
};

const CACHE_KEY = "pricing-profit-overview";
const MIN_LOADING_MS = 400;

type CanonicalPricingViewState = {
  status: "idle" | "loading" | "ready" | "empty" | "error";
  lastUpdatedAt: string | null;
  hasRecommendations: boolean;
  hasProfitData: boolean;
};

function createEmptyOverview(): PricingProfitOverview {
  return {
    subscription: {
      capabilities: {},
      enabledModules: {},
    },
    moduleState: {
      dataStatus: "empty",
      title: "Pricing setup is incomplete",
      description: "Run the first live sync to populate pricing and profit outputs.",
      nextAction: "Run live sync",
    },
    pricingState: {
      primaryState: "SETUP_INCOMPLETE",
      pricingStatus: "empty",
      competitorDependency: "missing",
      profitModelStatus: "missing",
      recommendationCount: 0,
      prioritizedRecommendationCount: 0,
      projectedGainStatus: "not_available",
      projectedGainValue: 0,
      responseMode: "baseline_only",
      lastSuccessfulRunAt: null,
      title: "Pricing setup is incomplete",
      description: "Run the first live sync to populate pricing and profit outputs.",
      nextAction: "Run live sync",
    },
    summary: {
      recommendationCount: 0,
      profitOpportunityCount: 0,
      responseMode: "Baseline recommendations active",
    },
    prioritizedRecommendations: [],
    diagnosticSummary: [],
    pricingModes: [],
    planGateSummary: [],
  };
}

function formatDateTime(value?: string | null) {
  if (!value) return "Not available";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function toneForPrimaryState(state: PricingPrimaryState) {
  switch (state) {
    case "READY":
      return "success" as const;
    case "FAILED":
      return "critical" as const;
    case "PARTIAL_READINESS":
      return "warning" as const;
    default:
      return "info" as const;
  }
}

function toneForDiagnostic(status: string) {
  if (status === "ready") return "success";
  if (status === "partial") return "attention";
  if (status === "empty") return "info";
  return "subdued";
}

function gainLabel(overview: PricingProfitOverview) {
  const state = overview.pricingState!;
  if (state.projectedGainStatus === "available") return "Projected gain";
  if (state.projectedGainStatus === "estimated_baseline") return "Estimated gain";
  return "Projected gain";
}

function deriveCanonicalPricingState(
  overview: PricingProfitOverview
): CanonicalPricingViewState {
  const hasRecommendations = (overview.prioritizedRecommendations?.length ?? 0) > 0;
  const hasProfitData = (overview.summary.profitOpportunityCount ?? 0) > 0;
  const lastUpdatedAt = overview.pricingState?.lastSuccessfulRunAt ?? null;

  if (hasRecommendations || hasProfitData) {
    return {
      status: "ready",
      lastUpdatedAt,
      hasRecommendations,
      hasProfitData,
    };
  }

  return {
    status: "empty",
    lastUpdatedAt,
    hasRecommendations: false,
    hasProfitData: false,
  };
}

function StatusBanner(props: {
  status: CanonicalPricingViewState["status"];
  overview: PricingProfitOverview;
}) {
  const pricingState = props.overview.pricingState ?? createEmptyOverview().pricingState!;

  switch (props.status) {
    case "loading":
      return (
        <Banner title="Loading pricing engine" tone="info">
          <p>VedaSuite is loading the latest pricing recommendations and profit guidance.</p>
        </Banner>
      );
    case "ready":
      return (
        <Banner title={pricingState.title} tone="success">
          <p>{pricingState.description}</p>
        </Banner>
      );
    case "empty":
      return (
        <Banner title="No pricing changes recommended right now" tone="info">
          <p>
            {pricingState.primaryState === "EMPTY_HEALTHY"
              ? "The pricing engine ran successfully, but no important pricing changes are recommended right now."
              : pricingState.description}
          </p>
        </Banner>
      );
    case "error":
      return (
        <Banner title="Pricing engine could not be loaded" tone="critical">
          <p>VedaSuite could not load the latest pricing data. Try refreshing again.</p>
        </Banner>
      );
    case "idle":
    default:
      return (
        <Banner title="Pricing engine is idle" tone="info">
          <p>{pricingState.description}</p>
        </Banner>
      );
  }
}

export function PricingProfitPage() {
  const { navigateEmbedded } = useEmbeddedNavigation();
  const { subscription } = useSubscriptionPlan();
  const cachedOverview = readModuleCache<PricingProfitOverview>(CACHE_KEY);
  const initialOverviewRef = useRef<PricingProfitOverview>(
    cachedOverview ?? createEmptyOverview()
  );
  const initialOverview = initialOverviewRef.current;
  const [overview, setOverview] = useState<PricingProfitOverview>(
    initialOverview
  );
  const [pageState, setPageState] = useState<CanonicalPricingViewState>(
    cachedOverview
      ? deriveCanonicalPricingState(initialOverview)
      : {
          status: "loading",
          lastUpdatedAt: null,
          hasRecommendations: false,
          hasProfitData: false,
        }
  );
  const requestIdRef = useRef(0);
  const allowed = !!subscription?.enabledModules?.pricingProfit;

  const loadOverview = async () => {
    const requestId = ++requestIdRef.current;
    const startedAt = Date.now();
    setPageState((current) => ({
      ...current,
      status: "loading",
    }));

    const response = await embeddedShopRequest<{ overview: PricingProfitOverview }>(
      "/api/pricing-profit/overview",
      { timeoutMs: 15000 }
    );
    const elapsed = Date.now() - startedAt;
    const remainingDelay = Math.max(0, MIN_LOADING_MS - elapsed);
    if (remainingDelay > 0) {
      await new Promise((resolve) => setTimeout(resolve, remainingDelay));
    }
    if (requestId !== requestIdRef.current) {
      return;
    }
    setOverview(response.overview);
    writeModuleCache(CACHE_KEY, response.overview);
    setPageState(deriveCanonicalPricingState(response.overview));
  };

  useEffect(() => {
    if (!allowed) {
      setOverview(initialOverview);
      setPageState(
        cachedOverview
          ? deriveCanonicalPricingState(initialOverview)
          : {
              status: "idle",
              lastUpdatedAt: null,
              hasRecommendations: false,
              hasProfitData: false,
            }
      );
      return;
    }

    let mounted = true;
    const requestId = ++requestIdRef.current;
    const startedAt = Date.now();
    setPageState((current) => ({
      ...current,
      status: "loading",
    }));

    embeddedShopRequest<{ overview: PricingProfitOverview }>("/api/pricing-profit/overview", {
      timeoutMs: 15000,
    })
      .then(async (response) => {
        const elapsed = Date.now() - startedAt;
        const remainingDelay = Math.max(0, MIN_LOADING_MS - elapsed);
        if (remainingDelay > 0) {
          await new Promise((resolve) => setTimeout(resolve, remainingDelay));
        }
        if (!mounted || requestId !== requestIdRef.current) return;
        setOverview(response.overview);
        writeModuleCache(CACHE_KEY, response.overview);
        setPageState(deriveCanonicalPricingState(response.overview));
      })
      .catch(() => {
        if (!mounted || requestId !== requestIdRef.current) return;
        setOverview(initialOverview);
        setPageState({
          status: "error",
          lastUpdatedAt: initialOverview.pricingState?.lastSuccessfulRunAt ?? null,
          hasRecommendations:
            (initialOverview.prioritizedRecommendations?.length ?? 0) > 0,
          hasProfitData: (initialOverview.summary.profitOpportunityCount ?? 0) > 0,
        });
      });

    return () => {
      mounted = false;
    };
  }, [allowed, cachedOverview, initialOverview]);

  if (!allowed) {
    return (
      <Page
        title="AI Pricing Engine"
        subtitle="Optimize pricing for margin and demand with clearer pricing workflows."
      >
        <Layout>
          <Layout.Section>
            <Banner title="Upgrade required: Growth or Pro" tone="info">
              <p>
                AI Pricing Engine unlocks on Growth and expands fully on Pro.
              </p>
            </Banner>
          </Layout.Section>
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <Text as="h3" variant="headingMd">
                  What unlocks when pricing is active
                </Text>
                <BlockStack gap="150">
                  <Text as="p">- Baseline pricing recommendations</Text>
                  <Text as="p">- Explainable recommendation review</Text>
                  <Text as="p">- Profit protection and advanced pricing modes on Pro</Text>
                </BlockStack>
                <Button onClick={() => navigateEmbedded("/app/billing")}>
                  Manage subscription plans
                </Button>
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>
      </Page>
    );
  }

  const pricingOverviewState = overview.pricingState ?? createEmptyOverview().pricingState!;
  const topBannerTone = toneForPrimaryState(pricingOverviewState.primaryState);
  const gainValue =
    pricingOverviewState.projectedGainStatus === "not_available"
      ? "Not available"
      : `$${Math.round(pricingOverviewState.projectedGainValue)}`;

  return (
    <Page
      title="AI Pricing Engine"
      subtitle="Review the products that need pricing attention, why they were flagged, and what data supports each action."
      primaryAction={{
        content: pageState.status === "loading" ? "Refreshing..." : "Refresh pricing view",
        onAction: loadOverview,
        disabled: pageState.status === "loading",
      }}
    >
      <Layout>
        <Layout.Section>
          <StatusBanner status={pageState.status} overview={overview} />
        </Layout.Section>

        {pageState.status === "loading" || pageState.status === "error" ? null : pageState.status === "empty" ? (
          <Layout.Section>
            <Card>
              <BlockStack gap="200">
                <Text as="h3" variant="headingMd">
                  No pricing changes recommended
                </Text>
                <Text as="p" tone="subdued">
                  The pricing engine ran successfully, but no important pricing changes are recommended right now.
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  Last successful pricing run: {formatDateTime(pageState.lastUpdatedAt)}
                </Text>
              </BlockStack>
            </Card>
          </Layout.Section>
        ) : (
          <>
            <Layout.Section>
              <InlineGrid columns={{ xs: 1, md: 4 }} gap="400">
                <Card>
                  <BlockStack gap="200">
                    <Text as="h3" variant="headingMd">
                      Recommendations ready
                    </Text>
                    <Text as="p" variant="heading2xl">
                      {pricingOverviewState.prioritizedRecommendationCount}
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
                    <Text as="p" variant="bodySm" tone="subdued">
                      {pricingOverviewState.responseMode === "baseline_only"
                        ? "Recommendations are currently based on store, order, and margin signals."
                        : pricingOverviewState.responseMode === "mixed"
                        ? "Store, competitor, and profit signals are all contributing."
                        : pricingOverviewState.responseMode === "competitor_informed"
                        ? "Competitor monitoring is contributing to current pricing guidance."
                        : "Margin protection is active while deeper competitor context catches up."}
                    </Text>
                  </BlockStack>
                </Card>
                <Card>
                  <BlockStack gap="200">
                    <Text as="h3" variant="headingMd">
                      {gainLabel(overview)}
                    </Text>
                    <Text as="p" variant="heading2xl">
                      {gainValue}
                    </Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                      {pricingOverviewState.projectedGainStatus === "available"
                        ? "Based on live pricing and profit model outputs."
                        : pricingOverviewState.projectedGainStatus === "estimated_baseline"
                        ? "Estimated from current store data and baseline pricing logic."
                        : "A stronger pricing or profit signal is needed before a gain estimate is shown."}
                    </Text>
                  </BlockStack>
                </Card>
              </InlineGrid>
            </Layout.Section>

                <Layout.Section>
                  <Card>
                    <BlockStack gap="300">
                      <InlineStack align="space-between" blockAlign="center">
                        <Text as="h3" variant="headingMd">
                          Priority recommendations
                        </Text>
                        <Badge tone={topBannerTone}>
                          {pricingOverviewState.primaryState === "READY"
                            ? "Ready"
                            : pricingOverviewState.primaryState === "PARTIAL_READINESS"
                            ? "Partial readiness"
                            : pricingOverviewState.primaryState === "EMPTY_HEALTHY"
                            ? "No action needed"
                            : pricingOverviewState.primaryState === "PROCESSING"
                            ? "Processing"
                            : pricingOverviewState.primaryState === "FAILED"
                            ? "Needs attention"
                            : "Setup required"}
                        </Badge>
                      </InlineStack>

                      {(overview.prioritizedRecommendations ?? []).length === 0 ? (
                        <Text as="p" tone="subdued">
                          {pricingOverviewState.description}
                        </Text>
                      ) : (
                        (overview.prioritizedRecommendations ?? []).map((item) => (
                          <Card key={item.id}>
                            <BlockStack gap="200">
                              <InlineStack align="space-between" blockAlign="start">
                                <BlockStack gap="100">
                                  <Text as="p" variant="headingSm">
                                    {`${item.rank}. ${item.productHandle}`}
                                  </Text>
                                  <Text as="p" tone="subdued">
                                    {`$${item.currentPrice.toFixed(2)} -> $${item.recommendedPrice.toFixed(2)}`}
                                  </Text>
                                </BlockStack>
                                <InlineStack gap="200">
                                  <Badge tone="info">{item.recommendationType}</Badge>
                                  <Badge tone={item.confidence === "High" ? "success" : item.confidence === "Medium" ? "attention" : "info"}>
                                    {item.confidence}
                                  </Badge>
                                </InlineStack>
                              </InlineStack>
                              <Text as="p">{item.expectedImpact}</Text>
                              <Text as="p" tone="subdued">
                                {item.why}
                              </Text>
                              <Text as="p" variant="bodySm" tone="subdued">
                                {item.support}
                              </Text>
                              <InlineStack gap="200">
                                <Badge tone="info">{item.dataBasis}</Badge>
                                {item.inputsUsed.map((input) => (
                                  <Badge key={`${item.id}-${input}`} tone="subdued">
                                    {input}
                                  </Badge>
                                ))}
                              </InlineStack>
                              <Text as="p" variant="bodySm">
                                {item.merchantActionNote}
                              </Text>
                            </BlockStack>
                          </Card>
                        ))
                      )}
                    </BlockStack>
                  </Card>
                </Layout.Section>

                <Layout.Section>
                  <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
                    <Card>
                      <BlockStack gap="300">
                        <Text as="h3" variant="headingMd">
                          Why these recommendations exist
                        </Text>
                        {(overview.diagnosticSummary ?? []).map((item) => (
                          <div key={item.title}>
                            <InlineStack align="space-between" blockAlign="start">
                              <BlockStack gap="100">
                                <Text as="p" variant="headingSm">
                                  {item.title}
                                </Text>
                                <Text as="p" tone="subdued">
                                  {item.detail}
                                </Text>
                              </BlockStack>
                              <Badge tone={toneForDiagnostic(item.status)}>
                                {item.status}
                              </Badge>
                            </InlineStack>
                          </div>
                        ))}
                      </BlockStack>
                    </Card>

                    <Card>
                      <BlockStack gap="300">
                        <Text as="h3" variant="headingMd">
                          Pricing modes and strategy
                        </Text>
                        {(overview.pricingModes ?? []).length === 0 ? (
                          <Text as="p" tone="subdued">
                            Pricing modes will appear after pricing recommendations are available.
                          </Text>
                        ) : (
                          (overview.pricingModes ?? []).map((mode) => (
                            <div key={mode.key}>
                              <InlineStack align="space-between" blockAlign="start">
                                <BlockStack gap="100">
                                  <Text as="p" variant="headingSm">
                                    {mode.label}
                                  </Text>
                                  <Text as="p" tone="subdued">
                                    {mode.description}
                                  </Text>
                                </BlockStack>
                                <Badge tone={mode.available ? (mode.recommended ? "success" : "info") : "attention"}>
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
                      </BlockStack>
                    </Card>
                  </InlineGrid>
                </Layout.Section>

                <Layout.Section>
                  <Card>
                    <BlockStack gap="300">
                      <InlineStack align="space-between" blockAlign="center">
                        <Text as="h3" variant="headingMd">
                          Plan-gated advanced capabilities
                        </Text>
                        <Button variant="secondary" onClick={() => navigateEmbedded("/app/billing")}>
                          Manage plan
                        </Button>
                      </InlineStack>
                      {(overview.planGateSummary ?? []).map((item) => (
                        <div key={item.title}>
                          <Text as="p" variant="headingSm">
                            {item.title}
                          </Text>
                          <Text as="p" tone="subdued">
                            {item.detail}
                          </Text>
                        </div>
                      ))}
                    </BlockStack>
                  </Card>
                </Layout.Section>

                <Layout.Section>
                  <Card>
                    <BlockStack gap="200">
                      <Text as="p" variant="bodySm" tone="subdued">
                        Last successful pricing run: {formatDateTime(pageState.lastUpdatedAt)}
                      </Text>
                    </BlockStack>
                  </Card>
                </Layout.Section>
          </>
        )}
      </Layout>
    </Page>
  );
}

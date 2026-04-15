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
  viewState?: {
    status: "initializing" | "syncing_data" | "empty" | "ready" | "failed";
    title: string;
    description: string;
    nextAction?: string | null;
    emptyReason?:
      | "no_catalog_data"
      | "no_sales_history"
      | "no_competitor_input"
      | "no_recommendations"
      | null;
    processingSummary?: {
      catalogProducts: number;
      salesOrders: number;
      competitorInputs: number;
      pricingRows: number;
      profitRows: number;
      recommendations: number;
    };
    timedOutSources?: string[];
    invalidRecommendationCount?: number;
    lastSuccessfulRunAt?: string | null;
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
  requestMeta?: {
    resolvedAt?: string;
    durationMs?: number;
    timedOutSources?: string[];
    invalidRecommendationCount?: number;
    processingSummary?: {
      catalogProducts: number;
      salesOrders: number;
      competitorInputs: number;
      pricingRows: number;
      profitRows: number;
      recommendations: number;
    };
  };
};

const CACHE_KEY = "pricing-profit-overview";
const MIN_LOADING_MS = 400;

type CanonicalPricingViewState = {
  status: "initializing" | "syncing_data" | "ready" | "empty" | "failed";
  lastUpdatedAt: string | null;
  hasRecommendations: boolean;
  hasProfitData: boolean;
  error: string | null;
  requestInFlight: boolean;
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
  const status =
    overview.viewState?.status ??
    (hasRecommendations || hasProfitData ? "ready" : "empty");
  return {
    status,
    lastUpdatedAt:
      overview.viewState?.lastSuccessfulRunAt ??
      overview.pricingState?.lastSuccessfulRunAt ??
      null,
    hasRecommendations,
    hasProfitData,
    error: null,
    requestInFlight: false,
  };
}

function StatusBanner(props: {
  status: CanonicalPricingViewState["status"];
  overview: PricingProfitOverview;
  error?: string | null;
}) {
  const pricingState = props.overview.pricingState ?? createEmptyOverview().pricingState!;
  const viewState = props.overview.viewState;

  switch (props.status) {
    case "initializing":
      return (
        <Banner title="Loading pricing engine" tone="info">
          <p>
            VedaSuite is checking the latest catalog, sales, competitor, and pricing data for this store.
          </p>
        </Banner>
      );
    case "syncing_data":
      return (
        <Banner title="Refreshing pricing engine" tone="info">
          <p>
            VedaSuite is processing the latest store data before it refreshes pricing recommendations.
          </p>
        </Banner>
      );
    case "ready":
      return (
        <Banner title={viewState?.title ?? pricingState.title} tone="success">
          <p>{viewState?.description ?? pricingState.description}</p>
        </Banner>
      );
    case "empty":
      return (
        <Banner title={viewState?.title ?? "No pricing recommendations yet"} tone="info">
          <p>{viewState?.description ?? pricingState.description}</p>
        </Banner>
      );
    case "failed":
      return (
        <Banner title="Pricing engine could not be loaded" tone="critical">
          <p>
            {props.error ??
              viewState?.description ??
              "VedaSuite could not load the latest pricing data. Try refreshing again."}
          </p>
        </Banner>
      );
    default:
      return (
        <Banner title="Pricing engine" tone="info">
          <p>{viewState?.description ?? pricingState.description}</p>
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
          status: "initializing",
          lastUpdatedAt: null,
          hasRecommendations: false,
          hasProfitData: false,
          error: null,
          requestInFlight: false,
        }
  );
  const requestIdRef = useRef(0);
  const requestPromiseRef = useRef<Promise<void> | null>(null);
  const allowed = !!subscription?.enabledModules?.pricingProfit;

  const loadOverview = async () => {
    if (requestPromiseRef.current) {
      return requestPromiseRef.current;
    }

    const requestId = ++requestIdRef.current;
    const startedAt = Date.now();
    setPageState((current) => ({
      ...current,
      status:
        current.hasRecommendations || current.hasProfitData
          ? "syncing_data"
          : "initializing",
      requestInFlight: true,
      error: null,
    }));

    const requestPromise = (async () => {
      try {
        const response = await embeddedShopRequest<{ overview: PricingProfitOverview }>(
          "/api/pricing-profit/overview",
          { timeoutMs: 15000 }
        );
        if (!response?.overview || typeof response.overview !== "object") {
          throw new Error("Pricing response was incomplete.");
        }
        if (!response.overview.viewState?.status) {
          throw new Error("Pricing response did not include a valid view state.");
        }
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
        setPageState({
          ...deriveCanonicalPricingState(response.overview),
          requestInFlight: false,
          error: null,
        });
      } catch (error) {
        if (requestId !== requestIdRef.current) {
          return;
        }
        setPageState((current) => ({
          ...current,
          status: "failed",
          requestInFlight: false,
          error:
            error instanceof Error
              ? error.message
              : "Pricing engine could not be loaded.",
        }));
      } finally {
        if (requestPromiseRef.current === requestPromise) {
          requestPromiseRef.current = null;
        }
      }
    })();

    requestPromiseRef.current = requestPromise;
    return requestPromise;
  };

  useEffect(() => {
    if (!allowed) {
      setOverview(initialOverview);
      setPageState(
        cachedOverview
          ? deriveCanonicalPricingState(initialOverview)
          : {
              status: "initializing",
              lastUpdatedAt: null,
              hasRecommendations: false,
              hasProfitData: false,
              error: null,
              requestInFlight: false,
            }
      );
      return;
    }

    let mounted = true;
    void loadOverview().catch(() => undefined);

    return () => {
      mounted = false;
    };
  }, [allowed]);

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
        content: pageState.requestInFlight ? "Refreshing..." : "Refresh pricing view",
        onAction: loadOverview,
        disabled: pageState.requestInFlight,
      }}
    >
      <Layout>
        <Layout.Section>
          <StatusBanner status={pageState.status} overview={overview} error={pageState.error} />
        </Layout.Section>

        {pageState.status === "initializing" || pageState.status === "syncing_data" ? (
          <Layout.Section>
            <Card>
              <BlockStack gap="200">
                <Text as="h3" variant="headingMd">
                  {pageState.status === "syncing_data"
                    ? "Pricing refresh is in progress"
                    : "Preparing pricing inputs"}
                </Text>
                <Text as="p" tone="subdued">
                  {pageState.status === "syncing_data"
                    ? "The latest sync is still processing pricing rows and profit signals."
                    : "VedaSuite is checking catalog, sales, competitor, and pricing data before showing this module."}
                </Text>
              </BlockStack>
            </Card>
          </Layout.Section>
        ) : pageState.status === "failed" ? (
          <Layout.Section>
            <Card>
              <BlockStack gap="200">
                <Text as="h3" variant="headingMd">
                  Pricing engine needs attention
                </Text>
                <Text as="p" tone="subdued">
                  {pageState.error ??
                    overview.viewState?.description ??
                    "VedaSuite could not finish loading the pricing engine."}
                </Text>
                <Button variant="primary" onClick={loadOverview} disabled={pageState.requestInFlight}>
                  Retry pricing refresh
                </Button>
              </BlockStack>
            </Card>
          </Layout.Section>
        ) : pageState.status === "empty" ? (
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <Text as="h3" variant="headingMd">
                  {overview.viewState?.title ?? "No pricing recommendations yet"}
                </Text>
                <Text as="p" tone="subdued">
                  {overview.viewState?.description ??
                    "The pricing engine ran successfully, but no important pricing changes are recommended right now."}
                </Text>
                <InlineGrid columns={{ xs: 1, md: 3 }} gap="300">
                  <div className="vs-signal-stat">
                    <Text as="p" variant="bodySm" tone="subdued">
                      Catalog products processed
                    </Text>
                    <Text as="p">
                      {overview.viewState?.processingSummary?.catalogProducts ?? 0}
                    </Text>
                  </div>
                  <div className="vs-signal-stat">
                    <Text as="p" variant="bodySm" tone="subdued">
                      Sales orders processed
                    </Text>
                    <Text as="p">
                      {overview.viewState?.processingSummary?.salesOrders ?? 0}
                    </Text>
                  </div>
                  <div className="vs-signal-stat">
                    <Text as="p" variant="bodySm" tone="subdued">
                      Competitor inputs
                    </Text>
                    <Text as="p">
                      {overview.viewState?.processingSummary?.competitorInputs ?? 0}
                    </Text>
                  </div>
                </InlineGrid>
                <Text as="p" variant="bodySm" tone="subdued">
                  Last successful pricing run: {formatDateTime(pageState.lastUpdatedAt)}
                </Text>
                <InlineStack gap="300">
                  <Button variant="primary" onClick={loadOverview} disabled={pageState.requestInFlight}>
                    Refresh pricing view
                  </Button>
                  <Button onClick={() => navigateEmbedded("/app/dashboard")}>
                    Open dashboard
                  </Button>
                </InlineStack>
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

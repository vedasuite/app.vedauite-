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
import { useCallback, useEffect, useRef, useState } from "react";
import { useEmbeddedNavigation } from "../../hooks/useEmbeddedNavigation";
import { useSubscriptionPlan } from "../../hooks/useSubscriptionPlan";
import { embeddedShopRequest } from "../../lib/embeddedShopRequest";
import { readModuleCache, writeModuleCache } from "../../lib/moduleCache";

type BackendStatus =
  | "syncing"
  | "empty_no_data"
  | "ready"
  | "failed_timeout"
  | "failed_error";
type ScreenStatus =
  | "initializing"
  | "syncing"
  | "empty_no_data"
  | "ready"
  | "failed_timeout"
  | "failed_error";
type PricingPrimaryState =
  | "SETUP_INCOMPLETE"
  | "PARTIAL_READINESS"
  | "READY"
  | "EMPTY_HEALTHY"
  | "PROCESSING"
  | "FAILED";

type Overview = {
  viewState?: {
    status: BackendStatus;
    title: string;
    description: string;
    nextAction?: string | null;
    processingSummary?: {
      catalogProducts: number;
      salesOrders: number;
      competitorInputs: number;
      pricingRows: number;
      profitRows: number;
      recommendations: number;
    };
    lastSuccessfulRunAt?: string | null;
  };
  pricingState?: {
    primaryState: PricingPrimaryState;
    prioritizedRecommendationCount: number;
    projectedGainStatus: "available" | "estimated_baseline" | "not_available";
    projectedGainValue: number;
    responseMode:
      | "baseline_only"
      | "competitor_informed"
      | "margin_protection"
      | "mixed";
    description: string;
    lastSuccessfulRunAt?: string | null;
  };
  summary: {
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
    dataBasis: string;
    why: string;
    support: string;
    inputsUsed: string[];
    merchantActionNote: string;
  }>;
  diagnosticSummary?: Array<{ title: string; detail: string; status: string }>;
  pricingModes?: Array<{
    key: string;
    label: string;
    description: string;
    available?: boolean;
    gate?: string;
    recommended?: boolean;
  }>;
  planGateSummary?: Array<{ title: string; detail: string }>;
};

type ScreenState = {
  status: ScreenStatus;
  errorMessage: string | null;
  lastUpdatedAt: string | null;
  accessDenied: boolean;
};

const CACHE_KEY = "pricing-profit-overview";
const REQUEST_TIMEOUT_MS = 18000;
const MIN_LOADING_MS = 400;

function emptyOverview(): Overview {
  return {
    viewState: {
      status: "empty_no_data",
      title: "Pricing data has not been prepared yet",
      description: "Run the first Shopify sync so VedaSuite can prepare pricing guidance.",
      nextAction: "Run live sync",
      processingSummary: {
        catalogProducts: 0,
        salesOrders: 0,
        competitorInputs: 0,
        pricingRows: 0,
        profitRows: 0,
        recommendations: 0,
      },
      lastSuccessfulRunAt: null,
    },
    pricingState: {
      primaryState: "SETUP_INCOMPLETE",
      prioritizedRecommendationCount: 0,
      projectedGainStatus: "not_available",
      projectedGainValue: 0,
      responseMode: "baseline_only",
      description: "Run the first live sync to populate pricing outputs.",
      lastSuccessfulRunAt: null,
    },
    summary: {
      profitOpportunityCount: 0,
      responseMode: "Baseline recommendations active",
    },
    prioritizedRecommendations: [],
    diagnosticSummary: [],
    pricingModes: [],
    planGateSummary: [],
  };
}

function isBackendStatus(value: unknown): value is BackendStatus {
  return (
    value === "syncing" ||
    value === "empty_no_data" ||
    value === "ready" ||
    value === "failed_timeout" ||
    value === "failed_error"
  );
}

function formatDate(value?: string | null) {
  if (!value) return "Not available";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function toneForPrimaryState(value: PricingPrimaryState) {
  if (value === "READY") return "success" as const;
  if (value === "PARTIAL_READINESS") return "warning" as const;
  if (value === "FAILED") return "critical" as const;
  return "info" as const;
}

function toneForDiagnostic(value: string) {
  if (value === "ready") return "success";
  if (value === "partial") return "attention";
  if (value === "empty") return "info";
  return "subdued";
}

function gainLabel(overview: Overview) {
  const status = overview.pricingState?.projectedGainStatus;
  if (status === "estimated_baseline") return "Estimated gain";
  return "Projected gain";
}

function logPricingEvent(event: string, details?: Record<string, unknown>) {
  console.info("[pricing-engine]", event, details ?? {});
}

function stateFromOverview(overview: Overview): ScreenState {
  const status = overview.viewState?.status;
  if (!isBackendStatus(status)) {
    return {
      status: "failed_error",
      errorMessage: "Pricing response did not include a valid state.",
      lastUpdatedAt: null,
      accessDenied: false,
    };
  }

  return {
    status,
    errorMessage: null,
    lastUpdatedAt:
      overview.viewState?.lastSuccessfulRunAt ??
      overview.pricingState?.lastSuccessfulRunAt ??
      null,
    accessDenied: false,
  };
}

function stateFromError(error: unknown): ScreenState {
  const err = error as Error & { code?: string };
  const message =
    err instanceof Error ? err.message : "Pricing engine could not be loaded.";
  const accessDenied =
    err?.code === "CAPABILITY_REQUIRED" ||
    /does not include .*pricing/i.test(message.toLowerCase());

  return {
    status:
      err?.code === "PRICING_TIMEOUT" || /timed out/i.test(message.toLowerCase())
        ? "failed_timeout"
        : "failed_error",
    errorMessage: message,
    lastUpdatedAt: null,
    accessDenied,
  };
}

function StatusBanner({
  screenState,
  overview,
}: {
  screenState: ScreenState;
  overview: Overview;
}) {
  switch (screenState.status) {
    case "initializing":
      return (
        <Banner title="Loading pricing engine" tone="info">
          <p>VedaSuite is checking the latest pricing data for this store.</p>
        </Banner>
      );
    case "syncing":
      return (
        <Banner title="Refreshing pricing engine" tone="info">
          <p>VedaSuite is processing synced store data and rebuilding pricing guidance.</p>
        </Banner>
      );
    case "empty_no_data":
      return (
        <Banner title={overview.viewState?.title ?? "No pricing recommendations yet"} tone="info">
          <p>{overview.viewState?.description ?? "No pricing recommendations are available yet."}</p>
        </Banner>
      );
    case "ready":
      return (
        <Banner title={overview.viewState?.title ?? "Pricing recommendations are ready"} tone="success">
          <p>{overview.viewState?.description ?? overview.pricingState?.description}</p>
        </Banner>
      );
    case "failed_timeout":
      return (
        <Banner title="Pricing engine took too long to load" tone="critical">
          <p>{screenState.errorMessage ?? "VedaSuite could not finish loading pricing data in time."}</p>
        </Banner>
      );
    default:
      return (
        <Banner title="Pricing engine could not be loaded" tone="critical">
          <p>{screenState.errorMessage ?? "VedaSuite could not load pricing data."}</p>
        </Banner>
      );
  }
}

export function PricingProfitPage() {
  const { navigateEmbedded } = useEmbeddedNavigation();
  const { subscription } = useSubscriptionPlan();
  const cachedOverview = readModuleCache<Overview>(CACHE_KEY);
  const [overview, setOverview] = useState<Overview>(cachedOverview ?? emptyOverview());
  const [screenState, setScreenState] = useState<ScreenState>(
    cachedOverview
      ? stateFromOverview(cachedOverview)
      : { status: "initializing", errorMessage: null, lastUpdatedAt: null, accessDenied: false }
  );
  const requestIdRef = useRef(0);
  const inFlightRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const allowed = !!subscription?.enabledModules?.pricingProfit;

  const loadOverview = useCallback(async (reason: "mount" | "refresh" | "retry" = "refresh") => {
    if (!allowed) return;
    if (inFlightRef.current) {
      logPricingEvent("fetch_skipped_inflight", { reason });
      return;
    }

    const requestId = ++requestIdRef.current;
    const startedAt = Date.now();
    const controller = new AbortController();
    abortControllerRef.current?.abort();
    abortControllerRef.current = controller;
    inFlightRef.current = true;

    logPricingEvent(reason === "mount" ? "page_fetch_start" : "refresh_start", {
      requestId,
      reason,
    });

    setScreenState((current) => ({
      status:
        current.status === "ready" || current.status === "empty_no_data"
          ? "syncing"
          : "initializing",
      errorMessage: null,
      lastUpdatedAt: current.lastUpdatedAt,
      accessDenied: false,
    }));

    try {
      const response = await Promise.race([
        embeddedShopRequest<{ overview: Overview }>("/api/pricing-profit/overview", {
          timeoutMs: REQUEST_TIMEOUT_MS,
          signal: controller.signal,
        }),
        new Promise<never>((_, reject) => {
          window.setTimeout(
            () => reject(new Error("Pricing page request timed out.")),
            REQUEST_TIMEOUT_MS
          );
        }),
      ]);

      if (!response?.overview || !isBackendStatus(response.overview.viewState?.status)) {
        throw new Error("Pricing response did not include a valid state.");
      }

      const remainingDelay = Math.max(0, MIN_LOADING_MS - (Date.now() - startedAt));
      if (remainingDelay > 0) {
        await new Promise((resolve) => window.setTimeout(resolve, remainingDelay));
      }

      if (requestId !== requestIdRef.current) return;

      setOverview(response.overview);
      writeModuleCache(CACHE_KEY, response.overview);
      setScreenState(stateFromOverview(response.overview));
      logPricingEvent("fetch_success", {
        requestId,
        reason,
        status: response.overview.viewState?.status,
        recommendationCount: response.overview.prioritizedRecommendations?.length ?? 0,
      });
    } catch (error) {
      if (requestId !== requestIdRef.current) return;
      const nextState = stateFromError(error);
      setScreenState(nextState);
      logPricingEvent("fetch_failure", {
        requestId,
        reason,
        status: nextState.status,
        message: nextState.errorMessage,
        accessDenied: nextState.accessDenied,
      });
    } finally {
      if (requestId === requestIdRef.current) {
        inFlightRef.current = false;
        abortControllerRef.current = null;
        logPricingEvent(reason === "mount" ? "page_fetch_end" : "refresh_end", {
          requestId,
          reason,
        });
      }
    }
  }, [allowed]);

  useEffect(() => {
    logPricingEvent("page_mount", { allowed });
    if (allowed) {
      void loadOverview("mount");
    }
    return () => {
      abortControllerRef.current?.abort();
      inFlightRef.current = false;
      logPricingEvent("page_unmount");
    };
  }, [allowed, loadOverview]);

  if (!allowed || screenState.accessDenied) {
    return (
      <Page
        title="AI Pricing Engine"
        subtitle="Optimize pricing for margin and demand with clearer pricing workflows."
      >
        <Layout>
          <Layout.Section>
            <Banner title="Upgrade required: Growth or Pro" tone="info">
              <p>AI Pricing Engine unlocks on Growth and expands fully on Pro.</p>
            </Banner>
          </Layout.Section>
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <Text as="h3" variant="headingMd">What unlocks when pricing is active</Text>
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

  const processing = overview.viewState?.processingSummary ?? emptyOverview().viewState?.processingSummary;
  const pricingState = overview.pricingState ?? emptyOverview().pricingState!;
  const refreshing = screenState.status === "initializing" || screenState.status === "syncing";
  const gainValue =
    pricingState.projectedGainStatus === "not_available"
      ? "Not available"
      : `$${Math.round(pricingState.projectedGainValue)}`;

  return (
    <Page
      title="AI Pricing Engine"
      subtitle="Review the products that need pricing attention, why they were flagged, and what data supports each action."
      primaryAction={{
        content: refreshing ? "Refreshing..." : "Refresh pricing view",
        onAction: () => void loadOverview("refresh"),
        disabled: refreshing,
      }}
    >
      <Layout>
        <Layout.Section>
          <StatusBanner screenState={screenState} overview={overview} />
        </Layout.Section>

        {refreshing ? (
          <Layout.Section>
            <Card>
              <BlockStack gap="200">
                <Text as="h3" variant="headingMd">
                  {screenState.status === "syncing"
                    ? "Pricing refresh is in progress"
                    : "Preparing pricing inputs"}
                </Text>
                <InlineGrid columns={{ xs: 1, md: 3 }} gap="300">
                  <div className="vs-signal-stat">
                    <Text as="p" variant="bodySm" tone="subdued">Products checked</Text>
                    <Text as="p">{processing?.catalogProducts ?? 0}</Text>
                  </div>
                  <div className="vs-signal-stat">
                    <Text as="p" variant="bodySm" tone="subdued">Orders checked</Text>
                    <Text as="p">{processing?.salesOrders ?? 0}</Text>
                  </div>
                  <div className="vs-signal-stat">
                    <Text as="p" variant="bodySm" tone="subdued">Pricing rows available</Text>
                    <Text as="p">{processing?.pricingRows ?? 0}</Text>
                  </div>
                </InlineGrid>
              </BlockStack>
            </Card>
          </Layout.Section>
        ) : null}

        {screenState.status === "failed_timeout" || screenState.status === "failed_error" ? (
          <Layout.Section>
            <Card>
              <BlockStack gap="200">
                <Text as="h3" variant="headingMd">Pricing engine needs attention</Text>
                <Text as="p" tone="subdued">
                  {screenState.errorMessage ?? "VedaSuite could not finish loading the pricing engine."}
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  Last successful pricing run: {formatDate(screenState.lastUpdatedAt)}
                </Text>
                <InlineStack gap="300">
                  <Button variant="primary" onClick={() => void loadOverview("retry")}>
                    Retry pricing refresh
                  </Button>
                  <Button onClick={() => navigateEmbedded("/app/dashboard")}>
                    Open dashboard
                  </Button>
                </InlineStack>
              </BlockStack>
            </Card>
          </Layout.Section>
        ) : null}

        {screenState.status === "empty_no_data" ? (
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <Text as="h3" variant="headingMd">
                  {overview.viewState?.title ?? "No pricing recommendations yet"}
                </Text>
                <Text as="p" tone="subdued">
                  {overview.viewState?.description ?? "No pricing recommendations are available yet."}
                </Text>
                <InlineGrid columns={{ xs: 1, md: 4 }} gap="300">
                  <div className="vs-signal-stat">
                    <Text as="p" variant="bodySm" tone="subdued">Products checked</Text>
                    <Text as="p">{processing?.catalogProducts ?? 0}</Text>
                  </div>
                  <div className="vs-signal-stat">
                    <Text as="p" variant="bodySm" tone="subdued">Orders checked</Text>
                    <Text as="p">{processing?.salesOrders ?? 0}</Text>
                  </div>
                  <div className="vs-signal-stat">
                    <Text as="p" variant="bodySm" tone="subdued">Competitor inputs checked</Text>
                    <Text as="p">{processing?.competitorInputs ?? 0}</Text>
                  </div>
                  <div className="vs-signal-stat">
                    <Text as="p" variant="bodySm" tone="subdued">Recommendations found</Text>
                    <Text as="p">{processing?.recommendations ?? 0}</Text>
                  </div>
                </InlineGrid>
                <Text as="p" variant="bodySm" tone="subdued">
                  Next step: {overview.viewState?.nextAction ?? "Run sync or review data readiness"}
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  Last successful pricing run: {formatDate(screenState.lastUpdatedAt)}
                </Text>
                <InlineStack gap="300">
                  <Button variant="primary" onClick={() => void loadOverview("refresh")}>
                    Retry pricing refresh
                  </Button>
                  <Button onClick={() => navigateEmbedded("/app/dashboard")}>
                    Open dashboard
                  </Button>
                </InlineStack>
              </BlockStack>
            </Card>
          </Layout.Section>
        ) : null}

        {screenState.status === "ready" ? (
          <>
            <Layout.Section>
              <InlineGrid columns={{ xs: 1, md: 4 }} gap="400">
                <Card><BlockStack gap="200"><Text as="h3" variant="headingMd">Recommendations ready</Text><Text as="p" variant="heading2xl">{pricingState.prioritizedRecommendationCount}</Text></BlockStack></Card>
                <Card><BlockStack gap="200"><Text as="h3" variant="headingMd">Profit opportunities</Text><Text as="p" variant="heading2xl">{overview.summary.profitOpportunityCount}</Text></BlockStack></Card>
                <Card><BlockStack gap="200"><Text as="h3" variant="headingMd">Response mode</Text><Text as="p" variant="headingMd">{overview.summary.responseMode}</Text></BlockStack></Card>
                <Card><BlockStack gap="200"><Text as="h3" variant="headingMd">{gainLabel(overview)}</Text><Text as="p" variant="heading2xl">{gainValue}</Text></BlockStack></Card>
              </InlineGrid>
            </Layout.Section>

            <Layout.Section>
              <Card>
                <BlockStack gap="300">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="h3" variant="headingMd">Priority recommendations</Text>
                    <Badge tone={toneForPrimaryState(pricingState.primaryState)}>
                      {pricingState.primaryState === "READY"
                        ? "Ready"
                        : pricingState.primaryState === "PARTIAL_READINESS"
                        ? "Partial readiness"
                        : pricingState.primaryState === "PROCESSING"
                        ? "Processing"
                        : pricingState.primaryState === "FAILED"
                        ? "Needs attention"
                        : "Setup required"}
                    </Badge>
                  </InlineStack>

                  {(overview.prioritizedRecommendations ?? []).length === 0 ? (
                    <Text as="p" tone="subdued">{pricingState.description}</Text>
                  ) : (
                    (overview.prioritizedRecommendations ?? []).map((item) => (
                      <Card key={item.id}>
                        <BlockStack gap="200">
                          <InlineStack align="space-between" blockAlign="start">
                            <BlockStack gap="100">
                              <Text as="p" variant="headingSm">{`${item.rank}. ${item.productHandle}`}</Text>
                              <Text as="p" tone="subdued">{`$${item.currentPrice.toFixed(2)} -> $${item.recommendedPrice.toFixed(2)}`}</Text>
                            </BlockStack>
                            <InlineStack gap="200">
                              <Badge tone="info">{item.recommendationType}</Badge>
                              <Badge tone={item.confidence === "High" ? "success" : item.confidence === "Medium" ? "attention" : "info"}>{item.confidence}</Badge>
                            </InlineStack>
                          </InlineStack>
                          <Text as="p">{item.expectedImpact}</Text>
                          <Text as="p" tone="subdued">{item.why}</Text>
                          <Text as="p" variant="bodySm" tone="subdued">{item.support}</Text>
                          <InlineStack gap="200">
                            <Badge tone="info">{item.dataBasis}</Badge>
                            {item.inputsUsed.map((input) => <Badge key={`${item.id}-${input}`} tone="subdued">{input}</Badge>)}
                          </InlineStack>
                          <Text as="p" variant="bodySm">{item.merchantActionNote}</Text>
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
                    <Text as="h3" variant="headingMd">Why these recommendations exist</Text>
                    {(overview.diagnosticSummary ?? []).map((item) => (
                      <div key={item.title}>
                        <InlineStack align="space-between" blockAlign="start">
                          <BlockStack gap="100">
                            <Text as="p" variant="headingSm">{item.title}</Text>
                            <Text as="p" tone="subdued">{item.detail}</Text>
                          </BlockStack>
                          <Badge tone={toneForDiagnostic(item.status)}>{item.status}</Badge>
                        </InlineStack>
                      </div>
                    ))}
                  </BlockStack>
                </Card>

                <Card>
                  <BlockStack gap="300">
                    <Text as="h3" variant="headingMd">Pricing modes and strategy</Text>
                    {(overview.pricingModes ?? []).length === 0 ? (
                      <Text as="p" tone="subdued">Pricing modes will appear after pricing recommendations are available.</Text>
                    ) : (
                      (overview.pricingModes ?? []).map((mode) => (
                        <div key={mode.key}>
                          <InlineStack align="space-between" blockAlign="start">
                            <BlockStack gap="100">
                              <Text as="p" variant="headingSm">{mode.label}</Text>
                              <Text as="p" tone="subdued">{mode.description}</Text>
                            </BlockStack>
                            <Badge tone={mode.available ? (mode.recommended ? "success" : "info") : "attention"}>
                              {mode.available ? (mode.recommended ? "Recommended" : "Available") : mode.gate ?? "Pro"}
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
                    <Text as="h3" variant="headingMd">Plan-gated advanced capabilities</Text>
                    <Button variant="secondary" onClick={() => navigateEmbedded("/app/billing")}>Manage plan</Button>
                  </InlineStack>
                  {(overview.planGateSummary ?? []).map((item) => (
                    <div key={item.title}>
                      <Text as="p" variant="headingSm">{item.title}</Text>
                      <Text as="p" tone="subdued">{item.detail}</Text>
                    </div>
                  ))}
                </BlockStack>
              </Card>
            </Layout.Section>

            <Layout.Section>
              <Card>
                <BlockStack gap="200">
                  <Text as="p" variant="bodySm" tone="subdued">
                    Last successful pricing run: {formatDate(screenState.lastUpdatedAt)}
                  </Text>
                </BlockStack>
              </Card>
            </Layout.Section>
          </>
        ) : null}
      </Layout>
    </Page>
  );
}

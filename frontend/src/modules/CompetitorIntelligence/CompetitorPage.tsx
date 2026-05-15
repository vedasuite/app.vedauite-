import {
  Badge,
  Banner,
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
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { ModuleGate } from "../../components/ModuleGate";
import { useAppState } from "../../hooks/useAppState";
import { useShopifyAdminLinks } from "../../hooks/useShopifyAdminLinks";
import { useSubscriptionPlan } from "../../hooks/useSubscriptionPlan";
import { isBackendModuleEnabled } from "../../lib/backendModuleAccess";
import { embeddedShopRequest } from "../../lib/embeddedShopRequest";
import { readModuleCache, writeModuleCache } from "../../lib/moduleCache";

type CompetitorPrimaryState =
  | "SETUP_INCOMPLETE"
  | "AWAITING_FIRST_RUN"
  | "NO_MATCHES"
  | "LOW_CONFIDENCE"
  | "NO_CHANGES"
  | "CHANGES_DETECTED"
  | "STALE"
  | "FAILURE";

type CompetitorRow = {
  id: string;
  productHandle: string;
  competitorName: string;
  competitorUrl: string;
  price?: number | null;
  promotion?: string | null;
  stockStatus?: string | null;
  source?: string;
  confidenceScore?: number;
  confidenceLabel?: string;
  matchReason?: string;
};

type CompetitorOverview = {
  competitorState?: {
    primaryState: CompetitorPrimaryState;
    freshnessLabel: string;
    lastSuccessfulRunAt?: string | null;
    lastAttemptAt?: string | null;
    checkedDomainsCount: number;
    monitoredProductsCount?: number;
    matchedProductsCount: number;
    validMatchedProductsCount?: number;
    lowConfidenceMatchesCount?: number;
    excludedProductsCount?: number;
    excludedProducts?: {
      archived: number;
      draft: number;
      giftCardLike: number;
      missingPrice: number;
    };
    activePromotionsCount: number;
    stockAlertsCount: number;
    coverageStatus: string;
    title: string;
    description: string;
    confidenceExplanation?: string;
    actionPanel?: {
      headline: string;
      explanation: string;
      actions: string[];
    };
    nextAction?: string | null;
    toastMessage?: string | null;
  };
  sourceBreakdown?: { website: number; googleShopping: number; metaAds: number };
  moveFeed?: Array<{
    id: string;
    headline: string;
    moveType: string;
    source: string;
    priority: string;
    whyItMatters: string;
    suggestedAction: string;
  }>;
  actionSuggestions?: Array<{
    productHandle: string;
    suggestion: string;
    why: string;
  }>;
  weeklyReport?: {
    headline: string;
    whyItMatters: string;
    merchantBrief?: string;
    nextBestAction?: string;
  };
  lowConfidenceRows?: Array<{
    id: string;
    productHandle: string;
    competitorName: string;
    confidenceLabel: string;
    confidenceScore: number;
    matchReason: string;
  }>;
  productCoverage?: {
    eligibleProductsCount: number;
    excludedProductsCount: number;
    excludedProducts: {
      archived: number;
      draft: number;
      giftCardLike: number;
      missingPrice: number;
    };
    explanation: string;
  };
};

type CompetitorConnector = {
  id: string;
  label: string;
  description: string;
  trackedTargets: number;
  lastIngestedAt?: string | null;
  readiness?: string;
  action?: string;
};

type CompetitorResponseEngine = {
  summary: {
    responseMode: string;
    automationReadiness: string;
  };
  responsePlans: Array<{
    productHandle: string;
    pressureScore: number;
    recommendedPlay: string;
    rationale: string;
    executionHint: string;
    automationPosture: string;
  }>;
};

const resourceName = { singular: "competitor product", plural: "competitor products" };

function createEmptyOverview(): CompetitorOverview {
  return {
    competitorState: {
      primaryState: "SETUP_INCOMPLETE",
      freshnessLabel: "Ready after first refresh",
      lastSuccessfulRunAt: null,
      lastAttemptAt: null,
      checkedDomainsCount: 0,
      matchedProductsCount: 0,
      activePromotionsCount: 0,
      stockAlertsCount: 0,
      coverageStatus: "Add domains",
      title: "Add competitor websites to begin analysis",
      description:
        "Add competitor websites to begin tracking pricing and product trends.",
      confidenceExplanation:
        "Comparable products appear after VedaSuite finds strong live product evidence on the selected competitor websites.",
      actionPanel: {
        headline: "Begin competitor analysis",
        explanation:
          "Add competitor websites, then run the first analysis so VedaSuite can look for comparable products.",
        actions: ["Add competitor websites", "Run competitor analysis"],
      },
      nextAction: "Add competitor websites",
      toastMessage: "Add competitor websites before running competitor analysis.",
    },
    sourceBreakdown: { website: 0, googleShopping: 0, metaAds: 0 },
    moveFeed: [],
    actionSuggestions: [],
    weeklyReport: {
      headline: "Add competitor websites to start the weekly brief",
      whyItMatters:
        "VedaSuite needs a completed analysis with matched products before weekly reporting becomes useful.",
      merchantBrief:
        "VedaSuite will build a weekly competitor brief after the first completed matched analysis.",
      nextBestAction: "Add competitor websites and run your first analysis.",
    },
    lowConfidenceRows: [],
    productCoverage: {
      eligibleProductsCount: 0,
      excludedProductsCount: 0,
      excludedProducts: {
        archived: 0,
        draft: 0,
        giftCardLike: 0,
        missingPrice: 0,
      },
      explanation:
        "Only active priced products are reviewed for competitor overlap.",
    },
  };
}

function createEmptyResponseEngine(): CompetitorResponseEngine {
  return {
    summary: {
      responseMode: "No response needed",
      automationReadiness:
        "Response recommendations appear after VedaSuite finds comparable competitor products.",
    },
    responsePlans: [],
  };
}

function normalizeOverview(input: CompetitorOverview): CompetitorOverview {
  const fallback = createEmptyOverview();
  return {
    ...fallback,
    ...input,
    competitorState: {
      ...fallback.competitorState!,
      ...input.competitorState,
    },
    sourceBreakdown: {
      website: input.sourceBreakdown?.website ?? 0,
      googleShopping: input.sourceBreakdown?.googleShopping ?? 0,
      metaAds: input.sourceBreakdown?.metaAds ?? 0,
    },
    moveFeed: input.moveFeed ?? [],
    actionSuggestions: input.actionSuggestions ?? [],
    weeklyReport: {
      ...fallback.weeklyReport!,
      ...input.weeklyReport,
    },
  };
}

function formatDateTime(value?: string | null) {
  if (!value) return "Not available";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function toneForPriority(value: string) {
  const normalized = value.toLowerCase();
  if (normalized === "high") return "critical";
  if (normalized === "medium") return "attention";
  return "info";
}

function getBannerTone(state: CompetitorPrimaryState) {
  switch (state) {
    case "CHANGES_DETECTED":
      return "success" as const;
    case "FAILURE":
      return "critical" as const;
    case "LOW_CONFIDENCE":
    case "STALE":
    case "NO_MATCHES":
      return "warning" as const;
    default:
      return "info" as const;
  }
}

function getPageSubtitle(state: CompetitorPrimaryState) {
  switch (state) {
    case "SETUP_INCOMPLETE":
      return "Add competitor websites to begin tracking pricing and product trends.";
    case "AWAITING_FIRST_RUN":
      return "Competitor websites are ready. Run the first analysis to begin.";
    case "NO_MATCHES":
      return "Competitor analysis completed. No matching products were identified yet.";
    case "LOW_CONFIDENCE":
      return "Possible product matches were found, but they need stronger evidence before they are shown as recommendations.";
    case "NO_CHANGES":
      return "Competitor analysis is active and ready to surface changes when they appear.";
    case "CHANGES_DETECTED":
      return "Review competitor price moves, promotion changes, and recommended responses.";
    case "STALE":
      return "Competitor analysis has not been updated recently.";
    case "FAILURE":
      return "The latest competitor analysis needs attention before new insights can appear.";
  }
}

function getPrimaryActionLabel(state: CompetitorPrimaryState) {
  if (state === "SETUP_INCOMPLETE") return "Add competitor websites";
  if (state === "CHANGES_DETECTED") return "View changes";
  if (state === "LOW_CONFIDENCE") return "Review coverage";
  return "Run analysis";
}

function getEmptyMessage(state: CompetitorPrimaryState, tab: "tracked" | "feed" | "strategy") {
  if (tab === "tracked") {
    if (state === "SETUP_INCOMPLETE") return "Add competitor websites to begin tracking pricing and product trends.";
    if (state === "AWAITING_FIRST_RUN") return "Run the first analysis to build the tracked products table.";
    if (state === "NO_MATCHES") return "Competitor analysis completed. No matching products were identified yet.";
    if (state === "LOW_CONFIDENCE") return "Possible competitor pages were found, but more evidence is needed before they appear here.";
    return "Tracked products will appear here after competitor data becomes available.";
  }
  if (tab === "feed") {
    if (state === "NO_MATCHES") return "No competitor actions are available yet because no matching products were identified.";
    if (state === "LOW_CONFIDENCE") return "No competitor actions are available yet because more evidence is needed.";
    if (state === "NO_CHANGES") return "Competitor analysis is active. No price, stock, or promotion changes were found.";
    return "The move feed will populate as competitor changes are detected.";
  }
  if (state === "LOW_CONFIDENCE") {
    return "Response recommendations appear after VedaSuite confirms stronger comparable matches.";
  }
  if (state === "NO_MATCHES") {
    return "Response recommendations appear after VedaSuite finds comparable competitor products.";
  }
  if (state === "NO_CHANGES") {
    return "Matched products are active, but no response action is needed right now.";
  }
  return "Response guidance will appear here when competitor pressure increases.";
}

export function CompetitorPage() {
  const { getProductUrl } = useShopifyAdminLinks();
  const [searchParams] = useSearchParams();
  const { appState } = useAppState();
  const { subscription, loading: subscriptionLoading } = useSubscriptionPlan();
  const [rows, setRows] = useState<CompetitorRow[]>(
    readModuleCache<CompetitorRow[]>("competitor-rows") ?? []
  );
  const [overview, setOverview] = useState<CompetitorOverview>(
    readModuleCache<CompetitorOverview>("competitor-overview") ?? createEmptyOverview()
  );
  const [connectors, setConnectors] = useState<CompetitorConnector[]>(
    readModuleCache<CompetitorConnector[]>("competitor-connectors") ?? []
  );
  const [responseEngine, setResponseEngine] = useState<CompetitorResponseEngine>(
    readModuleCache<CompetitorResponseEngine>("competitor-response-engine") ??
      createEmptyResponseEngine()
  );
  const [selectedTab, setSelectedTab] = useState(0);
  const [modalOpen, setModalOpen] = useState(false);
  const [ingesting, setIngesting] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [domainsInput, setDomainsInput] = useState("");

  const allowed = isBackendModuleEnabled(appState, "competitor");
  const canSeeWeeklyReports =
    subscription?.capabilities?.["competitor.weeklyReports"] ?? false;
  const focus = searchParams.get("focus");
  const primaryState = overview.competitorState?.primaryState ?? "SETUP_INCOMPLETE";
  const showOperationalPanels = primaryState !== "SETUP_INCOMPLETE";

  useEffect(() => {
    setSelectedTab(focus === "feed" ? 1 : focus === "strategy" ? 2 : 0);
  }, [focus]);

  useEffect(() => {
    if (allowed) {
      return;
    }

    const emptyOverview = createEmptyOverview();
    setRows([]);
    setOverview(emptyOverview);
    setConnectors([]);
    setResponseEngine(createEmptyResponseEngine());
    writeModuleCache("competitor-rows", []);
    writeModuleCache("competitor-overview", emptyOverview);
    writeModuleCache("competitor-connectors", []);
    writeModuleCache("competitor-response-engine", createEmptyResponseEngine());
  }, [allowed]);

  useEffect(() => {
    if (!allowed) return;
    let mounted = true;

    Promise.all([
      embeddedShopRequest<{ products: CompetitorRow[] }>("/api/competitor/products", {
        timeoutMs: 30000,
      }),
      embeddedShopRequest<CompetitorOverview>("/api/competitor/overview", {
        timeoutMs: 30000,
      }),
      embeddedShopRequest<{ connectors: CompetitorConnector[] }>("/api/competitor/connectors", {
        timeoutMs: 30000,
      }),
      embeddedShopRequest<{ responseEngine: CompetitorResponseEngine }>(
        "/api/competitor/response-engine",
        { timeoutMs: 30000 }
      ),
    ])
      .then(
        ([productsResponse, overviewResponse, connectorsResponse, responseEngineResponse]) => {
          if (!mounted) return;
          const nextOverview = normalizeOverview(overviewResponse);
          const nextResponseEngine =
            responseEngineResponse.responseEngine ?? createEmptyResponseEngine();
          setRows(productsResponse.products);
          setOverview(nextOverview);
          setConnectors(connectorsResponse.connectors);
          setResponseEngine(nextResponseEngine);
          writeModuleCache("competitor-rows", productsResponse.products);
          writeModuleCache("competitor-overview", nextOverview);
          writeModuleCache("competitor-connectors", connectorsResponse.connectors);
          writeModuleCache("competitor-response-engine", nextResponseEngine);
        }
      )
      .catch(() => {
        if (!mounted) return;
        setOverview(createEmptyOverview());
        setConnectors([]);
        setResponseEngine(createEmptyResponseEngine());
        setToast("Competitor analysis could not be loaded. Please try again.");
      });

    return () => {
      mounted = false;
    };
  }, [allowed]);

  const visibleRows = useMemo(() => {
    if (focus === "promotions") return rows.filter((row) => !!row.promotion);
    if (focus === "stock") {
      return rows.filter(
        (row) => row.stockStatus === "low_stock" || row.stockStatus === "out_of_stock"
      );
    }
    return rows;
  }, [focus, rows]);

  const refreshCompetitorState = async (merchantMessage?: string | null) => {
    const [productsResponse, overviewResponse, connectorsResponse, responseEngineResponse] =
      await Promise.all([
        embeddedShopRequest<{ products: CompetitorRow[] }>("/api/competitor/products", {
          timeoutMs: 30000,
        }),
        embeddedShopRequest<CompetitorOverview>("/api/competitor/overview", {
          timeoutMs: 30000,
        }),
        embeddedShopRequest<{ connectors: CompetitorConnector[] }>("/api/competitor/connectors", {
          timeoutMs: 30000,
        }),
        embeddedShopRequest<{ responseEngine: CompetitorResponseEngine }>(
          "/api/competitor/response-engine",
          { timeoutMs: 30000 }
        ),
      ]);

    const nextOverview = normalizeOverview(overviewResponse);
    const nextResponseEngine =
      responseEngineResponse.responseEngine ?? createEmptyResponseEngine();
    setRows(productsResponse.products);
    setOverview(nextOverview);
    setConnectors(connectorsResponse.connectors);
    setResponseEngine(nextResponseEngine);
    writeModuleCache("competitor-rows", productsResponse.products);
    writeModuleCache("competitor-overview", nextOverview);
    writeModuleCache("competitor-connectors", connectorsResponse.connectors);
    writeModuleCache("competitor-response-engine", nextResponseEngine);
    setToast(merchantMessage ?? nextOverview.competitorState?.toastMessage ?? null);
  };

  const saveDomains = async () => {
    const domains = domainsInput
      .split(",")
      .map((domain) => domain.trim())
      .filter(Boolean)
      .map((domain) => ({ domain }));

    try {
      await embeddedShopRequest("/api/competitor/domains", {
        method: "POST",
        body: { domains },
        timeoutMs: 30000,
      });
      await refreshCompetitorState(
        domains.length > 0
          ? "Competitor websites updated."
          : "Competitor websites cleared."
      );
      setModalOpen(false);
    } catch {
      setToast("Unable to update competitor domains.");
    }
  };

  const ingestCompetitorData = async () => {
    try {
      setIngesting(true);
      const ingestResponse = await embeddedShopRequest<{
        result: { merchantMessage?: string | null };
      }>("/api/competitor/ingest", { method: "POST", timeoutMs: 45000 });
      await refreshCompetitorState(ingestResponse.result.merchantMessage ?? null);
    } catch {
      setToast("Competitor analysis failed. Please try again.");
    } finally {
      setIngesting(false);
    }
  };

  const handlePrimaryAction = () => {
    if (primaryState === "SETUP_INCOMPLETE") {
      setModalOpen(true);
      return;
    }
    if (primaryState === "CHANGES_DETECTED") {
      setSelectedTab(1);
      return;
    }
    if (primaryState === "LOW_CONFIDENCE") {
      setSelectedTab(0);
      return;
    }
    void ingestCompetitorData();
  };

  const summaryCards = [
    ["Comparable matches", overview.competitorState?.validMatchedProductsCount ?? overview.competitorState?.matchedProductsCount ?? 0],
    ["Low-confidence matches", overview.competitorState?.lowConfidenceMatchesCount ?? 0],
    ["Active promotions", overview.competitorState?.activePromotionsCount ?? 0],
    ["Stock alerts", overview.competitorState?.stockAlertsCount ?? 0],
    ["Domains reviewed", overview.competitorState?.checkedDomainsCount ?? 0],
    ["Analysis recency", overview.competitorState?.freshnessLabel ?? "Unknown"],
    ["Coverage status", overview.competitorState?.coverageStatus ?? "Unknown"],
  ];

  const analysisStatusRows = [
    ["Primary state", overview.competitorState?.title ?? "Unknown"],
    [
      "Last successful analysis",
      formatDateTime(overview.competitorState?.lastSuccessfulRunAt),
    ],
    ["Last analysis attempt", formatDateTime(overview.competitorState?.lastAttemptAt)],
    ["Domains reviewed", String(overview.competitorState?.checkedDomainsCount ?? 0)],
    ["Eligible products reviewed", String(overview.competitorState?.monitoredProductsCount ?? overview.productCoverage?.eligibleProductsCount ?? 0)],
    ["Comparable matches", String(overview.competitorState?.validMatchedProductsCount ?? overview.competitorState?.matchedProductsCount ?? 0)],
    ["Low-confidence matches", String(overview.competitorState?.lowConfidenceMatchesCount ?? 0)],
    ["Coverage status", overview.competitorState?.coverageStatus ?? "Unknown"],
  ];

  const sourceBreakdown = overview.sourceBreakdown ?? {
    website: 0,
    googleShopping: 0,
    metaAds: 0,
  };

  return (
    <ModuleGate
      title="Competitor Intelligence"
      subtitle="Track competitor pricing, promotions, stock posture, and response opportunities across key domains."
      requiredPlan="Starter, Growth, or Pro"
      allowed={allowed}
      featureKey="competitor"
    >
      <Page
        title="Competitor Intelligence"
        subtitle={getPageSubtitle(primaryState)}
        primaryAction={{
          content: ingesting ? "Refreshing..." : getPrimaryActionLabel(primaryState),
          onAction: handlePrimaryAction,
          disabled: ingesting,
        }}
        secondaryActions={[{ content: "Update domains", onAction: () => setModalOpen(true) }]}
      >
        <Layout>
          {subscriptionLoading ? (
            <Layout.Section>
              <Banner title="Loading competitor analysis" tone="info">
                <p>VedaSuite is loading competitor insights and response guidance.</p>
              </Banner>
            </Layout.Section>
          ) : null}

          <Layout.Section>
            <Banner
              title={overview.competitorState?.title ?? "Competitor analysis"}
              tone={getBannerTone(primaryState)}
            >
              <BlockStack gap="200">
                <Text as="p">{overview.competitorState?.description}</Text>
                <Text as="p" tone="subdued">
                  {overview.competitorState?.nextAction}
                </Text>
                <InlineStack gap="300">
                  <Button onClick={handlePrimaryAction} disabled={ingesting}>
                    {getPrimaryActionLabel(primaryState)}
                  </Button>
                  <Button variant="secondary" onClick={() => setModalOpen(true)}>
                    Update domains
                  </Button>
                </InlineStack>
              </BlockStack>
            </Banner>
          </Layout.Section>

          {showOperationalPanels ? (
            <Layout.Section>
              <InlineGrid columns={{ xs: 1, md: 3 }} gap="400">
                {summaryCards.map(([label, value]) => (
                  <Card key={String(label)}>
                    <BlockStack gap="150">
                      <Text as="h3" variant="headingMd">
                        {String(label)}
                      </Text>
                      <Text as="p" variant="headingLg">
                        {String(value)}
                      </Text>
                    </BlockStack>
                  </Card>
                ))}
              </InlineGrid>
            </Layout.Section>
          ) : null}

          <Layout.Section>
            <InlineGrid columns={{ xs: 1, md: showOperationalPanels ? 2 : 1 }} gap="400">
              <Card>
                <BlockStack gap="300">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="h3" variant="headingMd">
                      What to do next
                    </Text>
                    <Badge tone={getBannerTone(primaryState)}>
                      {overview.competitorState?.coverageStatus}
                    </Badge>
                  </InlineStack>
                  <Text as="p" tone="subdued">
                    {overview.competitorState?.actionPanel?.explanation ??
                      overview.competitorState?.confidenceExplanation ??
                      overview.competitorState?.description}
                  </Text>
                  <BlockStack gap="150">
                    {(
                      overview.competitorState?.actionPanel?.actions?.length
                        ? overview.competitorState.actionPanel.actions
                        : overview.actionSuggestions?.length
                        ? overview.actionSuggestions.map((item) => `${item.productHandle}: ${item.suggestion}`)
                        : [overview.competitorState?.nextAction ?? "Review competitor analysis."]
                    ).map((item) => (
                      <Text key={item} as="p">
                        - {item}
                      </Text>
                    ))}
                  </BlockStack>
                </BlockStack>
              </Card>

              {showOperationalPanels ? (
                <Card>
                <BlockStack gap="300">
                  <Text as="h3" variant="headingMd">
                    Analysis status
                  </Text>
                  <BlockStack gap="200">
                    {analysisStatusRows.map(([label, value]) => (
                      <InlineStack key={label} align="space-between" blockAlign="start">
                        <Text as="p" variant="bodySm" tone="subdued">
                          {label}
                        </Text>
                        <Text as="p" alignment="end">
                          {value}
                        </Text>
                      </InlineStack>
                    ))}
                  </BlockStack>
                </BlockStack>
                </Card>
              ) : null}
            </InlineGrid>
          </Layout.Section>

          {showOperationalPanels ? (
          <Layout.Section>
            <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
              <Card>
                <BlockStack gap="250">
                  <Text as="h3" variant="headingMd">
                    Match quality and catalog coverage
                  </Text>
                  <Text as="p" tone="subdued">
                    {overview.productCoverage?.explanation ??
                      "Only strong, comparable competitor matches are shown in the main tables."}
                  </Text>
                  <Text as="p" variant="bodySm">
                    Eligible active products: {overview.productCoverage?.eligibleProductsCount ?? 0}
                  </Text>
                  <Text as="p" variant="bodySm">
                    Excluded products: {overview.productCoverage?.excludedProductsCount ?? 0}
                  </Text>
                  <BlockStack gap="100">
                    <Text as="p" variant="bodySm" tone="subdued">
                      Not included in analysis
                    </Text>
                    <Text as="p" variant="bodySm">
                      Archived: {overview.productCoverage?.excludedProducts.archived ?? 0}
                    </Text>
                    <Text as="p" variant="bodySm">
                      Draft: {overview.productCoverage?.excludedProducts.draft ?? 0}
                    </Text>
                    <Text as="p" variant="bodySm">
                      Gift-card-like: {overview.productCoverage?.excludedProducts.giftCardLike ?? 0}
                    </Text>
                    <Text as="p" variant="bodySm">
                      Missing price: {overview.productCoverage?.excludedProducts.missingPrice ?? 0}
                    </Text>
                  </BlockStack>
                </BlockStack>
              </Card>

              <Card>
                <BlockStack gap="250">
                  <Text as="h3" variant="headingMd">
                    Why products did or did not match
                  </Text>
                  <Text as="p" tone="subdued">
                    {overview.competitorState?.confidenceExplanation ??
                      "VedaSuite only shows comparable matches after it confirms strong live product evidence."}
                  </Text>
                  {(overview.lowConfidenceRows ?? []).length > 0 ? (
                    <BlockStack gap="150">
                      {(overview.lowConfidenceRows ?? []).map((row) => (
                        <Text key={row.id} as="p" variant="bodySm">
                          - {row.productHandle} on {row.competitorName}: {row.matchReason} ({row.confidenceLabel} confidence)
                        </Text>
                      ))}
                    </BlockStack>
                  ) : (
                    <Text as="p" variant="bodySm">
                      No low-confidence matches are being shown right now.
                    </Text>
                  )}
                </BlockStack>
              </Card>
            </InlineGrid>
          </Layout.Section>
          ) : null}

          {showOperationalPanels ? (
          <Layout.Section>
            <Card>
              <Tabs
                tabs={[
                  { id: "tracked", content: "Tracked products" },
                  { id: "feed", content: "Move feed & signals" },
                  { id: "strategy", content: "Response strategy" },
                ]}
                selected={selectedTab}
                onSelect={setSelectedTab}
              >
                <Box paddingBlockStart="400">
                  {selectedTab === 0 ? (
                    visibleRows.length === 0 ? (
                      <Card>
                        <BlockStack gap="200">
                          <Text as="h3" variant="headingMd">
                            No tracked products to review
                          </Text>
                          <Text as="p" tone="subdued">
                            {getEmptyMessage(primaryState, "tracked")}
                          </Text>
                        </BlockStack>
                      </Card>
                    ) : (
                      <IndexTable
                        resourceName={resourceName}
                        itemCount={visibleRows.length}
                        selectable={false}
                        headings={[
                          { title: "Product" },
                          { title: "Competitor" },
                          { title: "Price" },
                          { title: "Confidence" },
                          { title: "Promotion" },
                          { title: "Stock" },
                          { title: "Shopify" },
                        ]}
                      >
                        {visibleRows.map((row, index) => (
                          <IndexTable.Row id={row.id} key={row.id} position={index}>
                            <IndexTable.Cell>{row.productHandle}</IndexTable.Cell>
                            <IndexTable.Cell>{row.competitorName}</IndexTable.Cell>
                            <IndexTable.Cell>
                              {row.price != null ? `$${row.price.toFixed(2)}` : "-"}
                            </IndexTable.Cell>
                            <IndexTable.Cell>
                              {row.confidenceLabel ? (
                                <BlockStack gap="100">
                                  <Badge
                                    tone={
                                      row.confidenceLabel === "high"
                                        ? "success"
                                        : row.confidenceLabel === "medium"
                                        ? "attention"
                                        : "info"
                                    }
                                  >
                                    {row.confidenceLabel}
                                  </Badge>
                                  {row.matchReason ? (
                                    <Text as="p" variant="bodySm" tone="subdued">
                                      {row.matchReason}
                                    </Text>
                                  ) : null}
                                </BlockStack>
                              ) : (
                                "-"
                              )}
                            </IndexTable.Cell>
                            <IndexTable.Cell>
                              {row.promotion ? <Badge tone="info">{row.promotion}</Badge> : "-"}
                            </IndexTable.Cell>
                            <IndexTable.Cell>{row.stockStatus ?? "-"}</IndexTable.Cell>
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
                  ) : selectedTab === 1 ? (
                    <BlockStack gap="300">
                      <InlineGrid columns={{ xs: 1, md: 3 }} gap="300">
                        {[
                          ["Website", sourceBreakdown.website],
                          ["Shopping beta", sourceBreakdown.googleShopping],
                          ["Ad-library beta", sourceBreakdown.metaAds],
                        ].map(([label, value]) => (
                          <Card key={String(label)}>
                            <BlockStack gap="150">
                              <Text as="p" variant="bodySm" tone="subdued">
                                {String(label)}
                              </Text>
                              <Text as="p" variant="headingLg">
                                {String(value)}
                              </Text>
                            </BlockStack>
                          </Card>
                        ))}
                      </InlineGrid>

                      {(overview.moveFeed ?? []).length === 0 ? (
                        <Card>
                          <BlockStack gap="200">
                            <Text as="h3" variant="headingMd">
                              No move feed items yet
                            </Text>
                            <Text as="p" tone="subdued">
                              {getEmptyMessage(primaryState, "feed")}
                            </Text>
                          </BlockStack>
                        </Card>
                      ) : (
                        (overview.moveFeed ?? []).map((item) => (
                          <Card key={item.id}>
                            <BlockStack gap="200">
                              <InlineStack align="space-between" blockAlign="start">
                                <BlockStack gap="100">
                                  <Text as="p" variant="headingSm">
                                    {item.headline}
                                  </Text>
                                  <Text as="p" tone="subdued">
                                    {`${item.moveType} via ${item.source}`}
                                  </Text>
                                  <Text as="p">{item.whyItMatters}</Text>
                                  <Text as="p" variant="bodySm">
                                    Recommended action: {item.suggestedAction}
                                  </Text>
                                </BlockStack>
                                <Badge tone={toneForPriority(item.priority)}>
                                  {item.priority}
                                </Badge>
                              </InlineStack>
                            </BlockStack>
                          </Card>
                        ))
                      )}
                    </BlockStack>
                  ) : (
                    <BlockStack gap="300">
                      <Card>
                        <BlockStack gap="200">
                          <Text as="h3" variant="headingMd">
                            Response strategy
                          </Text>
                          <Text as="p" tone="subdued">
                            {responseEngine.summary.automationReadiness}
                          </Text>
                        </BlockStack>
                      </Card>

                      {(responseEngine.responsePlans ?? []).length === 0 ? (
                        <Card>
                          <BlockStack gap="200">
                            <Text as="h3" variant="headingMd">
                              No active response recommendations
                            </Text>
                            <Text as="p" tone="subdued">
                              {getEmptyMessage(primaryState, "strategy")}
                            </Text>
                          </BlockStack>
                        </Card>
                      ) : (
                        (responseEngine.responsePlans ?? []).slice(0, 4).map((item) => (
                          <Card key={`${item.productHandle}-strategy`}>
                            <BlockStack gap="200">
                              <InlineStack align="space-between" blockAlign="start">
                                <BlockStack gap="100">
                                  <Text as="p" variant="headingSm">
                                    {item.productHandle}
                                  </Text>
                                  <Text as="p" tone="subdued">
                                    {item.rationale}
                                  </Text>
                                  <Text as="p" variant="bodySm">
                                    {item.executionHint}
                                  </Text>
                                </BlockStack>
                                <Badge tone={item.pressureScore >= 70 ? "critical" : "attention"}>
                                  {`${item.pressureScore}/100`}
                                </Badge>
                              </InlineStack>
                              <InlineStack gap="200">
                                <Badge tone="info">{item.automationPosture}</Badge>
                                <Badge tone="info">{item.recommendedPlay}</Badge>
                              </InlineStack>
                            </BlockStack>
                          </Card>
                        ))
                      )}
                    </BlockStack>
                  )}
                </Box>
              </Tabs>
            </Card>
          </Layout.Section>
          ) : null}

          {showOperationalPanels ? (
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <Text as="h3" variant="headingMd">
                  Channel and connector status
                </Text>
                <InlineGrid columns={{ xs: 1, md: 3 }} gap="300">
                  {connectors.map((connector) => (
                    <Card key={connector.id}>
                      <BlockStack gap="200">
                        <InlineStack align="space-between" blockAlign="center">
                          <Text as="h3" variant="headingMd">
                            {connector.label}
                          </Text>
                          <Badge
                            tone={
                              connector.readiness === "Live"
                                ? "success"
                                : connector.readiness === "Configured"
                                ? "info"
                                : connector.readiness === "Beta"
                                ? "attention"
                                : "subdued"
                            }
                          >
                            {connector.readiness ?? "Not enabled"}
                          </Badge>
                        </InlineStack>
                        <Text as="p" tone="subdued">
                          {connector.description}
                        </Text>
                        <Text as="p" variant="bodySm" tone="subdued">
                          {`Targets: ${connector.trackedTargets}`}
                        </Text>
                        <Text as="p" variant="bodySm" tone="subdued">
                          {connector.lastIngestedAt
                            ? `Last pulled ${formatDateTime(connector.lastIngestedAt)}`
                            : "No data pulled yet"}
                        </Text>
                        <Text as="p" variant="bodySm">
                          {connector.action ?? "No action needed"}
                        </Text>
                      </BlockStack>
                    </Card>
                  ))}
                </InlineGrid>
              </BlockStack>
            </Card>
          </Layout.Section>
          ) : null}

          {canSeeWeeklyReports &&
          (primaryState === "NO_CHANGES" || primaryState === "CHANGES_DETECTED") ? (
            <Layout.Section>
              <Card>
                <BlockStack gap="200">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="h3" variant="headingMd">
                      Weekly market brief
                    </Text>
                    <Badge tone="success">Included</Badge>
                  </InlineStack>
                  <Text as="p" variant="headingSm">
                    {overview.weeklyReport?.headline}
                  </Text>
                  <Text as="p" tone="subdued">
                    {overview.weeklyReport?.whyItMatters}
                  </Text>
                  <Text as="p" variant="bodySm">
                    {overview.weeklyReport?.merchantBrief}
                  </Text>
                  <Text as="p" variant="bodySm">
                    Next step: {overview.weeklyReport?.nextBestAction}
                  </Text>
                </BlockStack>
              </Card>
            </Layout.Section>
          ) : null}
        </Layout>

        <Modal
          open={modalOpen}
          onClose={() => setModalOpen(false)}
          title="Competitor tracking domains"
          primaryAction={{ content: "Save domains", onAction: saveDomains }}
        >
          <Modal.Section>
            <BlockStack gap="300">
              <Text as="p">
                Add domains to monitor for competitor price, promotion, and stock changes.
              </Text>
              <TextField
                label="Domains"
                value={domainsInput}
                onChange={setDomainsInput}
                autoComplete="off"
                multiline={4}
              />
            </BlockStack>
          </Modal.Section>
        </Modal>

        {toast ? <Toast content={toast} onDismiss={() => setToast(null)} /> : null}
      </Page>
    </ModuleGate>
  );
}

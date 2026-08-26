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
  List,
  Modal,
  Page,
  Tabs,
  Text,
  TextField,
  Toast,
} from "@shopify/polaris";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { ModuleGate } from "../../components/ModuleGate";
import { useAppState } from "../../hooks/useAppState";
import { useShopifyAdminLinks } from "../../hooks/useShopifyAdminLinks";
import { useSubscriptionPlan } from "../../hooks/useSubscriptionPlan";
import { isBackendModuleEnabled } from "../../lib/backendModuleAccess";
import { embeddedShopRequest } from "../../lib/embeddedShopRequest";
import { readModuleCache, writeModuleCache } from "../../lib/moduleCache";
import { ModuleInsights } from "../Dashboard/components/ModuleInsights";

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
  competitorProductTitle?: string | null;
  competitorProductHandle?: string | null;
  catalogObservation?: boolean;
};

type CompetitorOverview = {
  competitorState?: {
    primaryState: CompetitorPrimaryState;
    freshnessLabel: string;
    lastSuccessfulRunAt?: string | null;
    lastAttemptAt?: string | null;
    /** Domains that actually yielded evidence on the latest run. */
    checkedDomainsCount: number;
    attemptedDomainsCount?: number;
    refreshedDomainsCount?: number;
    /** Merchant-safe explanations only. No Node error strings are sent. */
    failedDomains?: Array<{
      domain: string;
      status: string | null;
      message: string;
      lastAttemptAt?: string | null;
      lastSuccessAt?: string | null;
    }>;
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
        "No competitor domains added. VedaSuite can only read prices from sites you name, so add at least one domain to begin.",
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
        "No response guidance: no competitor product has been matched to yours, so there is nothing to respond to.",
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
      return "VedaSuite reached your competitor pages but could not match any of their products to yours. Matching needs comparable titles or handles on both sides.";
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
    if (state === "AWAITING_FIRST_RUN") return "Domains added, but never collected. Run an analysis so VedaSuite can fetch each competitor page and try to match it to your products.";
    if (state === "NO_MATCHES") return "Competitor analysis completed. No matching products were identified yet.";
    if (state === "LOW_CONFIDENCE") return "Possible matches were found, but their match confidence is too low to compare prices against. A weak match produces a wrong gap, so they are held back rather than shown.";
    return "No competitor rows collected yet. Each row needs a domain that VedaSuite could reach and read on its last attempt.";
  }
  if (tab === "feed") {
    if (state === "NO_MATCHES") return "No actions yet: none of the collected competitor products matched anything in your catalog, so there is no price to compare.";
    if (state === "LOW_CONFIDENCE") return "No actions yet: the matches found are below the confidence VedaSuite requires before it will state a price gap.";
    if (state === "NO_CHANGES") return "Collection is working and matches are current. Nothing has changed on your competitors since the last successful check.";
    return "No competitor changes recorded yet. This feed fills when a matched competitor price, stock state or promotion actually moves.";
  }
  if (state === "LOW_CONFIDENCE") {
    return "No response guidance: current matches are too low-confidence to base a pricing response on.";
  }
  if (state === "NO_MATCHES") {
    return "Response recommendations appear after VedaSuite finds comparable competitor products.";
  }
  if (state === "NO_CHANGES") {
    return "Matches are current and no competitor has moved, so no response is needed right now.";
  }
  return "No response guidance yet. It appears when a matched competitor is priced below you on evidence that is current.";
}

export function CompetitorPage() {
  const { getProductUrl } = useShopifyAdminLinks();
  const [searchParams] = useSearchParams();
  const { appState, refresh } = useAppState();
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
  const tabsSectionRef = useRef<HTMLDivElement | null>(null);
  const [ingesting, setIngesting] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [domainsInput, setDomainsInput] = useState("");

  const allowed = isBackendModuleEnabled(appState, "competitor");
  // The client's cached entitlement can go stale right after a billing
  // change (e.g. cancelling a subscription). The backend's
  // requireFeature("competitor") middleware is the real source of truth
  // and correctly rejects with a 403 FEATURE_LOCKED in that case — track
  // that separately so ModuleGate shows the correct upgrade-required UI
  // instead of a confusing generic "could not load" toast.
  const [planLocked, setPlanLocked] = useState(false);
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
      .catch((err) => {
        if (!mounted) return;
        const code = err instanceof Error ? (err as Error & { code?: string }).code : undefined;
        if (code === "REAUTHORIZE_REQUIRED") { void refresh(); return; }
        if (code === "FEATURE_LOCKED") {
          setPlanLocked(true);
          return;
        }
        setOverview(createEmptyOverview());
        setConnectors([]);
        setResponseEngine(createEmptyResponseEngine());
        setToast(
          err instanceof Error
            ? err.message
            : "Competitor analysis could not be loaded. Please try again."
        );
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
      .split(/[\s,]+/)
      .map((domain) => domain.trim())
      .filter(Boolean)
      .map((domain) => ({ domain }));

    // Toast renders at the bottom of the scrollable frame — invisible
    // without scrolling back up if triggered while scrolled down.
    window.scrollTo({ top: 0, behavior: "smooth" });

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
    // Toast renders at the bottom of the scrollable frame — invisible
    // without scrolling back up if triggered while scrolled down.
    window.scrollTo({ top: 0, behavior: "smooth" });
    try {
      setIngesting(true);
      const ingestResponse = await embeddedShopRequest<{
        result: { merchantMessage?: string | null };
      }>("/api/competitor/ingest", { method: "POST", timeoutMs: 180000 });
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
      setToast("Market Signals loaded — scroll down to 'Move feed & signals' tab.");
      window.setTimeout(() => {
        tabsSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 50);
      return;
    }
    if (primaryState === "LOW_CONFIDENCE") {
      setSelectedTab(0);
      setToast("Review low-confidence matches — scroll down to 'Tracked products' tab.");
      window.setTimeout(() => {
        tabsSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 50);
      return;
    }
    void ingestCompetitorData();
  };

  const summaryCards = [
    ["Comparable matches", overview.competitorState?.validMatchedProductsCount ?? overview.competitorState?.matchedProductsCount ?? 0],
    ["Low-confidence matches", overview.competitorState?.lowConfidenceMatchesCount ?? 0],
    ["Active promotions", overview.competitorState?.activePromotionsCount ?? 0],
    ["Stock alerts", overview.competitorState?.stockAlertsCount ?? 0],
    // "Domains reviewed: 3" counted domains that were ATTEMPTED, including one
    // whose certificate had expired. Refreshed and attempted are now shown
    // together so the number cannot imply evidence that was never collected.
    [
      "Domains refreshed",
      `${overview.competitorState?.refreshedDomainsCount ?? overview.competitorState?.checkedDomainsCount ?? 0} of ${overview.competitorState?.attemptedDomainsCount ?? 0}`,
    ],
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
    [
      "Domains refreshed",
      `${overview.competitorState?.refreshedDomainsCount ?? overview.competitorState?.checkedDomainsCount ?? 0} of ${overview.competitorState?.attemptedDomainsCount ?? 0}`,
    ],
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
      title="Market Signals"
      subtitle="Signals read from competitor pages VedaSuite could reach. Each domain reports whether its last check actually succeeded."
      requiredPlan="Starter, Growth, or Pro"
      allowed={allowed && !planLocked}
      featureKey="competitor"
    >
      <Page
        title="Market Signals"
        subtitle={getPageSubtitle(primaryState)}
        primaryAction={{
          content: ingesting ? "Refreshing..." : getPrimaryActionLabel(primaryState),
          onAction: handlePrimaryAction,
          disabled: ingesting,
        }}
        secondaryActions={[
          // Only offer a separate "Run analysis" when the primary action does
          // something else (it navigates to a tab in these two states).
          // Otherwise the header would render two identical buttons.
          ...(primaryState === "CHANGES_DETECTED" || primaryState === "LOW_CONFIDENCE"
            ? [
                {
                  content: ingesting ? "Running..." : "Run analysis",
                  onAction: () => void ingestCompetitorData(),
                  disabled: ingesting,
                },
              ]
            : []),
          { content: "Update domains", onAction: () => setModalOpen(true) },
        ]}
      >
        <Layout>
          {/*
            A domain that failed must be VISIBLE, not merely absent from a
            count. The message comes from the backend, which rebuilds it from
            the stored status — the raw technical detail ("CERT_HAS_EXPIRED:
            fetch failed") lives on a column that is never serialised here.
            The domain is shown exactly as the merchant typed it; VedaSuite
            does not guess at a correction.
          */}
          {(overview.competitorState?.failedDomains ?? []).length > 0 ? (
            <Layout.Section>
              <Banner
                tone="warning"
                title={`${overview.competitorState?.refreshedDomainsCount ?? 0} of ${overview.competitorState?.attemptedDomainsCount ?? 0} domains refreshed`}
              >
                <BlockStack gap="200">
                  <Text as="p">
                    The figures on this page do not include fresh data from the
                    domains below. Anything shown for them comes from earlier
                    stored data, not from this run.
                  </Text>
                  <List type="bullet">
                    {(overview.competitorState?.failedDomains ?? []).map((entry) => (
                      <List.Item key={entry.domain}>{entry.message}</List.Item>
                    ))}
                  </List>
                </BlockStack>
              </Banner>
            </Layout.Section>
          ) : null}
          <Layout.Section>
            <ModuleInsights
              modules={["competitor"]}
              title="Open market signal findings"
              pressureLabel="Market pressure"
              pressureCaption="Weighted from the urgency of current competitor price and promotion findings."
              emptyWhy="Competitor findings only appear once VedaSuite has fresh, confidently matched competitor prices to compare against your own — stale or low-confidence matches are deliberately excluded rather than guessed at."
              emptySteps={[
                "Add competitor domains to track on this page",
                "Run an analysis so competitor prices are collected",
                "Add product cost and selling price so price gaps can be valued",
              ]}
            />
          </Layout.Section>
          {subscriptionLoading ? (
            <Layout.Section>
              <Banner title="Loading competitor analysis" tone="info">
                <p>VedaSuite is loading competitor insights and response guidance.</p>
              </Banner>
            </Layout.Section>
          ) : null}

          {ingesting ? (
            <Layout.Section>
              <Banner title="Running competitor analysis — this takes 1–3 minutes" tone="info">
                <p>VedaSuite is crawling your competitor domains and matching products. Do not close this page. The results will appear automatically when done.</p>
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
                <BlockStack gap="200">
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
                <BlockStack gap="200">
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
            <div ref={tabsSectionRef}>
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
                          { title: "Competitor site" },
                          { title: "Price" },
                          { title: "Confidence" },
                          { title: "Promotion" },
                          { title: "Stock" },
                          { title: "Shopify" },
                        ]}
                      >
                        {visibleRows.map((row, index) => (
                          <IndexTable.Row id={row.id} key={row.id} position={index}>
                            <IndexTable.Cell>
                              <BlockStack gap="100">
                                <Text as="span">
                                  {row.competitorProductTitle ?? row.productHandle}
                                </Text>
                                {row.catalogObservation ? (
                                  <Text as="span" variant="bodySm" tone="subdued">
                                    Competitor catalog product
                                  </Text>
                                ) : row.competitorProductHandle ? (
                                  <Text as="span" variant="bodySm" tone="subdued">
                                    Matched with {row.competitorProductHandle}
                                  </Text>
                                ) : null}
                              </BlockStack>
                            </IndexTable.Cell>
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
                              {row.catalogObservation ? (
                                <Button url={row.competitorUrl} external>
                                  Competitor
                                </Button>
                              ) : getProductUrl(row.productHandle) ? (
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
            </div>
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
                                : undefined
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
          title="Market Signals domains"
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

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
import { useShopifyAdminLinks } from "../../hooks/useShopifyAdminLinks";
import { useSubscriptionPlan } from "../../hooks/useSubscriptionPlan";
import { embeddedShopRequest } from "../../lib/embeddedShopRequest";
import { readModuleCache, writeModuleCache } from "../../lib/moduleCache";

type CompetitorRow = {
  id: string;
  productHandle: string;
  competitorName: string;
  competitorUrl: string;
  price?: number | null;
  promotion?: string | null;
  stockStatus?: string | null;
  source?: string;
  adCopy?: string | null;
};

type CompetitorOverview = {
  monitoringStatus?: {
    setupStatus: string;
    syncStatus: string;
    crawlStatus: string;
    snapshotStatus: string;
    freshnessStatus: string;
    lastSuccessAt?: string | null;
    lastAttemptAt?: string | null;
    checkedDomainsCount: number;
    monitoredProductsCount: number;
    matchedProductsCount: number;
    detectedPriceChangesCount: number;
    detectedPromotionChangesCount: number;
    latestSyncReason?: string | null;
  };
  readiness?: {
    readinessState: string;
    reason: string;
    processingState?: string;
    lastUpdatedAt?: string | null;
  };
  recentPriceChanges: number;
  promotionAlerts: number;
  stockMovementAlerts: number;
  trackedDomains: number;
  lastIngestedAt?: string | null;
  freshnessHours?: number | null;
  promotionalHeat?: string;
  marketPressure?: string;
  adPressure?: string;
  launchAlerts?: Array<{
    productHandle: string;
    competitorName: string;
    source: string;
    collectedAt: string;
  }>;
  sourceBreakdown?: { website: number; googleShopping: number; metaAds: number };
  topMovers?: Array<{
    productHandle: string;
    priceDelta: number;
    promotionSignals: number;
    stockSignals: number;
  }>;
  moveFeed?: Array<{
    id: string;
    headline: string;
    moveType: string;
    source: string;
    priority: string;
    impactScore: number;
    actionWindow?: string;
    eventCluster?: string;
    whyItMatters: string;
    suggestedAction: string;
    collectedAt: string;
  }>;
  strategyDetections?: Array<{
    strategy: string;
    signalStrength: string;
    why: string;
    implication: string;
    recommendedMove: string;
  }>;
  actionSuggestions?: Array<{
    productHandle: string;
    suggestion: string;
    why: string;
    urgency?: string;
    expectedOutcome?: string;
  }>;
  weeklyReport?: {
    headline: string;
    whyItMatters: string;
    suggestedActions: string[];
    reportReadiness: string;
    biggestMoves?: Array<{
      headline: string;
      impactScore: number;
      suggestedAction: string;
    }>;
    merchantBrief?: string;
    nextBestAction?: string;
  };
  coverageSummary?: {
    domainsConfigured: number;
    channelsReady: string[];
    monitoringPosture: string;
  };
};

type CompetitorConnector = {
  id: string;
  label: string;
  description: string;
  connected: boolean;
  trackedTargets: number;
  lastIngestedAt?: string | null;
  readiness?: string;
};

type CompetitorResponseEngine = {
  summary: {
    responseMode: string;
    topPressureCount: number;
    automationReadiness: string;
  };
  responsePlans: Array<{
    productHandle: string;
    pressureScore: number;
    recommendedPlay: string;
    rationale: string;
    priceDelta: number;
    promotionSignals: number;
    stockSignals: number;
    sourceCount: number;
    confidence: number;
    reasons: string[];
    automationPosture: string;
    executionHint: string;
  }>;
};

type DerivedCompetitorModuleState =
  | "success"
  | "partial"
  | "setup_incomplete"
  | "empty_healthy"
  | "failure"
  | "stale";

const resourceName = { singular: "competitor product", plural: "competitor products" };

function createEmptyOverview(
  readinessState = "SYNC_REQUIRED",
  reason = "Add monitored domains and run the first competitor ingestion."
): CompetitorOverview {
  return {
    monitoringStatus: {
      setupStatus: "NO_DOMAINS",
      syncStatus: "NOT_STARTED",
      crawlStatus: "NOT_STARTED",
      snapshotStatus: "NOT_STARTED",
      freshnessStatus: "UNKNOWN",
      lastSuccessAt: null,
      lastAttemptAt: null,
      checkedDomainsCount: 0,
      monitoredProductsCount: 0,
      matchedProductsCount: 0,
      detectedPriceChangesCount: 0,
      detectedPromotionChangesCount: 0,
      latestSyncReason: reason,
    },
    readiness: {
      readinessState,
      reason,
      processingState: "NOT_STARTED",
      lastUpdatedAt: null,
    },
    recentPriceChanges: 0,
    promotionAlerts: 0,
    stockMovementAlerts: 0,
    trackedDomains: 0,
    lastIngestedAt: null,
    freshnessHours: null,
    promotionalHeat: "Unavailable",
    marketPressure: "Unavailable",
    adPressure: "Unavailable",
    launchAlerts: [],
    sourceBreakdown: { website: 0, googleShopping: 0, metaAds: 0 },
    topMovers: [],
    moveFeed: [],
    strategyDetections: [],
    actionSuggestions: [],
    weeklyReport: undefined,
    coverageSummary: {
      domainsConfigured: 0,
      channelsReady: [],
      monitoringPosture: reason,
    },
  };
}

function createEmptyConnectors(): CompetitorConnector[] {
  return [];
}

function createEmptyResponseEngine(
  reason = "Response suggestions appear after successful competitor ingestion."
): CompetitorResponseEngine {
  return {
    summary: {
      responseMode: "Awaiting monitored competitor data",
      topPressureCount: 0,
      automationReadiness: reason,
    },
    responsePlans: [],
  };
}

function normalizeOverview(input: CompetitorOverview): CompetitorOverview {
  return {
    ...createEmptyOverview(
      input.readiness?.readinessState,
      input.readiness?.reason
    ),
    ...input,
    sourceBreakdown: {
      website: input.sourceBreakdown?.website ?? 0,
      googleShopping: input.sourceBreakdown?.googleShopping ?? 0,
      metaAds: input.sourceBreakdown?.metaAds ?? 0,
    },
    moveFeed: input.moveFeed ?? [],
    topMovers: input.topMovers ?? [],
    launchAlerts: input.launchAlerts ?? [],
    strategyDetections: input.strategyDetections ?? [],
    actionSuggestions: input.actionSuggestions ?? [],
    weeklyReport: {
      headline:
        input.weeklyReport?.headline ??
        "Awaiting competitor ingestion",
      whyItMatters:
        input.weeklyReport?.whyItMatters ??
        "Add monitored domains and run ingestion to build an event-driven competitor feed.",
      suggestedActions:
        input.weeklyReport?.suggestedActions ?? [],
      reportReadiness:
        input.weeklyReport?.reportReadiness ?? "Awaiting competitor ingestion",
      biggestMoves: input.weeklyReport?.biggestMoves ?? [],
      merchantBrief:
        input.weeklyReport?.merchantBrief ?? reasonForWeeklyBrief(input),
      nextBestAction:
        input.weeklyReport?.nextBestAction ??
        "Add competitor domains and run your first ingestion.",
    },
    coverageSummary: {
      domainsConfigured:
        input.coverageSummary?.domainsConfigured ??
        0,
      channelsReady:
        input.coverageSummary?.channelsReady ??
        [],
      monitoringPosture:
        input.coverageSummary?.monitoringPosture ??
        "Needs setup",
    },
    monitoringStatus: {
      setupStatus: input.monitoringStatus?.setupStatus ?? "NO_DOMAINS",
      syncStatus: input.monitoringStatus?.syncStatus ?? "NOT_STARTED",
      crawlStatus: input.monitoringStatus?.crawlStatus ?? "NOT_STARTED",
      snapshotStatus: input.monitoringStatus?.snapshotStatus ?? "NOT_STARTED",
      freshnessStatus: input.monitoringStatus?.freshnessStatus ?? "UNKNOWN",
      lastSuccessAt: input.monitoringStatus?.lastSuccessAt ?? null,
      lastAttemptAt: input.monitoringStatus?.lastAttemptAt ?? null,
      checkedDomainsCount: input.monitoringStatus?.checkedDomainsCount ?? 0,
      monitoredProductsCount: input.monitoringStatus?.monitoredProductsCount ?? 0,
      matchedProductsCount: input.monitoringStatus?.matchedProductsCount ?? 0,
      detectedPriceChangesCount:
        input.monitoringStatus?.detectedPriceChangesCount ?? 0,
      detectedPromotionChangesCount:
        input.monitoringStatus?.detectedPromotionChangesCount ?? 0,
      latestSyncReason: input.monitoringStatus?.latestSyncReason ?? null,
    },
  };
}

function reasonForWeeklyBrief(input: CompetitorOverview) {
  return (
    input.readiness?.reason ??
    "The weekly brief will populate after live competitor monitoring data is collected."
  );
}

function toneForPriority(value: string) {
  const normalized = value.toLowerCase();
  if (normalized === "high") return "critical";
  if (normalized === "medium") return "attention";
  return "info";
}

function toneForHeat(value?: string | null) {
  const normalized = (value ?? "").toLowerCase();
  if (normalized === "high") return "critical";
  if (normalized === "medium") return "attention";
  return "success";
}

function formatDateTime(value?: string | null) {
  if (!value) return "Not available";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function deriveCompetitorModuleState(
  data: CompetitorOverview
): DerivedCompetitorModuleState {
  const status = data.monitoringStatus;

  if (!status) {
    return "setup_incomplete";
  }

  if (
    status.setupStatus === "NO_DOMAINS" ||
    status.setupStatus === "NO_MONITORED_PRODUCTS"
  ) {
    return "setup_incomplete";
  }

  if (
    status.syncStatus === "FAILED" ||
    status.crawlStatus === "FAILED" ||
    status.snapshotStatus === "FAILED"
  ) {
    return "failure";
  }

  if (status.freshnessStatus === "STALE") {
    return "stale";
  }

  if (status.snapshotStatus === "NO_MATCHES") {
    return "partial";
  }

  if (status.crawlStatus === "PARTIAL" || status.snapshotStatus === "PARTIAL") {
    return "partial";
  }

  if (status.snapshotStatus === "NO_CHANGES") {
    return "empty_healthy";
  }

  if (status.snapshotStatus === "READY") {
    return "success";
  }

  return "partial";
}

function deriveCompetitorBanner(data: CompetitorOverview) {
  const state = deriveCompetitorModuleState(data);
  const status = data.monitoringStatus;

  switch (state) {
    case "success":
      return {
        state,
        tone: "success" as const,
        title: "Competitor monitoring refreshed successfully",
        body: `Last updated ${formatDateTime(status?.lastSuccessAt)}. ${status?.checkedDomainsCount ?? 0} domains checked, ${status?.matchedProductsCount ?? 0} products matched, ${status?.detectedPriceChangesCount ?? 0} price changes and ${status?.detectedPromotionChangesCount ?? 0} promotion changes detected.`,
        summary: "Usable competitor snapshots were produced in the latest refresh.",
        primaryAction: "View changes",
        secondaryAction: null,
      };
    case "partial":
      return {
        state,
        tone: "warning" as const,
        title: "Competitor refresh completed with partial coverage",
        body:
          status?.snapshotStatus === "NO_MATCHES"
            ? "The refresh checked your competitor domains, but none of the monitored products could be matched to comparable competitor snapshots."
            : "The latest refresh completed, but some tracked products still do not have usable competitor snapshots.",
        summary:
          status?.latestSyncReason ??
          "Review tracked products, update monitored domains, or run another refresh after coverage changes.",
        primaryAction:
          status?.snapshotStatus === "NO_MATCHES"
            ? "Review tracked products"
            : "Re-run sync",
        secondaryAction: "Update domains",
      };
    case "setup_incomplete":
      return {
        state,
        tone: "info" as const,
        title: "Complete competitor setup to start monitoring",
        body:
          status?.setupStatus === "NO_DOMAINS"
            ? "Add competitor domains before VedaSuite can monitor websites, pricing, and promotions."
            : "VedaSuite still needs monitored products before it can compare your catalog with competitor snapshots.",
        summary:
          status?.setupStatus === "NO_DOMAINS"
            ? "No competitor domains are configured yet."
            : "No monitored products are available for competitor matching yet.",
        primaryAction: "Complete setup",
        secondaryAction: "Update domains",
      };
    case "empty_healthy":
      return {
        state,
        tone: "info" as const,
        title: "Monitoring is active. No competitor changes were detected.",
        body: `Last successful refresh: ${formatDateTime(status?.lastSuccessAt)}. VedaSuite checked ${status?.checkedDomainsCount ?? 0} domains and matched ${status?.matchedProductsCount ?? 0} products, but no competitor price or promotion changes were detected in the latest refresh.`,
        summary: "This is a healthy monitoring result, not an error.",
        primaryAction: "Refresh again",
        secondaryAction: "Update domains",
      };
    case "failure":
      return {
        state,
        tone: "critical" as const,
        title: "Competitor refresh failed",
        body:
          status?.latestSyncReason ??
          "VedaSuite could not complete the latest competitor refresh.",
        summary: "Retry the refresh or update monitored domains before trying again.",
        primaryAction: "Retry refresh",
        secondaryAction: "Update domains",
      };
    case "stale":
    default:
      return {
        state: "stale" as const,
        tone: "warning" as const,
        title: "Competitor monitoring is stale",
        body: `The latest usable competitor refresh is getting old. Last successful refresh: ${formatDateTime(status?.lastSuccessAt)}.`,
        summary:
          status?.latestSyncReason ??
          "Run a fresh refresh to restore current competitor coverage.",
        primaryAction: "Re-run sync",
        secondaryAction: "Update domains",
      };
  }
}

function monitoringCoverageLabel(data: CompetitorOverview) {
  const state = deriveCompetitorModuleState(data);

  switch (state) {
    case "success":
      return "Healthy coverage";
    case "partial":
      return "Partial coverage";
    case "setup_incomplete":
      return "Setup required";
    case "empty_healthy":
      return "Healthy with no changes";
    case "failure":
      return "Refresh failed";
    case "stale":
    default:
      return "Stale coverage";
  }
}

function EmptyState(props: {
  title: string;
  body: string;
  action?: React.ReactNode;
  secondaryAction?: React.ReactNode;
}) {
  return (
    <Card>
      <BlockStack gap="300">
        <Text as="h3" variant="headingMd">{props.title}</Text>
        <Text as="p" tone="subdued">{props.body}</Text>
        {props.action || props.secondaryAction ? (
          <InlineStack gap="300">
            {props.action}
            {props.secondaryAction}
          </InlineStack>
        ) : null}
      </BlockStack>
    </Card>
  );
}

function BulletList({ items, empty }: { items: string[]; empty: string }) {
  if (items.length === 0) {
    return <Text as="p" tone="subdued">{empty}</Text>;
  }
  return (
    <BlockStack gap="100">
      {items.map((item) => (
        <Text key={item} as="p" variant="bodySm">- {item}</Text>
      ))}
    </BlockStack>
  );
}

export function CompetitorPage() {
  const { getProductUrl } = useShopifyAdminLinks();
  const [searchParams] = useSearchParams();
  const { subscription, loading: subscriptionLoading } = useSubscriptionPlan();
  const [rows, setRows] = useState<CompetitorRow[]>(
    readModuleCache<CompetitorRow[]>("competitor-rows") ?? []
  );
  const [overview, setOverview] = useState<CompetitorOverview>(
    readModuleCache<CompetitorOverview>("competitor-overview") ??
      createEmptyOverview()
  );
  const [connectors, setConnectors] = useState<CompetitorConnector[]>(
    readModuleCache<CompetitorConnector[]>("competitor-connectors") ??
      createEmptyConnectors()
  );
  const [responseEngine, setResponseEngine] = useState<CompetitorResponseEngine>(
    readModuleCache<CompetitorResponseEngine>("competitor-response-engine") ??
      createEmptyResponseEngine()
  );
  const [loading, setLoading] = useState(
    rows.length === 0 && (overview.moveFeed?.length ?? 0) === 0
  );
  const [selectedTab, setSelectedTab] = useState(0);
  const [modalOpen, setModalOpen] = useState(false);
  const [ingesting, setIngesting] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [domainsInput, setDomainsInput] = useState(
    "styleorbit.example, urbanloom.example"
  );

  const focus = searchParams.get("focus");
  const allowed = !!subscription?.enabledModules?.competitor;
  const canSeeStrategy =
    subscription?.capabilities?.["competitor.strategyDetection"] ?? false;
  const canSeeWeeklyReports =
    subscription?.capabilities?.["competitor.weeklyReports"] ?? false;
  const canSeeAdvancedReports =
    subscription?.capabilities?.["competitor.advancedReports"] ?? false;

  useEffect(() => {
    setSelectedTab(focus === "feed" ? 1 : focus === "strategy" ? 2 : 0);
  }, [focus]);

  useEffect(() => {
    if (!allowed) return;
    let mounted = true;
    setLoading(true);
    Promise.all([
      embeddedShopRequest<{ products: CompetitorRow[] }>("/api/competitor/products", { timeoutMs: 30000 }),
      embeddedShopRequest<CompetitorOverview>("/api/competitor/overview", { timeoutMs: 30000 }),
      embeddedShopRequest<{ connectors: CompetitorConnector[] }>("/api/competitor/connectors", { timeoutMs: 30000 }),
      embeddedShopRequest<{ responseEngine: CompetitorResponseEngine }>("/api/competitor/response-engine", { timeoutMs: 30000 }),
    ])
      .then(([productsResponse, overviewResponse, connectorsResponse, responseEngineResponse]) => {
        if (!mounted) return;
        const nextOverview = normalizeOverview(overviewResponse);
        setRows(productsResponse.products);
        setOverview(nextOverview);
        setConnectors(connectorsResponse.connectors);
        setResponseEngine(
          responseEngineResponse.responseEngine ?? createEmptyResponseEngine()
        );
        writeModuleCache("competitor-rows", productsResponse.products);
        writeModuleCache("competitor-overview", nextOverview);
        writeModuleCache("competitor-connectors", connectorsResponse.connectors);
        writeModuleCache(
          "competitor-response-engine",
          responseEngineResponse.responseEngine ?? createEmptyResponseEngine()
        );
      })
      .catch(() => {
        if (!mounted) return;
        setOverview(
          createEmptyOverview(
            "FAILED",
            "VedaSuite could not load persisted competitor monitoring outputs."
          )
        );
        setConnectors(createEmptyConnectors());
        setResponseEngine(
          createEmptyResponseEngine(
            "Response suggestions are unavailable until competitor monitoring loads."
          )
        );
        setToast("Competitor monitoring could not be loaded. Please try again.");
      })
      .finally(() => {
        if (mounted) setLoading(false);
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

  const saveDomains = async () => {
    const domains = domainsInput
      .split(",")
      .map((domain) => domain.trim())
      .filter(Boolean)
      .map((domain) => ({ domain }));
    try {
      const [, overviewResponse, connectorsResponse] = await Promise.all([
        embeddedShopRequest("/api/competitor/domains", {
          method: "POST",
          body: { domains },
          timeoutMs: 30000,
        }),
        embeddedShopRequest<CompetitorOverview>("/api/competitor/overview", {
          timeoutMs: 30000,
        }),
        embeddedShopRequest<{ connectors: CompetitorConnector[] }>(
          "/api/competitor/connectors",
          { timeoutMs: 30000 }
        ),
      ]);
      const nextOverview = normalizeOverview(overviewResponse);
      setOverview(nextOverview);
      setConnectors(connectorsResponse.connectors);
      writeModuleCache("competitor-overview", nextOverview);
      writeModuleCache("competitor-connectors", connectorsResponse.connectors);
      setToast(
        domains.length > 0
          ? "Competitor tracking domains updated."
          : "Competitor tracking domains cleared."
      );
      setModalOpen(false);
    } catch {
      setToast("Unable to update competitor domains.");
    }
  };

  const handleBannerPrimaryAction = () => {
    switch (banner.primaryAction) {
      case "View changes":
        setSelectedTab(1);
        return;
      case "Review tracked products":
        setSelectedTab(0);
        return;
      case "Complete setup":
        setModalOpen(true);
        return;
      case "Refresh again":
      case "Retry refresh":
      case "Re-run sync":
        void ingestCompetitorData();
        return;
      default:
        return;
    }
  };

  const handleBannerSecondaryAction = () => {
    if (banner.secondaryAction === "Update domains") {
      setModalOpen(true);
    }
  };

  const ingestCompetitorData = async () => {
    try {
      setIngesting(true);
      const [ingestResponse, productsResponse, overviewResponse, connectorsResponse, responseEngineResponse] =
        await Promise.all([
          embeddedShopRequest<{ result: { ingested: number; status?: string; reason?: string | null; merchantMessage?: string | null } }>("/api/competitor/ingest", { method: "POST", timeoutMs: 45000 }),
          embeddedShopRequest<{ products: CompetitorRow[] }>("/api/competitor/products", { timeoutMs: 30000 }),
          embeddedShopRequest<CompetitorOverview>("/api/competitor/overview", { timeoutMs: 30000 }),
          embeddedShopRequest<{ connectors: CompetitorConnector[] }>("/api/competitor/connectors", { timeoutMs: 30000 }),
          embeddedShopRequest<{ responseEngine: CompetitorResponseEngine }>("/api/competitor/response-engine", { timeoutMs: 30000 }),
        ]);
      const nextOverview = normalizeOverview(overviewResponse);
      setRows(productsResponse.products);
      setOverview(nextOverview);
      setConnectors(connectorsResponse.connectors);
      setResponseEngine(
        responseEngineResponse.responseEngine ?? createEmptyResponseEngine()
      );
      writeModuleCache("competitor-rows", productsResponse.products);
      writeModuleCache("competitor-overview", nextOverview);
      writeModuleCache("competitor-connectors", connectorsResponse.connectors);
      writeModuleCache(
        "competitor-response-engine",
        responseEngineResponse.responseEngine ?? createEmptyResponseEngine()
      );
      const nextBanner = deriveCompetitorBanner(nextOverview);
      setToast(
        ingestResponse.result.merchantMessage ??
          (nextBanner.state === "success"
            ? "Competitor monitoring refreshed successfully."
            : nextBanner.state === "partial"
            ? "Refresh completed, but some products could not be matched to competitor snapshots."
            : nextBanner.state === "empty_healthy"
            ? "Refresh completed. No competitor changes detected."
            : nextBanner.state === "setup_incomplete"
            ? "Competitor setup is incomplete."
            : nextBanner.state === "stale"
            ? "Refresh completed, but monitoring still needs a fresher result."
            : "Competitor refresh failed. Please try again.")
      );
    } catch {
      setToast("Competitor refresh failed. Please try again.");
    } finally {
      setIngesting(false);
    }
  };

  const sourceBreakdown = overview.sourceBreakdown ?? {
    website: 0,
    googleShopping: 0,
    metaAds: 0,
  };
  const moduleState = deriveCompetitorModuleState(overview);
  const banner = deriveCompetitorBanner(overview);
  const monitoringStatusRows = [
    ["Last successful refresh", formatDateTime(overview.monitoringStatus?.lastSuccessAt)],
    ["Last refresh attempt", formatDateTime(overview.monitoringStatus?.lastAttemptAt)],
    ["Domains checked", String(overview.monitoringStatus?.checkedDomainsCount ?? 0)],
    ["Products matched", String(overview.monitoringStatus?.matchedProductsCount ?? 0)],
    ["Coverage status", monitoringCoverageLabel(overview)],
    ["Refresh result", banner.summary],
  ];

  return (
    <ModuleGate
      title="Competitor Intelligence"
      subtitle="Track price moves, promotions, stock posture, and response opportunities across key competitor domains."
      requiredPlan="Starter, Growth, or Pro"
      allowed={allowed}
    >
      <Page
        title="Competitor Intelligence"
        subtitle={
          moduleState === "success"
            ? "Review competitor price moves, promotion changes, and recommended responses."
            : moduleState === "empty_healthy"
            ? "Monitoring is active and ready to surface competitor changes when they appear."
            : moduleState === "setup_incomplete"
            ? "Complete setup to start monitoring competitor domains and matched products."
            : moduleState === "failure"
            ? "The latest competitor refresh needs attention before fresh monitoring can resume."
            : moduleState === "stale"
            ? "Competitor monitoring needs a fresh refresh to restore current market coverage."
            : "Review coverage gaps and refresh competitor monitoring to improve matched snapshots."
        }
        primaryAction={{
          content: ingesting ? "Refreshing..." : "Refresh competitor monitoring",
          onAction: ingestCompetitorData,
          disabled: ingesting,
        }}
        secondaryActions={[{ content: "Update domains", onAction: () => setModalOpen(true) }]}
      >
        <Layout>
          {subscriptionLoading || loading ? (
            <Layout.Section>
              <Banner title="Refreshing competitor intelligence" tone="info">
                <p>VedaSuite is loading market signals, event feed items, and response plays in the background.</p>
              </Banner>
            </Layout.Section>
          ) : null}

        <Layout.Section>
            <Banner
              title={banner.title}
              tone={banner.tone}
            >
              <BlockStack gap="200">
                <Text as="p">{banner.body}</Text>
                <Text as="p" tone="subdued">{banner.summary}</Text>
                <InlineStack gap="300">
                  {banner.primaryAction ? (
                    <Button onClick={handleBannerPrimaryAction} disabled={ingesting}>
                      {banner.primaryAction}
                    </Button>
                  ) : null}
                  {banner.secondaryAction ? (
                    <Button variant="secondary" onClick={handleBannerSecondaryAction}>
                      {banner.secondaryAction}
                    </Button>
                  ) : null}
                </InlineStack>
              </BlockStack>
            </Banner>
          </Layout.Section>

          <Layout.Section>
            <InlineGrid columns={{ xs: 1, md: 3 }} gap="400">
              {[
                [
                  "Matched products",
                  overview.monitoringStatus?.matchedProductsCount ?? rows.length,
                ],
                ["Active promotions", overview.promotionAlerts],
                ["Stock alerts", overview.stockMovementAlerts],
                [
                  "Domains checked",
                  overview.monitoringStatus?.checkedDomainsCount ?? overview.trackedDomains,
                ],
                [
                  "Monitoring freshness",
                  overview.monitoringStatus?.freshnessStatus === "FRESH"
                    ? "Fresh"
                    : overview.monitoringStatus?.freshnessStatus === "STALE"
                    ? "Stale"
                    : "Unknown",
                ],
                ["Coverage status", monitoringCoverageLabel(overview)],
              ].map(([label, value]) => (
                <Card key={String(label)}>
                  <BlockStack gap="200">
                    <Text as="h3" variant="headingMd">{String(label)}</Text>
                    <Text as="p" variant="heading2xl">{String(value)}</Text>
                  </BlockStack>
                </Card>
              ))}
            </InlineGrid>
          </Layout.Section>

          <Layout.Section>
            <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
              <Card>
                <BlockStack gap="300">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="h3" variant="headingMd">Monitoring status</Text>
                    <Badge
                      tone={
                        banner.tone === "success"
                          ? "success"
                          : banner.tone === "critical"
                          ? "critical"
                          : "attention"
                      }
                    >
                      {monitoringCoverageLabel(overview)}
                    </Badge>
                  </InlineStack>
                  <Text as="p" tone="subdued">
                    Use this summary to confirm whether the latest refresh succeeded, partially covered your tracked catalog, or needs setup changes.
                  </Text>
                  <BlockStack gap="200">
                    {monitoringStatusRows.map(([label, value]) => (
                      <InlineStack
                        key={label}
                        align="space-between"
                        blockAlign="start"
                      >
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
              <Card>
                <BlockStack gap="300">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="h3" variant="headingMd">Monitoring coverage</Text>
                    <Badge
                      tone={
                        overview.coverageSummary?.monitoringPosture === "Live monitoring"
                          ? "success"
                          : "attention"
                      }
                    >
                      {overview.coverageSummary?.monitoringPosture}
                    </Badge>
                  </InlineStack>
                  <Text as="p" tone="subdued">
                    VedaSuite turns website, shopping-surface, and ad-pressure signals into one event-driven market view.
                  </Text>
                  <InlineGrid columns={{ xs: 1, md: 2 }} gap="300">
                    <div className="vs-action-card">
                      <Text as="p" variant="headingSm">Configured domains</Text>
                      <Text as="p" variant="headingLg">
                        {overview.coverageSummary?.domainsConfigured ?? 0}
                      </Text>
                    </div>
                    <div className="vs-action-card">
                      <Text as="p" variant="headingSm">Channels ready</Text>
                      <BulletList
                        items={overview.coverageSummary?.channelsReady ?? []}
                        empty="Website monitoring and limited-preview imported channel summaries become available after competitor domains are configured."
                      />
                    </div>
                  </InlineGrid>
                </BlockStack>
              </Card>

              <Card>
                <BlockStack gap="300">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="h3" variant="headingMd">Weekly competitor brief</Text>
                    <Badge tone={canSeeWeeklyReports ? "success" : "attention"}>
                      {canSeeWeeklyReports ? "Included" : "Growth+"}
                    </Badge>
                  </InlineStack>
                  <Text as="p" variant="headingSm">
                    {overview.weeklyReport?.headline}
                  </Text>
                  <Text as="p" tone="subdued">
                    {overview.weeklyReport?.merchantBrief}
                  </Text>
                  <div className="vs-action-card">
                    <Text as="p" variant="headingSm">Next best action</Text>
                    <Text as="p" tone="subdued">
                      {overview.weeklyReport?.nextBestAction}
                    </Text>
                  </div>
                  <BulletList
                    items={(overview.weeklyReport?.biggestMoves ?? []).map(
                      (item) =>
                        `${item.headline} (${item.impactScore}/100): ${item.suggestedAction}`
                    )}
                    empty="The weekly brief will highlight the biggest competitor moves once the first ingest completes."
                  />
                </BlockStack>
              </Card>
            </InlineGrid>
          </Layout.Section>

          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h3" variant="headingMd">Competitor Move Feed</Text>
                  <Badge tone={overview.moveFeed && overview.moveFeed.length > 0 ? "success" : "info"}>
                    {overview.moveFeed && overview.moveFeed.length > 0 ? `${overview.moveFeed.length} recent moves` : "Awaiting first ingest"}
                  </Badge>
                </InlineStack>
                {(overview.moveFeed ?? []).length === 0 ? (
                  <Text as="p" tone="subdued">The move feed translates website, shopping-surface, promotion, stock, and ad-pressure signals into merchant-ready decisions.</Text>
                ) : (
                  <BlockStack gap="200">
                    {(overview.moveFeed ?? []).map((item) => (
                      <div key={item.id} className="vs-action-card">
                        <InlineStack align="space-between" blockAlign="start">
                          <BlockStack gap="100">
                            <InlineStack gap="200" blockAlign="center">
                              <Text as="p" variant="headingSm">{item.headline}</Text>
                              <Badge tone={toneForPriority(item.priority)}>{`${item.priority} impact`}</Badge>
                            </InlineStack>
                            <Text as="p" tone="subdued">{`${item.moveType} via ${item.source}`}</Text>
                            {item.eventCluster ? (
                              <Text as="p" variant="bodySm" tone="subdued">
                                {item.eventCluster}
                              </Text>
                            ) : null}
                            <Text as="p">{item.whyItMatters}</Text>
                            <Text as="p" variant="bodySm">{`What should I do? ${item.suggestedAction}`}</Text>
                            {item.actionWindow ? (
                              <Text as="p" variant="bodySm" tone="subdued">
                                {`Action window: ${item.actionWindow}`}
                              </Text>
                            ) : null}
                          </BlockStack>
                          <Badge tone="info">{`${item.impactScore}/100`}</Badge>
                        </InlineStack>
                      </div>
                    ))}
                  </BlockStack>
                )}
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section>
            <InlineGrid columns={{ xs: 1, md: 3 }} gap="400">
              {connectors.map((connector) => (
                <Card key={connector.id}>
                  <BlockStack gap="200">
                    <InlineStack align="space-between" blockAlign="center">
                      <Text as="h3" variant="headingMd">{connector.label}</Text>
                      <Badge tone={connector.connected ? "success" : "attention"}>{connector.connected ? "Connected" : "Needs setup"}</Badge>
                    </InlineStack>
                    <Text as="p" tone="subdued">{connector.description}</Text>
                    <Text as="p" variant="bodySm" tone="subdued">{`Targets: ${connector.trackedTargets}`}</Text>
                    <Text as="p" variant="bodySm" tone="subdued">{`Status: ${connector.readiness ?? "Not configured"}`}</Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                      {connector.lastIngestedAt ? `Last ingested ${new Date(connector.lastIngestedAt).toLocaleString()}` : "No ingestion yet"}
                    </Text>
                  </BlockStack>
                </Card>
              ))}
            </InlineGrid>
          </Layout.Section>

          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h3" variant="headingMd">Weekly market brief</Text>
                  <Badge tone={canSeeWeeklyReports ? "success" : "attention"}>{canSeeWeeklyReports ? "Included" : "Upgrade for full reports"}</Badge>
                </InlineStack>
                <Text as="p" variant="headingSm">{overview.weeklyReport?.headline}</Text>
                <Text as="p" tone="subdued">{overview.weeklyReport?.whyItMatters}</Text>
                <InlineGrid columns={{ xs: 1, md: 2 }} gap="300">
                  <div className="vs-action-card">
                    <BlockStack gap="100">
                      <Text as="p" variant="headingSm">Suggested merchant actions</Text>
                      <BulletList items={overview.weeklyReport?.suggestedActions ?? []} empty="Run first ingestion to build your first weekly competitor brief." />
                    </BlockStack>
                  </div>
                  <div className="vs-action-card">
                    <BlockStack gap="100">
                      <Text as="p" variant="headingSm">Report readiness</Text>
                      <Text as="p" tone="subdued">{overview.weeklyReport?.reportReadiness}</Text>
                      {!canSeeAdvancedReports ? <Text as="p" variant="bodySm">Upgrade to Pro for advanced weekly recommendations and deeper strategy detection.</Text> : null}
                    </BlockStack>
                  </div>
                </InlineGrid>
                {(overview.weeklyReport?.biggestMoves ?? []).length > 0 ? (
                  <Card>
                    <BlockStack gap="200">
                      <Text as="h3" variant="headingMd">Biggest moves this week</Text>
                      {(overview.weeklyReport?.biggestMoves ?? []).map((item) => (
                        <InlineStack key={`${item.headline}-${item.impactScore}`} align="space-between" blockAlign="center">
                          <BlockStack gap="100">
                            <Text as="p">{item.headline}</Text>
                            <Text as="p" variant="bodySm" tone="subdued">
                              {item.suggestedAction}
                            </Text>
                          </BlockStack>
                          <Badge tone="attention">{`${item.impactScore}/100`}</Badge>
                        </InlineStack>
                      ))}
                    </BlockStack>
                  </Card>
                ) : null}
              </BlockStack>
            </Card>
          </Layout.Section>

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
                        <BlockStack gap="300">
                          <Text as="h3" variant="headingMd">
                            Competitor watchlist is ready
                          </Text>
                          <Text as="p" tone="subdued">
                            Connect domains and run ingestion to start collecting live competitor products and events.
                          </Text>
                          <InlineGrid columns={{ xs: 1, md: 2 }} gap="300">
                            {(overview.moveFeed ?? []).slice(0, 2).map((item) => (
                              <div key={item.id} className="vs-action-card">
                                <BlockStack gap="100">
                                  <InlineStack align="space-between" blockAlign="start">
                                    <Text as="p" variant="headingSm">{item.headline}</Text>
                                    <Badge tone={toneForPriority(item.priority)}>{item.priority}</Badge>
                                  </InlineStack>
                                  <Text as="p" tone="subdued">{item.whyItMatters}</Text>
                                  <Text as="p" variant="bodySm">Suggested action: {item.suggestedAction}</Text>
                                </BlockStack>
                              </div>
                            ))}
                          </InlineGrid>
                          <InlineStack gap="300">
                            <Button onClick={() => setModalOpen(true)}>Add competitor domains</Button>
                            <Button variant="secondary" onClick={ingestCompetitorData}>Run first ingestion</Button>
                          </InlineStack>
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
                          { title: "Promotion" },
                          { title: "Stock" },
                          { title: "Shopify" },
                        ]}
                      >
                        {visibleRows.map((row, index) => (
                          <IndexTable.Row id={row.id} key={row.id} position={index}>
                            <IndexTable.Cell>{row.productHandle}</IndexTable.Cell>
                            <IndexTable.Cell>{row.competitorName}</IndexTable.Cell>
                            <IndexTable.Cell>{row.price != null ? `$${row.price.toFixed(2)}` : "-"}</IndexTable.Cell>
                            <IndexTable.Cell>{row.promotion ? <Badge tone="info">{row.promotion}</Badge> : "-"}</IndexTable.Cell>
                            <IndexTable.Cell>
                              <BlockStack gap="100">
                                <Text as="span">{row.stockStatus ?? "-"}</Text>
                                {row.source ? <Badge tone="info">{row.source}</Badge> : null}
                              </BlockStack>
                            </IndexTable.Cell>
                            <IndexTable.Cell>
                              {getProductUrl(row.productHandle) ? (
                                <Button url={getProductUrl(row.productHandle) ?? undefined} external>Product</Button>
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
                          ["Website crawl", sourceBreakdown.website],
                          ["Google Shopping", sourceBreakdown.googleShopping],
                          ["Meta Ad Library", sourceBreakdown.metaAds],
                        ].map(([label, value]) => (
                          <div key={String(label)} className="vs-signal-stat">
                            <Text as="p" variant="bodySm" tone="subdued">{String(label)}</Text>
                            <Text as="p" variant="headingLg">{String(value)}</Text>
                          </div>
                        ))}
                      </InlineGrid>
                      <Card>
                        <BlockStack gap="200">
                          <Text as="h3" variant="headingMd">Highest market movers</Text>
                          {(overview.topMovers ?? []).length === 0 ? (
                            <Text as="p" tone="subdued">No high-signal competitor movers are available yet.</Text>
                          ) : (
                            (overview.topMovers ?? []).map((mover) => (
                              <InlineStack key={mover.productHandle} align="space-between" blockAlign="center">
                                <BlockStack gap="100">
                                  <Text as="p">{mover.productHandle}</Text>
                                  <Text as="p" variant="bodySm" tone="subdued">{`${mover.promotionSignals} promotion signals | ${mover.stockSignals} stock signals`}</Text>
                                </BlockStack>
                                <Badge tone={mover.priceDelta < 0 ? "attention" : "info"}>
                                  {mover.priceDelta >= 0 ? `+$${mover.priceDelta.toFixed(2)}` : `-$${Math.abs(mover.priceDelta).toFixed(2)}`}
                                </Badge>
                              </InlineStack>
                            ))
                          )}
                        </BlockStack>
                      </Card>
                      <Card>
                        <BlockStack gap="200">
                          <Text as="h3" variant="headingMd">Move feed detail</Text>
                          {(overview.moveFeed ?? []).length === 0 ? (
                            <Text as="p" tone="subdued">
                              Live competitor event detail will appear after the first successful ingestion.
                            </Text>
                          ) : (
                            (overview.moveFeed ?? []).slice(0, 5).map((item) => (
                              <div key={`${item.id}-detail`} className="vs-action-card">
                                <InlineStack align="space-between" blockAlign="start">
                                  <BlockStack gap="100">
                                    <Text as="p" variant="headingSm">{item.moveType}</Text>
                                    <Text as="p" tone="subdued">{item.eventCluster}</Text>
                                    <Text as="p" variant="bodySm">
                                      Why this matters: {item.whyItMatters}
                                    </Text>
                                    <Text as="p" variant="bodySm">
                                      Action window: {item.actionWindow ?? "Monitor"}
                                    </Text>
                                  </BlockStack>
                                  <Badge tone={toneForPriority(item.priority)}>
                                    {item.priority}
                                  </Badge>
                                </InlineStack>
                              </div>
                            ))
                          )}
                        </BlockStack>
                      </Card>
                      <Card>
                        <BlockStack gap="200">
                          <Text as="h3" variant="headingMd">Product launch alerts</Text>
                          {(overview.launchAlerts ?? []).length === 0 ? (
                            <Text as="p" tone="subdued">No launch push has been inferred yet, so the module is keeping launch watch in a monitor posture.</Text>
                          ) : (
                            (overview.launchAlerts ?? []).map((alert) => (
                              <InlineStack key={`${alert.productHandle}-${alert.collectedAt}`} align="space-between" blockAlign="center">
                                <BlockStack gap="100">
                                  <Text as="p">{alert.productHandle}</Text>
                                  <Text as="p" variant="bodySm" tone="subdued">{`${alert.competitorName} | ${alert.source}`}</Text>
                                </BlockStack>
                                <Badge tone="attention">Launch watch</Badge>
                              </InlineStack>
                            ))
                          )}
                        </BlockStack>
                      </Card>
                    </BlockStack>
                  ) : (
                    <BlockStack gap="300">
                      <Card>
                        <BlockStack gap="200">
                          <InlineStack align="space-between" blockAlign="center">
                            <Text as="h3" variant="headingMd">Recommended market response</Text>
                            <Badge tone={toneForHeat(overview.marketPressure)}>{`${responseEngine.summary.responseMode} | ${responseEngine.summary.topPressureCount} high-pressure SKUs`}</Badge>
                          </InlineStack>
                          <Text as="p" tone="subdued">{responseEngine.summary.automationReadiness}</Text>
                          <InlineGrid columns={{ xs: 1, md: 3 }} gap="300">
                            {[
                              ["Hold price", "Margin-first", "Best when promotional heat is low and competitor signals are not concentrated on hero SKUs."],
                              ["Selective match", "Tactical", "Use when a few products show repeated price drops and promotion clustering."],
                              ["Bundle defense", "Response plan", "Protect margin by bundling complementary products instead of broad catalog discounting."],
                            ].map(([title, label, body]) => (
                              <Card key={String(title)}>
                                <BlockStack gap="200">
                                  <InlineStack align="space-between" blockAlign="center">
                                    <Text as="h3" variant="headingMd">{String(title)}</Text>
                                    <Badge tone={title === "Hold price" ? "success" : title === "Selective match" ? "attention" : "info"}>{String(label)}</Badge>
                                  </InlineStack>
                                  <Text as="p" tone="subdued">{String(body)}</Text>
                                </BlockStack>
                              </Card>
                            ))}
                          </InlineGrid>
                        </BlockStack>
                      </Card>
                      <Card>
                        <BlockStack gap="200">
                          <Text as="h3" variant="headingMd">What should I do?</Text>
                          {(overview.actionSuggestions ?? []).length === 0 ? (
                            <Text as="p" tone="subdued">Action suggestions are currently calm because no concentrated competitor pressure has been detected.</Text>
                          ) : (
                            (overview.actionSuggestions ?? []).map((item) => (
                              <div key={item.productHandle} className="vs-action-card">
                                <BlockStack gap="100">
                                  <InlineStack align="space-between">
                                    <Text as="p" variant="headingSm">{item.productHandle}</Text>
                                    <Badge tone="info">{item.suggestion}</Badge>
                                  </InlineStack>
                                  <Text as="p" tone="subdued">{item.why}</Text>
                                  {item.expectedOutcome ? (
                                    <Text as="p" variant="bodySm">
                                      Expected outcome: {item.expectedOutcome}
                                    </Text>
                                  ) : null}
                                  {item.urgency ? (
                                    <Badge tone="attention">{item.urgency}</Badge>
                                  ) : null}
                                </BlockStack>
                              </div>
                            ))
                          )}
                        </BlockStack>
                      </Card>
                      <Card>
                        <BlockStack gap="200">
                          <Text as="h3" variant="headingMd">Priority watchlist</Text>
                          {(responseEngine.responsePlans ?? []).length === 0 ? (
                            <Text as="p" tone="subdued">The response engine is in watch mode and will elevate products here if competitor pressure intensifies.</Text>
                          ) : (
                            (responseEngine.responsePlans ?? []).slice(0, 4).map((item) => (
                              <InlineStack key={`${item.productHandle}-strategy`} align="space-between" blockAlign="center">
                                <BlockStack gap="100">
                                  <Text as="p">{item.productHandle}</Text>
                                  <Text as="p" variant="bodySm" tone="subdued">{`${item.promotionSignals} promotion signals | ${item.stockSignals} stock signals | ${item.confidence}% estimated strength`}</Text>
                                  <Text as="p" variant="bodySm">{item.executionHint}</Text>
                                  <Text as="p" variant="bodySm" tone="subdued">{item.automationPosture}</Text>
                                </BlockStack>
                                <Button
                                  onClick={() =>
                                    window.open(
                                      getProductUrl(item.productHandle) ?? undefined,
                                      "_blank",
                                      "noopener,noreferrer"
                                    )
                                  }
                                  disabled={!getProductUrl(item.productHandle)}
                                >
                                  Open Shopify product
                                </Button>
                              </InlineStack>
                            ))
                          )}
                        </BlockStack>
                      </Card>
                      <Card>
                        <BlockStack gap="200">
                          <InlineStack align="space-between" blockAlign="center">
                            <Text as="h3" variant="headingMd">Competitor strategy detection</Text>
                            <Badge tone={canSeeStrategy ? "success" : "attention"}>{canSeeStrategy ? "Included" : "Pro feature"}</Badge>
                          </InlineStack>
                          {!canSeeStrategy ? (
                            <Banner title="Upgrade to Pro for strategy detection" tone="info">
                              <p>Growth keeps the move feed and action suggestions active, while Pro unlocks deeper competitor intent inference.</p>
                            </Banner>
                          ) : null}
                          {(overview.strategyDetections ?? []).length === 0 ? (
                            <Text as="p" tone="subdued">No live competitor strategy pattern has been detected yet.</Text>
                          ) : (
                            (overview.strategyDetections ?? []).map((detection) => (
                              <div key={`${detection.strategy}-${detection.why}`} className="vs-action-card">
                                <InlineStack align="space-between" blockAlign="start">
                                  <BlockStack gap="100">
                                    <Text as="p" variant="headingSm">{detection.strategy}</Text>
                                    <Text as="p" tone="subdued">{detection.why}</Text>
                                    <Text as="p" variant="bodySm">
                                      Why this matters: {detection.implication}
                                    </Text>
                                    <Text as="p" variant="bodySm">
                                      Recommended move: {detection.recommendedMove}
                                    </Text>
                                  </BlockStack>
                                    <Badge tone="attention">{detection.signalStrength}</Badge>
                                </InlineStack>
                              </div>
                            ))
                          )}
                        </BlockStack>
                      </Card>
                    </BlockStack>
                  )}
                </Box>
              </Tabs>
            </Card>
          </Layout.Section>
        </Layout>

        <Modal
          open={modalOpen}
          onClose={() => setModalOpen(false)}
          title="Competitor tracking domains"
          primaryAction={{ content: "Save domains", onAction: saveDomains }}
        >
          <Modal.Section>
            <BlockStack gap="300">
              <Text as="p">Add domains to monitor for promotions, launches, price shifts, and stock pressure.</Text>
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

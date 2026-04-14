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

type CompetitorPrimaryState =
  | "SETUP_INCOMPLETE"
  | "AWAITING_FIRST_RUN"
  | "NO_MATCHES"
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
};

type CompetitorOverview = {
  competitorState?: {
    primaryState: CompetitorPrimaryState;
    freshnessLabel: string;
    lastSuccessfulRunAt?: string | null;
    lastAttemptAt?: string | null;
    checkedDomainsCount: number;
    matchedProductsCount: number;
    activePromotionsCount: number;
    stockAlertsCount: number;
    coverageStatus: string;
    title: string;
    description: string;
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
      freshnessLabel: "Awaiting first successful refresh",
      lastSuccessfulRunAt: null,
      lastAttemptAt: null,
      checkedDomainsCount: 0,
      matchedProductsCount: 0,
      activePromotionsCount: 0,
      stockAlertsCount: 0,
      coverageStatus: "Setup required",
      title: "Competitor setup is incomplete",
      description:
        "Add competitor domains before VedaSuite can monitor comparable competitor products.",
      nextAction: "Add competitor domains",
      toastMessage: "Add competitor domains before refreshing competitor monitoring.",
    },
    sourceBreakdown: { website: 0, googleShopping: 0, metaAds: 0 },
    moveFeed: [],
    actionSuggestions: [],
    weeklyReport: {
      headline: "Competitor monitoring is not ready for a brief yet",
      whyItMatters:
        "VedaSuite needs a successful monitored refresh with matched products before weekly reporting becomes useful.",
      merchantBrief:
        "VedaSuite will build a weekly competitor brief after the first successful matched refresh.",
      nextBestAction: "Add competitor domains and run your first refresh.",
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
      return "Complete setup to start monitoring competitor domains and matched products.";
    case "AWAITING_FIRST_RUN":
      return "Domains are configured. Run the first refresh to begin competitor monitoring.";
    case "NO_MATCHES":
      return "Monitoring ran successfully, but VedaSuite has not found comparable competitor products yet.";
    case "NO_CHANGES":
      return "Monitoring is active and ready to surface competitor changes when they appear.";
    case "CHANGES_DETECTED":
      return "Review competitor price moves, promotion changes, and recommended responses.";
    case "STALE":
      return "Competitor data needs a fresh refresh before you act on it.";
    case "FAILURE":
      return "The latest competitor refresh needs attention before fresh monitoring can resume.";
  }
}

function getPrimaryActionLabel(state: CompetitorPrimaryState) {
  if (state === "SETUP_INCOMPLETE") return "Add competitor domains";
  if (state === "CHANGES_DETECTED") return "View changes";
  return "Refresh monitoring";
}

function getEmptyMessage(state: CompetitorPrimaryState, tab: "tracked" | "feed" | "strategy") {
  if (tab === "tracked") {
    if (state === "SETUP_INCOMPLETE") return "Add competitor domains to build the tracked products table.";
    if (state === "AWAITING_FIRST_RUN") return "Run the first refresh to build the tracked products table.";
    if (state === "NO_MATCHES") return "Monitoring ran successfully, but no comparable competitor products were found.";
    return "Tracked products will appear here after competitor data becomes available.";
  }
  if (tab === "feed") {
    if (state === "NO_MATCHES") return "No move feed is available yet because VedaSuite has not found comparable competitor products.";
    if (state === "NO_CHANGES") return "Monitoring is active. No price, stock, or promotion changes were detected in the latest refresh.";
    return "The move feed will populate as competitor changes are detected.";
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
  const [domainsInput, setDomainsInput] = useState("styleorbit.example, urbanloom.example");

  const allowed = !!subscription?.enabledModules?.competitor;
  const canSeeWeeklyReports =
    subscription?.capabilities?.["competitor.weeklyReports"] ?? false;
  const focus = searchParams.get("focus");
  const primaryState = overview.competitorState?.primaryState ?? "SETUP_INCOMPLETE";

  useEffect(() => {
    setSelectedTab(focus === "feed" ? 1 : focus === "strategy" ? 2 : 0);
  }, [focus]);

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
        setToast("Competitor monitoring could not be loaded. Please try again.");
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
          ? "Competitor tracking domains updated."
          : "Competitor tracking domains cleared."
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
      setToast("Competitor refresh failed. Please try again.");
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
    void ingestCompetitorData();
  };

  const summaryCards = [
    ["Matched products", overview.competitorState?.matchedProductsCount ?? 0],
    ["Active promotions", overview.competitorState?.activePromotionsCount ?? 0],
    ["Stock alerts", overview.competitorState?.stockAlertsCount ?? 0],
    ["Domains checked", overview.competitorState?.checkedDomainsCount ?? 0],
    ["Monitoring freshness", overview.competitorState?.freshnessLabel ?? "Unknown"],
    ["Coverage status", overview.competitorState?.coverageStatus ?? "Unknown"],
  ];

  const monitoringStatusRows = [
    ["Primary state", overview.competitorState?.title ?? "Unknown"],
    [
      "Last successful refresh",
      formatDateTime(overview.competitorState?.lastSuccessfulRunAt),
    ],
    ["Last refresh attempt", formatDateTime(overview.competitorState?.lastAttemptAt)],
    ["Domains checked", String(overview.competitorState?.checkedDomainsCount ?? 0)],
    ["Matched products", String(overview.competitorState?.matchedProductsCount ?? 0)],
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
              <Banner title="Loading competitor monitoring" tone="info">
                <p>VedaSuite is loading competitor state, coverage, and response guidance.</p>
              </Banner>
            </Layout.Section>
          ) : null}

          <Layout.Section>
            <Banner
              title={overview.competitorState?.title ?? "Competitor monitoring"}
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

          <Layout.Section>
            <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
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
                  <BlockStack gap="150">
                    {(overview.actionSuggestions?.length
                      ? overview.actionSuggestions.map((item) => `${item.productHandle}: ${item.suggestion}`)
                      : [overview.competitorState?.nextAction ?? "Review competitor monitoring state."]).map((item) => (
                      <Text key={item} as="p">
                        - {item}
                      </Text>
                    ))}
                  </BlockStack>
                </BlockStack>
              </Card>

              <Card>
                <BlockStack gap="300">
                  <Text as="h3" variant="headingMd">
                    Monitoring status
                  </Text>
                  <BlockStack gap="200">
                    {monitoringStatusRows.map(([label, value]) => (
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
            </InlineGrid>
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
                          ["Google Shopping", sourceBreakdown.googleShopping],
                          ["Meta Ads", sourceBreakdown.metaAds],
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
                                : connector.readiness === "Preview"
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

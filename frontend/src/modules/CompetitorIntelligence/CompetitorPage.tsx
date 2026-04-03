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
  price?: number;
  promotion?: string | null;
  stockStatus?: string | null;
  source?: string;
  adCopy?: string | null;
};

type CompetitorOverview = {
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
  sourceBreakdown?: {
    website: number;
    googleShopping: number;
    metaAds: number;
  };
  topMovers?: Array<{
    productHandle: string;
    priceDelta: number;
    promotionSignals: number;
    stockSignals: number;
  }>;
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

const resourceName = {
  singular: "competitor product",
  plural: "competitor products",
};

export function CompetitorPage() {
  const { getProductUrl } = useShopifyAdminLinks();
  const [searchParams] = useSearchParams();
  const { subscription, loading: subscriptionLoading } = useSubscriptionPlan();
  const cachedRows = readModuleCache<CompetitorRow[]>("competitor-rows");
  const cachedOverview = readModuleCache<CompetitorOverview>("competitor-overview");
  const cachedConnectors = readModuleCache<CompetitorConnector[]>(
    "competitor-connectors"
  );
  const cachedResponseEngine = readModuleCache<CompetitorResponseEngine>(
    "competitor-response-engine"
  );
  const [rows, setRows] = useState<CompetitorRow[]>(cachedRows ?? []);
  const [overview, setOverview] = useState<CompetitorOverview | null>(
    cachedOverview ?? null
  );
  const [connectors, setConnectors] = useState<CompetitorConnector[]>(
    cachedConnectors ?? []
  );
  const [responseEngine, setResponseEngine] =
    useState<CompetitorResponseEngine | null>(cachedResponseEngine ?? null);
  const [loading, setLoading] = useState(false);
  const [selectedTab, setSelectedTab] = useState(0);
  const [modalOpen, setModalOpen] = useState(false);
  const [ingesting, setIngesting] = useState(false);
  const [domainsInput, setDomainsInput] = useState(
    "styleorbit.example, urbanloom.example"
  );
  const [toast, setToast] = useState<string | null>(null);
  const focus = searchParams.get("focus");

  const effectiveConnectors = useMemo(
    () =>
      connectors.length > 0
        ? connectors
        : [
            {
              id: "website",
              label: "Website monitoring",
              description:
                "Track competitor pricing, promotions, and stock posture across monitored storefronts.",
              connected: false,
              trackedTargets: 0,
              readiness: "Add competitor domains to begin monitoring",
            },
            {
              id: "shopping",
              label: "Google Shopping signals",
              description:
                "Estimate shopping-surface pressure and pricing posture from tracked competitor coverage.",
              connected: false,
              trackedTargets: 0,
              readiness: "Available after monitored products are ingested",
            },
            {
              id: "ads",
              label: "Ad pressure watch",
              description:
                "Surface Meta-style ad and promotion signals alongside website monitoring.",
              connected: false,
              trackedTargets: 0,
              readiness: "Build your tracked domain set first",
            },
          ],
    [connectors]
  );

  useEffect(() => {
    Promise.all([
      embeddedShopRequest<{ products: CompetitorRow[] }>("/api/competitor/products", {
        timeoutMs: 30000,
      }),
      embeddedShopRequest<CompetitorOverview>("/api/competitor/overview", {
        timeoutMs: 30000,
      }),
      embeddedShopRequest<{ connectors: CompetitorConnector[] }>(
        "/api/competitor/connectors",
        { timeoutMs: 30000 }
      ),
      embeddedShopRequest<{ responseEngine: CompetitorResponseEngine }>(
        "/api/competitor/response-engine",
        { timeoutMs: 30000 }
      ),
    ])
      .then(([productsResponse, overviewResponse, connectorsResponse, responseEngineResponse]) => {
        setRows(productsResponse.products);
        setOverview(overviewResponse);
        setConnectors(connectorsResponse.connectors);
        setResponseEngine(responseEngineResponse.responseEngine);
        writeModuleCache("competitor-rows", productsResponse.products);
        writeModuleCache("competitor-overview", overviewResponse);
        writeModuleCache("competitor-connectors", connectorsResponse.connectors);
        writeModuleCache(
          "competitor-response-engine",
          responseEngineResponse.responseEngine
        );
      })
      .catch(() => {
        setRows([]);
        setOverview(null);
        setConnectors([]);
        setResponseEngine(null);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    setSelectedTab(
      focus === "insights" ? 1 : focus === "strategy" ? 2 : 0
    );
  }, [focus]);

  const insights = useMemo(() => {
    if (!overview) {
      return [];
    }

    return [
      `Market pressure is ${overview.marketPressure ?? "Low"} with ${
        overview.recentPriceChanges
      } fresh competitor signals.`,
      `Promotional heat is ${overview.promotionalHeat ?? "Low"} across ${
        overview.promotionAlerts
      } detected offers.`,
      overview.freshnessHours != null
        ? `Latest ingestion ran ${overview.freshnessHours} hours ago, which keeps monitoring current.`
        : "Run ingestion to build fresh competitor coverage across your tracked catalog.",
    ];
  }, [overview]);

  const summary = useMemo(
    () => ({
      tracked: rows.length,
      promotions: rows.filter((row) => row.promotion).length,
      stockAlerts: rows.filter((row) => row.stockStatus === "low_stock").length,
    }),
    [rows]
  );

  const visibleRows = useMemo(() => {
    if (focus === "promotions") {
      return rows.filter((row) => row.promotion);
    }

    if (focus === "stock") {
      return rows.filter((row) => row.stockStatus === "low_stock");
    }

    return rows;
  }, [focus, rows]);

  const focusMessage =
    focus === "promotions"
      ? "Showing tracked products with active promotions so you can judge whether a response is necessary."
      : focus === "stock"
      ? "Showing low-stock competitor items where margin expansion may be possible."
      : null;

  const moveFeed = useMemo(
    () =>
      rows.slice(0, 8).map((row) => ({
        id: row.id,
        headline: `${row.competitorName} moved on ${row.productHandle}`,
        detail:
          row.promotion ??
          row.adCopy ??
          (row.stockStatus ? `Stock posture: ${row.stockStatus}` : "Price observation captured"),
        source: row.source ?? "website",
      })),
    [rows]
  );

  const strategyDetections = useMemo(() => {
    if (!responseEngine?.responsePlans?.length) {
      return [];
    }

    return responseEngine.responsePlans.slice(0, 3).map((plan) => ({
      productHandle: plan.productHandle,
      label:
        plan.recommendedPlay === "bundle_defense"
          ? "Likely inventory-clearout or share-defense push"
          : plan.recommendedPlay === "selective_match"
          ? "Likely tactical discounting on exposed SKU"
          : "Likely watch-and-hold posture from competitor",
      why: plan.rationale,
    }));
  }, [responseEngine]);

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
      setToast("Competitor tracking domains updated.");
      setModalOpen(false);
    } catch {
      setToast("Unable to update competitor domains.");
    }
  };

  const ingestCompetitorData = async () => {
    try {
      setIngesting(true);
      const [productsResponse, overviewResponse] = await Promise.all([
        embeddedShopRequest<{ result: { ingested: number } }>("/api/competitor/ingest", {
          method: "POST",
          timeoutMs: 45000,
        }),
        embeddedShopRequest<{ products: CompetitorRow[] }>("/api/competitor/products", {
          timeoutMs: 30000,
        }),
      ]);
      setToast(
        `Competitor ingestion completed with ${productsResponse.result.ingested} fresh market records.`
      );
      setRows(overviewResponse.products);
      writeModuleCache("competitor-rows", overviewResponse.products);
      const [refreshedOverview, refreshedConnectors, refreshedResponseEngine] =
        await Promise.all([
        embeddedShopRequest<CompetitorOverview>("/api/competitor/overview", {
          timeoutMs: 30000,
        }),
        embeddedShopRequest<{ connectors: CompetitorConnector[] }>(
          "/api/competitor/connectors",
          { timeoutMs: 30000 }
        ),
        embeddedShopRequest<{ responseEngine: CompetitorResponseEngine }>(
          "/api/competitor/response-engine",
          { timeoutMs: 30000 }
        ),
      ]);
      setOverview(refreshedOverview);
      writeModuleCache("competitor-overview", refreshedOverview);
      setConnectors(refreshedConnectors.connectors);
      writeModuleCache("competitor-connectors", refreshedConnectors.connectors);
      setResponseEngine(refreshedResponseEngine.responseEngine);
      writeModuleCache(
        "competitor-response-engine",
        refreshedResponseEngine.responseEngine
      );
    } catch {
      setToast("Unable to ingest competitor data right now.");
    } finally {
      setIngesting(false);
    }
  };

  return (
    <ModuleGate
      title="Competitor Intelligence"
      subtitle="Track price moves, promotions, and stock posture across key competitor domains."
      requiredPlan="Starter, Growth, or Pro"
      allowed={!!subscription?.enabledModules.competitor}
    >
        <Page
          title="Competitor Intelligence"
          subtitle={
            rows.length === 0
              ? "No competitor tracking data is available yet."
              : "Track price moves, promotions, and stock posture across key competitor domains."
          }
          primaryAction={{
            content: ingesting ? "Ingesting..." : "Ingest competitor data",
            onAction: ingestCompetitorData,
            disabled: ingesting,
          }}
          secondaryActions={[
            {
              content: "Update domains",
              onAction: () => setModalOpen(true),
            },
          ]}
        >
          <Layout>
            {subscriptionLoading || loading ? (
              <Layout.Section>
                <Banner title="Refreshing competitor intelligence" tone="info">
                  <p>Competitor data is loading in the background.</p>
                </Banner>
              </Layout.Section>
            ) : null}
            <Layout.Section>
              {rows.length === 0 ? (
                <Banner title="Competitor monitoring is ready to configure" tone="info">
                  <p>
                    Add monitored domains, then run ingestion to build competitor price, promotion, launch, and ad-pressure coverage.
                  </p>
                </Banner>
              ) : (
                <Banner title="Market monitoring is live" tone="success">
                  <p>
                    VedaSuite can combine competitor websites, Google Shopping, and ad
                    intelligence into weekly market movement reports.
                  </p>
                </Banner>
              )}
            </Layout.Section>
            {focusMessage ? (
              <Layout.Section>
                <Banner title="Focused market view" tone="info">
                  <p>{focusMessage}</p>
                </Banner>
              </Layout.Section>
            ) : null}

            <Layout.Section>
              <Card>
                <BlockStack gap="300">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="h3" variant="headingMd">
                      Competitor Move Feed
                    </Text>
                    <Badge tone="info">
                      {moveFeed.length > 0 ? `${moveFeed.length} recent moves` : "Awaiting first ingest"}
                    </Badge>
                  </InlineStack>
                  {moveFeed.length === 0 ? (
                    <Text as="p" tone="subdued">
                      The move feed will surface launches, promotions, ad pressure, and stock posture once competitor ingestion runs.
                    </Text>
                  ) : (
                    moveFeed.map((item) => (
                      <div key={item.id} className="vs-action-card">
                        <InlineStack align="space-between" blockAlign="start">
                          <BlockStack gap="100">
                            <Text as="p" variant="headingSm">
                              {item.headline}
                            </Text>
                            <Text as="p" tone="subdued">
                              {item.detail}
                            </Text>
                          </BlockStack>
                          <Badge tone="attention">{item.source}</Badge>
                        </InlineStack>
                      </div>
                    ))
                  )}
                </BlockStack>
              </Card>
            </Layout.Section>
            <Layout.Section>
              <InlineGrid columns={{ xs: 1, md: 3 }} gap="400">
                {effectiveConnectors.map((connector) => (
                  <Card key={connector.id}>
                    <BlockStack gap="200">
                      <InlineStack align="space-between" blockAlign="center">
                        <Text as="h3" variant="headingMd">
                          {connector.label}
                        </Text>
                        <Badge tone={connector.connected ? "success" : "attention"}>
                          {connector.connected ? "Connected" : "Needs setup"}
                        </Badge>
                      </InlineStack>
                      <Text as="p" tone="subdued">
                        {connector.description}
                      </Text>
                      <Text as="p" variant="bodySm" tone="subdued">
                        Targets: {connector.trackedTargets}
                      </Text>
                      {connector.readiness ? (
                        <Text as="p" variant="bodySm" tone="subdued">
                          Status: {connector.readiness}
                        </Text>
                      ) : null}
                      <Text as="p" variant="bodySm" tone="subdued">
                        {connector.lastIngestedAt
                          ? `Last ingested ${new Date(
                              connector.lastIngestedAt
                            ).toLocaleString()}`
                          : "No ingestion yet"}
                      </Text>
                    </BlockStack>
                  </Card>
                ))}
              </InlineGrid>
            </Layout.Section>
            <Layout.Section>
              <InlineGrid columns={{ xs: 1, md: 3 }} gap="400">
                <Card>
                  <BlockStack gap="200">
                    <Text as="h3" variant="headingMd">
                      Tracked products
                    </Text>
                    <Text as="p" variant="heading2xl">
                      {summary.tracked}
                    </Text>
                  </BlockStack>
                </Card>
                <Card>
                  <BlockStack gap="200">
                    <Text as="h3" variant="headingMd">
                      Active promotions
                    </Text>
                    <Text as="p" variant="heading2xl">
                      {overview?.promotionAlerts ?? summary.promotions}
                    </Text>
                  </BlockStack>
                </Card>
                <Card>
                  <BlockStack gap="200">
                    <Text as="h3" variant="headingMd">
                      Stock alerts
                    </Text>
                    <Text as="p" variant="heading2xl">
                      {overview?.stockMovementAlerts ?? summary.stockAlerts}
                    </Text>
                  </BlockStack>
                </Card>
                <Card>
                  <BlockStack gap="200">
                    <Text as="h3" variant="headingMd">
                      Tracked domains
                    </Text>
                    <Text as="p" variant="heading2xl">
                      {overview?.trackedDomains ?? 0}
                    </Text>
                  </BlockStack>
                </Card>
                <Card>
                  <BlockStack gap="200">
                    <Text as="h3" variant="headingMd">
                      Monitoring freshness
                    </Text>
                    <Text as="p" variant="heading2xl">
                      {overview?.freshnessHours != null
                        ? `${overview.freshnessHours}h`
                        : "N/A"}
                    </Text>
                  </BlockStack>
                </Card>
                <Card>
                  <BlockStack gap="200">
                    <Text as="h3" variant="headingMd">
                      Ad pressure
                    </Text>
                    <Text as="p" variant="heading2xl">
                      {overview?.adPressure ?? "Low"}
                    </Text>
                  </BlockStack>
                </Card>
              </InlineGrid>
            </Layout.Section>
            <Layout.Section>
              <Card>
                <BlockStack gap="300">
                  <InlineStack align="space-between" blockAlign="center">
                    <BlockStack gap="100">
                      <Text as="h3" variant="headingMd">
                        Market movement in the last 24 hours
                      </Text>
                      <Text as="p" tone="subdued">
                        Price changes and promotions are refreshed from your tracked competitor set.
                      </Text>
                    </BlockStack>
                    <Badge tone="success">
                      {`${overview?.recentPriceChanges ?? summary.tracked} signals`}
                    </Badge>
                  </InlineStack>
                  <InlineGrid columns={{ xs: 1, md: 3 }} gap="300">
                    <div className="vs-signal-stat">
                      <Text as="p" variant="bodySm" tone="subdued">
                        Website crawl
                      </Text>
                      <Text as="p" variant="headingLg">
                        {overview?.sourceBreakdown?.website ?? 0}
                      </Text>
                    </div>
                    <div className="vs-signal-stat">
                      <Text as="p" variant="bodySm" tone="subdued">
                        Google Shopping
                      </Text>
                      <Text as="p" variant="headingLg">
                        {overview?.sourceBreakdown?.googleShopping ?? 0}
                      </Text>
                    </div>
                    <div className="vs-signal-stat">
                      <Text as="p" variant="bodySm" tone="subdued">
                        Meta Ad Library
                      </Text>
                      <Text as="p" variant="headingLg">
                        {overview?.sourceBreakdown?.metaAds ?? 0}
                      </Text>
                    </div>
                  </InlineGrid>
                </BlockStack>
              </Card>
            </Layout.Section>

            <Layout.Section>
              <Card>
                <Tabs
                  tabs={[
                    { id: "tracked", content: "Tracked products" },
                    { id: "insights", content: "AI insights" },
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
                              No tracked competitor results yet
                            </Text>
                            <Text as="p" tone="subdued">
                              Add competitor domains, run ingestion, and VedaSuite will start surfacing price moves, promotions, stock posture, launch watch signals, and response recommendations here.
                            </Text>
                            <InlineStack gap="300">
                              <Button onClick={() => setModalOpen(true)}>
                                Add competitor domains
                              </Button>
                              <Button variant="secondary" onClick={ingestCompetitorData}>
                                Run first ingestion
                              </Button>
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
                              <IndexTable.Cell>
                                {row.price != null ? `$${row.price.toFixed(2)}` : "-"}
                              </IndexTable.Cell>
                              <IndexTable.Cell>
                            {row.promotion ? (
                                  <Badge tone="info">{row.promotion}</Badge>
                                ) : (
                                  "-"
                                )}
                              </IndexTable.Cell>
                              <IndexTable.Cell>
                                <BlockStack gap="100">
                                  <Text as="span">{row.stockStatus ?? "-"}</Text>
                                  {row.source ? (
                                    <Badge tone="info">{row.source}</Badge>
                                  ) : null}
                                </BlockStack>
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
                    ) : selectedTab === 1 ? (
                      <BlockStack gap="300">
                        {insights.map((insight) => (
                          <Card key={insight}>
                            <InlineStack align="space-between">
                              <Text as="p">{insight}</Text>
                              <Badge tone="success">AI insight</Badge>
                            </InlineStack>
                          </Card>
                        ))}
                        {overview?.topMovers?.length ? (
                          <Card>
                            <BlockStack gap="200">
                              <Text as="h3" variant="headingMd">
                                Highest market movers
                              </Text>
                              {overview.topMovers.map((mover) => (
                                <InlineStack
                                  key={mover.productHandle}
                                  align="space-between"
                                  blockAlign="center"
                                >
                                  <BlockStack gap="100">
                                    <Text as="p">{mover.productHandle}</Text>
                                    <Text as="p" variant="bodySm" tone="subdued">
                                      {`${mover.promotionSignals} promo signals | ${mover.stockSignals} stock signals`}
                                    </Text>
                                  </BlockStack>
                                  <Badge tone={mover.priceDelta < 0 ? "attention" : "info"}>
                                    {mover.priceDelta >= 0
                                      ? `+$${mover.priceDelta.toFixed(2)}`
                                      : `-$${Math.abs(mover.priceDelta).toFixed(2)}`}
                                  </Badge>
                                </InlineStack>
                              ))}
                            </BlockStack>
                          </Card>
                        ) : null}
                        {overview?.launchAlerts?.length ? (
                          <Card>
                            <BlockStack gap="200">
                              <Text as="h3" variant="headingMd">
                                Product launch alerts
                              </Text>
                              {overview.launchAlerts.map((alert) => (
                                <InlineStack
                                  key={`${alert.productHandle}-${alert.collectedAt}`}
                                  align="space-between"
                                  blockAlign="center"
                                >
                                  <BlockStack gap="100">
                                    <Text as="p">{alert.productHandle}</Text>
                                    <Text as="p" variant="bodySm" tone="subdued">
                                      {`${alert.competitorName} | ${alert.source}`}
                                    </Text>
                                  </BlockStack>
                                  <Badge tone="attention">Launch watch</Badge>
                                </InlineStack>
                              ))}
                            </BlockStack>
                          </Card>
                        ) : null}
                        {visibleRows
                          .filter((row) => row.adCopy)
                          .slice(0, 2)
                          .map((row) => (
                            <Card key={`${row.id}-adcopy`}>
                              <BlockStack gap="100">
                                <InlineStack align="space-between" blockAlign="center">
                                  <Text as="h3" variant="headingMd">
                                    {row.competitorName} ad signal
                                  </Text>
                                  <Badge tone="attention">Meta Ad Library</Badge>
                                </InlineStack>
                                <Text as="p" tone="subdued">
                                  {row.adCopy}
                                </Text>
                              </BlockStack>
                            </Card>
                          ))}
                      </BlockStack>
                    ) : (
                      <BlockStack gap="300">
                        <Card>
                          <BlockStack gap="200">
                            <Text as="h3" variant="headingMd">
                              Recommended market response
                            </Text>
                            {responseEngine ? (
                              <Badge tone="info">
                                {`${responseEngine.summary.responseMode} | ${responseEngine.summary.topPressureCount} high-pressure SKUs`}
                              </Badge>
                            ) : null}
                            <Text as="p" tone="subdued">
                              {overview?.promotionalHeat === "High"
                                ? "Use selective pricing responses and lean on bundles instead of matching every promotion."
                                : overview?.marketPressure === "High"
                                ? "Maintain daily monitoring and prioritize hero SKU defense."
                                : "Keep a focused watchlist and avoid unnecessary discounting while the market stays stable."}
                            </Text>
                            {responseEngine ? (
                              <Text as="p" variant="bodySm" tone="subdued">
                                {responseEngine.summary.automationReadiness}
                              </Text>
                            ) : null}
                          </BlockStack>
                        </Card>
                        <InlineGrid columns={{ xs: 1, md: 3 }} gap="300">
                          <Card>
                            <BlockStack gap="200">
                              <InlineStack align="space-between" blockAlign="center">
                                <Text as="h3" variant="headingMd">
                                  Hold price
                                </Text>
                                <Badge tone="success">Margin-first</Badge>
                              </InlineStack>
                              <Text as="p" tone="subdued">
                                Best when promotional heat is low and your competitor signals are not concentrated on hero SKUs.
                              </Text>
                            </BlockStack>
                          </Card>
                          <Card>
                            <BlockStack gap="200">
                              <InlineStack align="space-between" blockAlign="center">
                                <Text as="h3" variant="headingMd">
                                  Selective match
                                </Text>
                                <Badge tone="attention">Tactical</Badge>
                              </InlineStack>
                              <Text as="p" tone="subdued">
                                Use this when one or two products show repeated price drops and promotion clustering.
                              </Text>
                            </BlockStack>
                          </Card>
                          <Card>
                            <BlockStack gap="200">
                              <InlineStack align="space-between" blockAlign="center">
                                <Text as="h3" variant="headingMd">
                                  Bundle defense
                                </Text>
                                <Badge tone="info">Response plan</Badge>
                              </InlineStack>
                              <Text as="p" tone="subdued">
                                Protect margin by packaging complementary products instead of broad catalog discounting.
                              </Text>
                            </BlockStack>
                          </Card>
                        </InlineGrid>
                        <Card>
                          <BlockStack gap="200">
                            <Text as="h3" variant="headingMd">
                              Priority watchlist
                            </Text>
                            {(responseEngine?.responsePlans ?? []).slice(0, 3).map((item) => (
                              <InlineStack
                                key={`${item.productHandle}-strategy`}
                                align="space-between"
                                blockAlign="center"
                              >
                                <BlockStack gap="100">
                                  <Text as="p">{item.productHandle}</Text>
                                  <Text as="p" variant="bodySm" tone="subdued">
                                    {`${item.promotionSignals} promotion signals | ${item.stockSignals} stock signals | ${item.confidence}% confidence`}
                                  </Text>
                                  <Text as="p" variant="bodySm">
                                    {item.executionHint}
                                  </Text>
                                  <Text as="p" variant="bodySm" tone="subdued">
                                    {item.automationPosture}
                                  </Text>
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
                            ))}
                          </BlockStack>
                        </Card>
                        {responseEngine?.responsePlans?.length ? (
                          <Card>
                            <BlockStack gap="200">
                              <Text as="h3" variant="headingMd">
                                Response explanations
                              </Text>
                              {responseEngine.responsePlans.slice(0, 2).map((plan) => (
                                <BlockStack key={`${plan.productHandle}-explain`} gap="100">
                                  <InlineStack align="space-between" blockAlign="center">
                                    <Text as="p">{plan.productHandle}</Text>
                                    <Badge tone="success">{plan.recommendedPlay}</Badge>
                                  </InlineStack>
                                  {plan.reasons.map((reason) => (
                                    <Text
                                      key={`${plan.productHandle}-${reason}`}
                                      as="p"
                                      variant="bodySm"
                                      tone="subdued"
                                    >
                                      {reason}
                                    </Text>
                                  ))}
                                  <Text as="p" variant="bodySm">
                                    {plan.rationale}
                                  </Text>
                                </BlockStack>
                              ))}
                            </BlockStack>
                          </Card>
                        ) : null}
                        {strategyDetections.length > 0 ? (
                          <Card>
                            <BlockStack gap="200">
                              <Text as="h3" variant="headingMd">
                                Competitor strategy detection
                              </Text>
                              {strategyDetections.map((detection) => (
                                <div
                                  key={`${detection.productHandle}-${detection.label}`}
                                  className="vs-action-card"
                                >
                                  <Text as="p" variant="headingSm">
                                    {detection.productHandle}
                                  </Text>
                                  <Text as="p">{detection.label}</Text>
                                  <Text as="p" tone="subdued">
                                    {detection.why}
                                  </Text>
                                </div>
                              ))}
                            </BlockStack>
                          </Card>
                        ) : null}
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
                <Text as="p">
                  Add domains to monitor for promotions, launches, and pricing shifts.
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

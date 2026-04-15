import { prisma } from "../db/prismaClient";
import { fetchCompetitorSnapshot } from "./shopifyAdminService";
import {
  deriveModuleReadiness,
  deriveSyncStatus,
  getStoreOperationalSnapshot,
} from "./storeOperationalStateService";
import {
  createUnifiedModuleState,
  toIsoString,
} from "./unifiedModuleStateService";

type CompetitorSetupStatus =
  | "READY"
  | "NO_DOMAINS"
  | "NO_MONITORED_PRODUCTS";

type CompetitorSyncStatus =
  | "NOT_STARTED"
  | "RUNNING"
  | "SUCCEEDED"
  | "SUCCEEDED_NO_DATA"
  | "FAILED";

type CompetitorCrawlStatus =
  | "NOT_STARTED"
  | "RUNNING"
  | "SUCCEEDED"
  | "PARTIAL"
  | "FAILED";

type CompetitorSnapshotStatus =
  | "NOT_STARTED"
  | "READY"
  | "NO_MATCHES"
  | "NO_CHANGES"
  | "PARTIAL"
  | "FAILED";

type CompetitorFreshnessStatus = "UNKNOWN" | "FRESH" | "STALE";
type CompetitorPrimaryState =
  | "SETUP_INCOMPLETE"
  | "AWAITING_FIRST_RUN"
  | "NO_MATCHES"
  | "LOW_CONFIDENCE"
  | "NO_CHANGES"
  | "CHANGES_DETECTED"
  | "STALE"
  | "FAILURE";
type CompetitorChannelAvailability = "Live" | "Configured" | "Preview" | "Not enabled";

type SourceProductCandidate = {
  productHandle: string;
  title: string;
  status: string;
  currentPrice: number | null;
};

type CompetitorMatchMetadata = {
  confidenceScore: number;
  confidenceLabel: "high" | "medium" | "low";
  matchReason: string;
  usedFallbackPrice: boolean;
  externalFetch?: boolean;
  sourceProductTitle?: string;
  sourceProductStatus?: string;
};

const GIFT_CARD_PATTERN =
  /\bgift\s*card\b|\bgiftcard\b|\bgift[-\s]?voucher\b|\be[-\s]?gift\b/i;

function parseCompetitorMetadata(value?: string | null): CompetitorMatchMetadata | null {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value) as CompetitorMatchMetadata;
  } catch {
    return null;
  }
}

function normalizeCompetitorMetadata(
  row: Pick<
    OverviewRow,
    "insightsJson" | "productHandle" | "price" | "promotion" | "stockStatus"
  >
): CompetitorMatchMetadata {
  const parsed = parseCompetitorMetadata(row.insightsJson);
  if (parsed) {
    return parsed;
  }

  const confidenceScore =
    row.price != null
      ? 82
      : row.promotion || row.stockStatus === "low_stock" || row.stockStatus === "out_of_stock"
      ? 58
      : 42;

  return {
    confidenceScore,
    confidenceLabel:
      confidenceScore >= 80 ? "high" : confidenceScore >= 60 ? "medium" : "low",
    matchReason:
      confidenceScore >= 80
        ? "Live competitor pricing was captured for this product."
        : confidenceScore >= 60
        ? "The product page matched, but only part of the live pricing signal could be confirmed."
        : "The match relied on weak page signals and is excluded from comparable-product reporting.",
    usedFallbackPrice: confidenceScore < 80,
  };
}

export function filterCompetitorSourceProducts(products: SourceProductCandidate[]) {
  const excluded = {
    archived: 0,
    draft: 0,
    giftCardLike: 0,
    missingPrice: 0,
  };

  const eligible = products.filter((product) => {
    const status = (product.status ?? "").toLowerCase();
    if (status === "archived") {
      excluded.archived += 1;
      return false;
    }
    if (status === "draft") {
      excluded.draft += 1;
      return false;
    }
    if (GIFT_CARD_PATTERN.test(product.title)) {
      excluded.giftCardLike += 1;
      return false;
    }
    if (product.currentPrice == null || product.currentPrice <= 0) {
      excluded.missingPrice += 1;
      return false;
    }
    return true;
  });

  return {
    eligible,
    excluded,
    excludedCount:
      excluded.archived + excluded.draft + excluded.giftCardLike + excluded.missingPrice,
  };
}

function filterComparableRows(rows: OverviewRow[]) {
  const deduped = new Map<string, OverviewRow>();
  const lowConfidenceRows: OverviewRow[] = [];
  const excludedDuplicates: OverviewRow[] = [];

  for (const row of rows) {
    const metadata = normalizeCompetitorMetadata(row);
    if (metadata.confidenceScore < 60) {
      lowConfidenceRows.push(row);
      continue;
    }

    const key = `${row.productHandle}::${row.competitorName}::${row.source}`;
    if (deduped.has(key)) {
      excludedDuplicates.push(row);
      continue;
    }
    deduped.set(key, row);
  }

  const comparableRows = Array.from(deduped.values());
  return {
    comparableRows,
    lowConfidenceRows,
    excludedDuplicates,
    validMatchedProductsCount: new Set(comparableRows.map((row) => row.productHandle)).size,
    lowConfidenceProductsCount: new Set(lowConfidenceRows.map((row) => row.productHandle)).size,
  };
}

function getCompetitorFreshnessLabel(
  freshnessHours: number | null,
  lastSuccessfulRunAt: Date | null
) {
  if (!lastSuccessfulRunAt) {
    return "Awaiting first successful refresh";
  }
  if (freshnessHours == null) {
    return "Refresh time unavailable";
  }
  if (freshnessHours <= 1) {
    return "Refreshed recently";
  }
  if (freshnessHours > 24) {
    return `Stale: last refreshed ${freshnessHours} hours ago`;
  }
  return `Last refreshed ${freshnessHours} hours ago`;
}

export function deriveCompetitorPrimaryState(args: {
  hasDomains: boolean;
  syncStatusLabel: CompetitorSyncStatus;
  lastSuccessfulRunAt: Date | null;
  freshnessHours: number | null;
  validMatchedProductsCount: number;
  lowConfidenceProductsCount: number;
  changesDetected: boolean;
}) {
  if (!args.hasDomains) {
    return "SETUP_INCOMPLETE" as const;
  }
  if (args.syncStatusLabel === "FAILED") {
    return "FAILURE" as const;
  }
  if (!args.lastSuccessfulRunAt) {
    return "AWAITING_FIRST_RUN" as const;
  }
  if (args.freshnessHours != null && args.freshnessHours > 24) {
    return "STALE" as const;
  }
  if (args.validMatchedProductsCount === 0 && args.lowConfidenceProductsCount > 0) {
    return "LOW_CONFIDENCE" as const;
  }
  if (args.validMatchedProductsCount === 0) {
    return "NO_MATCHES" as const;
  }
  if (!args.changesDetected) {
    return "NO_CHANGES" as const;
  }
  return "CHANGES_DETECTED" as const;
}

function getCompetitorPrimaryStateCopy(args: {
  primaryState: CompetitorPrimaryState;
  freshnessLabel: string;
  validMatchedProductsCount: number;
  lowConfidenceProductsCount: number;
  checkedDomainsCount: number;
  changesDetected: number;
  latestError: string | null;
  lastSuccessfulRunAt: Date | null;
}) {
  switch (args.primaryState) {
    case "SETUP_INCOMPLETE":
      return {
        title: "Competitor setup is incomplete",
        description:
          "Add competitor domains before VedaSuite can check live competitor websites for comparable products.",
        nextAction: "Add competitor domains",
        coverageStatus: "Setup required",
        toastMessage: "Add competitor domains before refreshing competitor monitoring.",
      };
    case "AWAITING_FIRST_RUN":
      return {
        title: "Configured, awaiting first successful run",
        description:
          "Domains are configured, but VedaSuite has not completed its first successful competitor refresh yet.",
        nextAction: "Run competitor monitoring",
        coverageStatus: "Awaiting first run",
        toastMessage: "Refresh started. VedaSuite is preparing the first competitor monitoring run.",
      };
    case "NO_MATCHES":
      return {
        title: "Monitoring is active, but no comparable competitor products were found",
        description:
          "The latest refresh completed successfully, but none of the monitored competitor pages matched your tracked products yet.",
        nextAction: "Review tracked products or add more competitor domains",
        coverageStatus: "No comparable matches found",
        toastMessage: "Refresh completed. No comparable competitor products were found.",
      };
    case "LOW_CONFIDENCE":
      return {
        title: "Monitoring ran, but only low-confidence matches were found",
        description:
          "VedaSuite found possible competitor pages, but the captured signals were too weak to treat them as reliable comparable products.",
        nextAction: "Review domains, product overlap, or run another refresh",
        coverageStatus: "Low-confidence matches only",
        toastMessage:
          "Refresh completed. Possible competitor matches were found, but they were not reliable enough to use yet.",
      };
    case "NO_CHANGES":
      return {
        title: "Monitoring is active. No competitor changes detected",
        description:
          "Comparable products were matched successfully, but the latest refresh did not detect any new price, promotion, or stock changes.",
        nextAction: "Review tracked products or refresh again later",
        coverageStatus: "Healthy with no changes",
        toastMessage: "Refresh completed. No competitor changes detected.",
      };
    case "CHANGES_DETECTED":
      return {
        title: "Competitor changes were detected across matched products",
        description: `The latest refresh checked ${args.checkedDomainsCount} domains, matched ${args.validMatchedProductsCount} comparable products, and found ${args.changesDetected} live competitor changes.`,
        nextAction: "View changes",
        coverageStatus: "Changes detected",
        toastMessage: "Refresh completed. New competitor changes detected.",
      };
    case "STALE":
      return {
        title: "Competitor monitoring is stale",
        description: `Competitor data is older than the freshness threshold. ${args.freshnessLabel}.`,
        nextAction: "Refresh competitor monitoring",
        coverageStatus: "Stale: refresh recommended",
        toastMessage: "Competitor data is stale. Run a refresh to update monitoring.",
      };
    case "FAILURE":
    default:
      return {
        title: "Competitor refresh failed",
        description:
          args.latestError ??
          "VedaSuite could not complete the latest competitor refresh.",
        nextAction: "Retry refresh",
        coverageStatus: "Refresh failed",
        toastMessage: "Competitor refresh failed. Please try again.",
      };
  }
}

function normalizeCompetitorName(domain: string, label?: string | null) {
  return label ?? domain.replace(/\..+$/, "").replace(/[-_]/g, " ");
}

function formatSourceLabel(source: string) {
  if (source === "google_shopping") return "Google Shopping (limited preview)";
  if (source === "meta_ads") return "Ad-library import (limited preview)";
  if (source.startsWith("website")) return "Website monitoring";
  return source;
}

function inferMoveType(row: {
  promotion: string | null;
  stockStatus: string | null;
  source: string;
  adCopy: string | null;
  price: number | null;
}) {
  if (row.stockStatus === "out_of_stock") return "Stock outage";
  if (row.stockStatus === "low_stock") return "Stock pressure";
  if (row.promotion) return "Promotion change";
  if (row.source === "meta_ads" || row.adCopy) return "Imported ad signal";
  if (row.source === "google_shopping") return "Imported shopping signal";
  if (row.price != null) return "Price move";
  return "Market signal";
}

function scorePriority(impactScore: number) {
  if (impactScore >= 75) return "High";
  if (impactScore >= 45) return "Medium";
  return "Low";
}

function inferSuggestedAction(args: {
  priceDelta: number;
  promotion: string | null;
  stockStatus: string | null;
  source: string;
}) {
  if (args.stockStatus === "out_of_stock") return "Promote availability and hold price";
  if (args.stockStatus === "low_stock") return "Monitor stock pressure before discounting";
  if (args.promotion) return "Review bundle or selective response";
  if (args.source === "meta_ads") return "Monitor campaign pressure";
  if (args.priceDelta <= -2) return "Review hero SKU pricing";
  if (args.priceDelta >= 2) return "Hold price and protect margin";
  return "Wait and monitor";
}

function inferActionWindow(priority: string) {
  if (priority === "High") return "Today";
  if (priority === "Medium") return "This week";
  return "Monitor";
}

async function getStore(shopDomain: string) {
  const store = await prisma.store.findUnique({
    where: { shop: shopDomain },
    include: {
      competitorDomains: true,
      productSnapshots: {
        select: {
          handle: true,
          title: true,
          status: true,
          currentPrice: true,
        },
      },
    },
  });
  if (!store) {
    throw new Error("Store not found");
  }
  return store;
}

type OverviewRow = Awaited<ReturnType<typeof getCompetitorRows>>[number];

async function getCompetitorRows(storeId: string, limit = 500) {
  return prisma.competitorData.findMany({
    where: { storeId },
    orderBy: { collectedAt: "desc" },
    take: limit,
  });
}

function buildProductSignals(rows: OverviewRow[]) {
  const productSignals = new Map<
    string,
    { latest?: number | null; earliest?: number | null; promotions: number; stock: number; sources: Set<string> }
  >();

  for (const row of [...rows].reverse()) {
    const bucket = productSignals.get(row.productHandle) ?? {
      latest: null,
      earliest: null,
      promotions: 0,
      stock: 0,
      sources: new Set<string>(),
    };
    if (bucket.earliest == null && row.price != null) {
      bucket.earliest = row.price;
    }
    if (row.price != null) {
      bucket.latest = row.price;
    }
    if (row.promotion) bucket.promotions += 1;
    if (row.stockStatus === "low_stock" || row.stockStatus === "out_of_stock") {
      bucket.stock += 1;
    }
    bucket.sources.add(row.source);
    productSignals.set(row.productHandle, bucket);
  }

  return productSignals;
}

function buildStrategyDetections(rows: OverviewRow[]) {
  const promotionCount = rows.filter((row) => !!row.promotion).length;
  const stockAlerts = rows.filter((row) =>
    row.stockStatus === "low_stock" || row.stockStatus === "out_of_stock"
  ).length;
  const adPressure = rows.filter((row) => row.source === "meta_ads" || !!row.adCopy).length;
  const priceRows = rows.filter((row) => row.price != null);
  const averagePrice = priceRows.length
    ? priceRows.reduce((sum, row) => sum + (row.price ?? 0), 0) / priceRows.length
    : 0;

  const detections: Array<{
    strategy: string;
    signalStrength: string;
    why: string;
    implication: string;
    recommendedMove: string;
  }> = [];

  if (promotionCount >= 4) {
    detections.push({
      strategy: "Promotion-led push",
      signalStrength: promotionCount >= 8 ? "Strong" : "Moderate",
      why: "Repeated live promotion signals are appearing across the monitored competitor set.",
      implication: "The competitor may be trying to improve short-term conversion or move inventory.",
      recommendedMove: "Use selective offers or bundles instead of broad matching discounts.",
    });
  }

  if (stockAlerts >= 3) {
    detections.push({
      strategy: "Inventory pressure",
      signalStrength: stockAlerts >= 6 ? "Strong" : "Moderate",
      why: "Low-stock and out-of-stock signals are clustering in the live monitoring feed.",
      implication: "Pressure may ease without a broad pricing response if the competitor is supply constrained.",
      recommendedMove: "Hold price on hero SKUs and watch availability before reacting.",
    });
  }

  if (adPressure >= 3) {
    detections.push({
      strategy: "Visibility push",
      signalStrength: adPressure >= 6 ? "Strong" : "Moderate",
      why: "Live ad-pressure signals suggest the competitor is increasing visibility.",
      implication: "Merchants may need stronger merchandising or promotional positioning rather than immediate repricing.",
      recommendedMove: "Promote differentiated value props and monitor conversion on exposed SKUs.",
    });
  }

  if (averagePrice > 0 && promotionCount === 0 && stockAlerts === 0 && adPressure === 0) {
    detections.push({
      strategy: "Price watch only",
      signalStrength: "Early",
      why: "Current competitor coverage is mostly pricing-only and does not yet suggest a larger strategy pattern.",
      implication: "Keep monitoring until promotion, stock, or ad signals strengthen the picture.",
      recommendedMove: "Wait and monitor rather than making a reactive pricing change.",
    });
  }

  return detections.slice(0, 4);
}

export async function getCompetitorOverview(shopDomain: string) {
  const [store, operational] = await Promise.all([
    getStore(shopDomain),
    getStoreOperationalSnapshot(shopDomain),
  ]);
  const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const last72h = new Date(Date.now() - 72 * 60 * 60 * 1000);

  const [recentRows, allRows, latestSyncJob] = await Promise.all([
    prisma.competitorData.findMany({
      where: { storeId: store.id, collectedAt: { gte: last72h } },
      orderBy: { collectedAt: "desc" },
      take: 150,
    }),
    getCompetitorRows(store.id),
    prisma.syncJob.findFirst({
      where: { storeId: store.id },
      orderBy: { createdAt: "desc" },
    }),
  ]);
  const latestCompetitorJob = operational.latestCompetitorIngestJob;
  const latestCompetitorSummary = latestCompetitorJob?.summaryJson
    ? (() => {
        try {
          return JSON.parse(latestCompetitorJob.summaryJson) as {
            ingested?: number;
            domains?: number;
            products?: number;
            skipped?: number;
            status?: string;
            reason?: string | null;
          };
        } catch {
          return null;
        }
      })()
    : null;
  const syncState = deriveSyncStatus({
    connectionStatus: operational.store.lastConnectionStatus,
    latestSyncJobStatus: operational.latestSyncJob?.status ?? null,
    lastSyncStatus: operational.store.lastSyncStatus,
    products: operational.counts.products,
    orders: operational.counts.orders,
    customers: operational.counts.customers,
    priceRows: operational.counts.pricingRows,
    profitRows: operational.counts.profitRows,
    timelineEvents: operational.counts.timelineEvents,
  });

  const eligibleProducts = filterCompetitorSourceProducts(
    store.productSnapshots.map((product) => ({
      productHandle: product.handle,
      title: product.title,
      status: product.status,
      currentPrice: product.currentPrice ?? null,
    }))
  );
  const comparableRecentRows = filterComparableRows(recentRows);
  const comparableAllRows = filterComparableRows(allRows);
  const sourceBreakdown = {
    website: comparableRecentRows.comparableRows.filter((row) => row.source.startsWith("website")).length,
    googleShopping: comparableRecentRows.comparableRows.filter((row) => row.source === "google_shopping").length,
    metaAds: comparableRecentRows.comparableRows.filter((row) => row.source === "meta_ads").length,
  };

  const promoCount = comparableRecentRows.comparableRows.filter((row) => !!row.promotion).length;
  const stockAlerts = comparableRecentRows.comparableRows.filter(
    (row) => row.stockStatus === "low_stock" || row.stockStatus === "out_of_stock"
  ).length;
  const recentChanges = comparableRecentRows.comparableRows.filter((row) => row.collectedAt >= last24h).length;

  const productSignals = buildProductSignals(comparableRecentRows.comparableRows);
  const topMovers = Array.from(productSignals.entries())
    .map(([productHandle, bucket]) => ({
      productHandle,
      priceDelta:
        bucket.latest != null && bucket.earliest != null
          ? Number((bucket.latest - bucket.earliest).toFixed(2))
          : 0,
      promotionSignals: bucket.promotions,
      stockSignals: bucket.stock,
    }))
    .sort(
      (a, b) =>
        Math.abs(b.priceDelta) - Math.abs(a.priceDelta) ||
        b.promotionSignals - a.promotionSignals
    )
    .slice(0, 5);

  const moveFeed = comparableRecentRows.comparableRows.slice(0, 10).map((row) => {
    const bucket = productSignals.get(row.productHandle);
    const priceDelta =
      bucket?.latest != null && bucket?.earliest != null
        ? Number((bucket.latest - bucket.earliest).toFixed(2))
        : 0;
    const impactScore = Math.max(
      12,
      Math.min(
        96,
        Math.round(
          Math.abs(priceDelta) * 16 +
            (row.promotion ? 22 : 0) +
            (row.stockStatus === "out_of_stock"
              ? 28
              : row.stockStatus === "low_stock"
              ? 16
              : 0) +
            (row.source === "meta_ads" ? 14 : row.source === "google_shopping" ? 10 : 8)
        )
      )
    );
    const priority = scorePriority(impactScore);

    return {
      id: row.id,
      headline: `${row.competitorName} changed ${row.productHandle}`,
      moveType: inferMoveType(row),
      source: formatSourceLabel(row.source),
      priority,
      impactScore,
      actionWindow: inferActionWindow(priority),
      eventCluster:
        row.promotion || row.adCopy
          ? "Promotion and visibility"
          : row.stockStatus === "out_of_stock" || row.stockStatus === "low_stock"
          ? "Inventory and availability"
          : "Pricing and market posture",
      whyItMatters:
        row.promotion ??
        row.adCopy ??
        (row.stockStatus
          ? `Stock posture is now ${row.stockStatus.replace(/_/g, " ")}.`
          : priceDelta !== 0
          ? `Observed competitor price movement of ${priceDelta >= 0 ? "+" : "-"}$${Math.abs(priceDelta).toFixed(2)}.`
          : "A fresh competitor signal was detected for this SKU."),
      suggestedAction: inferSuggestedAction({
        priceDelta,
        promotion: row.promotion,
        stockStatus: row.stockStatus,
        source: row.source,
      }),
      collectedAt: row.collectedAt,
    };
  });

  const actionSuggestions = topMovers.slice(0, 4).map((mover) => ({
    productHandle: mover.productHandle,
    suggestion:
      mover.promotionSignals >= 2
        ? "Bundle or selectively match"
        : mover.priceDelta <= -2
        ? "Review hero SKU pricing"
        : mover.stockSignals > 0
        ? "Hold margin and monitor"
        : "Wait and monitor",
    why:
      mover.promotionSignals >= 2
        ? "Promotions are clustering around this SKU."
        : mover.priceDelta <= -2
        ? "Competitor pricing dropped enough to affect conversion risk."
        : mover.stockSignals > 0
        ? "Competitor stock posture may ease pressure without immediate discounting."
        : "Current movement does not yet justify a reactive pricing change.",
    urgency:
      mover.promotionSignals >= 2 || Math.abs(mover.priceDelta) >= 2
        ? "Act this week"
        : "Monitor",
    expectedOutcome:
      mover.promotionSignals >= 2
        ? "Protect conversion without broad margin erosion."
        : mover.priceDelta <= -2
        ? "Reduce demand leakage on exposed SKUs."
        : mover.stockSignals > 0
        ? "Preserve margin while the competitor availability story develops."
        : "Avoid unnecessary reactions and preserve pricing discipline.",
  }));

  const strategyDetections = buildStrategyDetections(comparableRecentRows.comparableRows);
  const lastIngestedAt = comparableAllRows.comparableRows[0]?.collectedAt ?? allRows[0]?.collectedAt ?? null;
  const lastSuccessAt =
    latestCompetitorJob &&
    (latestCompetitorJob.status === "SUCCEEDED" ||
      latestCompetitorJob.status === "SUCCEEDED_NO_DATA")
      ? latestCompetitorJob.finishedAt ?? null
      : lastIngestedAt;
  const lastAttemptAt =
    latestCompetitorJob?.finishedAt ??
    latestCompetitorJob?.startedAt ??
    null;
  const freshnessHours = lastSuccessAt
    ? Number(((Date.now() - new Date(lastSuccessAt).getTime()) / (1000 * 60 * 60)).toFixed(1))
    : null;
  const checkedDomainsCount =
    latestCompetitorSummary?.domains ?? store.competitorDomains.length;
  const monitoredProductsCount =
    latestCompetitorSummary?.products ?? eligibleProducts.eligible.length;
  const matchedProductsCount = comparableRecentRows.validMatchedProductsCount;
  const lowConfidenceMatchesCount = comparableRecentRows.lowConfidenceProductsCount;
  const detectedPriceChangesCount = topMovers.filter(
    (item) => item.priceDelta !== 0
  ).length;
  const detectedPromotionChangesCount = promoCount;
  const setupStatus: CompetitorSetupStatus =
    store.competitorDomains.length === 0
      ? "NO_DOMAINS"
      : monitoredProductsCount === 0
      ? "NO_MONITORED_PRODUCTS"
      : "READY";
  const syncStatusLabel: CompetitorSyncStatus =
    latestCompetitorJob?.status === "RUNNING"
      ? "RUNNING"
      : latestCompetitorJob?.status === "FAILED"
      ? "FAILED"
      : latestCompetitorJob?.status === "SUCCEEDED_NO_DATA"
      ? "SUCCEEDED_NO_DATA"
      : latestCompetitorJob?.status === "SUCCEEDED"
      ? "SUCCEEDED"
      : "NOT_STARTED";
  const crawlStatus: CompetitorCrawlStatus =
    syncStatusLabel === "RUNNING"
      ? "RUNNING"
      : syncStatusLabel === "FAILED"
      ? "FAILED"
      : syncStatusLabel === "NOT_STARTED"
      ? "NOT_STARTED"
      : latestCompetitorSummary?.skipped && latestCompetitorSummary.skipped > 0 && (latestCompetitorSummary.ingested ?? 0) > 0
      ? "PARTIAL"
      : syncStatusLabel === "SUCCEEDED" || syncStatusLabel === "SUCCEEDED_NO_DATA"
      ? "SUCCEEDED"
      : "NOT_STARTED";
  const freshnessStatus: CompetitorFreshnessStatus =
    freshnessHours == null ? "UNKNOWN" : freshnessHours > 24 ? "STALE" : "FRESH";
  const snapshotStatus: CompetitorSnapshotStatus =
    syncStatusLabel === "FAILED"
      ? "FAILED"
      : setupStatus !== "READY"
      ? "NOT_STARTED"
      : syncStatusLabel === "RUNNING"
      ? "NOT_STARTED"
      : monitoredProductsCount === 0
      ? "NOT_STARTED"
      : matchedProductsCount === 0 && lowConfidenceMatchesCount === 0
      ? "NO_MATCHES"
      : matchedProductsCount === 0 && lowConfidenceMatchesCount > 0
      ? "PARTIAL"
      : detectedPriceChangesCount === 0 && detectedPromotionChangesCount === 0
      ? "NO_CHANGES"
      : crawlStatus === "PARTIAL"
      ? "PARTIAL"
      : "READY";
  const freshnessFailureReason =
    freshnessHours != null && freshnessHours > 72
      ? `Competitor monitoring is stale. Last successful ingestion was ${freshnessHours} hours ago.`
      : operational.latestCompetitorIngestJob?.status === "FAILED"
      ? operational.latestCompetitorIngestJob.errorMessage ??
        "The latest competitor ingestion failed."
      : operational.store.lastConnectionError;
  const readiness = deriveModuleReadiness({
    syncStatus:
      operational.latestCompetitorIngestJob?.status === "FAILED"
        ? "FAILED"
        : syncState.status === "READY_WITH_DATA" &&
          operational.counts.competitorDomains > 0 &&
          operational.counts.competitorRows === 0
        ? "SYNC_COMPLETED_PROCESSING_PENDING"
        : syncState.status,
    rawCount: operational.counts.competitorDomains,
    processedCount: operational.counts.competitorRows,
    lastUpdatedAt: operational.latestCompetitorAt,
    failureReason: freshnessFailureReason,
  });

  const competitorDependencyState = operational.counts.competitorRows > 0 ? "ready" : "missing";
  const pricingDependencyState = operational.counts.pricingRows > 0 ? "ready" : "missing";
  const fraudDependencyState = operational.counts.timelineEvents > 0 ? "ready" : "missing";
  const changesDetected =
    detectedPriceChangesCount +
    detectedPromotionChangesCount +
    stockAlerts;
  const freshnessLabel = getCompetitorFreshnessLabel(
    freshnessHours,
    lastSuccessAt
  );
  const primaryState = deriveCompetitorPrimaryState({
    hasDomains: store.competitorDomains.length > 0,
    syncStatusLabel,
    lastSuccessfulRunAt: lastSuccessAt,
    freshnessHours,
    validMatchedProductsCount: matchedProductsCount,
    lowConfidenceProductsCount: lowConfidenceMatchesCount,
    changesDetected: changesDetected > 0,
  });
  const primaryStateCopy = getCompetitorPrimaryStateCopy({
    primaryState,
    freshnessLabel,
    validMatchedProductsCount: matchedProductsCount,
    lowConfidenceProductsCount: lowConfidenceMatchesCount,
    checkedDomainsCount,
    changesDetected,
    latestError:
      latestCompetitorJob?.errorMessage ??
      latestCompetitorSummary?.reason ??
      null,
    lastSuccessfulRunAt: lastSuccessAt,
  });
  const weeklyReport = {
    headline:
      primaryState === "CHANGES_DETECTED"
        ? `${recentChanges} competitor signals detected in the last 24 hours`
        : primaryState === "NO_CHANGES"
        ? "Monitoring is active with no new competitor changes"
        : primaryState === "LOW_CONFIDENCE"
        ? "Possible competitor overlap was found, but confidence is still low"
        : primaryState === "NO_MATCHES"
        ? "Monitoring is active, but no comparable matches were found"
        : store.competitorDomains.length > 0
        ? "Competitor monitoring is not ready for a brief yet"
        : "Competitor monitoring needs setup",
    whyItMatters:
      primaryState === "CHANGES_DETECTED" || primaryState === "NO_CHANGES"
        ? "Live competitor observations are available for pricing, promotion, stock, and visibility review."
        : primaryState === "LOW_CONFIDENCE"
        ? "Some pages resembled competitor product pages, but the captured pricing and product signals were not strong enough to trust yet."
        : primaryState === "NO_MATCHES"
        ? "Your domains were refreshed successfully, but VedaSuite did not find overlapping competitor products to compare yet."
        : store.competitorDomains.length > 0
        ? "Domains are configured, but VedaSuite needs a successful monitored refresh with matched products before weekly reporting becomes useful."
        : "Add monitored domains to start collecting competitor pricing and promotion data.",
    suggestedActions:
      actionSuggestions.length > 0
        ? actionSuggestions.map((item) => `${item.productHandle}: ${item.suggestion}`)
        : primaryState === "LOW_CONFIDENCE"
        ? [
            "Review domain relevance and ensure competitor product handles overlap your active catalog.",
            "Refresh again after refining monitored domains.",
          ]
        : primaryState === "NO_MATCHES"
        ? [
            "Review tracked products and competitor domains for overlap.",
            "Add more competitor domains and run another refresh.",
          ]
        : store.competitorDomains.length > 0
        ? ["Run competitor ingestion.", "Review the move feed after the first live pull."]
        : ["Add competitor domains.", "Run your first ingestion."],
    reportReadiness:
      primaryState === "CHANGES_DETECTED" || primaryState === "NO_CHANGES"
        ? "Live competitor report available"
        : primaryState === "LOW_CONFIDENCE"
        ? "Waiting for stronger match confidence"
        : primaryState === "NO_MATCHES"
        ? "Waiting for matched products"
        : lastSuccessAt
        ? "Waiting for matched competitor products"
        : "Awaiting first sync",
    biggestMoves: moveFeed.slice(0, 3).map((item) => ({
      headline: item.headline,
      impactScore: item.impactScore,
      suggestedAction: item.suggestedAction,
    })),
    merchantBrief:
      strategyDetections[0]?.implication ??
      ((primaryState === "CHANGES_DETECTED" || primaryState === "NO_CHANGES")
        ? "No dominant competitor strategy has been inferred yet from the current live data."
        : primaryState === "LOW_CONFIDENCE"
        ? "VedaSuite needs stronger comparable-product confirmation before it can build a reliable competitor brief."
        : primaryState === "NO_MATCHES"
        ? "VedaSuite needs comparable competitor product matches before it can build a reliable weekly brief."
        : "VedaSuite will build a weekly competitor brief after the first successful matched refresh."),
    nextBestAction:
      actionSuggestions[0]?.suggestion ??
      (primaryState === "LOW_CONFIDENCE"
        ? "Review domains and prioritize competitor sites with clearer product overlap."
        : primaryState === "NO_MATCHES"
        ? "Review tracked products and add more relevant competitor domains."
        : store.competitorDomains.length > 0
        ? "Run ingestion to populate the move feed."
        : "Add competitor domains and start monitoring."),
  };
  const moduleState =
    primaryState === "SETUP_INCOMPLETE"
      ? createUnifiedModuleState({
          setupStatus: "incomplete",
          syncStatus: syncStatusLabel === "FAILED" ? "failed" : "idle",
          dataStatus: "empty",
          lastSuccessfulSyncAt: toIsoString(lastSuccessAt),
          lastAttemptAt: toIsoString(lastAttemptAt),
          coverage: "none",
          dependencies: {
            competitor: competitorDependencyState,
            pricing: pricingDependencyState,
            fraud: fraudDependencyState,
          },
          title: primaryStateCopy.title,
          description: primaryStateCopy.description,
          nextAction: primaryStateCopy.nextAction,
        })
      : syncStatusLabel === "RUNNING"
      ? createUnifiedModuleState({
          setupStatus: "complete",
          syncStatus: "running",
          dataStatus: "processing",
          lastSuccessfulSyncAt: toIsoString(lastSuccessAt),
          lastAttemptAt: toIsoString(lastAttemptAt),
          coverage: matchedProductsCount > 0 ? "partial" : "none",
          dependencies: {
            competitor: competitorDependencyState,
            pricing: pricingDependencyState,
            fraud: fraudDependencyState,
          },
          title: "Competitor monitoring is refreshing",
          description:
            "VedaSuite is checking competitor domains and updating matched products.",
          nextAction: "Wait for refresh to finish",
        })
      : primaryState === "FAILURE"
      ? createUnifiedModuleState({
          setupStatus: "complete",
          syncStatus: "failed",
          dataStatus: "failed",
          lastSuccessfulSyncAt: toIsoString(lastSuccessAt),
          lastAttemptAt: toIsoString(lastAttemptAt),
          coverage: matchedProductsCount > 0 ? "partial" : "none",
          dependencies: {
            competitor: competitorDependencyState,
            pricing: pricingDependencyState,
            fraud: fraudDependencyState,
          },
          title: primaryStateCopy.title,
          description: primaryStateCopy.description,
          nextAction: primaryStateCopy.nextAction,
        })
      : primaryState === "STALE"
      ? createUnifiedModuleState({
          setupStatus: "complete",
          syncStatus: "completed",
          dataStatus: "stale",
          lastSuccessfulSyncAt: toIsoString(lastSuccessAt),
          lastAttemptAt: toIsoString(lastAttemptAt),
          dataChanged: changesDetected > 0,
          coverage: matchedProductsCount > 0 ? "partial" : "none",
          dependencies: {
            competitor: competitorDependencyState,
            pricing: pricingDependencyState,
            fraud: fraudDependencyState,
          },
          title: primaryStateCopy.title,
          description: primaryStateCopy.description,
          nextAction: primaryStateCopy.nextAction,
        })
      : primaryState === "AWAITING_FIRST_RUN"
      ? createUnifiedModuleState({
          setupStatus: "complete",
          syncStatus:
            operational.latestCompetitorIngestJob?.status === "RUNNING"
              ? "running"
              : "idle",
          dataStatus:
            operational.latestCompetitorIngestJob?.status === "RUNNING"
              ? "processing"
              : "empty",
          lastSuccessfulSyncAt: toIsoString(lastSuccessAt),
          lastAttemptAt: toIsoString(lastAttemptAt),
          coverage: "none",
          dependencies: {
            competitor: competitorDependencyState,
            pricing: pricingDependencyState,
            fraud: fraudDependencyState,
          },
          title: primaryStateCopy.title,
          description: primaryStateCopy.description,
          nextAction: primaryStateCopy.nextAction,
        })
      : primaryState === "NO_MATCHES"
      ? createUnifiedModuleState({
          setupStatus: "complete",
          syncStatus: "completed",
          dataStatus: "empty",
          lastSuccessfulSyncAt: toIsoString(lastSuccessAt),
          lastAttemptAt: toIsoString(lastAttemptAt),
          coverage: "none",
          dependencies: {
            competitor: competitorDependencyState,
            pricing: pricingDependencyState,
            fraud: fraudDependencyState,
          },
          title: primaryStateCopy.title,
          description: primaryStateCopy.description,
          nextAction: primaryStateCopy.nextAction,
        })
      : primaryState === "LOW_CONFIDENCE"
      ? createUnifiedModuleState({
          setupStatus: "complete",
          syncStatus: "completed",
          dataStatus: "partial",
          lastSuccessfulSyncAt: toIsoString(lastSuccessAt),
          lastAttemptAt: toIsoString(lastAttemptAt),
          coverage: "partial",
          dependencies: {
            competitor: competitorDependencyState,
            pricing: pricingDependencyState,
            fraud: fraudDependencyState,
          },
          title: primaryStateCopy.title,
          description: primaryStateCopy.description,
          nextAction: primaryStateCopy.nextAction,
        })
      : crawlStatus === "PARTIAL" || snapshotStatus === "PARTIAL"
      ? createUnifiedModuleState({
          setupStatus: "complete",
          syncStatus: "completed",
          dataStatus: "partial",
          lastSuccessfulSyncAt: toIsoString(lastSuccessAt),
          lastAttemptAt: toIsoString(lastAttemptAt),
          dataChanged:
            detectedPriceChangesCount > 0 || detectedPromotionChangesCount > 0,
          coverage: "partial",
          dependencies: {
            competitor: competitorDependencyState,
            pricing: pricingDependencyState,
            fraud: fraudDependencyState,
          },
          title: "Competitor data is available with partial coverage",
          description:
            "Some competitor products matched, but coverage is still incomplete across the tracked catalog.",
          nextAction: "Review tracked products or update competitor domains",
        })
      : primaryState === "NO_CHANGES"
      ? createUnifiedModuleState({
          setupStatus: "complete",
          syncStatus: "completed",
          dataStatus: "empty",
          lastSuccessfulSyncAt: toIsoString(lastSuccessAt),
          lastAttemptAt: toIsoString(lastAttemptAt),
          coverage: "full",
          dependencies: {
            competitor: competitorDependencyState,
            pricing: pricingDependencyState,
            fraud: fraudDependencyState,
          },
          title: primaryStateCopy.title,
          description: primaryStateCopy.description,
          nextAction: primaryStateCopy.nextAction,
        })
      : createUnifiedModuleState({
          setupStatus: "complete",
          syncStatus: "completed",
          dataStatus: "ready",
          lastSuccessfulSyncAt: toIsoString(lastSuccessAt),
          lastAttemptAt: toIsoString(lastAttemptAt),
          dataChanged: true,
          coverage: "full",
          dependencies: {
            competitor: competitorDependencyState,
            pricing: pricingDependencyState,
            fraud: fraudDependencyState,
          },
          title: primaryStateCopy.title,
          description: primaryStateCopy.description,
          nextAction: primaryStateCopy.nextAction,
        });

  return {
    competitorState: {
      primaryState,
      setupStatus:
        store.competitorDomains.length === 0 ? "not_configured" : "configured",
      ingestionStatus:
        syncStatusLabel === "RUNNING"
          ? "running"
          : syncStatusLabel === "FAILED"
          ? "failed"
          : lastSuccessAt
          ? "completed"
          : "never_run",
      matchStatus:
        matchedProductsCount === 0 && lowConfidenceMatchesCount > 0
          ? "partial_matches"
          : matchedProductsCount === 0
          ? "no_matches"
          : crawlStatus === "PARTIAL"
          ? "partial_matches"
          : "matched",
      changeStatus: changesDetected > 0 ? "changes_detected" : "no_changes",
      freshnessStatus: freshnessStatus === "STALE" ? "stale" : "fresh",
      freshnessLabel,
      channels: {
        website:
          store.competitorDomains.length === 0
            ? "not_configured"
            : lastSuccessAt
            ? "connected"
            : "preview_only",
        googleShopping: "preview_only",
        metaAds: "preview_only",
      },
      lastSuccessfulRunAt: toIsoString(lastSuccessAt),
      lastAttemptAt: toIsoString(lastAttemptAt),
      configuredDomainsCount: store.competitorDomains.length,
      checkedDomainsCount,
      monitoredProductsCount,
      matchedProductsCount,
      validMatchedProductsCount: matchedProductsCount,
      lowConfidenceMatchesCount,
      excludedProductsCount: eligibleProducts.excludedCount,
      excludedProducts: eligibleProducts.excluded,
      activePromotionsCount: promoCount,
      activePromotionCount: promoCount,
      stockAlertsCount: stockAlerts,
      detectedPriceChangesCount,
      detectedPromotionChangesCount,
      coverageStatus: primaryStateCopy.coverageStatus,
      title: primaryStateCopy.title,
      description: primaryStateCopy.description,
      confidenceExplanation:
        primaryState === "LOW_CONFIDENCE"
          ? "Possible competitor pages were found, but they did not provide strong enough live pricing or product signals to count as reliable comparable matches."
          : primaryState === "NO_MATCHES"
          ? "VedaSuite only counts a comparable match when the competitor page provides strong enough live product evidence."
          : "Comparable products shown on this page passed the current match-confidence checks.",
      actionPanel: {
        headline:
          primaryState === "SETUP_INCOMPLETE"
            ? "Complete monitoring setup"
            : primaryState === "AWAITING_FIRST_RUN"
            ? "Run the first monitored refresh"
            : primaryState === "NO_MATCHES"
            ? "Improve comparable-product coverage"
            : primaryState === "LOW_CONFIDENCE"
            ? "Strengthen match confidence"
            : primaryState === "CHANGES_DETECTED"
            ? "Review competitor changes"
            : "Keep monitoring active",
        explanation:
          primaryState === "SETUP_INCOMPLETE"
            ? "Add relevant competitor domains before VedaSuite can check live competitor products."
            : primaryState === "AWAITING_FIRST_RUN"
            ? "Domains are configured. The next refresh will test those sites against your active catalog."
            : primaryState === "NO_MATCHES"
            ? "Monitoring completed successfully, but none of the checked competitor pages overlapped your active monitored products."
            : primaryState === "LOW_CONFIDENCE"
            ? "Monitoring found possible overlap, but the captured competitor pages were not strong enough to trust as comparable products yet."
            : primaryState === "CHANGES_DETECTED"
            ? "Prioritize the products with live price, promotion, or stock changes first."
            : "Monitoring is working normally. No urgent competitor action is required right now.",
        actions:
          primaryState === "SETUP_INCOMPLETE"
            ? ["Add competitor domains", "Refresh monitoring"]
            : primaryState === "AWAITING_FIRST_RUN"
            ? ["Run competitor monitoring", "Review active catalog coverage"]
            : primaryState === "NO_MATCHES"
            ? [
                "Review active products for overlap with monitored competitors",
                "Add more relevant competitor domains",
                "Refresh monitoring again",
              ]
            : primaryState === "LOW_CONFIDENCE"
            ? [
                "Review domain quality and product overlap",
                "Prioritize competitors with clearer product pages",
                "Refresh monitoring again",
              ]
            : primaryState === "CHANGES_DETECTED"
            ? [
                "Open the move feed and review changed products",
                "Use response guidance for highest-pressure products",
              ]
            : ["Refresh again later", "Review tracked products"],
      },
      nextAction: primaryStateCopy.nextAction,
      toastMessage: primaryStateCopy.toastMessage,
    },
    moduleState,
    monitoringStatus: {
      setupStatus,
      syncStatus: syncStatusLabel,
      crawlStatus,
      snapshotStatus,
      freshnessStatus,
      lastSuccessAt,
      lastAttemptAt,
      checkedDomainsCount,
      monitoredProductsCount,
      matchedProductsCount,
      lowConfidenceMatchesCount,
      detectedPriceChangesCount,
      detectedPromotionChangesCount,
      latestSyncReason:
        latestCompetitorSummary?.reason ??
        latestCompetitorJob?.errorMessage ??
        null,
    },
    readiness,
    recentPriceChanges: recentChanges,
    promotionAlerts: promoCount,
    stockMovementAlerts: stockAlerts,
    trackedDomains: store.competitorDomains.length,
    lastIngestedAt,
    freshnessHours,
    promotionalHeat: promoCount >= 15 ? "High" : promoCount >= 7 ? "Medium" : "Low",
    marketPressure:
      recentChanges >= 24 ? "High" : recentChanges >= 10 ? "Medium" : recentChanges > 0 ? "Low" : "No live market data",
    adPressure:
      sourceBreakdown.metaAds > 0
        ? "Imported preview data present"
        : "Not enabled",
    launchAlerts: recentRows
      .filter((row) => !!row.promotion && /launch|new/i.test(row.promotion))
      .slice(0, 5)
      .map((row) => ({
        productHandle: row.productHandle,
        competitorName: row.competitorName,
        source: row.source,
        collectedAt: row.collectedAt,
      })),
    sourceBreakdown,
    topMovers,
    moveFeed,
    lowConfidenceRows: comparableRecentRows.lowConfidenceRows.slice(0, 6).map((row) => {
      const metadata = normalizeCompetitorMetadata(row);
      return {
        id: row.id,
        productHandle: row.productHandle,
        competitorName: row.competitorName,
        confidenceLabel: metadata.confidenceLabel,
        confidenceScore: metadata.confidenceScore,
        matchReason: metadata.matchReason,
      };
    }),
    productCoverage: {
      eligibleProductsCount: eligibleProducts.eligible.length,
      excludedProductsCount: eligibleProducts.excludedCount,
      excludedProducts: eligibleProducts.excluded,
      explanation:
        eligibleProducts.excludedCount > 0
          ? `Draft, archived, gift-card-like, or price-missing products are excluded from competitor monitoring to keep matches useful.`
          : "Only active catalog products with usable pricing are monitored for competitor overlap.",
    },
    strategyDetections,
    actionSuggestions,
    weeklyReport,
    coverageSummary: {
      domainsConfigured: store.competitorDomains.length,
      channelsReady: [
        store.competitorDomains.length > 0 ? "Website monitoring" : null,
        sourceBreakdown.googleShopping > 0 ? "Google Shopping" : null,
        sourceBreakdown.metaAds > 0 ? "Meta Ad Library" : null,
      ].filter((item): item is string => item !== null),
      monitoringPosture: primaryStateCopy.coverageStatus,
    },
  };
}

export async function listTrackedCompetitorProducts(shopDomain: string) {
  const store = await getStore(shopDomain);
  const rows = await getCompetitorRows(store.id, 150);
  return filterComparableRows(rows).comparableRows.map((row) => {
    const metadata = normalizeCompetitorMetadata(row);
    return {
      ...row,
      confidenceScore: metadata.confidenceScore,
      confidenceLabel: metadata.confidenceLabel,
      matchReason: metadata.matchReason,
    };
  });
}

export async function listCompetitorConnectors(shopDomain: string) {
  const store = await getStore(shopDomain);
  const rows = await getCompetitorRows(store.id, 300);
  const latestBySource = new Map<string, Date>();
  const websiteLastIngestedAt =
    rows.find((row) => row.source === "website_live")?.collectedAt ??
    rows.find((row) => row.source === "website")?.collectedAt ??
    null;

  for (const row of rows) {
    if (!latestBySource.has(row.source)) {
      latestBySource.set(row.source, row.collectedAt);
    }
  }

  return [
    {
      id: "website",
      label: "Website crawler",
      description: "Fetches live competitor storefront observations from tracked domains.",
      connected: store.competitorDomains.length > 0,
      trackedTargets: store.competitorDomains.length,
      lastIngestedAt: websiteLastIngestedAt,
      readiness:
        store.competitorDomains.length === 0
          ? "Not enabled"
          : websiteLastIngestedAt
          ? "Live"
          : "Configured",
      action:
        store.competitorDomains.length === 0
          ? "Add domains"
          : websiteLastIngestedAt
          ? "No action needed"
          : "Run refresh",
    },
    {
      id: "google_shopping",
      label: "Google Shopping feed",
      description:
        "Limited preview connector. Production VedaSuite does not yet run live Google Shopping ingestion.",
      connected: false,
      trackedTargets: 0,
      lastIngestedAt: null,
      readiness: "Preview",
      action: "No action needed",
    },
    {
      id: "meta_ads",
      label: "Meta Ad Library",
      description:
        "Limited preview connector. Production VedaSuite does not yet run live ad-library ingestion.",
      connected: false,
      trackedTargets: 0,
      lastIngestedAt: null,
      readiness: "Preview",
      action: "No action needed",
    },
  ];
}

export async function updateCompetitorDomains(
  shopDomain: string,
  domains: { domain: string; label?: string }[]
) {
  const store = await getStore(shopDomain);
  const normalizedDomains = domains
    .map((domain) => ({
      domain: domain.domain.trim().toLowerCase(),
      label: domain.label?.trim() || null,
    }))
    .filter((domain) => domain.domain.length > 0);

  await prisma.competitorDomain.deleteMany({
    where: { storeId: store.id },
  });

  if (normalizedDomains.length > 0) {
    await prisma.competitorDomain.createMany({
      data: normalizedDomains.map((domain) => ({
        storeId: store.id,
        domain: domain.domain,
        label: domain.label ?? undefined,
      })),
    });
  }

  return prisma.competitorDomain.findMany({
    where: { storeId: store.id },
  });
}

export async function ingestCompetitorSnapshots(shopDomain: string) {
  const store = await getStore(shopDomain);
  const domains = store.competitorDomains;
  const job = await prisma.syncJob.create({
    data: {
      storeId: store.id,
      jobType: "competitor_ingest",
      triggerSource: "manual",
      status: "RUNNING",
      startedAt: new Date(),
    },
  });

  try {
    if (domains.length === 0) {
      const result = {
        ingested: 0,
        domains: 0,
        products: 0,
        skipped: 0,
        status: "SUCCEEDED_NO_DATA",
        reason: "No competitor domains are configured for this store.",
        merchantMessage: "Add competitor domains before running a refresh.",
      };

      await prisma.syncJob.update({
        where: { id: job.id },
        data: {
          status: "SUCCEEDED_NO_DATA",
          finishedAt: new Date(),
          summaryJson: JSON.stringify(result),
        },
      });

      return result;
    }

    const sourceProducts = filterCompetitorSourceProducts(
      store.productSnapshots.map((product) => ({
        productHandle: product.handle,
        title: product.title,
        status: product.status,
        currentPrice: product.currentPrice ?? null,
      }))
    );

    if (sourceProducts.eligible.length === 0) {
      const result = {
        ingested: 0,
        domains: domains.length,
        products: 0,
        skipped: 0,
        status: "SUCCEEDED_NO_DATA",
        reason:
          sourceProducts.excludedCount > 0
            ? "No eligible active products were available for competitor monitoring after draft, archived, gift-card-like, and price-missing products were excluded."
            : "No active priced products were available for competitor monitoring yet.",
        merchantMessage:
          "Refresh completed, but there were no eligible active products available for competitor matching yet.",
        excludedProducts: sourceProducts.excluded,
      };

      await prisma.syncJob.update({
        where: { id: job.id },
        data: {
          status: "SUCCEEDED_NO_DATA",
          finishedAt: new Date(),
          summaryJson: JSON.stringify(result),
        },
      });

      return result;
    }

    let ingested = 0;
    let lowConfidenceMatches = 0;
    let skipped = 0;

    for (const domain of domains) {
      for (const product of sourceProducts.eligible.slice(0, 18)) {
        const liveSnapshot = await fetchCompetitorSnapshot(
          domain.domain,
          product.productHandle,
          product.currentPrice ?? 0
        );

        if (!liveSnapshot) {
          skipped += 1;
          continue;
        }

        if (liveSnapshot.confidenceScore < 60) {
          lowConfidenceMatches += 1;
        }

        await prisma.competitorData.create({
          data: {
            storeId: store.id,
            productHandle: product.productHandle,
            competitorName: normalizeCompetitorName(domain.domain, domain.label),
            competitorUrl:
              liveSnapshot.competitorUrl ??
              `https://${domain.domain}/products/${product.productHandle}`,
            source: liveSnapshot.source ?? "website_live",
            price: liveSnapshot.price ?? null,
            promotion: liveSnapshot.promotion ?? null,
            stockStatus: liveSnapshot.stockStatus ?? null,
            adCopy: liveSnapshot.adCopy ?? null,
            insightsJson: JSON.stringify({
              ingestionSource: "live_competitor_fetch",
              capturedAt: new Date().toISOString(),
              externalFetch: true,
              sourceProductTitle: product.title,
              sourceProductStatus: product.status,
              confidenceScore: liveSnapshot.confidenceScore,
              confidenceLabel: liveSnapshot.confidenceLabel,
              matchReason: liveSnapshot.matchReason,
              usedFallbackPrice: liveSnapshot.usedFallbackPrice,
            }),
          },
        });
        ingested += 1;
      }
    }

    const status = ingested > 0 ? "SUCCEEDED" : "SUCCEEDED_NO_DATA";
    const result = {
      ingested,
      domains: domains.length,
      products: sourceProducts.eligible.length,
      skipped,
      lowConfidenceMatches,
      excludedProducts: sourceProducts.excluded,
      status,
      reason:
        ingested > 0
          ? null
          : "Competitor pages were fetched, but no live competitor snapshots were captured for the monitored products.",
      merchantMessage:
        ingested > 0 && lowConfidenceMatches === 0
          ? "Competitor monitoring refreshed successfully."
          : ingested > 0 && lowConfidenceMatches === ingested
          ? "Refresh completed. Possible competitor pages were found, but the matches were too weak to rely on yet."
        : skipped > 0
          ? "Refresh completed. No comparable competitor products were found."
          : "Refresh completed. No competitor changes detected.",
    };

    await prisma.syncJob.update({
      where: { id: job.id },
      data: {
        status,
        finishedAt: new Date(),
        summaryJson: JSON.stringify(result),
        errorMessage: ingested > 0 ? null : result.reason,
      },
    });

    return result;
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Competitor ingestion failed.";

    await prisma.syncJob.update({
      where: { id: job.id },
      data: {
        status: "FAILED",
        finishedAt: new Date(),
        errorMessage: message,
      },
    });

    throw error;
  }
}

export async function getCompetitorResponseEngine(shopDomain: string) {
  const overview = await getCompetitorOverview(shopDomain);

  const responsePlans = (overview.topMovers ?? [])
    .map((mover) => {
      const pressureScore = Math.min(
        100,
        Math.round(
          Math.abs(mover.priceDelta) * 18 +
            mover.promotionSignals * 16 +
            mover.stockSignals * 12
        )
      );

      return {
        productHandle: mover.productHandle,
        pressureScore,
        recommendedPlay:
          mover.promotionSignals >= 2
            ? "bundle_or_selective_match"
            : mover.priceDelta <= -2
            ? "review_price"
            : mover.stockSignals > 0
            ? "hold_and_monitor"
            : "wait_and_monitor",
        rationale:
          mover.promotionSignals >= 2
            ? "Promotion clustering suggests a selective response is safer than broad discounting."
            : mover.priceDelta <= -2
            ? "Live competitor price movement is large enough to review the SKU."
            : mover.stockSignals > 0
            ? "Competitor stock pressure may ease without a reactive price move."
            : "Current live signals do not justify an immediate reaction.",
        priceDelta: mover.priceDelta,
        promotionSignals: mover.promotionSignals,
        stockSignals: mover.stockSignals,
        sourceCount:
          Number(mover.promotionSignals > 0) +
          Number(mover.stockSignals > 0) +
          Number(mover.priceDelta !== 0),
        confidence: Math.max(35, Math.min(80, pressureScore)),
        reasons: [
          mover.priceDelta !== 0
            ? `Observed price delta: ${mover.priceDelta >= 0 ? "+" : "-"}$${Math.abs(mover.priceDelta).toFixed(2)}`
            : "No strong price shift yet.",
          mover.promotionSignals > 0
            ? `${mover.promotionSignals} live promotion signals recorded.`
            : "No live promotion cluster recorded.",
          mover.stockSignals > 0
            ? `${mover.stockSignals} stock-pressure signals recorded.`
            : "No live stock-pressure signal recorded.",
        ],
        automationPosture:
          pressureScore >= 70 ? "Merchant review recommended" : "Advisory mode",
        executionHint:
          pressureScore >= 70
            ? "Prioritize this SKU in pricing review this week."
            : "Keep monitoring this SKU until stronger live signals appear.",
      };
    })
    .slice(0, 5);

  return {
    summary: {
      responseMode:
        overview.competitorState?.primaryState === "NO_MATCHES"
          ? "No matched products yet"
          : responsePlans.length === 0
          ? "No response needed"
          : responsePlans.some((plan) => plan.pressureScore >= 70)
          ? "Respond selectively"
          : "Hold and monitor",
      topPressureCount: responsePlans.filter((plan) => plan.pressureScore >= 50).length,
      automationReadiness:
        overview.competitorState?.primaryState === "NO_MATCHES"
          ? "Response recommendations appear after VedaSuite finds comparable competitor products."
          : responsePlans.length === 0
          ? "Matched competitor products are live, but no response action is needed right now."
          : "Competitor response suggestions are ready for merchant review.",
    },
    responsePlans,
  };
}

import { prisma } from "../db/prismaClient";
import { fetchCompetitorSnapshot } from "./shopifyAdminService";
import {
  deriveModuleReadiness,
  deriveSyncStatus,
  getStoreOperationalSnapshot,
} from "./storeOperationalStateService";
import {
  createUnifiedModuleState,
  isStaleTimestamp,
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

  const sourceBreakdown = {
    website: recentRows.filter((row) => row.source.startsWith("website")).length,
    googleShopping: recentRows.filter((row) => row.source === "google_shopping").length,
    metaAds: recentRows.filter((row) => row.source === "meta_ads").length,
  };

  const promoCount = recentRows.filter((row) => !!row.promotion).length;
  const stockAlerts = recentRows.filter(
    (row) => row.stockStatus === "low_stock" || row.stockStatus === "out_of_stock"
  ).length;
  const recentChanges = recentRows.filter((row) => row.collectedAt >= last24h).length;

  const productSignals = buildProductSignals(recentRows);
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

  const moveFeed = recentRows.slice(0, 10).map((row) => {
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

  const strategyDetections = buildStrategyDetections(recentRows);
  const lastIngestedAt = allRows[0]?.collectedAt ?? null;
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
  const freshnessHours = lastIngestedAt
    ? Number(((Date.now() - new Date(lastIngestedAt).getTime()) / (1000 * 60 * 60)).toFixed(1))
    : null;
  const checkedDomainsCount =
    latestCompetitorSummary?.domains ?? store.competitorDomains.length;
  const monitoredProductsCount =
    latestCompetitorSummary?.products ??
    new Set(allRows.map((row) => row.productHandle)).size;
  const matchedProductsCount = new Set(recentRows.map((row) => row.productHandle)).size;
  const detectedPriceChangesCount = topMovers.filter(
    (item) => item.priceDelta !== 0
  ).length;
  const detectedPromotionChangesCount = promoCount;
  const setupStatus: CompetitorSetupStatus =
    store.competitorDomains.length === 0
      ? "NO_DOMAINS"
      : (latestCompetitorSummary?.products ?? monitoredProductsCount) === 0
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
      : matchedProductsCount === 0
      ? "NO_MATCHES"
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

  const weeklyReport = {
    headline:
      recentRows.length > 0
        ? `${recentChanges} competitor signals detected in the last 24 hours`
        : store.competitorDomains.length > 0
        ? "Competitor monitoring configured"
        : "Competitor monitoring needs setup",
    whyItMatters:
      recentRows.length > 0
        ? "Live competitor observations are available for pricing, promotion, stock, and visibility review."
        : store.competitorDomains.length > 0
        ? "Domains are configured, but VedaSuite is still waiting for the first successful ingestion run."
        : "Add monitored domains to start collecting competitor pricing and promotion data.",
    suggestedActions:
      actionSuggestions.length > 0
        ? actionSuggestions.map((item) => `${item.productHandle}: ${item.suggestion}`)
        : store.competitorDomains.length > 0
        ? ["Run competitor ingestion.", "Review the move feed after the first live pull."]
        : ["Add competitor domains.", "Run your first ingestion."],
    reportReadiness:
      recentRows.length > 0
        ? "Live competitor report available"
        : latestSyncJob?.status === "SUCCEEDED"
        ? "Waiting for competitor ingestion"
        : "Awaiting first sync",
    biggestMoves: moveFeed.slice(0, 3).map((item) => ({
      headline: item.headline,
      impactScore: item.impactScore,
      suggestedAction: item.suggestedAction,
    })),
    merchantBrief:
      strategyDetections[0]?.implication ??
      (recentRows.length > 0
        ? "No dominant competitor strategy has been inferred yet from the current live data."
        : "VedaSuite will build a weekly competitor brief after the first successful ingestion."),
    nextBestAction:
      actionSuggestions[0]?.suggestion ??
      (store.competitorDomains.length > 0
        ? "Run ingestion to populate the move feed."
        : "Add competitor domains and start monitoring."),
  };

  const competitorDependencyState = operational.counts.competitorRows > 0 ? "ready" : "missing";
  const pricingDependencyState = operational.counts.pricingRows > 0 ? "ready" : "missing";
  const fraudDependencyState = operational.counts.timelineEvents > 0 ? "ready" : "missing";
  const moduleState =
    setupStatus === "NO_DOMAINS"
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
          title: "Competitor setup is incomplete",
          description:
            "Add competitor domains before VedaSuite can monitor competitor prices, promotions, and changes.",
          nextAction: "Add competitor domains",
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
      : syncStatusLabel === "FAILED"
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
          title: "Competitor refresh failed",
          description:
            latestCompetitorJob?.errorMessage ??
            "VedaSuite could not refresh competitor data for the latest attempt.",
          nextAction: "Retry refresh",
        })
      : isStaleTimestamp(lastSuccessAt)
      ? createUnifiedModuleState({
          setupStatus: "complete",
          syncStatus: "completed",
          dataStatus: "stale",
          lastSuccessfulSyncAt: toIsoString(lastSuccessAt),
          lastAttemptAt: toIsoString(lastAttemptAt),
          dataChanged:
            detectedPriceChangesCount > 0 || detectedPromotionChangesCount > 0,
          coverage: matchedProductsCount > 0 ? "partial" : "none",
          dependencies: {
            competitor: competitorDependencyState,
            pricing: pricingDependencyState,
            fraud: fraudDependencyState,
          },
          title: "Competitor data is out of date",
          description:
            "The last successful competitor refresh is older than 24 hours. Run a new refresh to see current changes.",
          nextAction: "Refresh competitor data",
        })
      : matchedProductsCount === 0
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
          title: "Monitoring is active, but no competitor matches were found",
          description:
            "VedaSuite checked your configured domains, but it did not find matching competitor products yet.",
          nextAction:
            "Try adding more competitor domains or review whether your products overlap.",
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
      : detectedPriceChangesCount === 0 && detectedPromotionChangesCount === 0
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
          title: "Monitoring is active. No competitor changes were found.",
          description:
            "The latest refresh completed successfully, but no competitor price or promotion changes were detected.",
          nextAction: "Refresh again later or update tracked domains",
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
          title: "Competitor data is ready",
          description:
            "VedaSuite found usable competitor matches and detected live market changes for review.",
          nextAction: "View competitor changes",
        });

  return {
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
    strategyDetections,
    actionSuggestions,
    weeklyReport,
    coverageSummary: {
      domainsConfigured: store.competitorDomains.length,
      channelsReady: [
        sourceBreakdown.website > 0 ? "Website monitoring" : null,
        sourceBreakdown.googleShopping > 0 ? "Google Shopping" : null,
        sourceBreakdown.metaAds > 0 ? "Imported ad preview" : null,
      ].filter((item): item is string => item !== null),
      monitoringPosture:
        readiness.readinessState === "READY_WITH_DATA" &&
        freshnessHours != null &&
        freshnessHours <= 72
          ? "Live monitoring"
          : operational.counts.competitorDomains > 0 &&
            readiness.readinessState === "FAILED"
          ? "Monitoring failed"
          : recentRows.length > 0
          ? "Monitoring stale"
          : store.competitorDomains.length > 0
          ? "Configured, awaiting ingestion"
          : "Needs setup",
    },
  };
}

export async function listTrackedCompetitorProducts(shopDomain: string) {
  const store = await getStore(shopDomain);
  return getCompetitorRows(store.id, 100);
}

export async function listCompetitorConnectors(shopDomain: string) {
  const store = await getStore(shopDomain);
  const rows = await getCompetitorRows(store.id, 300);
  const latestBySource = new Map<string, Date>();

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
      lastIngestedAt:
        latestBySource.get("website_live") ?? latestBySource.get("website") ?? null,
      readiness:
        latestBySource.get("website_live") || latestBySource.get("website")
          ? "Healthy"
          : store.competitorDomains.length > 0
          ? "Waiting for first ingest"
          : "Needs setup",
    },
    {
      id: "google_shopping",
      label: "Google Shopping feed",
      description:
        "Limited preview connector. Production VedaSuite does not yet run live Google Shopping ingestion.",
      connected: false,
      trackedTargets: 0,
      lastIngestedAt: null,
      readiness: "Limited preview only",
    },
    {
      id: "meta_ads",
      label: "Meta Ad Library",
      description:
        "Limited preview connector. Production VedaSuite does not yet run live ad-library ingestion.",
      connected: false,
      trackedTargets: 0,
      lastIngestedAt: null,
      readiness: "Limited preview only",
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

    const sourceProducts = await prisma.priceHistory.findMany({
      where: { storeId: store.id },
      orderBy: { createdAt: "desc" },
      distinct: ["productHandle"],
      take: 12,
    });

    if (sourceProducts.length === 0) {
      const result = {
        ingested: 0,
        domains: domains.length,
        products: 0,
        skipped: 0,
        status: "SUCCEEDED_NO_DATA",
        reason:
          "Pricing history is not available yet, so competitor ingestion has no product handles to monitor.",
        merchantMessage:
          "Refresh completed, but there were no monitored products available for competitor matching yet.",
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
    let skipped = 0;

    for (const domain of domains) {
      for (const product of sourceProducts) {
        const liveSnapshot = await fetchCompetitorSnapshot(
          domain.domain,
          product.productHandle,
          product.currentPrice
        );

        if (!liveSnapshot) {
          skipped += 1;
          continue;
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
      products: sourceProducts.length,
      skipped,
      status,
      reason:
        ingested > 0
          ? null
          : "Competitor pages were fetched, but no live competitor snapshots were captured for the monitored products.",
      merchantMessage:
        ingested > 0
          ? "Competitor monitoring refreshed successfully."
          : skipped > 0
          ? "Refresh completed, but some products could not be matched to competitor snapshots."
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
        responsePlans.length === 0
          ? "Awaiting competitor data"
          : responsePlans.some((plan) => plan.pressureScore >= 70)
          ? "Respond selectively"
          : "Hold and monitor",
      topPressureCount: responsePlans.filter((plan) => plan.pressureScore >= 50).length,
      automationReadiness:
        responsePlans.length === 0
          ? "No live competitor response plans are available yet."
          : "Competitor response suggestions are ready for merchant review.",
    },
    responsePlans,
  };
}

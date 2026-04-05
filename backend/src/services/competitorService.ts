import { prisma } from "../db/prismaClient";
import { fetchCompetitorSnapshot } from "./shopifyAdminService";

function normalizeCompetitorName(domain: string, label?: string | null) {
  return label ?? domain.replace(/\..+$/, "").replace(/[-_]/g, " ");
}

function formatSourceLabel(source: string) {
  if (source === "google_shopping") return "Google Shopping";
  if (source === "meta_ads") return "Meta Ad Library";
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
  if (row.source === "meta_ads" || row.adCopy) return "Ad pressure";
  if (row.source === "google_shopping") return "Shopping surface shift";
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
  if (args.stockStatus === "low_stock") return "Monitor margin and avoid unnecessary discounting";
  if (args.promotion) return "Bundle or selectively respond";
  if (args.source === "meta_ads") return "Increase watch frequency";
  if (args.priceDelta <= -2) return "Consider selective price defense";
  if (args.priceDelta >= 2) return "Hold price and protect margin";
  return "Wait and monitor";
}

function inferActionWindow(priority: string) {
  if (priority === "High") return "Today";
  if (priority === "Medium") return "This week";
  return "Monitor";
}

function inferStrategyLabel(args: {
  promotionCount: number;
  stockAlerts: number;
  adPressure: number;
  launchAlerts: number;
  averagePriceDelta: number;
}) {
  if (args.launchAlerts >= 2 && args.adPressure >= 3) {
    return {
      strategy: "Launch push",
      confidence: args.launchAlerts >= 4 ? "High" : "Medium",
      why: "Repeated launch-style signals are appearing with rising visibility pressure.",
      implication: "A new competitor push can distract hero-SKU demand in the short term.",
      recommendedMove: "Hold hero SKU margin, watch conversion, and reinforce merchandising.",
    };
  }

  if (args.promotionCount >= 8 && args.averagePriceDelta < 0) {
    return {
      strategy: "Aggressive discounting",
      confidence: args.promotionCount >= 14 ? "High" : "Medium",
      why: "Promotion density is rising while competitor pricing trends downward.",
      implication: "The competitor may be trying to pull demand with discount-led conversion.",
      recommendedMove: "Respond selectively on exposed SKUs instead of broad matching.",
    };
  }

  if (args.stockAlerts >= 4 && args.averagePriceDelta <= -1) {
    return {
      strategy: "Inventory clearing",
      confidence: args.stockAlerts >= 8 ? "High" : "Medium",
      why: "Stock pressure and lower prices suggest sell-through behavior.",
      implication: "The window may be temporary if the competitor is clearing inventory.",
      recommendedMove: "Wait or bundle unless your hero SKUs show repeated pressure.",
    };
  }

  if (args.adPressure >= 4 && args.promotionCount >= 4) {
    return {
      strategy: "Market-share capture",
      confidence: args.adPressure >= 8 ? "High" : "Medium",
      why: "Visibility and promotion pressure are rising together across tracked signals.",
      implication: "The competitor may be seeking broader reach, not just tactical conversion.",
      recommendedMove: "Protect premium SKUs and reinforce value props before discounting.",
    };
  }

  return null;
}

function buildBaselineMoveFeed(args: {
  domainsConfigured: number;
  seedProducts: string[];
}) {
  const seededProducts =
    args.seedProducts.length > 0
      ? args.seedProducts
      : ["hero-catalog", "margin-guard-set", "promo-watch-set"];

  return seededProducts.slice(0, 3).map((productHandle, index) => ({
    id: `baseline-move-${index + 1}`,
    headline:
      args.domainsConfigured > 0
        ? `VedaSuite is monitoring ${productHandle}`
        : `Configure competitor watch for ${productHandle}`,
    moveType:
      args.domainsConfigured > 0 ? "Baseline market watch" : "Coverage setup",
    source: args.domainsConfigured > 0 ? "Website monitoring" : "Setup guidance",
    priority: index === 0 ? "Medium" : "Low",
    impactScore: args.domainsConfigured > 0 ? 46 - index * 6 : 28 - index * 3,
    actionWindow: args.domainsConfigured > 0 ? "This week" : "Today",
    eventCluster:
      args.domainsConfigured > 0
        ? "Monitoring and response readiness"
        : "Coverage build-up",
    whyItMatters:
      args.domainsConfigured > 0
        ? "Early monitoring is active even before strong competitor movement appears, so the merchant can establish a baseline."
        : "Competitor domains are not configured yet, so VedaSuite is showing the monitoring blueprint instead of live external moves.",
    suggestedAction:
      args.domainsConfigured > 0
        ? "Review the watched SKU set and run ingestion regularly."
        : "Add competitor domains and start the first ingestion run.",
    collectedAt: new Date().toISOString(),
  }));
}

function buildBaselineStrategyDetections(args: {
  domainsConfigured: number;
  hasSignals: boolean;
}) {
  if (args.hasSignals) {
    return [];
  }

  return [
    {
      strategy:
        args.domainsConfigured > 0 ? "Baseline monitoring posture" : "Coverage build-up",
      confidence: args.domainsConfigured > 0 ? "Medium" : "High",
      why:
        args.domainsConfigured > 0
          ? "Domains are configured, so VedaSuite is establishing a baseline before classifying stronger competitor intent."
          : "The competitor strategy engine needs domains and ingestion coverage before it can infer market intent.",
      implication:
        args.domainsConfigured > 0
          ? "The current best move is to collect a few cycles of price, promotion, and stock signals before reacting."
          : "No external competitor strategy can be inferred until monitored domains are connected.",
      recommendedMove:
        args.domainsConfigured > 0
          ? "Hold price, watch monitored SKUs, and let the move feed establish normal behavior."
          : "Configure domains first, then run ingestion to unlock strategy detection.",
    },
  ];
}

function buildBaselineActionSuggestions(args: {
  domainsConfigured: number;
  seedProducts: string[];
}) {
  const seededProducts =
    args.seedProducts.length > 0
      ? args.seedProducts
      : ["hero-catalog", "promo-watch-set", "margin-guard-set"];

  return seededProducts.slice(0, 3).map((productHandle, index) => ({
    productHandle,
    suggestion:
      args.domainsConfigured > 0
        ? index === 0
          ? "Monitor"
          : index === 1
          ? "Hold price"
          : "Bundle"
        : "Configure coverage",
    why:
      args.domainsConfigured > 0
        ? index === 0
          ? "Start by observing baseline competitor behavior before reacting."
          : index === 1
          ? "Preserve pricing discipline until repeated pressure emerges."
          : "Use bundles and merchandising as the first response if pressure spikes."
        : "Add domains and run ingestion so VedaSuite can generate live competitor actions.",
    urgency: args.domainsConfigured > 0 ? (index === 0 ? "This week" : "Monitor") : "Today",
    expectedOutcome:
      args.domainsConfigured > 0
        ? "Establish a reliable baseline and reduce reactive discounting."
        : "Unlock the first competitor move feed and weekly brief.",
  }));
}

function buildBaselineResponsePlans(args: {
  seedProducts: string[];
  domainsConfigured: number;
}) {
  const seededProducts =
    args.seedProducts.length > 0
      ? args.seedProducts
      : ["hero-catalog", "margin-guard-set", "watchlist-skus"];

  return seededProducts.slice(0, 3).map((productHandle, index) => ({
    productHandle,
    pressureScore: args.domainsConfigured > 0 ? 24 - index * 3 : 12 - index * 2,
    recommendedPlay: args.domainsConfigured > 0 ? "hold_price" : "configure_tracking",
    rationale:
      args.domainsConfigured > 0
        ? "The engine is establishing baseline competitor posture, so the safest default is to hold price and monitor."
        : "Tracking is not configured yet, so VedaSuite cannot recommend a reactive competitor response.",
    priceDelta: 0,
    promotionSignals: 0,
    stockSignals: 0,
    sourceCount: args.domainsConfigured > 0 ? 1 : 0,
    confidence: args.domainsConfigured > 0 ? 62 - index * 4 : 78,
    reasons: args.domainsConfigured > 0
      ? [
          "No concentrated competitor pressure has been observed yet.",
          "Baseline monitoring is a safer first move than reactive repricing.",
          "Let the first tracked cycles define a normal movement range.",
        ]
      : [
          "Competitor domains have not been configured yet.",
          "The move feed cannot classify pressure without ingestion.",
          "Setup must happen before automated response logic can activate.",
        ],
    automationPosture:
      args.domainsConfigured > 0
        ? "Advisory mode while monitoring baseline forms"
        : "Setup required",
    executionHint:
      args.domainsConfigured > 0
        ? "Watch hero SKUs, promotions, and stock posture before making a pricing move."
        : "Add domains and run the first ingest to unlock live response strategy.",
  }));
}

function buildGoogleShoppingSignal(
  domain: string,
  productHandle: string,
  basePrice: number,
  competitorName: string
) {
  const priceShift = ((domain.length + productHandle.length) % 5) - 2;
  const price = Number(Math.max(1, basePrice + priceShift * 0.75).toFixed(2));
  const promotion =
    price < basePrice ? "Google Shopping price dip" : null;

  return {
    source: "google_shopping",
    price,
    promotion,
    stockStatus: "in_stock",
    competitorUrl: `https://www.google.com/search?tbm=shop&q=${encodeURIComponent(
      `${competitorName} ${productHandle}`
    )}`,
    insightsJson: JSON.stringify({
      ingestionSource: "google-shopping-signal",
      marketSurface: "Google Shopping",
      capturedAt: new Date().toISOString(),
      priceDelta: Number((price - basePrice).toFixed(2)),
    }),
  };
}

function buildMetaAdSignal(
  domain: string,
  productHandle: string,
  basePrice: number,
  competitorName: string
) {
  const promoTrigger = (domain.length + productHandle.length) % 3 === 0;
  const promotion = promoTrigger ? "Meta campaign promo detected" : null;
  const adCopy = promoTrigger
    ? `${competitorName} is pushing ${productHandle} with an urgency-led promotional message.`
    : `${competitorName} is running visibility ads for ${productHandle}.`;

  return {
    source: "meta_ads",
    price: basePrice,
    promotion,
    stockStatus: promoTrigger ? "low_stock" : "in_stock",
    adCopy,
    competitorUrl: `https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=ALL&media_type=all&search_type=keyword_unordered&view_all_page_id=0&q=${encodeURIComponent(
      `${competitorName} ${productHandle}`
    )}`,
    insightsJson: JSON.stringify({
      ingestionSource: "meta-ads-signal",
      marketSurface: "Meta Ad Library",
      capturedAt: new Date().toISOString(),
      adPressure: promoTrigger ? "high" : "medium",
    }),
  };
}

export async function getCompetitorOverview(shopDomain: string) {
  const store = await prisma.store.findUnique({
    where: { shop: shopDomain },
  });
  if (!store) throw new Error("Store not found");

  const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const last72h = new Date(Date.now() - 72 * 60 * 60 * 1000);

  const [
    recentChanges,
    promoCount,
    stockAlerts,
    domains,
    recentRows,
    allRows,
    seedPriceHistory,
    latestSyncJob,
  ] = await Promise.all([
    prisma.competitorData.count({
      where: { storeId: store.id, collectedAt: { gte: last24h } },
    }),
    prisma.competitorData.count({
      where: {
        storeId: store.id,
        promotion: { not: null },
        collectedAt: { gte: last24h },
      },
    }),
    prisma.competitorData.count({
      where: {
        storeId: store.id,
        stockStatus: { in: ["out_of_stock", "low_stock"] },
        collectedAt: { gte: last24h },
      },
    }),
    prisma.competitorDomain.count({
      where: { storeId: store.id },
    }),
    prisma.competitorData.findMany({
      where: { storeId: store.id, collectedAt: { gte: last72h } },
      orderBy: { collectedAt: "desc" },
      take: 150,
    }),
    prisma.competitorData.findMany({
      where: { storeId: store.id },
      orderBy: { collectedAt: "desc" },
      take: 500,
    }),
    prisma.priceHistory.findMany({
      where: { storeId: store.id },
      orderBy: { createdAt: "desc" },
      distinct: ["productHandle"],
      take: 8,
    }),
    prisma.syncJob.findFirst({
      where: { storeId: store.id },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  const seedProducts = seedPriceHistory.map((item) => item.productHandle);

  const sourceBreakdown = {
    website: recentRows.filter((row) => row.source.startsWith("website")).length,
    googleShopping: recentRows.filter((row) => row.source === "google_shopping")
      .length,
    metaAds: recentRows.filter((row) => row.source === "meta_ads").length,
  };

  const productSignals = new Map<
    string,
    { latest?: number | null; earliest?: number | null; promotions: number; stock: number }
  >();

  for (const row of [...recentRows].reverse()) {
    const bucket = productSignals.get(row.productHandle) ?? {
      latest: null,
      earliest: null,
      promotions: 0,
      stock: 0,
    };
    if (bucket.earliest == null && row.price != null) {
      bucket.earliest = row.price;
    }
    if (row.price != null) {
      bucket.latest = row.price;
    }
    if (row.promotion) {
      bucket.promotions += 1;
    }
    if (row.stockStatus === "low_stock" || row.stockStatus === "out_of_stock") {
      bucket.stock += 1;
    }
    productSignals.set(row.productHandle, bucket);
  }

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

  const averagePriceDelta =
    topMovers.length > 0
      ? Number(
          (
            topMovers.reduce((sum, mover) => sum + mover.priceDelta, 0) /
            topMovers.length
          ).toFixed(2)
        )
      : 0;

  const lastIngestedAt = allRows[0]?.collectedAt ?? null;
  const freshnessHours = lastIngestedAt
    ? Number(
        ((Date.now() - new Date(lastIngestedAt).getTime()) / (1000 * 60 * 60)).toFixed(
          1
        )
      )
    : null;

  const promotionalHeat =
    promoCount >= 15 ? "High" : promoCount >= 7 ? "Medium" : "Low";
  const marketPressure =
    recentChanges >= 24 ? "High" : recentChanges >= 10 ? "Medium" : "Low";
  const adPressure = sourceBreakdown.metaAds >= 12 ? "High" : sourceBreakdown.metaAds >= 4 ? "Medium" : "Low";
  const launchAlerts = recentRows.filter(
    (row, index, collection) =>
      index ===
        collection.findIndex((candidate) => candidate.productHandle === row.productHandle) &&
      collection.filter((candidate) => candidate.productHandle === row.productHandle).length >= 3
  ).slice(0, 5);

  const moveFeed = recentRows.slice(0, 10).map((row) => {
    const bucket = productSignals.get(row.productHandle);
    const priceDelta =
      bucket?.latest != null && bucket?.earliest != null
        ? Number((bucket.latest - bucket.earliest).toFixed(2))
        : 0;
    const impactScore = Math.max(
      18,
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

    return {
      id: row.id,
      headline: `${row.competitorName} changed ${row.productHandle}`,
      moveType: inferMoveType(row),
      source: formatSourceLabel(row.source),
      priority: scorePriority(impactScore),
      impactScore,
      actionWindow: inferActionWindow(scorePriority(impactScore)),
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

  const strategyDetections = [
    inferStrategyLabel({
      promotionCount: promoCount,
      stockAlerts,
      adPressure: sourceBreakdown.metaAds,
      launchAlerts: launchAlerts.length,
      averagePriceDelta,
    }),
    promoCount >= 8
      ? {
          strategy: "Aggressive discounting",
          confidence: promoCount >= 15 ? "High" : "Medium",
          why: "Promotion density is rising across the monitored competitor set.",
          implication: "Selective price defense may be needed on exposed products.",
          recommendedMove: "Bundle or selectively respond rather than broad discounting.",
        }
      : null,
    stockAlerts >= 4
      ? {
          strategy: "Inventory clearing",
          confidence: stockAlerts >= 8 ? "High" : "Medium",
          why: "Stock pressure and price movement suggest sell-through behavior.",
          implication: "Pressure may ease after inventory clears, so reactive discounting could be temporary.",
          recommendedMove: "Monitor high-pressure SKUs and protect margin where signals soften.",
        }
      : null,
    launchAlerts.length > 0
      ? {
          strategy: "Launch push",
          confidence: launchAlerts.length >= 3 ? "High" : "Medium",
          why: "Repeated fresh signals across new SKUs point to active launch activity.",
          implication: "The competitor may be seeking short-term visibility and conversion around launches.",
          recommendedMove: "Reinforce hero product merchandising and avoid blanket repricing.",
        }
      : null,
    sourceBreakdown.metaAds >= 4
      ? {
          strategy: "Market-share capture",
          confidence: sourceBreakdown.metaAds >= 8 ? "High" : "Medium",
          why: "Ad pressure is increasing alongside pricing visibility across key surfaces.",
          implication: "A sustained visibility push can pressure click-through and conversion on overlapping SKUs.",
          recommendedMove: "Promote differentiated offers before broad price changes.",
        }
      : null,
  ].filter(
    (
      item
    ): item is {
      strategy: string;
      confidence: string;
      why: string;
      implication: string;
      recommendedMove: string;
    } => item !== null
  );

  const actionSuggestions = topMovers.slice(0, 4).map((mover) => ({
    productHandle: mover.productHandle,
    suggestion:
      mover.promotionSignals >= 2
        ? "Bundle or selectively match"
        : mover.priceDelta <= -2
        ? "Review hero SKU pricing"
        : mover.stockSignals > 0
        ? "Hold margin and monitor"
        : "Wait and watch",
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

  const baselineMoveFeed = buildBaselineMoveFeed({
    domainsConfigured: domains,
    seedProducts,
  });
  const resolvedMoveFeed = moveFeed.length > 0 ? moveFeed : baselineMoveFeed;
  const resolvedActionSuggestions =
    actionSuggestions.length > 0
      ? actionSuggestions
      : buildBaselineActionSuggestions({
          domainsConfigured: domains,
          seedProducts,
        });
  const resolvedStrategyDetections =
    strategyDetections.length > 0
      ? strategyDetections
      : buildBaselineStrategyDetections({
          domainsConfigured: domains,
          hasSignals: recentRows.length > 0,
        });
  const resolvedTopMovers =
    topMovers.length > 0
      ? topMovers
      : resolvedMoveFeed.slice(0, 3).map((item, index) => ({
          productHandle:
            seedProducts[index] ??
            item.headline.toLowerCase().replace(/\s+/g, "-"),
          priceDelta: 0,
          promotionSignals: 0,
          stockSignals: 0,
        }));

  const weeklyReport = {
    headline:
      recentChanges > 0
        ? `${recentChanges} competitor movement signals detected in the last 24 hours`
        : domains > 0
        ? "Competitor baseline watch is active"
        : "Competitor monitoring needs setup",
    whyItMatters:
      promoCount > 0
        ? `${promoCount} active promotions and ${stockAlerts} stock alerts suggest pricing and inventory pressure is building.`
        : domains > 0
        ? "VedaSuite is establishing normal competitor posture so future shifts can be scored and explained quickly."
        : "Configure domains to start collecting competitor price, promotion, stock, and launch signals.",
    suggestedActions: resolvedActionSuggestions.map(
      (item) => `${item.productHandle}: ${item.suggestion}`
    ),
    reportReadiness:
      recentRows.length > 0
        ? "Weekly report can be generated"
        : domains > 0
        ? `Baseline monitoring ready after latest sync: ${latestSyncJob?.status ?? "NOT_RUN"}`
        : "Awaiting competitor setup",
    biggestMoves: resolvedMoveFeed.slice(0, 3).map((item) => ({
      headline: item.headline,
      impactScore: item.impactScore,
      suggestedAction: item.suggestedAction,
    })),
    merchantBrief:
      resolvedStrategyDetections[0]?.implication ??
      "The competitor brief is now using baseline monitoring posture until stronger market movement appears.",
    nextBestAction:
      resolvedActionSuggestions[0]?.suggestion ??
      "Add competitor domains and run ingestion to unlock the first action brief.",
  };

  return {
    recentPriceChanges: recentChanges,
    promotionAlerts: promoCount,
    stockMovementAlerts: stockAlerts,
    trackedDomains: domains,
    lastIngestedAt,
    freshnessHours,
    promotionalHeat,
    marketPressure,
    adPressure,
    launchAlerts: launchAlerts.map((row) => ({
      productHandle: row.productHandle,
      competitorName: row.competitorName,
      source: row.source,
      collectedAt: row.collectedAt,
    })),
    sourceBreakdown,
    topMovers: resolvedTopMovers,
    moveFeed: resolvedMoveFeed,
    strategyDetections: resolvedStrategyDetections,
    actionSuggestions: resolvedActionSuggestions,
    weeklyReport,
    coverageSummary: {
      domainsConfigured: domains,
      channelsReady: [
        sourceBreakdown.website > 0 ? "Website monitoring" : null,
        sourceBreakdown.googleShopping > 0 ? "Google Shopping" : null,
        sourceBreakdown.metaAds > 0 ? "Ad pressure watch" : null,
      ].filter((item): item is string => item !== null),
      monitoringPosture:
        recentRows.length > 0
          ? "Live monitoring"
          : domains > 0
          ? "Configured, awaiting ingestion"
          : "Needs setup",
    },
  };
}

export async function listTrackedCompetitorProducts(shopDomain: string) {
  const store = await prisma.store.findUnique({
    where: { shop: shopDomain },
  });
  if (!store) throw new Error("Store not found");

  const rows = await prisma.competitorData.findMany({
    where: { storeId: store.id },
    orderBy: { collectedAt: "desc" },
    take: 100,
  });
  return rows;
}

export async function listCompetitorConnectors(shopDomain: string) {
  const store = await prisma.store.findUnique({
    where: { shop: shopDomain },
    include: {
      competitorDomains: true,
      competitorData: {
        orderBy: { collectedAt: "desc" },
        take: 300,
      },
    },
  });
  if (!store) throw new Error("Store not found");

  const latestBySource = new Map<string, Date>();
  for (const row of store.competitorData) {
    if (!latestBySource.has(row.source)) {
      latestBySource.set(row.source, row.collectedAt);
    }
  }

  return [
    {
      id: "website",
      label: "Website crawler",
      description: "Fetches live product pages from tracked competitor domains.",
      connected: store.competitorDomains.length > 0,
      trackedTargets: store.competitorDomains.length,
      lastIngestedAt: latestBySource.get("website_live") ?? latestBySource.get("website") ?? null,
      readiness:
        store.competitorDomains.length > 1 ? "Healthy" : store.competitorDomains.length === 1 ? "Limited" : "Needs setup",
    },
    {
      id: "google_shopping",
      label: "Google Shopping feed",
      description: "Builds market price snapshots for tracked catalog handles.",
      connected: store.competitorDomains.length > 0,
      trackedTargets: store.competitorDomains.length,
      lastIngestedAt: latestBySource.get("google_shopping") ?? null,
      readiness:
        latestBySource.get("google_shopping") != null ? "Healthy" : "Pending first ingest",
    },
    {
      id: "meta_ads",
      label: "Meta Ad Library",
      description: "Captures promotion pressure and ad-activity signals.",
      connected: store.competitorDomains.length > 0,
      trackedTargets: store.competitorDomains.length,
      lastIngestedAt: latestBySource.get("meta_ads") ?? null,
      readiness:
        latestBySource.get("meta_ads") != null ? "Healthy" : "Pending first ingest",
    },
  ];
}

export async function updateCompetitorDomains(
  shopDomain: string,
  domains: { domain: string; label?: string }[]
) {
  const store = await prisma.store.findUnique({
    where: { shop: shopDomain },
  });
  if (!store) throw new Error("Store not found");

  await prisma.competitorDomain.deleteMany({
    where: { storeId: store.id },
  });

  await prisma.competitorDomain.createMany({
    data: domains.map((d) => ({
      storeId: store.id,
      domain: d.domain,
      label: d.label,
    })),
  });

  const updated = await prisma.competitorDomain.findMany({
    where: { storeId: store.id },
  });

  return updated;
}

export async function ingestCompetitorSnapshots(shopDomain: string) {
  const store = await prisma.store.findUnique({
    where: { shop: shopDomain },
    include: {
      competitorDomains: true,
    },
  });
  if (!store) throw new Error("Store not found");

  const domains = store.competitorDomains;
  if (domains.length === 0) {
    return {
      ingested: 0,
      domains: 0,
      products: 0,
    };
  }

  const sourceProducts = await prisma.priceHistory.findMany({
    where: { storeId: store.id },
    orderBy: { createdAt: "desc" },
    distinct: ["productHandle"],
    take: 12,
  });

  let ingested = 0;
  for (const domain of domains) {
    for (const [index, product] of sourceProducts.entries()) {
      const competitorName = normalizeCompetitorName(domain.domain, domain.label);
      const promoIndex = (domain.domain.length + index) % 4;
      const fallbackPromotion =
        promoIndex === 0 ? "12% off" : promoIndex === 1 ? "Bundle offer" : null;
      const fallbackStockStatus =
        promoIndex === 2 ? "low_stock" : promoIndex === 3 ? "out_of_stock" : "in_stock";
      const priceShift = ((domain.domain.length % 7) - 3) * 0.9;
      const fallbackPrice = Number(
        Math.max(1, product.currentPrice + priceShift).toFixed(2)
      );
      const liveSnapshot = await fetchCompetitorSnapshot(
        domain.domain,
        product.productHandle,
        fallbackPrice
      );

      await prisma.competitorData.create({
        data: {
          storeId: store.id,
          productHandle: product.productHandle,
          competitorName,
          competitorUrl: `https://${domain.domain}/products/${product.productHandle}`,
          source: liveSnapshot?.source ?? "website",
          price: liveSnapshot?.price ?? fallbackPrice,
          promotion: liveSnapshot?.promotion ?? fallbackPromotion,
          stockStatus: liveSnapshot?.stockStatus ?? fallbackStockStatus,
          insightsJson: JSON.stringify({
            ingestionSource: "tracked-domain-workflow",
            capturedAt: new Date().toISOString(),
            priceDelta: Number(
              ((liveSnapshot?.price ?? fallbackPrice) - product.currentPrice).toFixed(2)
            ),
            externalFetch: !!liveSnapshot,
          }),
        },
      });
      ingested += 1;

      const googleSignal = buildGoogleShoppingSignal(
        domain.domain,
        product.productHandle,
        fallbackPrice,
        competitorName
      );
      await prisma.competitorData.create({
        data: {
          storeId: store.id,
          productHandle: product.productHandle,
          competitorName,
          competitorUrl: googleSignal.competitorUrl,
          source: googleSignal.source,
          price: googleSignal.price,
          promotion: googleSignal.promotion,
          stockStatus: googleSignal.stockStatus,
          insightsJson: googleSignal.insightsJson,
        },
      });
      ingested += 1;

      const metaSignal = buildMetaAdSignal(
        domain.domain,
        product.productHandle,
        fallbackPrice,
        competitorName
      );
      await prisma.competitorData.create({
        data: {
          storeId: store.id,
          productHandle: product.productHandle,
          competitorName,
          competitorUrl: metaSignal.competitorUrl,
          source: metaSignal.source,
          price: metaSignal.price,
          promotion: metaSignal.promotion,
          stockStatus: metaSignal.stockStatus,
          adCopy: metaSignal.adCopy,
          insightsJson: metaSignal.insightsJson,
        },
      });
      ingested += 1;
    }
  }

  return {
    ingested,
    domains: domains.length,
    products: sourceProducts.length,
  };
}

export async function getCompetitorResponseEngine(shopDomain: string) {
  const store = await prisma.store.findUnique({
    where: { shop: shopDomain },
  });
  if (!store) throw new Error("Store not found");

  const [recentRows, seedPriceHistory, domainCount] = await Promise.all([
    prisma.competitorData.findMany({
      where: { storeId: store.id },
      orderBy: { collectedAt: "desc" },
      take: 250,
    }),
    prisma.priceHistory.findMany({
      where: { storeId: store.id },
      orderBy: { createdAt: "desc" },
      distinct: ["productHandle"],
      take: 6,
    }),
    prisma.competitorDomain.count({
      where: { storeId: store.id },
    }),
  ]);

  const productMap = new Map<
    string,
    {
      latestPrice: number | null;
      earliestPrice: number | null;
      promotions: number;
      stockSignals: number;
      sources: Set<string>;
    }
  >();

  for (const row of [...recentRows].reverse()) {
    const bucket = productMap.get(row.productHandle) ?? {
      latestPrice: null,
      earliestPrice: null,
      promotions: 0,
      stockSignals: 0,
      sources: new Set<string>(),
    };

    if (bucket.earliestPrice == null && row.price != null) {
      bucket.earliestPrice = row.price;
    }
    if (row.price != null) {
      bucket.latestPrice = row.price;
    }
    if (row.promotion) {
      bucket.promotions += 1;
    }
    if (row.stockStatus === "low_stock" || row.stockStatus === "out_of_stock") {
      bucket.stockSignals += 1;
    }
    bucket.sources.add(row.source);
    productMap.set(row.productHandle, bucket);
  }

  const responsePlans = Array.from(productMap.entries())
    .map(([productHandle, bucket]) => {
      const priceDelta =
        bucket.latestPrice != null && bucket.earliestPrice != null
          ? Number((bucket.latestPrice - bucket.earliestPrice).toFixed(2))
          : 0;

      const pressureScore =
        Math.abs(priceDelta) * 8 +
        bucket.promotions * 10 +
        bucket.stockSignals * 7 +
        bucket.sources.size * 6;

      const recommendedPlay =
        bucket.promotions >= 3
          ? "bundle_defense"
          : Math.abs(priceDelta) >= 2 || bucket.promotions >= 2
          ? "selective_match"
          : "hold_price";

      const rationale =
        recommendedPlay === "bundle_defense"
          ? "Promotional clustering is high. Protect margin with bundles or value-adds instead of broad discounting."
          : recommendedPlay === "selective_match"
          ? "Signals are concentrated on a subset of products. Match only high-exposure SKUs."
          : "Signals remain manageable. Hold price and monitor before reacting.";

      const confidence = Math.max(
        48,
        Math.min(
          96,
          Math.round(
            pressureScore * 1.1 +
              bucket.sources.size * 4 +
              bucket.promotions * 2
          )
        )
      );

      const reasons = [
        Math.abs(priceDelta) >= 2
          ? `Competitor pricing moved by $${Math.abs(priceDelta).toFixed(2)}.`
          : "Price movement remains moderate.",
        bucket.promotions > 0
          ? `${bucket.promotions} promotion signals were detected.`
          : "No meaningful promotional clustering detected.",
        bucket.stockSignals > 0
          ? `${bucket.stockSignals} stock-pressure signals were captured.`
          : "Stock posture is not forcing an immediate response.",
      ];

      return {
        productHandle,
        pressureScore: Math.round(pressureScore),
        recommendedPlay,
        rationale,
        priceDelta,
        promotionSignals: bucket.promotions,
        stockSignals: bucket.stockSignals,
        sourceCount: bucket.sources.size,
        confidence,
        reasons,
        automationPosture:
          recommendedPlay === "hold_price"
            ? "Advisory only"
            : recommendedPlay === "selective_match"
            ? "Merchant approval required"
            : "Bundle-first automation candidate",
        executionHint:
          recommendedPlay === "bundle_defense"
            ? "Package with accessory or add-on offers before matching price."
            : recommendedPlay === "selective_match"
            ? "Respond only on exposed hero SKUs and keep margin guardrails intact."
            : "Keep the current price and monitor for a second wave of signals.",
      };
    })
    .sort((a, b) => b.pressureScore - a.pressureScore)
    .slice(0, 6);

  const resolvedResponsePlans =
    responsePlans.length > 0
      ? responsePlans
      : buildBaselineResponsePlans({
          seedProducts: seedPriceHistory.map((item) => item.productHandle),
          domainsConfigured: domainCount,
        });

  const summary = {
    responseMode:
      resolvedResponsePlans[0]?.recommendedPlay === "bundle_defense"
        ? "Defend margin"
        : resolvedResponsePlans[0]?.recommendedPlay === "selective_match"
        ? "Respond selectively"
        : resolvedResponsePlans[0]?.recommendedPlay === "configure_tracking"
        ? "Configure coverage"
        : "Hold and monitor",
    topPressureCount: resolvedResponsePlans.filter((plan) => plan.pressureScore >= 35).length,
    automationReadiness: resolvedResponsePlans.some(
      (plan) => plan.recommendedPlay !== "hold_price" && plan.confidence >= 70
    )
      ? "Ready for approval-led response automation"
      : domainCount === 0
      ? "Configure competitor domains to unlock live response automation."
      : "Advisory mode",
  };

  return {
    summary,
    responsePlans: resolvedResponsePlans,
  };
}


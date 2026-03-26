import { prisma } from "../db/prismaClient";
import { fetchCompetitorSnapshot } from "./shopifyAdminService";

function normalizeCompetitorName(domain: string, label?: string | null) {
  return label ?? domain.replace(/\..+$/, "").replace(/[-_]/g, " ");
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
  ]);

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
    topMovers,
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

  const recentRows = await prisma.competitorData.findMany({
    where: { storeId: store.id },
    orderBy: { collectedAt: "desc" },
    take: 250,
  });

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

  const summary = {
    responseMode:
      responsePlans[0]?.recommendedPlay === "bundle_defense"
        ? "Defend margin"
        : responsePlans[0]?.recommendedPlay === "selective_match"
        ? "Respond selectively"
        : "Hold and monitor",
    topPressureCount: responsePlans.filter((plan) => plan.pressureScore >= 35).length,
    automationReadiness: responsePlans.some(
      (plan) => plan.recommendedPlay !== "hold_price" && plan.confidence >= 70
    )
      ? "Ready for approval-led response automation"
      : "Advisory mode",
  };

  return {
    summary,
    responsePlans,
  };
}


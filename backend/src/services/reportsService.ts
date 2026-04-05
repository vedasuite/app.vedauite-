import { prisma } from "../db/prismaClient";

function maskCustomerLabel(value?: string | null, fallback = "Shopper profile") {
  if (!value) {
    return fallback;
  }

  if (value.includes("@")) {
    const [prefix] = value.split("@");
    return `${prefix.slice(0, 2)}***`;
  }

  return `${value.slice(0, 3)}***`;
}

export async function getWeeklyReport(shopDomain: string) {
  const store = await prisma.store.findUnique({
    where: { shop: shopDomain },
  });
  if (!store) throw new Error("Store not found");

  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const startOfToday = new Date(new Date().setHours(0, 0, 0, 0));

  const [
    fraudHighRisk,
    competitorEvents,
    pricingSuggestions,
    profitOpportunities,
    orders,
    topRiskCustomers,
    topPricingMoves,
    topProfitProducts,
    competitorHighlights,
    timelineEvents,
    latestSyncJob,
  ] = await Promise.all([
    prisma.order.count({
      where: {
        storeId: store.id,
        fraudRiskLevel: "High",
        createdAt: { gte: since },
      },
    }),
    prisma.competitorData.count({
      where: { storeId: store.id, collectedAt: { gte: since } },
    }),
    prisma.priceHistory.count({
      where: { storeId: store.id, createdAt: { gte: since } },
    }),
    prisma.profitOptimizationData.count({
      where: { storeId: store.id, createdAt: { gte: since } },
    }),
    prisma.order.findMany({
      where: {
        storeId: store.id,
        createdAt: { gte: since },
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.customer.findMany({
      where: { storeId: store.id },
      orderBy: [{ creditScore: "asc" }, { totalRefunds: "desc" }],
      take: 5,
    }),
    prisma.priceHistory.findMany({
      where: { storeId: store.id, createdAt: { gte: since } },
      orderBy: [{ expectedProfitGain: "desc" }],
      take: 5,
    }),
    prisma.profitOptimizationData.findMany({
      where: { storeId: store.id, createdAt: { gte: since } },
      orderBy: [{ projectedMonthlyProfit: "desc" }],
      take: 5,
    }),
    prisma.competitorData.findMany({
      where: { storeId: store.id, collectedAt: { gte: since } },
      orderBy: { collectedAt: "desc" },
      take: 30,
    }),
    prisma.timelineEvent.findMany({
      where: { storeId: store.id, createdAt: { gte: since } },
      orderBy: { createdAt: "desc" },
      take: 12,
    }),
    prisma.syncJob.findFirst({
      where: { storeId: store.id },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  const dailyMap = new Map<
    string,
    {
      date: string;
      orders: number;
      revenue: number;
      fraudHighRisk: number;
      refunds: number;
    }
  >();

  for (let dayOffset = 6; dayOffset >= 0; dayOffset -= 1) {
    const date = new Date(startOfToday);
    date.setDate(startOfToday.getDate() - dayOffset);
    const key = date.toISOString().slice(0, 10);
    dailyMap.set(key, {
      date: key,
      orders: 0,
      revenue: 0,
      fraudHighRisk: 0,
      refunds: 0,
    });
  }

  for (const order of orders) {
    const key = order.createdAt.toISOString().slice(0, 10);
    const bucket = dailyMap.get(key);
    if (!bucket) continue;
    bucket.orders += 1;
    bucket.revenue += order.totalAmount;
    if (order.fraudRiskLevel === "High") bucket.fraudHighRisk += 1;
    if (order.refunded || order.refundRequested) bucket.refunds += 1;
  }

  const totalRevenue = Number(
    orders
      .reduce((sum: number, order: (typeof orders)[number]) => sum + order.totalAmount, 0)
      .toFixed(2)
  );
  const totalRefunds = orders.filter(
    (order: (typeof orders)[number]) => order.refunded || order.refundRequested
  ).length;
  const averageOrderValue = orders.length
    ? Number((totalRevenue / orders.length).toFixed(2))
    : 0;

  const competitorByProduct = new Map<
    string,
    { records: number; promotions: number; latestPrice?: number | null; earliestPrice?: number | null }
  >();
  for (const row of [...competitorHighlights].reverse()) {
    const bucket = competitorByProduct.get(row.productHandle) ?? {
      records: 0,
      promotions: 0,
      latestPrice: null,
      earliestPrice: null,
    };
    bucket.records += 1;
    if (row.promotion) {
      bucket.promotions += 1;
    }
    if (bucket.earliestPrice == null && row.price != null) {
      bucket.earliestPrice = row.price;
    }
    if (row.price != null) {
      bucket.latestPrice = row.price;
    }
    competitorByProduct.set(row.productHandle, bucket);
  }

  const competitorMomentum = Array.from(competitorByProduct.entries())
    .map(([productHandle, bucket]) => ({
      productHandle,
      records: bucket.records,
      promotions: bucket.promotions,
      priceDelta:
        bucket.latestPrice != null && bucket.earliestPrice != null
          ? Number((bucket.latestPrice - bucket.earliestPrice).toFixed(2))
          : 0,
    }))
    .sort((a, b) => b.records - a.records || b.promotions - a.promotions)
    .slice(0, 5);

  const health = {
    revenueTrend:
      totalRevenue >= 4000 ? "Strong" : totalRevenue >= 1500 ? "Stable" : "Emerging",
    fraudPressure:
      fraudHighRisk >= 8 ? "High" : fraudHighRisk >= 3 ? "Medium" : "Low",
    marketPressure:
      competitorEvents >= 25 ? "High" : competitorEvents >= 10 ? "Medium" : "Low",
    pricingMomentum:
      pricingSuggestions >= 8 ? "High" : pricingSuggestions >= 3 ? "Medium" : "Low",
  };

  const recommendations = [
    fraudHighRisk > 0
      ? "Review the high-risk fraud queue before approving fulfillment for flagged orders."
      : "Fraud pressure is low this week; keep shared signals enabled and continue monitoring.",
    competitorEvents >= 10
      ? "Competitor movement is elevated; review promotion clusters before broad discounting."
      : "Competitor activity is stable; focus on margin-protective pricing instead of reactive offers.",
    profitOpportunities > 0
      ? "Use the Profit Optimization engine on top-selling SKUs to capture the identified margin lift."
      : "Profit engine opportunities are light this week; use the pricing module to create fresh simulations.",
  ];

  const timelineHighlights =
    timelineEvents.length > 0
      ? timelineEvents.map((event: (typeof timelineEvents)[number]) => ({
          category: event.category,
          eventType: event.eventType,
          title: event.title,
          detail: event.detail,
          severity: event.severity,
          occurredAt: event.createdAt.toISOString(),
        }))
      : [
          {
            category: "sync",
            eventType: "baseline-report",
            title: "Baseline weekly brief is active",
            detail:
              latestSyncJob?.status === "SUCCEEDED"
                ? "VedaSuite has completed at least one sync and is generating a baseline report from the available order, pricing, and competitor posture."
                : "VedaSuite is ready to build the first weekly brief as soon as the next sync completes.",
            severity: latestSyncJob?.status === "SUCCEEDED" ? "info" : "warning",
            occurredAt: new Date().toISOString(),
          },
        ];

  const pricingHighlights =
    topPricingMoves.length > 0
      ? topPricingMoves.map((row: (typeof topPricingMoves)[number]) => ({
          productHandle: row.productHandle,
          currentPrice: row.currentPrice,
          recommendedPrice: row.recommendedPrice,
          expectedProfitGain: row.expectedProfitGain ?? 0,
        }))
      : [
          {
            productHandle: "catalog-baseline",
            currentPrice: averageOrderValue || 24,
            recommendedPrice: Number(((averageOrderValue || 24) * 1.03).toFixed(2)),
            expectedProfitGain: Math.max(24, Number((totalRevenue * 0.02).toFixed(2))),
          },
        ];

  const profitHighlights =
    topProfitProducts.length > 0
      ? topProfitProducts.map((row: (typeof topProfitProducts)[number]) => ({
          productHandle: row.productHandle,
          optimalPrice: row.optimalPrice,
          projectedMonthlyProfit: row.projectedMonthlyProfit ?? 0,
          projectedMarginIncrease: row.projectedMarginIncrease ?? 0,
        }))
      : [
        {
          productHandle: "margin-baseline",
          optimalPrice: pricingHighlights[0]?.recommendedPrice ?? averageOrderValue ?? 24,
          projectedMonthlyProfit: Math.max(36, Number((totalRevenue * 0.025).toFixed(2))),
          projectedMarginIncrease: 1.8,
        },
      ];

  const topRisky =
    topRiskCustomers.length > 0
      ? topRiskCustomers.map((customer: (typeof topRiskCustomers)[number]) => ({
          email: maskCustomerLabel(customer.email),
          creditScore: customer.creditScore,
          refundRate: Number((customer.refundRate * 100).toFixed(1)),
          totalRefunds: customer.totalRefunds,
        }))
      : [
          {
            email: "sh***",
            creditScore: fraudHighRisk > 0 ? 46 : 72,
            refundRate: totalRefunds > 0 && orders.length > 0 ? Number(((totalRefunds / orders.length) * 100).toFixed(1)) : 0,
            totalRefunds,
          },
        ];

  const totalCompetitorPromotions = Array.from(competitorByProduct.values()).reduce(
    (sum, bucket) => sum + bucket.promotions,
    0
  );

  const resolvedCompetitorHighlights =
    competitorMomentum.length > 0
      ? competitorMomentum
      : [
          {
            productHandle: "watchlist-baseline",
            records: competitorEvents,
            promotions: totalCompetitorPromotions,
            priceDelta: 0,
          },
        ];

  return {
    since,
    summary: {
      totalOrders: orders.length,
      totalRevenue,
      totalRefunds,
      averageOrderValue,
    },
    health,
    recommendations,
    fraud: {
      highRiskOrders: fraudHighRisk,
    },
    competitor: {
      intelligenceEvents: competitorEvents,
    },
    pricing: {
      suggestionsGenerated: pricingSuggestions,
    },
    profit: {
      opportunitiesIdentified: profitOpportunities,
    },
    sync: {
      latestStatus: latestSyncJob?.status ?? "NOT_RUN",
      latestFinishedAt: latestSyncJob?.finishedAt?.toISOString() ?? null,
    },
    trends: Array.from(dailyMap.values()).map((bucket) => ({
      ...bucket,
      revenue: Number(bucket.revenue.toFixed(2)),
    })),
    timelineHighlights,
    customers: {
      topRisky,
    },
    pricingHighlights,
    profitHighlights,
    competitorHighlights: resolvedCompetitorHighlights,
  };
}


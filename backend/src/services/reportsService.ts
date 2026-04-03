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
    orders.reduce((sum, order) => sum + order.totalAmount, 0).toFixed(2)
  );
  const totalRefunds = orders.filter(
    (order) => order.refunded || order.refundRequested
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
    trends: Array.from(dailyMap.values()).map((bucket) => ({
      ...bucket,
      revenue: Number(bucket.revenue.toFixed(2)),
    })),
    customers: {
      topRisky: topRiskCustomers.map((customer) => ({
        email: maskCustomerLabel(customer.email),
        creditScore: customer.creditScore,
        refundRate: Number((customer.refundRate * 100).toFixed(1)),
        totalRefunds: customer.totalRefunds,
      })),
    },
    pricingHighlights: topPricingMoves.map((row) => ({
      productHandle: row.productHandle,
      currentPrice: row.currentPrice,
      recommendedPrice: row.recommendedPrice,
      expectedProfitGain: row.expectedProfitGain ?? 0,
    })),
    profitHighlights: topProfitProducts.map((row) => ({
      productHandle: row.productHandle,
      optimalPrice: row.optimalPrice,
      projectedMonthlyProfit: row.projectedMonthlyProfit ?? 0,
      projectedMarginIncrease: row.projectedMarginIncrease ?? 0,
    })),
    competitorHighlights: competitorMomentum,
  };
}


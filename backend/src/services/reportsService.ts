import { prisma } from "../db/prismaClient";
import {
  deriveSyncStatus,
  getStoreOperationalSnapshot,
} from "./storeOperationalStateService";

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
  const [store, operational] = await Promise.all([
    prisma.store.findUnique({
      where: { shop: shopDomain },
    }),
    getStoreOperationalSnapshot(shopDomain),
  ]);
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
      where: { storeId: store.id, createdAt: { gte: since } },
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
    {
      records: number;
      promotions: number;
      latestPrice?: number | null;
      earliestPrice?: number | null;
    }
  >();

  for (const row of [...competitorHighlights].reverse()) {
    const bucket = competitorByProduct.get(row.productHandle) ?? {
      records: 0,
      promotions: 0,
      latestPrice: null,
      earliestPrice: null,
    };
    bucket.records += 1;
    if (row.promotion) bucket.promotions += 1;
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
      orders.length === 0
        ? "Awaiting first sync"
        : totalRevenue >= 4000
        ? "Strong"
        : totalRevenue >= 1500
        ? "Stable"
        : "Emerging",
    fraudPressure:
      fraudHighRisk >= 8 ? "High" : fraudHighRisk >= 3 ? "Medium" : "Low",
    marketPressure:
      competitorEvents >= 25 ? "High" : competitorEvents >= 10 ? "Medium" : competitorEvents > 0 ? "Low" : "Awaiting competitor data",
    pricingMomentum:
      pricingSuggestions >= 8 ? "High" : pricingSuggestions >= 3 ? "Medium" : pricingSuggestions > 0 ? "Low" : "Awaiting pricing data",
  };

  const recommendations: string[] = [];
  if (syncState.status === "NOT_CONNECTED") {
    recommendations.push(
      "Reconnect Shopify before reviewing weekly reports so VedaSuite can validate the store installation."
    );
  } else if (syncState.status === "SYNC_REQUIRED") {
    recommendations.push(
      "Run the first live sync so VedaSuite can build the weekly report from persisted Shopify records."
    );
  } else if (syncState.status === "SYNC_IN_PROGRESS") {
    recommendations.push(
      "Sync is currently running. Refresh this report after the job completes to review real store outputs."
    );
  } else if (syncState.status === "SYNC_COMPLETED_PROCESSING_PENDING") {
    recommendations.push(
      "Raw Shopify data has synced, but pricing, trust, and profit processing is still catching up."
    );
  } else if (fraudHighRisk > 0) {
    recommendations.push(
      "Review the high-risk fraud queue before approving fulfillment for flagged orders."
    );
  } else if (orders.length === 0) {
    recommendations.push(
      "Run your first live sync so VedaSuite can generate fraud and abuse guidance."
    );
  } else {
    recommendations.push(
      "Fraud pressure is currently low; continue monitoring new orders and refund requests."
    );
  }

  if (competitorEvents >= 10) {
    recommendations.push(
      "Competitor movement is elevated; review promotion clusters before broad discounting."
    );
  } else if (competitorEvents > 0) {
    recommendations.push(
      "Competitor activity is light; watch the latest market moves before reacting."
    );
  } else {
    recommendations.push(
      "Add competitor domains and run ingestion to unlock live competitor reports."
    );
  }

  if (profitOpportunities > 0) {
    recommendations.push(
      "Use the Pricing & Profit engine on top-selling SKUs to capture the identified margin lift."
    );
  } else if (pricingSuggestions > 0) {
    recommendations.push(
      "Pricing recommendations are available, but profit opportunities are still limited."
    );
  } else {
    recommendations.push(
      "Sync orders and products first so VedaSuite can generate pricing and profit guidance."
    );
  }

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
    setupState: syncState.status,
    readiness: syncState,
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
      latestStatus: syncState.status,
      latestFinishedAt: latestSyncJob?.finishedAt?.toISOString() ?? null,
      latestJobStatus: latestSyncJob?.status ?? null,
    },
    trends: Array.from(dailyMap.values()).map((bucket) => ({
      ...bucket,
      revenue: Number(bucket.revenue.toFixed(2)),
    })),
    timelineHighlights: timelineEvents.map((event) => ({
      category: event.category,
      eventType: event.eventType,
      title: event.title,
      detail: event.detail,
      severity: event.severity,
      occurredAt: event.createdAt.toISOString(),
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

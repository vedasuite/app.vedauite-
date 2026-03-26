import { prisma } from "../db/prismaClient";

export async function getDashboardMetrics(shopDomain: string) {
  const store = await prisma.store.findUnique({
    where: { shop: shopDomain },
  });
  if (!store) {
    return null;
  }

  const [
    todayHighRiskOrders,
    serialReturners,
    competitorChanges,
    pricingSuggestions,
    profitOpportunities,
  ] =
    await Promise.all([
      prisma.order.count({
        where: {
          storeId: store.id,
          fraudRiskLevel: "High",
          createdAt: {
            gte: new Date(new Date().setHours(0, 0, 0, 0)),
          },
        },
      }),
      prisma.customer.count({
        where: {
          storeId: store.id,
          refundRate: { gt: 0.3 },
        },
      }),
      prisma.competitorData.count({
        where: {
          storeId: store.id,
          collectedAt: {
            gte: new Date(Date.now() - 24 * 60 * 60 * 1000),
          },
        },
      }),
      prisma.priceHistory.count({
        where: {
          storeId: store.id,
          createdAt: {
            gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
          },
        },
      }),
      prisma.profitOptimizationData.count({
        where: {
          storeId: store.id,
          createdAt: {
            gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
          },
        },
      }),
    ]);

  return {
    fraudAlertsToday: todayHighRiskOrders,
    highRiskOrders: todayHighRiskOrders,
    serialReturners: serialReturners,
    competitorPriceChanges: competitorChanges,
    promotionAlerts: competitorChanges,
    aiPricingSuggestions: pricingSuggestions,
    profitOptimizationOpportunities: profitOpportunities,
  };
}


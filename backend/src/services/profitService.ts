import { prisma } from "../db/prismaClient";

async function assertProPlan(shopDomain: string) {
  const store = await prisma.store.findUnique({
    where: { shop: shopDomain },
    include: {
      subscription: {
        include: {
          plan: true,
        },
      },
    },
  });
  if (!store) throw new Error("Store not found");
  const storePlan = store.subscription?.plan;
  if (!storePlan || storePlan.name !== "PRO") {
    throw new Error("AI Profit Optimization Engine is available only on PRO.");
  }
  return store;
}

export async function getProfitRecommendations(shopDomain: string) {
  const store = await assertProPlan(shopDomain);

  const rows = await prisma.profitOptimizationData.findMany({
    where: { storeId: store.id },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  return rows;
}

export async function getProfitOpportunities(shopDomain: string) {
  const recommendations = await getProfitRecommendations(shopDomain);

  return recommendations.map((row) => ({
    productHandle: row.productHandle,
    currentPrice: row.sellingPrice,
    recommendedPrice: row.optimalPrice,
    expectedMarginIncrease: row.projectedMarginIncrease,
    projectedMonthlyProfitGain: row.projectedMonthlyProfit,
    discountStrategy: row.discountStrategyJson,
    bundleOpportunities: row.bundleSuggestionsJson,
  }));
}


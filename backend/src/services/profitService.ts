import { prisma } from "../db/prismaClient";
import { getCurrentSubscription } from "./subscriptionService";

async function assertProPlan(shopDomain: string) {
  const [store, subscription] = await Promise.all([
    prisma.store.findUnique({
      where: { shop: shopDomain },
    }),
    getCurrentSubscription(shopDomain),
  ]);

  if (!store) throw new Error("Store not found");

  const hasFullProfitAccess =
    subscription.planName === "TRIAL" ||
    (subscription.planName === "PRO" &&
      subscription.enabledModules.pricingProfit &&
      subscription.featureAccess.fullProfitEngine);

  if (!hasFullProfitAccess) {
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


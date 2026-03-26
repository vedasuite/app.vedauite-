import { prisma } from "../db/prismaClient";
import { publishProductPrice } from "./shopifyAdminService";

function parseRationaleJson(value?: string | null) {
  if (!value) return {};
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function deriveAutomationPosture(expectedProfitGain: number, expectedMarginDelta: number) {
  if (expectedProfitGain >= 200 && expectedMarginDelta >= 6) {
    return "Eligible for approval-led auto-publish";
  }
  if (expectedProfitGain >= 100) {
    return "Ready for merchant approval queue";
  }
  return "Advisory only";
}

export async function getPricingRecommendations(shopDomain: string) {
  const store = await prisma.store.findUnique({
    where: { shop: shopDomain },
  });
  if (!store) throw new Error("Store not found");

  const history = await prisma.priceHistory.findMany({
    where: { storeId: store.id },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  return history.map((row) => {
    const rationale = parseRationaleJson(row.rationaleJson);
    const demandScore =
      typeof rationale.demandScore === "number" ? rationale.demandScore : 58;
    const demandTrend =
      typeof rationale.demandTrend === "string" ? rationale.demandTrend : "stable";
    const demandSignals = Array.isArray(rationale.demandSignals)
      ? rationale.demandSignals
      : [
          `Sales velocity score is ${demandScore}/100.`,
          `Demand trend is ${demandTrend}.`,
          "Use margin guardrails before approving pricing changes.",
        ];
    const competitorPressure =
      typeof rationale.competitorPressure === "string"
        ? rationale.competitorPressure
        : "medium";
    const automationPosture = deriveAutomationPosture(
      row.expectedProfitGain ?? 0,
      row.expectedMarginDelta
    );

    return {
      ...row,
      demandScore,
      demandTrend,
      demandSignals,
      competitorPressure,
      automationPosture,
      approvalConfidence: Math.max(
        52,
        Math.min(
          95,
          Math.round(
            58 +
              Math.min(18, demandScore / 4) +
              Math.min(12, (row.expectedProfitGain ?? 0) / 20)
          )
        )
      ),
      autoApprovalCandidate:
        automationPosture === "Eligible for approval-led auto-publish",
    };
  });
}

export async function simulatePricingChange(params: {
  currentPrice: number;
  recommendedPrice: number;
  salesVelocity: number;
  margin: number;
}) {
  const { currentPrice, recommendedPrice, salesVelocity, margin } = params;
  const priceDelta = recommendedPrice - currentPrice;
  const expectedMarginImprovement =
    margin === 0 ? 0 : (priceDelta / currentPrice) * margin;

  const projectedMonthlyProfitGain =
    priceDelta * salesVelocity * 30 * (margin / 100);

  const demandScore = Math.max(
    0,
    Math.min(
      100,
      Math.round(salesVelocity * 4 + Math.max(0, 22 - Math.abs(priceDelta) * 3))
    )
  );

  return {
    currentPrice,
    recommendedPrice,
    expectedMarginImprovement,
    projectedMonthlyProfitGain,
    demandScore,
    demandTrend:
      demandScore >= 72 ? "strong" : demandScore >= 50 ? "stable" : "softening",
    automationPosture: deriveAutomationPosture(
      projectedMonthlyProfitGain,
      expectedMarginImprovement
    ),
    actionQueue:
      projectedMonthlyProfitGain >= 200
        ? "High priority review"
        : projectedMonthlyProfitGain >= 80
        ? "Standard approval queue"
        : "Advisory simulation only",
  };
}

export async function approvePricingRecommendation(
  shopDomain: string,
  recommendationId: string
) {
  const store = await prisma.store.findUnique({
    where: { shop: shopDomain },
  });
  if (!store) throw new Error("Store not found");

  const recommendation = await prisma.priceHistory.findFirst({
    where: {
      id: recommendationId,
      storeId: store.id,
    },
  });
  if (!recommendation) {
    throw new Error("Pricing recommendation not found");
  }

  const rationale = parseRationaleJson(recommendation.rationaleJson);
  const automationPosture = deriveAutomationPosture(
    recommendation.expectedProfitGain ?? 0,
    recommendation.expectedMarginDelta
  );

  const shopifyPublishResult = await publishProductPrice(
    shopDomain,
    recommendation.productHandle,
    recommendation.recommendedPrice
  );

  const updated = await prisma.priceHistory.update({
    where: { id: recommendation.id },
    data: {
      rationaleJson: JSON.stringify({
        ...rationale,
        status: "approved",
        approvedAt: new Date().toISOString(),
        publishedToShopify: shopifyPublishResult.updated,
        shopifyPublishReason:
          shopifyPublishResult.updated ? null : shopifyPublishResult.reason,
        automationPosture,
      }),
    },
  });

  return {
    ...updated,
    shopifyPublishResult,
    automationPosture,
  };
}

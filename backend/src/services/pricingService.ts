import { prisma } from "../db/prismaClient";

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
    return "Strong candidate for merchant review";
  }
  if (expectedProfitGain >= 100) {
    return "Merchant review recommended";
  }
  return "Baseline estimate only";
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
      typeof rationale.demandScore === "number" ? rationale.demandScore : null;
    const demandTrend =
      typeof rationale.demandTrend === "string"
        ? rationale.demandTrend
        : "insufficient history";
    const demandSignals = Array.isArray(rationale.demandSignals)
      ? rationale.demandSignals
      : [
          "This recommendation is currently a baseline estimate built from synced catalog pricing and merchant pricing settings.",
          "Product-level demand history is still limited, so margin impact should be reviewed manually.",
          "Use merchant approval before publishing price changes to Shopify.",
        ];
    const competitorPressure =
      typeof rationale.competitorPressure === "string"
        ? rationale.competitorPressure
        : "not_available";
    const automationPosture = deriveAutomationPosture(
      row.expectedProfitGain ?? 0,
      row.expectedMarginDelta
    );
    const evidenceSignals = Array.isArray(rationale.evidenceSignals)
      ? rationale.evidenceSignals.filter(
          (item): item is string => typeof item === "string" && item.trim().length > 0
        )
      : [];
    const evidenceCount = Math.max(1, evidenceSignals.length);

    return {
      ...row,
      demandScore,
      demandTrend,
      demandSignals,
      evidenceSignals,
      competitorPressure,
      automationPosture,
      approvalConfidence: Math.max(
        38,
        Math.min(
          78,
          Math.round(
            34 +
              evidenceCount * 8 +
              Math.min(10, Math.max(0, row.expectedMarginDelta) * 2) +
              Math.min(10, Math.max(0, row.expectedProfitGain ?? 0) / 40)
          )
        )
      ),
      autoApprovalCandidate: false,
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
        ? "High-priority merchant review"
        : projectedMonthlyProfitGain >= 80
        ? "Standard merchant review"
        : "Baseline simulation only",
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

  const updated = await prisma.priceHistory.update({
    where: { id: recommendation.id },
    data: {
      rationaleJson: JSON.stringify({
        ...rationale,
        status: "approved",
        approvedAt: new Date().toISOString(),
        publishedToShopify: false,
        shopifyPublishReason:
          "Direct Shopify product writes are disabled in the current approval-safe configuration.",
        automationPosture,
      }),
    },
  });

  return {
    ...updated,
    shopifyPublishResult: {
      updated: false,
      reason:
        "Direct Shopify price publishing is disabled. Review and apply product price changes manually in Shopify Admin if needed.",
    },
    automationPosture,
  };
}

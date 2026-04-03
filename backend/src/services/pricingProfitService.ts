import { getCompetitorResponseEngine } from "./competitorService";
import { getPricingRecommendations, simulatePricingChange } from "./pricingService";
import { getProfitOpportunities } from "./profitService";
import { getCurrentSubscription } from "./subscriptionService";

async function safelyResolve<T>(work: Promise<T>, fallback: T) {
  try {
    return await work;
  } catch {
    return fallback;
  }
}

export async function getPricingProfitOverview(shopDomain: string) {
  const subscription = await getCurrentSubscription(shopDomain);

  const [pricingRecommendations, competitorResponse] = await Promise.all([
    safelyResolve(getPricingRecommendations(shopDomain), []),
    safelyResolve(getCompetitorResponseEngine(shopDomain), {
      summary: {
        responseMode: "Monitor",
        topPressureCount: 0,
        automationReadiness: "Advisory mode",
      },
      responsePlans: [],
    }),
  ]);

  const canUseFullProfitEngine = subscription.featureAccess.fullProfitEngine;
  const profitOpportunities = canUseFullProfitEngine
    ? await getProfitOpportunities(shopDomain).catch(() => [])
    : [];

  const recommendationCount = pricingRecommendations.length;
  const profitOpportunityCount = profitOpportunities.length;
  const topRecommendation = pricingRecommendations[0] ?? null;
  const topProfitOpportunity = profitOpportunities[0] ?? null;

  const scenarioPreset = topRecommendation
    ? await safelyResolve(
        simulatePricingChange({
          currentPrice: topRecommendation.currentPrice,
          recommendedPrice: topRecommendation.recommendedPrice,
          salesVelocity:
            typeof topRecommendation.demandScore === "number"
              ? Math.max(1, topRecommendation.demandScore / 20)
              : 3,
          margin: Math.max(10, topRecommendation.expectedMarginDelta + 20),
        }),
        null
      )
    : null;

  const dailyActionBoard = [
    {
      id: "review-top-pricing-recommendation",
      title: topRecommendation
        ? `Review pricing recommendation for ${topRecommendation.productHandle}`
        : "Seed pricing history to unlock AI recommendations",
      detail: topRecommendation
        ? topRecommendation.demandSignals[0]
        : "Pricing recommendations appear once order, market, and cost signals accumulate.",
      actionType: topRecommendation ? "review" : "setup",
    },
    {
      id: "respond-to-market-pressure",
      title:
        competitorResponse.summary.responseMode === "Hold and monitor"
          ? "Monitor competitor pressure"
          : "Respond to competitor pressure",
      detail: competitorResponse.responsePlans[0]?.rationale ??
        "Competitor moves will drive the next pricing and profit actions.",
      actionType: "market",
    },
    {
      id: "protect-margin",
      title: canUseFullProfitEngine
        ? "Review margin-at-risk opportunities"
        : "Upgrade to Pro for full profit leak detection",
      detail: canUseFullProfitEngine
        ? `${profitOpportunityCount} profit opportunity items are ready.`
        : "Growth includes pricing intelligence, while Pro unlocks the full profit engine.",
      actionType: canUseFullProfitEngine ? "profit" : "upgrade",
    },
  ];

  return {
    subscription,
    summary: {
      recommendationCount,
      profitOpportunityCount,
      responseMode: competitorResponse.summary.responseMode,
      automationReadiness:
        topRecommendation?.automationPosture ?? "Advisory only",
      fullProfitEngine: canUseFullProfitEngine,
    },
    pricingRecommendations: pricingRecommendations.slice(0, 8),
    profitOpportunities: profitOpportunities.slice(0, 8),
    dailyActionBoard,
    scenarioPreset,
    marginAtRisk: {
      pressureProducts: competitorResponse.responsePlans
        .filter((plan) => plan.pressureScore >= 30)
        .slice(0, 5),
      projectedMonthlyGain:
        topProfitOpportunity?.projectedMonthlyProfitGain ??
        topRecommendation?.expectedProfitGain ??
        0,
    },
  };
}

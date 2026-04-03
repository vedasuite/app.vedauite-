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

  const pricingModes = [
    {
      key: "margin-first",
      label: "Margin-first",
      description:
        "Protect contribution margin and approve only the strongest price changes.",
      recommended:
        subscription.planName === "PRO" &&
        competitorResponse.summary.responseMode === "Defend margin",
    },
    {
      key: "balanced",
      label: "Balanced",
      description:
        "Blend conversion support with controlled margin protection across the catalog.",
      recommended:
        subscription.planName === "TRIAL" ||
        subscription.planName === "GROWTH" ||
        competitorResponse.summary.responseMode === "Hold and monitor",
    },
    {
      key: "growth-first",
      label: "Growth-first",
      description:
        "Use selective market response on exposed SKUs when share capture matters more than short-term margin.",
      recommended:
        competitorResponse.summary.responseMode === "Respond selectively",
    },
  ];

  const doNothingRecommendation =
    recommendationCount === 0
      ? {
          headline: "Do nothing right now",
          rationale:
            "There is not enough aligned pricing, market, and cost pressure to justify a change today.",
        }
      : topRecommendation &&
        Math.abs(topRecommendation.recommendedPrice - topRecommendation.currentPrice) < 1
      ? {
          headline: "Do nothing on low-delta SKUs",
          rationale:
            "Some products are close enough to target price that reacting now would add noise without meaningful profit lift.",
        }
      : null;

  const profitLeakSummary = [
    {
      title: "Discount leakage",
      detail:
        recommendationCount > 0
          ? `${recommendationCount} pricing recommendations suggest preventable margin leakage from reactive discounting.`
          : "No major discount leakage is visible yet.",
    },
    {
      title: "Return-linked margin pressure",
      detail:
        profitOpportunityCount > 0
          ? `${profitOpportunityCount} products show enough margin pressure to review returns, promotions, and unit economics together.`
          : "Return-linked margin pressure is still below the action threshold.",
    },
    {
      title: "Competitor pressure",
      detail:
        competitorResponse.summary.topPressureCount > 0
          ? `${competitorResponse.summary.topPressureCount} SKUs are exposed to market pressure and may need a strategy response.`
          : "Competitor pressure is currently modest across tracked SKUs.",
    },
  ];

  const scenarioPlaybook = [
    {
      scenario: "Hold price",
      outcome:
        competitorResponse.summary.responseMode === "Hold and monitor"
          ? "Recommended when pressure is low and margins should be protected."
          : "Use when the market normalizes after a temporary competitor move.",
    },
    {
      scenario: "Selective match",
      outcome:
        competitorResponse.summary.responseMode === "Respond selectively"
          ? "Recommended on exposed hero SKUs with concentrated price pressure."
          : "Reserve for SKUs where the competitor signal stack becomes more intense.",
    },
    {
      scenario: "Bundle defense",
      outcome:
        competitorResponse.summary.responseMode === "Defend margin"
          ? "Recommended when promotions spike and broad discounting would erode profit."
          : "Best used when promotion clusters increase and the merchant wants to avoid price wars.",
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
    pricingModes,
    doNothingRecommendation,
    profitLeakSummary,
    scenarioPlaybook,
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

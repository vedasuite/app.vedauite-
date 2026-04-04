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

async function safelyResolveWithTimeout<T>(
  work: Promise<T>,
  fallback: T,
  timeoutMs = 8000
) {
  return safelyResolve(
    Promise.race<T>([
      work,
      new Promise<T>((_, reject) => {
        setTimeout(() => reject(new Error("Timed out")), timeoutMs);
      }),
    ]),
    fallback
  );
}

export async function getPricingProfitOverview(shopDomain: string) {
  const subscription = await safelyResolveWithTimeout(
    getCurrentSubscription(shopDomain),
    {
      planName: "TRIAL",
      price: 0,
      trialDays: 3,
      starterModule: null,
      active: true,
      endsAt: null,
      trialStartedAt: null,
      trialEndsAt: null,
      status: "trial_active",
      billingStatus: null,
      starterModuleSwitchAvailableAt: null,
      enabledModules: {
        trustAbuse: true,
        competitor: true,
        pricingProfit: true,
        reports: true,
        settings: true,
        fraud: true,
        pricing: true,
        creditScore: true,
        profitOptimization: true,
      },
      featureAccess: {
        shopperTrustScore: true,
        returnAbuseIntelligence: true,
        fraudReviewQueue: true,
        supportCopilot: true,
        evidencePackExport: true,
        competitorMoveFeed: true,
        competitorStrategyDetection: true,
        weeklyCompetitorReports: true,
        pricingRecommendations: true,
        explainableRecommendations: true,
        scenarioSimulator: true,
        profitLeakDetector: true,
        marginAtRisk: true,
        dailyActionBoard: true,
        advancedAutomation: true,
        fullProfitEngine: true,
      },
      capabilities: {
        "module.trustAbuse": true,
        "module.competitorIntel": true,
        "module.pricingProfit": true,
        "reports.view": true,
        "reports.export": true,
        "settings.view": true,
        "settings.manage": true,
        "trust.score": true,
        "trust.timeline": true,
        "trust.returnAbuse": true,
        "trust.refundOutcomeSimulator": true,
        "trust.smartPolicyEngine": true,
        "trust.trustRecoveryEngine": true,
        "trust.supportCopilot": true,
        "trust.evidencePackExport": true,
        "trust.advancedAutomation": true,
        "competitor.moveFeed": true,
        "competitor.impactScore": true,
        "competitor.actionSuggestions": true,
        "competitor.strategyDetection": true,
        "competitor.weeklyReports": true,
        "competitor.advancedReports": true,
        "pricing.basicRecommendations": true,
        "pricing.explainableRecommendations": true,
        "pricing.advancedModes": true,
        "pricing.doNothingRecommendation": true,
        "pricing.profitLeakDetector": true,
        "pricing.dailyActionBoard": true,
        "pricing.scenarioSimulator": true,
        "pricing.marginAtRisk": true,
        "pricing.advancedAutomation": true,
        "billing.moduleSelectionStarter": false,
        "billing.planManagement": true,
        "billing.upgrade": true,
        "billing.downgrade": true,
        "billing.trialActive": true,
      },
    },
    5000
  );

  const [pricingRecommendations, competitorResponse] = await Promise.all([
    safelyResolveWithTimeout(getPricingRecommendations(shopDomain), [], 7000),
    safelyResolveWithTimeout(getCompetitorResponseEngine(shopDomain), {
      summary: {
        responseMode: "Monitor",
        topPressureCount: 0,
        automationReadiness: "Advisory mode",
      },
      responsePlans: [],
    }, 7000),
  ]);

  const canUseFullProfitEngine = subscription.featureAccess.fullProfitEngine;
  const canUseAdvancedModes = subscription.capabilities["pricing.advancedModes"];
  const canUseScenarioSimulator =
    subscription.capabilities["pricing.scenarioSimulator"];
  const canUseDailyActionBoard =
    subscription.capabilities["pricing.dailyActionBoard"];
  const canUseMarginAtRisk = subscription.capabilities["pricing.marginAtRisk"];
  const canUseProfitLeakDetector =
    subscription.capabilities["pricing.profitLeakDetector"];
  const canUseExplainablePricing =
    subscription.capabilities["pricing.explainableRecommendations"];
  const profitOpportunities = canUseFullProfitEngine
    ? await safelyResolveWithTimeout(getProfitOpportunities(shopDomain), [], 7000)
    : [];

  const recommendationCount = pricingRecommendations.length;
  const profitOpportunityCount = profitOpportunities.length;
  const topRecommendation = pricingRecommendations[0] ?? null;
  const topProfitOpportunity = profitOpportunities[0] ?? null;

  const scenarioPreset = topRecommendation
    ? await safelyResolveWithTimeout(
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
      priority: topRecommendation ? "High" : "Medium",
      expectedImpact: topRecommendation?.expectedProfitGain
        ? `Potential monthly gain of $${Math.round(topRecommendation.expectedProfitGain)}`
        : "Unlock the first pricing queue",
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
      priority:
        competitorResponse.summary.responseMode === "Hold and monitor"
          ? "Medium"
          : "High",
      expectedImpact:
        competitorResponse.summary.topPressureCount > 0
          ? `${competitorResponse.summary.topPressureCount} exposed SKU clusters`
          : "Market is currently stable",
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
      priority: canUseFullProfitEngine ? "High" : "Low",
      expectedImpact: canUseFullProfitEngine
        ? `Projected gain $${Math.round(
            topProfitOpportunity?.projectedMonthlyProfitGain ??
              topRecommendation?.expectedProfitGain ??
              0
          )}`
        : "Unlock advanced margin protection",
    },
  ];

  const pricingModes = [
    {
      key: "maximize-profit",
      label: "Maximize profit",
      description:
        "Protect contribution margin and approve only the strongest price changes.",
      available: canUseAdvancedModes,
      recommended:
        canUseAdvancedModes &&
        competitorResponse.summary.responseMode === "Defend margin",
      gate: canUseAdvancedModes ? "Included" : "Pro",
    },
    {
      key: "balanced",
      label: "Balanced",
      description:
        "Blend conversion support with controlled margin protection across the catalog.",
      available: true,
      recommended:
        subscription.capabilities["pricing.basicRecommendations"] ||
        competitorResponse.summary.responseMode === "Hold and monitor",
      gate: "Included",
    },
    {
      key: "maximize-sales",
      label: "Maximize sales",
      description:
        "Lean into conversion support when demand expansion matters more than short-term margin.",
      available: canUseAdvancedModes,
      recommended:
        competitorResponse.summary.responseMode === "Respond selectively",
      gate: canUseAdvancedModes ? "Included" : "Pro",
    },
    {
      key: "defend-market-share",
      label: "Defend market share",
      description:
        "Use targeted pricing responses on exposed SKUs while preserving margin guardrails.",
      available: canUseAdvancedModes,
      recommended:
        competitorResponse.summary.responseMode === "Respond selectively" &&
        competitorResponse.summary.topPressureCount >= 2,
      gate: canUseAdvancedModes ? "Included" : "Pro",
    },
    {
      key: "clear-inventory",
      label: "Clear inventory",
      description:
        "Bias toward sell-through on slower SKUs with inventory drag or promo pressure.",
      available: canUseAdvancedModes,
      recommended: canUseAdvancedModes && profitOpportunityCount === 0,
      gate: canUseAdvancedModes ? "Included" : "Pro",
    },
    {
      key: "premium-positioning",
      label: "Premium positioning",
      description:
        "Hold price and emphasize value when competitor pressure is low and margin matters most.",
      available: canUseAdvancedModes,
      recommended:
        canUseAdvancedModes &&
        competitorResponse.summary.responseMode === "Hold and monitor",
      gate: canUseAdvancedModes ? "Included" : "Pro",
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
      severity:
        recommendationCount >= 6 ? "High" : recommendationCount >= 2 ? "Medium" : "Low",
      action:
        recommendationCount > 0
          ? "Review approval-led pricing actions"
          : "Keep monitoring current pricing posture",
    },
    {
      title: "Return-linked margin pressure",
      detail:
        profitOpportunityCount > 0
          ? `${profitOpportunityCount} products show enough margin pressure to review returns, promotions, and unit economics together.`
          : "Return-linked margin pressure is still below the action threshold.",
      severity:
        profitOpportunityCount >= 4 ? "High" : profitOpportunityCount >= 1 ? "Medium" : "Low",
      action: canUseFullProfitEngine
        ? "Open profit opportunity queue"
        : "Upgrade to Pro for profit leak detection",
    },
    {
      title: "Competitor pressure",
      detail:
        competitorResponse.summary.topPressureCount > 0
          ? `${competitorResponse.summary.topPressureCount} SKUs are exposed to market pressure and may need a strategy response.`
          : "Competitor pressure is currently modest across tracked SKUs.",
      severity:
        competitorResponse.summary.topPressureCount >= 4
          ? "High"
          : competitorResponse.summary.topPressureCount >= 1
          ? "Medium"
          : "Low",
      action:
        competitorResponse.summary.topPressureCount > 0
          ? "Coordinate pricing and response strategy"
          : "No immediate repricing required",
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

  const explainabilityHighlights = pricingRecommendations.slice(0, 4).map((item) => ({
    id: item.id,
    productHandle: item.productHandle,
    recommendation:
      item.recommendedPrice > item.currentPrice ? "Increase price" : "Reduce price",
    why:
      item.demandSignals[0] ??
      "Recommendation is based on margin, demand, and market posture.",
    factors: [
      `Demand posture: ${item.demandTrend} (${item.demandScore}/100)`,
      `Competitor pressure: ${item.competitorPressure}`,
      `Margin delta: ${item.expectedMarginDelta.toFixed(1)}%`,
    ],
    guardrail:
      item.autoApprovalCandidate
        ? "High-confidence candidate for merchant approval."
        : "Merchant review recommended before publishing.",
  }));

  const simulatorSnapshots = topRecommendation
    ? await Promise.all(
        [
          {
            id: "hold",
            title: "Do nothing",
            recommendedPrice: topRecommendation.currentPrice,
            summary:
              "Keep the current price and avoid reacting until pressure becomes stronger.",
          },
          {
            id: "match",
            title: "Selective response",
            recommendedPrice: topRecommendation.recommendedPrice,
            summary:
              "Follow the current recommendation on exposed SKUs only.",
          },
          {
            id: "lift",
            title: "Margin defense",
            recommendedPrice: Number((topRecommendation.currentPrice + 2).toFixed(2)),
            summary:
              "Protect margin by holding or slightly increasing price where demand remains durable.",
          },
        ].map(async (scenario) => {
          const result = await safelyResolveWithTimeout(
            simulatePricingChange({
              currentPrice: topRecommendation.currentPrice,
              recommendedPrice: scenario.recommendedPrice,
              salesVelocity:
                typeof topRecommendation.demandScore === "number"
                  ? Math.max(1, topRecommendation.demandScore / 20)
                  : 3,
              margin: Math.max(10, topRecommendation.expectedMarginDelta + 20),
            }),
            null,
            5000
          );

          return {
            ...scenario,
            projectedMonthlyProfitGain:
              result?.projectedMonthlyProfitGain ?? 0,
            expectedMarginImprovement:
              result?.expectedMarginImprovement ?? 0,
            actionQueue: result?.actionQueue ?? "Advisory simulation only",
          };
        })
      )
    : [];

  const marginRiskDrivers = [
    {
      title: "Competitor pricing pressure",
      detail:
        competitorResponse.summary.topPressureCount > 0
          ? `${competitorResponse.summary.topPressureCount} competitor-driven pressure clusters need watching.`
          : "Competitor pressure is currently low.",
      severity:
        competitorResponse.summary.topPressureCount >= 4
          ? "High"
          : competitorResponse.summary.topPressureCount >= 1
          ? "Medium"
          : "Low",
    },
    {
      title: "Promotion exposure",
      detail:
        competitorResponse.responsePlans[0]?.promotionSignals
          ? `${competitorResponse.responsePlans[0].promotionSignals} promotion signals are influencing the response posture.`
          : "Promotion exposure is not yet significant.",
      severity:
        (competitorResponse.responsePlans[0]?.promotionSignals ?? 0) >= 3
          ? "High"
          : (competitorResponse.responsePlans[0]?.promotionSignals ?? 0) >= 1
          ? "Medium"
          : "Low",
    },
    {
      title: "Profit leakage",
      detail:
        canUseProfitLeakDetector && profitOpportunityCount > 0
          ? `${profitOpportunityCount} products are already showing measurable profit leakage.`
          : "Profit leakage detection will strengthen as more unit economics data lands.",
      severity:
        profitOpportunityCount >= 4 ? "High" : profitOpportunityCount >= 1 ? "Medium" : "Low",
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
      advancedModesEnabled: canUseAdvancedModes,
      scenarioSimulatorEnabled: canUseScenarioSimulator,
      marginAtRiskEnabled: canUseMarginAtRisk,
      profitLeakDetectorEnabled: canUseProfitLeakDetector,
      explainableRecommendationsEnabled: canUseExplainablePricing,
    },
    pricingRecommendations: pricingRecommendations.slice(0, 8),
    profitOpportunities: profitOpportunities.slice(0, 8),
    dailyActionBoard,
    pricingModes,
    doNothingRecommendation,
    profitLeakSummary,
    scenarioPlaybook,
    explainabilityHighlights,
    simulatorSnapshots,
    marginRiskDrivers,
    scenarioPreset,
    marginAtRisk: {
      pressureProducts: competitorResponse.responsePlans
        .filter((plan) => plan.pressureScore >= 30)
        .slice(0, 5),
      projectedMonthlyGain:
        topProfitOpportunity?.projectedMonthlyProfitGain ??
        topRecommendation?.expectedProfitGain ??
        0,
      summary:
        competitorResponse.summary.topPressureCount > 0
          ? "Margin is under pressure from competitor movement and promotion activity."
          : "Margin posture is currently stable.",
    },
  };
}

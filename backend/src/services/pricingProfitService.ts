import { prisma } from "../db/prismaClient";
import { getCompetitorResponseEngine } from "./competitorService";
import { getPricingRecommendations, simulatePricingChange } from "./pricingService";
import { getProfitOpportunities } from "./profitService";
import { getCurrentSubscription } from "./subscriptionService";
import {
  deriveModuleReadiness,
  deriveSyncStatus,
  getStoreOperationalSnapshot,
} from "./storeOperationalStateService";
import {
  createUnifiedModuleState,
  isStaleTimestamp,
  toIsoString,
} from "./unifiedModuleStateService";

type PricingPrimaryState =
  | "SETUP_INCOMPLETE"
  | "PARTIAL_READINESS"
  | "READY"
  | "EMPTY_HEALTHY"
  | "PROCESSING"
  | "FAILED";

function deriveRecommendationAction(currentPrice: number, recommendedPrice: number) {
  const delta = recommendedPrice - currentPrice;
  if (Math.abs(delta) < 0.5) return "Hold price";
  if (delta > 0) return "Increase price";
  if (delta < 0) return "Reduce price";
  return "Needs review";
}

function derivePricingConfidence(args: {
  approvalConfidence: number;
  competitorReady: boolean;
  profitReady: boolean;
}) {
  if (!args.competitorReady || !args.profitReady) {
    return "Baseline estimate";
  }
  if (args.approvalConfidence >= 70) return "High";
  if (args.approvalConfidence >= 52) return "Medium";
  return "Baseline estimate";
}

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
  const [store, operational] = await Promise.all([
    prisma.store.findUnique({
      where: { shop: shopDomain },
      select: { id: true },
    }),
    getStoreOperationalSnapshot(shopDomain),
  ]);
  if (!store) {
    throw new Error("Store not found");
  }

  const subscription = await getCurrentSubscription(shopDomain);
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
  const readiness = deriveModuleReadiness({
    syncStatus: syncState.status,
    rawCount: operational.counts.products + operational.counts.orders,
    processedCount: operational.counts.pricingRows + operational.counts.profitRows,
    lastUpdatedAt: operational.latestProcessingAt,
    failureReason: operational.store.lastConnectionError,
  });

  const [pricingRecommendations, competitorResponse] = await Promise.all([
    safelyResolveWithTimeout(getPricingRecommendations(shopDomain), [], 7000),
    safelyResolveWithTimeout(
      getCompetitorResponseEngine(shopDomain),
      {
        summary: {
          responseMode: "Awaiting monitored competitor data",
          topPressureCount: 0,
          automationReadiness:
            "Competitor response guidance appears after monitored domains are configured and live observations are collected.",
        },
        responsePlans: [],
      },
      7000
    ),
  ]);
  const competitorDependencyStatus =
    operational.counts.competitorRows > 0 ? "ready" : "missing";
  const pricingDependencyStatus =
    operational.counts.pricingRows + operational.counts.profitRows > 0
      ? "ready"
      : "missing";
  const fraudDependencyStatus =
    operational.counts.timelineEvents > 0 ? "ready" : "missing";

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
        : "Run live sync to unlock pricing recommendations",
      detail: topRecommendation
        ? topRecommendation.demandSignals[0]
        : "VedaSuite needs synced order, catalog, and pricing records before it can publish data-backed pricing actions.",
      actionType: topRecommendation ? "review" : "setup",
      priority: topRecommendation ? "High" : "Medium",
      expectedImpact: topRecommendation?.expectedProfitGain
        ? `Potential monthly gain of $${Math.round(topRecommendation.expectedProfitGain)}`
        : "Generate the first baseline pricing set",
    },
    {
      id: "respond-to-market-pressure",
      title:
        competitorResponse.summary.responseMode === "Hold and monitor"
          ? "Monitor competitor pressure"
          : "Review competitor pressure",
      detail:
        competitorResponse.responsePlans[0]?.rationale ??
        "Competitor response suggestions will become available once monitored domains are configured and ingested.",
      actionType: "market",
      priority:
        competitorResponse.summary.responseMode === "Hold and monitor"
          ? "Medium"
          : "High",
      expectedImpact:
        competitorResponse.summary.topPressureCount > 0
          ? `${competitorResponse.summary.topPressureCount} exposed SKU clusters`
          : "No concentrated market pressure yet",
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
        : "Unlock advanced margin analysis",
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
      recommended: false,
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
          headline: "No recommendation yet",
          rationale:
            "VedaSuite needs more synced pricing and margin data before it can justify a no-change recommendation.",
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
          : "No pricing recommendations are available yet because synced pricing history is still limited.",
      severity:
        recommendationCount >= 6 ? "High" : recommendationCount >= 2 ? "Medium" : "Low",
      action:
        recommendationCount > 0
          ? "Review approval-led pricing actions"
          : "Run live sync before reviewing pricing posture",
    },
    {
      title: "Return-linked margin pressure",
      detail:
        canUseProfitLeakDetector && profitOpportunityCount > 0
          ? `${profitOpportunityCount} products show enough margin pressure to review returns, promotions, and unit economics together.`
          : "Profit leak detection needs more synced product economics before it can surface issues.",
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
          : "No live competitor pressure has been detected yet.",
      severity:
        competitorResponse.summary.topPressureCount >= 4
          ? "High"
          : competitorResponse.summary.topPressureCount >= 1
          ? "Medium"
          : "Low",
      action:
        competitorResponse.summary.topPressureCount > 0
          ? "Coordinate pricing and response strategy"
          : "Add competitor domains or continue monitoring",
    },
  ];

  const scenarioPlaybook = [
    {
      scenario: "Hold price",
      outcome:
        competitorResponse.summary.responseMode === "Hold and monitor"
          ? "Recommended when live market pressure is low and margins should be protected."
          : "Use when the market normalizes after a temporary competitor move.",
    },
    {
      scenario: "Selective match",
      outcome:
        competitorResponse.summary.responseMode === "Respond selectively"
          ? "Recommended on exposed hero SKUs with concentrated live price pressure."
          : "Reserve for SKUs where competitor price pressure becomes more concentrated.",
    },
    {
      scenario: "Bundle defense",
      outcome:
        competitorResponse.summary.topPressureCount > 0
          ? "Use when live promotion pressure rises and broad discounting would erode profit."
          : "Keep in reserve until competitor promotions begin clustering on important SKUs.",
    },
  ];

  const explainabilityHighlights = pricingRecommendations.slice(0, 4).map((item) => ({
    id: item.id,
    productHandle: item.productHandle,
    recommendation:
      item.recommendedPrice > item.currentPrice ? "Increase price" : "Reduce price",
    why:
      item.demandSignals[0] ??
      "Recommendation is based on synced pricing records, order history, and current margin posture.",
    factors: [
      typeof item.demandScore === "number"
        ? `Demand posture: ${item.demandTrend} (${item.demandScore}/100)`
        : `Demand posture: ${item.demandTrend}`,
      `Competitor pressure: ${item.competitorPressure}`,
      `Margin delta: ${item.expectedMarginDelta.toFixed(1)}%`,
    ],
    guardrail:
      item.autoApprovalCandidate
        ? "Strong candidate for merchant review."
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
              "Protect margin by holding or slightly increasing price where live demand and competitor pressure appear limited.",
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
            actionQueue:
              result?.actionQueue ??
              "Baseline simulation only. Review with live cost and demand data before acting.",
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
          : "No live competitor pricing pressure has been detected yet.",
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
          : "No live competitor promotion cluster is active yet.",
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
          : "Profit leakage detection will improve after more unit economics data syncs in.",
      severity:
        profitOpportunityCount >= 4 ? "High" : profitOpportunityCount >= 1 ? "Medium" : "Low",
    },
  ];

  const lastSuccessfulSyncAt = toIsoString(
    operational.latestProcessingAt ?? operational.store.lastSyncAt
  );
  const lastAttemptAt = toIsoString(
    operational.latestSyncJob?.finishedAt ?? operational.latestSyncJob?.startedAt
  );
  const hasPricingData =
    recommendationCount > 0 || profitOpportunityCount > 0 || operational.counts.pricingRows > 0;
  const moduleState =
    syncState.status === "SYNC_IN_PROGRESS"
      ? createUnifiedModuleState({
          setupStatus: "complete",
          syncStatus: "running",
          dataStatus: "processing",
          lastSuccessfulSyncAt,
          lastAttemptAt,
          coverage: hasPricingData ? "partial" : "none",
          dependencies: {
            competitor: competitorDependencyStatus,
            pricing: pricingDependencyStatus,
            fraud: fraudDependencyStatus,
          },
          title: "Pricing data is still being processed",
          description:
            "VedaSuite is updating pricing recommendations and profitability data in the background.",
          nextAction: "Wait for processing to finish",
        })
      : syncState.status === "FAILED" || readiness.readinessState === "FAILED"
      ? createUnifiedModuleState({
          setupStatus: "complete",
          syncStatus: "failed",
          dataStatus: "failed",
          lastSuccessfulSyncAt,
          lastAttemptAt,
          coverage: hasPricingData ? "partial" : "none",
          dependencies: {
            competitor: competitorDependencyStatus,
            pricing: pricingDependencyStatus,
            fraud: fraudDependencyStatus,
          },
          title: "Pricing data needs attention",
          description:
            readiness.reason ??
            "VedaSuite could not complete the latest pricing refresh.",
          nextAction: "Retry sync",
        })
      : isStaleTimestamp(operational.latestProcessingAt ?? operational.store.lastSyncAt)
      ? createUnifiedModuleState({
          setupStatus: "complete",
          syncStatus: "completed",
          dataStatus: "stale",
          lastSuccessfulSyncAt,
          lastAttemptAt,
          dataChanged: hasPricingData,
          coverage: hasPricingData ? "partial" : "none",
          dependencies: {
            competitor: competitorDependencyStatus,
            pricing: pricingDependencyStatus,
            fraud: fraudDependencyStatus,
          },
          title: "Pricing data is out of date",
          description:
            "The latest pricing refresh is older than 24 hours. Run a new sync to review current recommendations.",
          nextAction: "Refresh pricing data",
        })
      : !hasPricingData && syncState.status === "EMPTY_STORE_DATA"
      ? createUnifiedModuleState({
          setupStatus: "complete",
          syncStatus: "completed",
          dataStatus: "empty",
          lastSuccessfulSyncAt,
          lastAttemptAt,
          coverage: "none",
          dependencies: {
            competitor: competitorDependencyStatus,
            pricing: pricingDependencyStatus,
            fraud: fraudDependencyStatus,
          },
          title: "Pricing is ready, but no opportunities were found yet",
          description:
            "VedaSuite is working normally, but the latest refresh did not surface pricing opportunities from the current store data.",
          nextAction: "Sync again after more store activity",
        })
      : hasPricingData && competitorDependencyStatus === "missing"
      ? createUnifiedModuleState({
          setupStatus: "complete",
          syncStatus: "completed",
          dataStatus: "partial",
          lastSuccessfulSyncAt,
          lastAttemptAt,
          dataChanged: true,
          coverage: "partial",
          dependencies: {
            competitor: competitorDependencyStatus,
            pricing: pricingDependencyStatus,
            fraud: fraudDependencyStatus,
          },
          title: "Pricing insights are available. Competitor data is still being processed.",
          description:
            "You can review pricing recommendations now while VedaSuite continues preparing competitor-based comparisons.",
          nextAction: "Review pricing insights",
        })
      : hasPricingData
      ? createUnifiedModuleState({
          setupStatus: "complete",
          syncStatus: "completed",
          dataStatus: "ready",
          lastSuccessfulSyncAt,
          lastAttemptAt,
          dataChanged: true,
          coverage: "full",
          dependencies: {
            competitor: competitorDependencyStatus,
            pricing: pricingDependencyStatus,
            fraud: fraudDependencyStatus,
          },
          title: "Pricing insights are ready",
          description:
            "VedaSuite has prepared pricing recommendations and profit guidance based on the latest store data.",
          nextAction: "Review pricing opportunities",
        })
      : createUnifiedModuleState({
          setupStatus: "incomplete",
          syncStatus: "idle",
          dataStatus: "empty",
          lastSuccessfulSyncAt,
          lastAttemptAt,
          coverage: "none",
          dependencies: {
            competitor: competitorDependencyStatus,
            pricing: pricingDependencyStatus,
            fraud: fraudDependencyStatus,
          },
          title: "Pricing setup is incomplete",
          description:
            "VedaSuite needs synced product, order, and pricing data before it can generate pricing guidance.",
          nextAction: "Run live sync",
        });
  const competitorReady = competitorDependencyStatus === "ready";
  const profitReady = canUseFullProfitEngine && profitOpportunityCount > 0;
  const projectedGainValue =
    topProfitOpportunity?.projectedMonthlyProfitGain ??
    topRecommendation?.expectedProfitGain ??
    0;
  const projectedGainStatus =
    projectedGainValue <= 0
      ? "not_available"
      : profitReady
      ? "available"
      : "estimated_baseline";
  const primaryState: PricingPrimaryState =
    moduleState.dataStatus === "processing"
      ? "PROCESSING"
      : moduleState.dataStatus === "failed"
      ? "FAILED"
      : moduleState.setupStatus === "incomplete"
      ? "SETUP_INCOMPLETE"
      : recommendationCount === 0 && profitOpportunityCount === 0
      ? "EMPTY_HEALTHY"
      : moduleState.dataStatus === "partial"
      ? "PARTIAL_READINESS"
      : "READY";
  const responseMode =
    !competitorReady && !profitReady
      ? "baseline_only"
      : competitorReady && profitReady
      ? "mixed"
      : !competitorReady
      ? "margin_protection"
      : "competitor_informed";
  const prioritizedRecommendations = pricingRecommendations
    .map((item, index) => {
      const actionLabel = deriveRecommendationAction(
        item.currentPrice,
        item.recommendedPrice
      );
      const confidence = derivePricingConfidence({
        approvalConfidence: item.approvalConfidence,
        competitorReady,
        profitReady,
      });
      const inputsUsed = [
        "store baseline",
        item.demandTrend !== "insufficient history" ? "demand posture" : null,
        competitorReady && item.competitorPressure !== "not_available"
          ? "competitor data"
          : null,
        fraudDependencyStatus === "ready" ? "return pressure" : null,
      ].filter((value): value is string => value !== null);
      const expectedImpact =
        item.expectedProfitGain != null && item.expectedProfitGain > 0
          ? projectedGainStatus === "available"
            ? `Projected monthly gain of $${Math.round(item.expectedProfitGain)}`
            : `Baseline estimated gain of $${Math.round(item.expectedProfitGain)}`
          : `Expected margin change of ${item.expectedMarginDelta.toFixed(1)}%`;

      return {
        id: item.id,
        rank: index + 1,
        productHandle: item.productHandle,
        currentPrice: item.currentPrice,
        recommendedPrice: item.recommendedPrice,
        recommendationType: actionLabel,
        expectedImpact,
        confidence,
        confidenceScore: item.approvalConfidence,
        dataBasis: competitorReady ? "competitor-informed" : "store-baseline",
        why:
          item.demandSignals[0] ??
          "Recommendation is based on synced pricing rows and current merchant pricing settings.",
        support:
          item.demandSignals[1] ??
          "Review this recommendation before publishing a price change.",
        inputsUsed,
        merchantActionNote:
          item.autoApprovalCandidate
            ? "Ready for merchant review."
            : "Review before applying in Shopify.",
      };
    })
    .sort((a, b) => b.confidenceScore - a.confidenceScore)
    .slice(0, 8);
  const diagnosticSummary = [
    {
      title: "Demand posture",
      detail:
        topRecommendation?.demandTrend && topRecommendation.demandTrend !== "insufficient history"
          ? `Current top recommendation is reacting to ${topRecommendation.demandTrend} demand conditions.`
          : "Demand history is still limited, so current recommendations lean on baseline store pricing data.",
      status:
        topRecommendation?.demandTrend && topRecommendation.demandTrend !== "insufficient history"
          ? "ready"
          : "partial",
    },
    {
      title: "Competitor pressure",
      detail: competitorReady
        ? competitorResponse.summary.automationReadiness
        : "Competitor-informed pricing is not ready yet. Baseline recommendations are active from store and margin signals.",
      status: competitorReady ? "ready" : "partial",
    },
    {
      title: "Promotion exposure",
      detail:
        competitorResponse.summary.topPressureCount > 0
          ? `${competitorResponse.summary.topPressureCount} SKU groups are under measurable competitor pressure.`
          : "No meaningful promotion or competitor pressure is active right now.",
      status:
        competitorResponse.summary.topPressureCount > 0 ? "ready" : "empty",
    },
    {
      title: "Profit leakage",
      detail: profitReady
        ? `${profitOpportunityCount} products have live profit opportunity analysis available.`
        : "Profit model readiness is still partial, so gain estimates remain directional.",
      status: profitReady ? "ready" : "partial",
    },
  ];
  const planGateSummary = [
    {
      title: "Available now",
      detail: "Baseline pricing recommendations and explainable pricing guidance are active on the current plan.",
    },
    {
      title: "Advanced on Pro",
      detail:
        "Pro unlocks advanced modes, profit leakage workflows, scenario simulation, and deeper margin defense.",
    },
  ];

  return {
    subscription,
    moduleState,
    readiness,
    pricingState: {
      primaryState,
      setupStatus: moduleState.setupStatus === "incomplete" ? "incomplete" : "ready",
      pricingStatus:
        moduleState.dataStatus === "processing"
          ? "processing"
          : moduleState.dataStatus === "failed"
          ? "failed"
          : primaryState === "PARTIAL_READINESS"
          ? "partial"
          : primaryState === "EMPTY_HEALTHY"
          ? "empty"
          : "ready",
      competitorDependency: competitorReady ? "ready" : "missing",
      profitModelStatus: profitReady ? "ready" : canUseFullProfitEngine ? "partial" : "missing",
      recommendationCount,
      prioritizedRecommendationCount: prioritizedRecommendations.length,
      projectedGainStatus,
      projectedGainValue,
      responseMode,
      lastSuccessfulRunAt: lastSuccessfulSyncAt,
      title: moduleState.title,
      description:
        primaryState === "PARTIAL_READINESS"
          ? "Baseline recommendations are active from store, order, and margin signals. Competitor-informed pricing will improve after competitor monitoring completes."
          : primaryState === "READY"
          ? "Recommendations and profit guidance are live from the latest synced store data."
          : primaryState === "EMPTY_HEALTHY"
          ? "The pricing engine ran successfully, but no important pricing changes are recommended right now."
          : moduleState.description,
      nextAction: moduleState.nextAction,
    },
    summary: {
      recommendationCount,
      profitOpportunityCount,
      responseMode:
        responseMode === "baseline_only"
          ? "Baseline recommendations active"
          : responseMode === "competitor_informed"
          ? "Competitor-informed pricing active"
          : responseMode === "margin_protection"
          ? "Margin protection active"
          : "Mixed pricing signals",
      automationReadiness:
        moduleState.dataStatus === "partial"
          ? "Pricing recommendations are ready. Competitor comparisons are still being prepared."
          : topRecommendation?.automationPosture ??
            "Merchant review guidance updates as live pricing and store data sync.",
      fullProfitEngine: canUseFullProfitEngine,
      advancedModesEnabled: canUseAdvancedModes,
      scenarioSimulatorEnabled: canUseScenarioSimulator,
      marginAtRiskEnabled: canUseMarginAtRisk,
      profitLeakDetectorEnabled: canUseProfitLeakDetector,
      explainableRecommendationsEnabled: canUseExplainablePricing,
    },
    pricingRecommendations: pricingRecommendations.slice(0, 8),
    prioritizedRecommendations,
    profitOpportunities: profitOpportunities.slice(0, 8),
    dailyActionBoard,
    pricingModes,
    doNothingRecommendation,
    profitLeakSummary,
    scenarioPlaybook,
    explainabilityHighlights,
    simulatorSnapshots,
    marginRiskDrivers,
    diagnosticSummary,
    planGateSummary,
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
          ? "Margin pressure is being inferred from live competitor movement and current pricing baselines."
          : "No live margin pressure drivers are active yet.",
    },
  };
}

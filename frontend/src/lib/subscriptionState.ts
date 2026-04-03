import type {
  FeatureAccess,
  ModuleAccess,
  StarterModule,
  SubscriptionInfo,
} from "../hooks/useSubscriptionPlan";

function normalizeStarterModule(
  value?: string | null
): StarterModule {
  if (value === "trustAbuse" || value === "competitor") {
    return value;
  }

  if (value === "fraud" || value === "creditScore") {
    return "trustAbuse";
  }

  return null;
}

function buildModuleAccess(
  planName: string,
  starterModule: StarterModule
): ModuleAccess {
  const trustAbuse =
    planName === "TRIAL" ||
    planName === "GROWTH" ||
    planName === "PRO" ||
    (planName === "STARTER" && starterModule === "trustAbuse");
  const competitor =
    planName === "TRIAL" ||
    planName === "GROWTH" ||
    planName === "PRO" ||
    (planName === "STARTER" && starterModule === "competitor");
  const pricingProfit =
    planName === "TRIAL" || planName === "GROWTH" || planName === "PRO";

  return {
    trustAbuse,
    competitor,
    pricingProfit,
    reports: true,
    settings: true,
    fraud: trustAbuse,
    pricing: pricingProfit,
    creditScore: trustAbuse,
    profitOptimization: planName === "TRIAL" || planName === "PRO",
  };
}

function buildFeatureAccess(
  planName: string,
  starterModule: StarterModule
): FeatureAccess {
  const enabledModules = buildModuleAccess(planName, starterModule);
  const isTrial = planName === "TRIAL";
  const isGrowth = planName === "GROWTH";
  const isPro = planName === "PRO";

  return {
    shopperTrustScore: enabledModules.trustAbuse,
    returnAbuseIntelligence: enabledModules.trustAbuse,
    fraudReviewQueue: enabledModules.trustAbuse,
    supportCopilot: isTrial || isGrowth || isPro,
    evidencePackExport: isTrial || isPro,
    competitorMoveFeed: enabledModules.competitor,
    competitorStrategyDetection: isTrial || isGrowth || isPro,
    weeklyCompetitorReports: isTrial || isGrowth || isPro,
    pricingRecommendations: enabledModules.pricingProfit,
    scenarioSimulator: enabledModules.pricingProfit,
    profitLeakDetector: enabledModules.pricingProfit,
    marginAtRisk: enabledModules.pricingProfit,
    dailyActionBoard: enabledModules.pricingProfit,
    advancedAutomation: isTrial || isPro,
    fullProfitEngine: isTrial || isPro,
  };
}

function getPlanPrice(planName: string) {
  switch (planName) {
    case "STARTER":
      return 19;
    case "GROWTH":
      return 49;
    case "PRO":
      return 99;
    default:
      return 0;
  }
}

export const fallbackSubscription: SubscriptionInfo = {
  planName: "TRIAL",
  price: 0,
  trialDays: 3,
  starterModule: null,
  active: false,
  endsAt: null,
  enabledModules: buildModuleAccess("TRIAL", null),
  featureAccess: buildFeatureAccess("TRIAL", null),
};

export function buildOptimisticSubscription(params: {
  planName: string;
  starterModule?: StarterModule | "fraud" | "creditScore" | null;
}) {
  const normalizedPlan = params.planName.toUpperCase();
  const starterModule = normalizeStarterModule(params.starterModule);

  return {
    planName: normalizedPlan,
    price: getPlanPrice(normalizedPlan),
    trialDays: normalizedPlan === "TRIAL" ? 3 : 0,
    starterModule,
    active: normalizedPlan !== "TRIAL",
    endsAt: null,
    enabledModules: buildModuleAccess(normalizedPlan, starterModule),
    featureAccess: buildFeatureAccess(normalizedPlan, starterModule),
  } satisfies SubscriptionInfo;
}

export function readOptimisticSubscriptionFromSearch(search: string) {
  const params = new URLSearchParams(search);
  const billing = params.get("billing");
  const planName = params.get("plan");

  if (billing !== "activated" || !planName) {
    return null;
  }

  return buildOptimisticSubscription({
    planName,
    starterModule: normalizeStarterModule(params.get("starterModule")),
  });
}

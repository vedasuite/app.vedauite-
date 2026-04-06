export const BILLING_PLANS = ["NONE", "TRIAL", "STARTER", "GROWTH", "PRO"] as const;

export type BillingPlanName = (typeof BILLING_PLANS)[number];
export type StarterModule = "trustAbuse" | "competitor" | null;

export const CAPABILITIES = [
  "module.trustAbuse",
  "module.competitorIntel",
  "module.pricingProfit",
  "reports.view",
  "reports.export",
  "settings.view",
  "settings.manage",
  "trust.score",
  "trust.timeline",
  "trust.returnAbuse",
  "trust.refundOutcomeSimulator",
  "trust.smartPolicyEngine",
  "trust.trustRecoveryEngine",
  "trust.supportCopilot",
  "trust.evidencePackExport",
  "trust.advancedAutomation",
  "competitor.moveFeed",
  "competitor.impactScore",
  "competitor.actionSuggestions",
  "competitor.strategyDetection",
  "competitor.weeklyReports",
  "competitor.advancedReports",
  "pricing.basicRecommendations",
  "pricing.explainableRecommendations",
  "pricing.advancedModes",
  "pricing.doNothingRecommendation",
  "pricing.profitLeakDetector",
  "pricing.dailyActionBoard",
  "pricing.scenarioSimulator",
  "pricing.marginAtRisk",
  "pricing.advancedAutomation",
  "billing.moduleSelectionStarter",
  "billing.planManagement",
  "billing.upgrade",
  "billing.downgrade",
  "billing.trialActive",
] as const;

export type Capability = (typeof CAPABILITIES)[number];
export type CapabilityMap = Record<Capability, boolean>;

export type ModuleAccess = {
  trustAbuse: boolean;
  competitor: boolean;
  pricingProfit: boolean;
  reports: boolean;
  settings: boolean;
  fraud: boolean;
  pricing: boolean;
  creditScore: boolean;
  profitOptimization: boolean;
};

export type FeatureAccess = {
  shopperTrustScore: boolean;
  returnAbuseIntelligence: boolean;
  fraudReviewQueue: boolean;
  supportCopilot: boolean;
  evidencePackExport: boolean;
  competitorMoveFeed: boolean;
  competitorStrategyDetection: boolean;
  weeklyCompetitorReports: boolean;
  pricingRecommendations: boolean;
  explainableRecommendations: boolean;
  scenarioSimulator: boolean;
  profitLeakDetector: boolean;
  marginAtRisk: boolean;
  dailyActionBoard: boolean;
  advancedAutomation: boolean;
  fullProfitEngine: boolean;
};

export type SubscriptionLifecycleStatus =
  | "trial_active"
  | "trial_expired"
  | "active_paid"
  | "cancelled"
  | "inactive";

export type SubscriptionInfo = {
  planName: BillingPlanName;
  price: number;
  trialDays: number;
  starterModule: StarterModule;
  active?: boolean;
  endsAt?: string | null;
  trialStartedAt?: string | null;
  trialEndsAt?: string | null;
  status?: SubscriptionLifecycleStatus;
  billingStatus?: string | null;
  starterModuleSwitchAvailableAt?: string | null;
  enabledModules: ModuleAccess;
  featureAccess: FeatureAccess;
  capabilities: CapabilityMap;
};

function normalizeBillingPlanName(value?: string | null): BillingPlanName {
  if (!value) {
    return "NONE";
  }

  const normalized = value.toUpperCase();
  if ((BILLING_PLANS as readonly string[]).includes(normalized)) {
    return normalized as BillingPlanName;
  }

  return "NONE";
}

export function normalizeStarterModule(value?: string | null): StarterModule {
  if (value === "trustAbuse" || value === "competitor") {
    return value;
  }

  if (value === "fraud" || value === "creditScore") {
    return "trustAbuse";
  }

  return null;
}

function emptyCapabilities(): CapabilityMap {
  return Object.fromEntries(CAPABILITIES.map((capability) => [capability, false])) as CapabilityMap;
}

export function buildCapabilities(
  planName: BillingPlanName,
  starterModule: StarterModule
) {
  const capabilities = emptyCapabilities();
  const isTrial = planName === "TRIAL";
  const isGrowth = planName === "GROWTH";
  const isPro = planName === "PRO";
  const isStarterTrust = planName === "STARTER" && starterModule === "trustAbuse";
  const isStarterCompetitor = planName === "STARTER" && starterModule === "competitor";

  capabilities["reports.view"] = true;
  capabilities["settings.view"] = true;
  capabilities["settings.manage"] = true;
  capabilities["billing.planManagement"] = true;
  capabilities["billing.upgrade"] = true;
  capabilities["billing.downgrade"] = planName !== "NONE";
  capabilities["billing.moduleSelectionStarter"] = planName === "STARTER";
  capabilities["billing.trialActive"] = isTrial;

  capabilities["module.trustAbuse"] = isTrial || isGrowth || isPro || isStarterTrust;
  capabilities["module.competitorIntel"] =
    isTrial || isGrowth || isPro || isStarterCompetitor;
  capabilities["module.pricingProfit"] = isTrial || isGrowth || isPro;

  capabilities["trust.score"] = capabilities["module.trustAbuse"];
  capabilities["trust.timeline"] = capabilities["module.trustAbuse"];
  capabilities["trust.returnAbuse"] = capabilities["module.trustAbuse"];
  capabilities["trust.refundOutcomeSimulator"] = isTrial || isPro;
  capabilities["trust.smartPolicyEngine"] = isTrial || isPro;
  capabilities["trust.trustRecoveryEngine"] = isTrial || isPro;
  capabilities["trust.supportCopilot"] = isTrial || isPro;
  capabilities["trust.evidencePackExport"] = isTrial || isPro;
  capabilities["trust.advancedAutomation"] = isTrial || isPro;

  capabilities["competitor.moveFeed"] =
    isTrial || isGrowth || isPro || isStarterCompetitor;
  capabilities["competitor.impactScore"] = isTrial || isGrowth || isPro;
  capabilities["competitor.actionSuggestions"] = isTrial || isGrowth || isPro;
  capabilities["competitor.strategyDetection"] = isTrial || isPro;
  capabilities["competitor.weeklyReports"] = isTrial || isGrowth || isPro;
  capabilities["competitor.advancedReports"] = isTrial || isPro;

  capabilities["pricing.basicRecommendations"] = capabilities["module.pricingProfit"];
  capabilities["pricing.explainableRecommendations"] =
    capabilities["module.pricingProfit"];
  capabilities["pricing.advancedModes"] = isTrial || isPro;
  capabilities["pricing.doNothingRecommendation"] =
    capabilities["module.pricingProfit"];
  capabilities["pricing.profitLeakDetector"] = isTrial || isPro;
  capabilities["pricing.dailyActionBoard"] = isTrial || isPro;
  capabilities["pricing.scenarioSimulator"] = isTrial || isPro;
  capabilities["pricing.marginAtRisk"] = isTrial || isPro;
  capabilities["pricing.advancedAutomation"] = isTrial || isPro;

  capabilities["reports.export"] = capabilities["competitor.weeklyReports"];

  return capabilities;
}

export function buildModuleAccess(planName: BillingPlanName, starterModule: StarterModule): ModuleAccess {
  const capabilities = buildCapabilities(planName, starterModule);
  const pricingProfit = capabilities["module.pricingProfit"];
  const trustAbuse = capabilities["module.trustAbuse"];
  const competitor = capabilities["module.competitorIntel"];

  return {
    trustAbuse,
    competitor,
    pricingProfit,
    reports: capabilities["reports.view"],
    settings: capabilities["settings.view"],
    fraud: trustAbuse,
    pricing: pricingProfit,
    creditScore: trustAbuse,
    profitOptimization:
      pricingProfit &&
      (capabilities["pricing.profitLeakDetector"] ||
        capabilities["pricing.dailyActionBoard"] ||
        capabilities["pricing.marginAtRisk"]),
  };
}

export function buildFeatureAccess(
  planName: BillingPlanName,
  starterModule: StarterModule
): FeatureAccess {
  const capabilities = buildCapabilities(planName, starterModule);

  return {
    shopperTrustScore: capabilities["trust.score"],
    returnAbuseIntelligence: capabilities["trust.returnAbuse"],
    fraudReviewQueue: capabilities["module.trustAbuse"],
    supportCopilot: capabilities["trust.supportCopilot"],
    evidencePackExport: capabilities["trust.evidencePackExport"],
    competitorMoveFeed: capabilities["competitor.moveFeed"],
    competitorStrategyDetection: capabilities["competitor.strategyDetection"],
    weeklyCompetitorReports: capabilities["competitor.weeklyReports"],
    pricingRecommendations: capabilities["pricing.basicRecommendations"],
    explainableRecommendations:
      capabilities["pricing.explainableRecommendations"],
    scenarioSimulator: capabilities["pricing.scenarioSimulator"],
    profitLeakDetector: capabilities["pricing.profitLeakDetector"],
    marginAtRisk: capabilities["pricing.marginAtRisk"],
    dailyActionBoard: capabilities["pricing.dailyActionBoard"],
    advancedAutomation:
      capabilities["trust.advancedAutomation"] ||
      capabilities["pricing.advancedAutomation"],
    fullProfitEngine:
      capabilities["pricing.profitLeakDetector"] &&
      capabilities["pricing.dailyActionBoard"] &&
      capabilities["pricing.marginAtRisk"] &&
      capabilities["pricing.scenarioSimulator"],
  };
}

function getPlanPrice(planName: BillingPlanName) {
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
  planName: "NONE",
  price: 0,
  trialDays: 0,
  starterModule: null,
  active: false,
  endsAt: null,
  trialStartedAt: null,
  trialEndsAt: null,
  status: "inactive",
  billingStatus: "INACTIVE",
  starterModuleSwitchAvailableAt: null,
  enabledModules: buildModuleAccess("NONE", null),
  featureAccess: buildFeatureAccess("NONE", null),
  capabilities: buildCapabilities("NONE", null),
};

export function normalizeSubscriptionInfo(
  value: Partial<SubscriptionInfo> | null | undefined
): SubscriptionInfo {
  if (!value) {
    return fallbackSubscription;
  }

  const planName = normalizeBillingPlanName(value.planName);
  const starterModule = normalizeStarterModule(value.starterModule);
  const capabilities =
    value.capabilities ?? buildCapabilities(planName, starterModule);
  const enabledModules =
    value.enabledModules ?? buildModuleAccess(planName, starterModule);
  const featureAccess =
    value.featureAccess ?? buildFeatureAccess(planName, starterModule);
  const status =
    value.status ??
    (planName === "TRIAL"
      ? "trial_active"
      : planName === "NONE"
      ? "inactive"
      : "active_paid");
  const billingStatus =
    value.billingStatus ?? (planName === "NONE" ? "INACTIVE" : "ACTIVE");

  return {
    planName,
    price: typeof value.price === "number" ? value.price : getPlanPrice(planName),
    trialDays: typeof value.trialDays === "number" ? value.trialDays : planName === "TRIAL" ? 3 : 0,
    starterModule,
    active:
      typeof value.active === "boolean"
        ? value.active
        : planName !== "NONE" && planName !== "TRIAL"
        ? true
        : planName === "TRIAL",
    endsAt: value.endsAt ?? null,
    trialStartedAt: value.trialStartedAt ?? null,
    trialEndsAt: value.trialEndsAt ?? null,
    status,
    billingStatus,
    starterModuleSwitchAvailableAt: value.starterModuleSwitchAvailableAt ?? null,
    enabledModules,
    featureAccess,
    capabilities,
  };
}

export function buildOptimisticSubscription(params: {
  planName: string;
  starterModule?: StarterModule | "fraud" | "creditScore" | null;
}) {
  const normalizedPlan = normalizeBillingPlanName(params.planName);
  const starterModule = normalizeStarterModule(params.starterModule);

  return normalizeSubscriptionInfo({
    planName: normalizedPlan,
    price: getPlanPrice(normalizedPlan),
    trialDays: normalizedPlan === "TRIAL" ? 3 : 0,
    starterModule,
    active: normalizedPlan !== "NONE",
    endsAt: null,
    trialStartedAt: null,
    trialEndsAt: null,
    status:
      normalizedPlan === "TRIAL"
        ? "trial_active"
        : normalizedPlan === "NONE"
        ? "inactive"
        : "active_paid",
    billingStatus: normalizedPlan === "NONE" ? "INACTIVE" : "ACTIVE",
    starterModuleSwitchAvailableAt: null,
    enabledModules: buildModuleAccess(normalizedPlan, starterModule),
    featureAccess: buildFeatureAccess(normalizedPlan, starterModule),
    capabilities: buildCapabilities(normalizedPlan, starterModule),
  });
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

export const BILLING_PLANS = ["NONE", "TRIAL", "STARTER", "GROWTH", "PRO"] as const;

export type BillingPlanName = (typeof BILLING_PLANS)[number];
export type StarterModule = "trustAbuse" | "competitor";

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

export type CurrentSubscription = {
  planName: BillingPlanName;
  price: number;
  trialDays: number;
  starterModule: StarterModule | null;
  active: boolean;
  endsAt: string | null;
  trialStartedAt: string | null;
  trialEndsAt: string | null;
  status: SubscriptionLifecycleStatus;
  billingStatus: string | null;
  starterModuleSwitchAvailableAt: string | null;
  enabledModules: ModuleAccess;
  featureAccess: FeatureAccess;
  capabilities: CapabilityMap;
};

export const STARTER_MODULE_SWITCH_COOLDOWN_HOURS = 24;
export const DEFAULT_TRIAL_DAYS = 3;

const PLAN_PRICE_MAP: Record<BillingPlanName, number> = {
  NONE: 0,
  TRIAL: 0,
  STARTER: 19,
  GROWTH: 49,
  PRO: 99,
};

export function normalizeStarterModule(value?: string | null): StarterModule | null {
  if (value === "trustAbuse" || value === "competitor") {
    return value;
  }

  if (value === "fraud" || value === "creditScore") {
    return "trustAbuse";
  }

  return null;
}

export function normalizePlanName(value?: string | null): BillingPlanName | null {
  const normalized = value?.replace(/^VedaSuite AI - /i, "").trim().toUpperCase();

  if (!normalized) {
    return null;
  }

  if ((BILLING_PLANS as readonly string[]).includes(normalized)) {
    return normalized as BillingPlanName;
  }

  return null;
}

export function getPlanPrice(planName: BillingPlanName) {
  return PLAN_PRICE_MAP[planName];
}

function emptyCapabilities(): CapabilityMap {
  return Object.fromEntries(CAPABILITIES.map((capability) => [capability, false])) as CapabilityMap;
}

export function buildCapabilities(
  planName: BillingPlanName,
  starterModule: StarterModule | null,
  options?: { trialActive?: boolean }
): CapabilityMap {
  const capabilities = emptyCapabilities();
  const normalizedStarterModule = normalizeStarterModule(starterModule);
  const isTrial = planName === "TRIAL";
  const isGrowth = planName === "GROWTH";
  const isPro = planName === "PRO";
  const isStarterTrust =
    planName === "STARTER" && normalizedStarterModule === "trustAbuse";
  const isStarterCompetitor =
    planName === "STARTER" && normalizedStarterModule === "competitor";

  capabilities["reports.view"] = true;
  capabilities["settings.view"] = true;
  capabilities["settings.manage"] = true;
  capabilities["billing.planManagement"] = true;
  capabilities["billing.upgrade"] = true;
  capabilities["billing.downgrade"] = planName !== "NONE";
  capabilities["billing.moduleSelectionStarter"] = planName === "STARTER";
  capabilities["billing.trialActive"] = isTrial && (options?.trialActive ?? true);

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

export function buildModuleAccessFromCapabilities(capabilities: CapabilityMap): ModuleAccess {
  const trustAbuse = capabilities["module.trustAbuse"];
  const competitor = capabilities["module.competitorIntel"];
  const pricingProfit = capabilities["module.pricingProfit"];

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

export function buildFeatureAccessFromCapabilities(
  capabilities: CapabilityMap
): FeatureAccess {
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

export function normalizeStarterModuleLabel(moduleKey: StarterModule | null) {
  if (moduleKey === "trustAbuse") {
    return "Trust & Abuse Intelligence";
  }
  if (moduleKey === "competitor") {
    return "Competitor Intelligence";
  }
  return null;
}

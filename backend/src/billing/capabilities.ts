export const BILLING_PLANS = ["NONE", "TRIAL", "STARTER", "GROWTH", "PRO"] as const;

export type BillingPlanName = (typeof BILLING_PLANS)[number];
export type StarterModule = "fraud" | "competitor";
export type CanonicalModuleKey = "fraud" | "competitor" | "pricing" | "profit";

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
  fraud: boolean;
  competitor: boolean;
  pricing: boolean;
  profit: boolean;
  trustAbuse: boolean;
  pricingProfit: boolean;
  reports: boolean;
  settings: boolean;
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

export type SubscriptionLifeCycleStatus =
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
  status: SubscriptionLifeCycleStatus;
  billingStatus: string | null;
  starterModuleSwitchAvailableAt: string | null;
  enabledModules: ModuleAccess;
  featureAccess: FeatureAccess;
  capabilities: CapabilityMap;
};

export type ResolvedEntitlements = {
  plan: BillingPlanName;
  billingStatus: string | null;
  starterModule: StarterModule | null;
  enabledModules: CanonicalModuleKey[];
  lockedModules: CanonicalModuleKey[];
  moduleAccess: ModuleAccess;
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
  if (value === "fraud" || value === "competitor") {
    return value;
  }

  if (value === "trust" || value === "trustAbuse" || value === "fraudIntelligence" || value === "creditScore") {
    return "fraud";
  }

  if (value === "competitorIntelligence" || value === "competitor_monitoring") {
    return "competitor";
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
    planName === "STARTER" && normalizedStarterModule === "fraud";
  const isStarterCompetitor =
    planName === "STARTER" && normalizedStarterModule === "competitor";
  const trialPreviewOnly = isTrial && (options?.trialActive ?? true);
  const fraudModule = isStarterTrust || isGrowth || isPro;
  const competitorModule = isStarterCompetitor || isGrowth || isPro;
  const pricingModule = isGrowth || isPro;
  const creditScoreModule = isGrowth || isPro;
  const reportsModule = isGrowth || isPro;
  const profitModule = isPro;

  capabilities["reports.view"] = reportsModule;
  capabilities["settings.view"] = true;
  capabilities["settings.manage"] = true;
  capabilities["billing.planManagement"] = true;
  capabilities["billing.upgrade"] = true;
  capabilities["billing.downgrade"] = planName !== "NONE";
  capabilities["billing.moduleSelectionStarter"] = planName === "STARTER";
  capabilities["billing.trialActive"] = trialPreviewOnly;

  capabilities["module.trustAbuse"] = fraudModule;
  capabilities["module.competitorIntel"] = competitorModule;
  capabilities["module.pricingProfit"] = pricingModule;

  capabilities["trust.score"] = creditScoreModule;
  capabilities["trust.timeline"] = fraudModule;
  capabilities["trust.returnAbuse"] = fraudModule;
  capabilities["trust.refundOutcomeSimulator"] = profitModule;
  capabilities["trust.smartPolicyEngine"] = fraudModule;
  capabilities["trust.trustRecoveryEngine"] = profitModule;
  capabilities["trust.supportCopilot"] = profitModule;
  capabilities["trust.evidencePackExport"] = fraudModule;
  capabilities["trust.advancedAutomation"] = profitModule;

  capabilities["competitor.moveFeed"] = competitorModule;
  capabilities["competitor.impactScore"] = competitorModule;
  capabilities["competitor.actionSuggestions"] = competitorModule;
  capabilities["competitor.strategyDetection"] = isGrowth || isPro;
  capabilities["competitor.weeklyReports"] = reportsModule && competitorModule;
  capabilities["competitor.advancedReports"] = isPro;

  capabilities["pricing.basicRecommendations"] = pricingModule;
  capabilities["pricing.explainableRecommendations"] = pricingModule;
  capabilities["pricing.advancedModes"] = profitModule;
  capabilities["pricing.doNothingRecommendation"] = pricingModule;
  capabilities["pricing.profitLeakDetector"] = profitModule;
  capabilities["pricing.dailyActionBoard"] = profitModule;
  capabilities["pricing.scenarioSimulator"] = profitModule;
  capabilities["pricing.marginAtRisk"] = profitModule;
  capabilities["pricing.advancedAutomation"] = profitModule;

  capabilities["reports.export"] = reportsModule;

  return capabilities;
}

export function buildModuleAccessFromCapabilities(capabilities: CapabilityMap): ModuleAccess {
  const trustAbuse = capabilities["module.trustAbuse"];
  const competitor = capabilities["module.competitorIntel"];
  const pricingProfit = capabilities["module.pricingProfit"];
  const profitOptimization =
    pricingProfit &&
    (capabilities["pricing.profitLeakDetector"] ||
      capabilities["pricing.dailyActionBoard"] ||
      capabilities["pricing.marginAtRisk"]);

  return {
    fraud: trustAbuse,
    competitor,
    pricing: pricingProfit,
    profit: profitOptimization,
    trustAbuse,
    pricingProfit,
    reports: capabilities["reports.view"],
    settings: capabilities["settings.view"],
    creditScore: trustAbuse,
    profitOptimization,
  };
}

export function resolveEntitlements(input: {
  plan: BillingPlanName;
  billingStatus: string | null;
  starterModule: StarterModule | null;
}) : ResolvedEntitlements {
  const normalizedStarterModule = normalizeStarterModule(input.starterModule);
  const capabilities = buildCapabilities(input.plan, normalizedStarterModule);
  const moduleAccess = buildModuleAccessFromCapabilities(capabilities);
  const featureAccess = buildFeatureAccessFromCapabilities(capabilities);
  const enabledModules = (["fraud", "competitor", "pricing", "profit"] as CanonicalModuleKey[]).filter(
    (moduleKey) => moduleAccess[moduleKey]
  );
  const lockedModules = (["fraud", "competitor", "pricing", "profit"] as CanonicalModuleKey[]).filter(
    (moduleKey) => !moduleAccess[moduleKey]
  );

  return {
    plan: input.plan,
    billingStatus: input.billingStatus,
    starterModule: input.plan === "STARTER" ? normalizedStarterModule : null,
    enabledModules,
    lockedModules,
    moduleAccess,
    featureAccess,
    capabilities,
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
  if (moduleKey === "fraud") {
    return "Fraud Intelligence";
  }
  if (moduleKey === "competitor") {
    return "Competitor Intelligence";
  }
  return null;
}

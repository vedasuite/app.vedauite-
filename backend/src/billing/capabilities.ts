export const BILLING_PLANS = ["NONE", "TRIAL", "STARTER", "GROWTH", "PRO"] as const;

export type BillingPlanName = (typeof BILLING_PLANS)[number];
/**
 * The single core module a Starter merchant selects. Pricing was added
 * alongside fraud/competitor so Starter can be sold against any one of the
 * three core workflows.
 */
export type StarterModule = "fraud" | "competitor" | "pricing";
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
  /**
   * Canonical trial-active flag — sourced from the single trial predicate in
   * billing/trialState.ts, never re-derived from planName or access state.
   */
  trialActive: boolean;
  trialDaysRemaining: number;
  /**
   * Is the shop still entitled to its ONE free trial? Sourced from
   * ShopTrialHistory via resolveBillingState — never inferred from trialActive,
   * planName, dates, or subscription state. Fails closed to false on a DB error.
   */
  trialEligible: boolean;
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

const PLAN_PRICE_MAP: Record<BillingPlanName, number> = {
  NONE: 0,
  TRIAL: 0,
  STARTER: 19,
  GROWTH: 49,
  PRO: 99,
};

export function normalizeStarterModule(value?: string | null): StarterModule | null {
  if (value === "fraud" || value === "competitor" || value === "pricing") {
    return value;
  }

  if (value === "trust" || value === "trustAbuse" || value === "fraudIntelligence" || value === "creditScore") {
    return "fraud";
  }

  if (value === "competitorIntelligence" || value === "competitor_monitoring") {
    return "competitor";
  }

  if (value === "pricingProfit" || value === "aiPricing" || value === "pricingEngine") {
    return "pricing";
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

  // Plan-selected trial model: the trial does not change WHICH plan's
  // entitlements apply — it only means Shopify has not billed for them yet.
  // A merchant who approved STARTER gets exactly STARTER's entitlements
  // during the trial, not every module. This is a deliberate product
  // decision — see the 2026-08-03 "plan-selected Shopify trial model"
  // change. `trialActive` still flows through to `billing.trialActive` for
  // UI/copy purposes ("Starter trial active", no charge yet), but it no
  // longer widens `effectivePlan`.
  //
  // Legacy standalone "TRIAL" plan rows (pre-dating this model) still
  // collapse to NONE, so no shop can sit on an indefinite free TRIAL plan.
  const trialActive = options?.trialActive ?? false;
  const selectedPlan = planName;
  const effectivePlan: BillingPlanName = selectedPlan === "TRIAL" ? "NONE" : selectedPlan;

  const isGrowth = effectivePlan === "GROWTH";
  const isPro = effectivePlan === "PRO";
  const isStarterTrust =
    effectivePlan === "STARTER" && normalizedStarterModule === "fraud";
  const isStarterCompetitor =
    effectivePlan === "STARTER" && normalizedStarterModule === "competitor";
  const isStarterPricing =
    effectivePlan === "STARTER" && normalizedStarterModule === "pricing";
  const fraudModule = isStarterTrust || isGrowth || isPro;
  const competitorModule = isStarterCompetitor || isGrowth || isPro;
  const pricingModule = isStarterPricing || isGrowth || isPro;
  const creditScoreModule = isGrowth || isPro;
  const reportsModule = isGrowth || isPro;
  // Full Profit Optimization stays Pro-only, trial or not.
  const profitModule = isPro;

  capabilities["reports.view"] = reportsModule;
  capabilities["settings.view"] = true;
  capabilities["settings.manage"] = true;
  capabilities["billing.planManagement"] = true;
  capabilities["billing.upgrade"] = true;
  // Billing-surface capabilities key off the SELECTED plan, not the trial
  // override: a merchant on a trial who picked Starter must still be able to
  // choose their Starter module.
  capabilities["billing.downgrade"] = selectedPlan !== "NONE";
  capabilities["billing.moduleSelectionStarter"] = selectedPlan === "STARTER";
  capabilities["billing.trialActive"] = trialActive;

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
  /**
   * True only while the shop's one-time 7-day trial window (started at the
   * moment a plan was approved in Shopify) is still open. Does not change
   * which plan's entitlements apply — `plan` gets its own normal
   * entitlements whether trialing or paid; the trial only means Shopify
   * has not billed for them yet.
   */
  trialActive?: boolean;
}) : ResolvedEntitlements {
  const normalizedStarterModule = normalizeStarterModule(input.starterModule);
  const capabilities = buildCapabilities(input.plan, normalizedStarterModule, {
    trialActive: input.trialActive ?? false,
  });
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
  if (moduleKey === "pricing") {
    return "AI Pricing Engine";
  }
  return null;
}

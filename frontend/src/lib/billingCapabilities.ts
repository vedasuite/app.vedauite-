export const BILLING_PLANS = ["NONE", "TRIAL", "STARTER", "GROWTH", "PRO"] as const;

export type BillingPlanName = (typeof BILLING_PLANS)[number];
export type StarterModule = "fraud" | "competitor" | null;

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

export type SubscriptionLifecycleStatus =
  | "trial_active"
  | "trial_expired"
  | "active_paid"
  | "cancelled"
  | "inactive";

export type CanonicalBillingLifecycle =
  | "no_subscription"
  | "pending_approval"
  | "active"
  | "cancelled"
  | "frozen"
  | "test_charge"
  | "uninstalled"
  | "unknown_error";

export type CanonicalEntitlementTier =
  | "none"
  | "trial"
  | "starter"
  | "growth"
  | "pro";

export type BillingState = {
  lifecycle: CanonicalBillingLifecycle;
  planName: BillingPlanName;
  planTier: CanonicalEntitlementTier;
  normalizedBillingStatus: string | null;
  active: boolean;
  accessActive: boolean;
  verified: boolean;
  status: SubscriptionLifecycleStatus;
  starterModule: StarterModule;
  endsAt: string | null;
  renewalAt: string | null;
  showRenewalDate: boolean;
  showTrialDate: boolean;
  subscriptionId: string | null;
  shopifyChargeId: string | null;
  planSource: "database" | "shopify_reconciled" | "trial" | "none";
  dbPlanName: BillingPlanName;
  dbBillingStatus: string | null;
  lastBillingSyncAt: string | null;
  lastBillingWebhookProcessedAt: string | null;
  lastBillingResolutionSource: string | null;
  pendingIntentStatus: string | null;
  pendingRequestedPlanName: BillingPlanName | null;
  pendingRequestedStarterModule: StarterModule;
  merchantTitle: string;
  merchantDescription: string;
  mismatchWarnings: string[];
};

export type EntitlementState = {
  tier: CanonicalEntitlementTier;
  planName: BillingPlanName;
  starterModule: StarterModule;
  accessActive: boolean;
  verified: boolean;
  modules: ModuleAccess;
  featureAccess: FeatureAccess;
  capabilities: CapabilityMap;
  title: string;
  description: string;
};

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

export function normalizeBillingLifecycle(
  value?: string | null
): CanonicalBillingLifecycle {
  switch (value) {
    case "pending_approval":
    case "active":
    case "cancelled":
    case "frozen":
    case "uninstalled":
    case "unknown_error":
      return value;
    case "test_charge":
      return "active";
    default:
      return "no_subscription";
  }
}

export function normalizeEntitlementTier(
  value?: string | null
): CanonicalEntitlementTier {
  switch (value) {
    case "trial":
    case "starter":
    case "growth":
    case "pro":
      return value;
    default:
      return "none";
  }
}

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
  if (value === "fraud" || value === "competitor") {
    return value;
  }

  if (
    value === "trust" ||
    value === "trustAbuse" ||
    value === "fraudIntelligence" ||
    value === "creditScore"
  ) {
    return "fraud";
  }

  if (value === "competitorIntelligence" || value === "competitor_monitoring") {
    return "competitor";
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
  const isStarterTrust = planName === "STARTER" && starterModule === "fraud";
  const isStarterCompetitor = planName === "STARTER" && starterModule === "competitor";
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
  capabilities["billing.trialActive"] = isTrial;

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

export function buildModuleAccess(planName: BillingPlanName, starterModule: StarterModule): ModuleAccess {
  const capabilities = buildCapabilities(planName, starterModule);
  const pricingProfit = capabilities["module.pricingProfit"];
  const trustAbuse = capabilities["module.trustAbuse"];
  const competitor = capabilities["module.competitorIntel"];
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

export function normalizeEntitlementState(
  value: Partial<EntitlementState> | null | undefined
): EntitlementState {
  if (!value) {
    return {
      tier: "none",
      planName: "NONE",
      starterModule: null,
      accessActive: false,
      verified: false,
      modules: buildModuleAccess("NONE", null),
      featureAccess: buildFeatureAccess("NONE", null),
      capabilities: buildCapabilities("NONE", null),
      title: "Limited access",
      description: "Choose a plan to unlock included features.",
    };
  }

  const planName = normalizeBillingPlanName(value.planName);
  const starterModule = normalizeStarterModule(value.starterModule);
  const capabilities =
    value.capabilities ?? buildCapabilities(planName, starterModule);
  const modules = value.modules ?? buildModuleAccess(planName, starterModule);
  const featureAccess =
    value.featureAccess ?? buildFeatureAccess(planName, starterModule);

  return {
    tier: normalizeEntitlementTier(value.tier),
    planName,
    starterModule,
    accessActive: !!value.accessActive,
    verified: !!value.verified,
    modules,
    featureAccess,
    capabilities,
    title: value.title ?? "Access",
    description: value.description ?? "Module access follows the verified current plan.",
  };
}

export function normalizeBillingState(
  value: Partial<BillingState> | null | undefined
): BillingState {
  const subscription = normalizeSubscriptionInfo(value as Partial<SubscriptionInfo>);
  const lifecycle = normalizeBillingLifecycle(value?.lifecycle);
  const merchantTitle =
    lifecycle === "active" && value?.merchantTitle?.toLowerCase().includes("test plan is active")
      ? `${subscription.planName === "TRIAL" ? "Trial access" : `${subscription.planName} plan`} is active`
      : value?.merchantTitle ?? "Billing status unavailable";
  const merchantDescription =
    lifecycle === "active" &&
    value?.merchantDescription?.toLowerCase().includes("shopify test charge")
      ? subscription.planName === "TRIAL"
        ? "Your trial is active."
        : "VedaSuite has verified the current plan and included features."
      : value?.merchantDescription ??
        "VedaSuite could not confirm the latest Shopify billing state yet.";

  return {
    lifecycle,
    planName: subscription.planName,
    planTier: normalizeEntitlementTier(value?.planTier),
    normalizedBillingStatus: value?.normalizedBillingStatus ?? subscription.billingStatus ?? null,
    active: !!value?.active,
    accessActive:
      typeof value?.accessActive === "boolean" ? value.accessActive : !!subscription.active,
    verified: !!value?.verified,
    status: value?.status ?? subscription.status ?? "inactive",
    starterModule: normalizeStarterModule(value?.starterModule ?? subscription.starterModule),
    endsAt: value?.endsAt ?? subscription.endsAt ?? null,
    renewalAt: value?.renewalAt ?? null,
    showRenewalDate: !!value?.showRenewalDate,
    showTrialDate: !!value?.showTrialDate,
    subscriptionId: value?.subscriptionId ?? null,
    shopifyChargeId: value?.shopifyChargeId ?? null,
    planSource: value?.planSource ?? "none",
    dbPlanName: normalizeBillingPlanName(value?.dbPlanName),
    dbBillingStatus: value?.dbBillingStatus ?? null,
    lastBillingSyncAt: value?.lastBillingSyncAt ?? null,
    lastBillingWebhookProcessedAt: value?.lastBillingWebhookProcessedAt ?? null,
    lastBillingResolutionSource: value?.lastBillingResolutionSource ?? null,
    pendingIntentStatus: value?.pendingIntentStatus ?? null,
    pendingRequestedPlanName:
      normalizeBillingPlanName(value?.pendingRequestedPlanName),
    pendingRequestedStarterModule: normalizeStarterModule(
      value?.pendingRequestedStarterModule
    ),
    merchantTitle,
    merchantDescription,
    mismatchWarnings: Array.isArray(value?.mismatchWarnings)
      ? value.mismatchWarnings.filter((item): item is string => typeof item === "string")
      : [],
  };
}

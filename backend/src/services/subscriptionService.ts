import { prisma } from "../db/prismaClient";
import {
  cancelAppSubscription,
  getActiveAppSubscription,
} from "./shopifyAdminService";

export type StarterModule = "trustAbuse" | "competitor";

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
  scenarioSimulator: boolean;
  profitLeakDetector: boolean;
  marginAtRisk: boolean;
  dailyActionBoard: boolean;
  advancedAutomation: boolean;
  fullProfitEngine: boolean;
};

export type CurrentSubscription = {
  planName: string;
  price: number;
  trialDays: number;
  starterModule: StarterModule | null;
  active: boolean;
  endsAt: string | null;
  enabledModules: ModuleAccess;
  featureAccess: FeatureAccess;
};

export function normalizeStarterModuleLabel(moduleKey: StarterModule | null) {
  if (moduleKey === "trustAbuse") {
    return "Trust & Abuse Intelligence";
  }
  if (moduleKey === "competitor") {
    return "Competitor Intelligence";
  }
  return null;
}

function isSubscriptionCurrentlyActive(endsAt?: Date | null, active?: boolean) {
  if (!active) {
    return false;
  }

  if (!endsAt) {
    return true;
  }

  return endsAt.getTime() > Date.now();
}

function normalizePlanName(planName?: string | null) {
  return planName?.replace(/^VedaSuite AI - /i, "").trim().toUpperCase() ?? null;
}

function normalizeStarterModule(value?: string | null): StarterModule | null {
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
  starterModule: StarterModule | null
): ModuleAccess {
  const isTrial = planName === "TRIAL";
  const isStarterTrust =
    planName === "STARTER" && normalizeStarterModule(starterModule) === "trustAbuse";
  const isStarterCompetitor =
    planName === "STARTER" && normalizeStarterModule(starterModule) === "competitor";

  const trustAbuse =
    isTrial || planName === "GROWTH" || planName === "PRO" || isStarterTrust;
  const competitor =
    isTrial || planName === "GROWTH" || planName === "PRO" || isStarterCompetitor;
  const pricingProfit = isTrial || planName === "GROWTH" || planName === "PRO";
  const reports = true;
  const settings = true;

  return {
    trustAbuse,
    competitor,
    pricingProfit,
    reports,
    settings,
    fraud: trustAbuse,
    pricing: pricingProfit,
    creditScore: trustAbuse,
    profitOptimization: isTrial || planName === "PRO",
  };
}

function buildFeatureAccess(
  planName: string,
  starterModule: StarterModule | null
): FeatureAccess {
  const modules = buildModuleAccess(planName, starterModule);
  const isTrial = planName === "TRIAL";
  const isGrowth = planName === "GROWTH";
  const isPro = planName === "PRO";

  return {
    shopperTrustScore: modules.trustAbuse,
    returnAbuseIntelligence: modules.trustAbuse,
    fraudReviewQueue: modules.trustAbuse,
    supportCopilot: isTrial || isGrowth || isPro,
    evidencePackExport: isTrial || isPro,
    competitorMoveFeed: modules.competitor,
    competitorStrategyDetection: isTrial || isGrowth || isPro,
    weeklyCompetitorReports: isTrial || isGrowth || isPro,
    pricingRecommendations: modules.pricingProfit,
    scenarioSimulator: modules.pricingProfit,
    profitLeakDetector: modules.pricingProfit,
    marginAtRisk: modules.pricingProfit,
    dailyActionBoard: modules.pricingProfit,
    advancedAutomation: isTrial || isPro,
    fullProfitEngine: isTrial || isPro,
  };
}

function buildSubscriptionPayload(params: {
  planName: string;
  price: number;
  trialDays: number;
  starterModule: StarterModule | null;
  active: boolean;
  endsAt: Date | null | undefined;
}): CurrentSubscription {
  return {
    planName: params.planName,
    price: params.price,
    trialDays: params.trialDays,
    starterModule: params.starterModule,
    active: params.active,
    endsAt: params.endsAt?.toISOString() ?? null,
    enabledModules: buildModuleAccess(params.planName, params.starterModule),
    featureAccess: buildFeatureAccess(params.planName, params.starterModule),
  };
}

async function resolvePlanRecord(planName: string, trialDays = 3, price = 0) {
  const existing = await prisma.subscriptionPlan.findUnique({
    where: { name: planName },
  });

  if (existing) {
    return existing;
  }

  return prisma.subscriptionPlan.create({
    data: {
      name: planName,
      price,
      trialDays,
      features: JSON.stringify({ planName }),
    },
  });
}

async function reconcileCurrentSubscriptionFromShopify(store: {
  id: string;
  shop: string;
  subscription: {
    starterModule: string | null;
    shopifyChargeId: string | null;
  } | null;
}) {
  const activeSubscription = await getActiveAppSubscription(store.shop);

  if (!activeSubscription) {
    return null;
  }

  const normalizedPlanName = normalizePlanName(activeSubscription.name);
  if (!normalizedPlanName) {
    return null;
  }

  const plan = await resolvePlanRecord(
    normalizedPlanName,
    3,
    normalizedPlanName === "STARTER"
      ? 19
      : normalizedPlanName === "GROWTH"
      ? 49
      : normalizedPlanName === "PRO"
      ? 99
      : 0
  );

  const currentPeriodEnd = activeSubscription.currentPeriodEnd
    ? new Date(activeSubscription.currentPeriodEnd)
    : null;

  return prisma.storeSubscription.upsert({
    where: { storeId: store.id },
    update: {
      planId: plan.id,
      shopifyChargeId: activeSubscription.id,
      active: true,
      endsAt: currentPeriodEnd,
      starterModule:
        normalizedPlanName === "STARTER"
          ? normalizeStarterModule(store.subscription?.starterModule) ?? "trustAbuse"
          : null,
    },
    create: {
      storeId: store.id,
      planId: plan.id,
      shopifyChargeId: activeSubscription.id,
      active: true,
      endsAt: currentPeriodEnd,
      starterModule: normalizedPlanName === "STARTER" ? "trustAbuse" : null,
    },
    include: {
      plan: true,
    },
  });
}

export async function getCurrentSubscription(
  shopDomain: string
): Promise<CurrentSubscription> {
  const store = await prisma.store.findUnique({
    where: { shop: shopDomain },
    include: {
      subscription: {
        include: {
          plan: true,
        },
      },
    },
  });

  if (!store) {
    throw new Error("Store not found");
  }

  let subscription = store.subscription;
  let subscriptionIsActive = isSubscriptionCurrentlyActive(
    subscription?.endsAt,
    subscription?.active
  );

  if (!subscriptionIsActive || !subscription?.plan) {
    const reconciledSubscription = await reconcileCurrentSubscriptionFromShopify({
      id: store.id,
      shop: store.shop,
      subscription: store.subscription
        ? {
            starterModule: store.subscription.starterModule,
            shopifyChargeId: store.subscription.shopifyChargeId,
          }
        : null,
    });

    if (reconciledSubscription) {
      subscription = reconciledSubscription;
      subscriptionIsActive = isSubscriptionCurrentlyActive(
        subscription.endsAt,
        subscription.active
      );
    }
  }

  if (!subscriptionIsActive || !subscription?.plan) {
    return buildSubscriptionPayload({
      planName: "TRIAL",
      price: 0,
      trialDays: 3,
      starterModule: null,
      active: false,
      endsAt: subscription?.endsAt,
    });
  }

  return buildSubscriptionPayload({
    planName: subscription.plan.name,
    price: subscription.plan.price,
    trialDays: subscription.plan.trialDays,
    starterModule: normalizeStarterModule(subscription.starterModule),
    active: subscription.active,
    endsAt: subscription.endsAt,
  });
}

export async function cancelSubscription(shopDomain: string) {
  const store = await prisma.store.findUnique({
    where: { shop: shopDomain },
    include: { subscription: true },
  });
  if (!store) throw new Error("Store not found");
  if (!store.subscription) throw new Error("No active subscription");

  if (store.subscription.shopifyChargeId) {
    await cancelAppSubscription(shopDomain, store.subscription.shopifyChargeId, false);
  }

  return prisma.storeSubscription.update({
    where: { id: store.subscription.id },
    data: {
      active: false,
      endsAt: new Date(),
    },
  });
}

export async function downgradeToTrial(shopDomain: string) {
  const store = await prisma.store.findUnique({
    where: { shop: shopDomain },
    include: { subscription: true },
  });
  if (!store) throw new Error("Store not found");

  if (store.subscription) {
    if (store.subscription.shopifyChargeId) {
      await cancelAppSubscription(shopDomain, store.subscription.shopifyChargeId, false);
    }

    await prisma.storeSubscription.delete({
      where: { id: store.subscription.id },
    });
  }

  return buildSubscriptionPayload({
    planName: "TRIAL",
    price: 0,
    trialDays: 3,
    starterModule: null,
    active: false,
    endsAt: null,
  });
}

export async function updateStarterModuleSelection(
  shopDomain: string,
  starterModule: StarterModule
) {
  const store = await prisma.store.findUnique({
    where: { shop: shopDomain },
    include: {
      subscription: {
        include: { plan: true },
      },
    },
  });
  if (!store) throw new Error("Store not found");
  if (!store.subscription || store.subscription.plan.name !== "STARTER") {
    throw new Error(
      "Starter module selection can only be changed on the STARTER plan."
    );
  }

  return prisma.storeSubscription.update({
    where: { id: store.subscription.id },
    data: { starterModule },
  });
}

export async function reconcileStoreSubscriptionFromWebhook(input: {
  shopDomain: string;
  shopifyChargeId?: string | null;
  planName?: string | null;
  status?: string | null;
  currentPeriodEnd?: string | null;
}) {
  const store = await prisma.store.findUnique({
    where: { shop: input.shopDomain },
    include: {
      subscription: true,
    },
  });

  if (!store) {
    return null;
  }

  const normalizedStatus = input.status?.toUpperCase() ?? null;
  const isActive =
    normalizedStatus === "ACTIVE" ||
    normalizedStatus === "ACCEPTED" ||
    normalizedStatus === "PENDING";

  const planName = normalizePlanName(input.planName);

  if (!isActive) {
    if (!store.subscription) {
      return null;
    }

    return prisma.storeSubscription.update({
      where: { id: store.subscription.id },
      data: {
        active: false,
        endsAt: input.currentPeriodEnd ? new Date(input.currentPeriodEnd) : new Date(),
      },
    });
  }

  if (!planName) {
    return store.subscription;
  }

  const plan = await prisma.subscriptionPlan.findUnique({
    where: { name: planName },
  });

  if (!plan) {
    return store.subscription;
  }

  return prisma.storeSubscription.upsert({
    where: { storeId: store.id },
    update: {
      planId: plan.id,
      shopifyChargeId: input.shopifyChargeId ?? store.subscription?.shopifyChargeId ?? null,
      active: true,
      endsAt: input.currentPeriodEnd ? new Date(input.currentPeriodEnd) : null,
      starterModule:
        planName === "STARTER"
          ? normalizeStarterModule(store.subscription?.starterModule) ?? "trustAbuse"
          : null,
    },
    create: {
      storeId: store.id,
      planId: plan.id,
      shopifyChargeId: input.shopifyChargeId ?? null,
      active: true,
      endsAt: input.currentPeriodEnd ? new Date(input.currentPeriodEnd) : null,
      starterModule: planName === "STARTER" ? "trustAbuse" : null,
    },
  });
}

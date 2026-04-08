import { env } from "../config/env";
import { Prisma } from "@prisma/client";
import { prisma } from "../db/prismaClient";
import {
  cancelAppSubscription,
  getActiveAppSubscription,
} from "./shopifyAdminService";
import {
  buildCapabilities,
  buildFeatureAccessFromCapabilities,
  buildModuleAccessFromCapabilities,
  DEFAULT_TRIAL_DAYS,
  getPlanPrice,
  normalizePlanName,
  normalizeStarterModule,
  normalizeStarterModuleLabel,
  STARTER_MODULE_SWITCH_COOLDOWN_HOURS,
  type BillingPlanName,
  type CurrentSubscription,
  type StarterModule,
  type SubscriptionLifeCycleStatus,
} from "../billing/capabilities";

export type {
  BillingPlanName,
  Capability,
  CapabilityMap,
  CurrentSubscription,
  FeatureAccess,
  ModuleAccess,
  StarterModule,
} from "../billing/capabilities";

const storeWithSubscriptionArgs =
  Prisma.validator<Prisma.StoreDefaultArgs>()({
    include: {
      subscription: {
        include: {
          plan: true,
        },
      },
    },
  });

type StoreWithSubscription = Prisma.StoreGetPayload<
  typeof storeWithSubscriptionArgs
>;

function getTrialEndsAt(trialStartedAt?: Date | null, trialEndsAt?: Date | null) {
  if (trialEndsAt) {
    return trialEndsAt;
  }

  if (!trialStartedAt) {
    return null;
  }

  const next = new Date(trialStartedAt);
  next.setDate(next.getDate() + env.billing.trialDays);
  return next;
}

function isDateInFuture(value?: Date | null) {
  return !!value && value.getTime() > Date.now();
}

function deriveLifecycleStatus(input: {
  planName: BillingPlanName;
  active: boolean;
  billingStatus: string | null;
  trialEndsAt: Date | null;
}): SubscriptionLifeCycleStatus {
  if (input.planName === "TRIAL") {
    return isDateInFuture(input.trialEndsAt) ? "trial_active" : "trial_expired";
  }

  if (input.planName === "NONE") {
    return input.billingStatus === "CANCELLED" ? "cancelled" : "inactive";
  }

  if (input.active) {
    return "active_paid";
  }

  return input.billingStatus === "CANCELLED" ? "cancelled" : "inactive";
}

async function ensurePlanRecord(planName: BillingPlanName) {
  const existing = await prisma.subscriptionPlan.findUnique({
    where: { name: planName },
  });

  if (existing) {
    return existing;
  }

  return prisma.subscriptionPlan.create({
    data: {
      name: planName,
      price: getPlanPrice(planName),
      trialDays: env.billing.trialDays,
      features: JSON.stringify({ planName }),
    },
  });
}

async function recordBillingAuditLog(input: {
  storeId: string;
  subscriptionId?: string | null;
  eventType: string;
  previousPlanName?: string | null;
  nextPlanName?: string | null;
  previousStarterModule?: string | null;
  nextStarterModule?: string | null;
  billingStatus?: string | null;
  metadata?: Record<string, unknown> | null;
}) {
  await prisma.billingAuditLog.create({
    data: {
      storeId: input.storeId,
      subscriptionId: input.subscriptionId ?? null,
      eventType: input.eventType,
      previousPlanName: input.previousPlanName ?? null,
      nextPlanName: input.nextPlanName ?? null,
      previousStarterModule: input.previousStarterModule ?? null,
      nextStarterModule: input.nextStarterModule ?? null,
      billingStatus: input.billingStatus ?? null,
      metadataJson: input.metadata ? JSON.stringify(input.metadata) : null,
    },
  });
}

async function ensureStoreTrialState(store: { id: string; trialStartedAt: Date | null; trialEndsAt: Date | null; }) {
  if (store.trialStartedAt && store.trialEndsAt) {
    return {
      trialStartedAt: store.trialStartedAt,
      trialEndsAt: store.trialEndsAt,
    };
  }

  const trialStartedAt = store.trialStartedAt ?? new Date();
  const trialEndsAt = getTrialEndsAt(trialStartedAt, store.trialEndsAt);

  await prisma.store.update({
    where: { id: store.id },
    data: {
      trialStartedAt,
      trialEndsAt,
    },
  });

  return { trialStartedAt, trialEndsAt };
}

function buildSubscriptionPayload(input: {
  planName: BillingPlanName;
  price: number;
  trialDays: number;
  starterModule: StarterModule | null;
  active: boolean;
  endsAt: Date | null;
  trialStartedAt: Date | null;
  trialEndsAt: Date | null;
  billingStatus: string | null;
  starterModuleSwitchAvailableAt?: Date | null;
}): CurrentSubscription {
  const capabilities = buildCapabilities(input.planName, input.starterModule, {
    trialActive: isDateInFuture(input.trialEndsAt),
  });

  return {
    planName: input.planName,
    price: input.price,
    trialDays: input.trialDays,
    starterModule: input.starterModule,
    active: input.active,
    endsAt: input.endsAt?.toISOString() ?? null,
    trialStartedAt: input.trialStartedAt?.toISOString() ?? null,
    trialEndsAt: input.trialEndsAt?.toISOString() ?? null,
    status: deriveLifecycleStatus({
      planName: input.planName,
      active: input.active,
      billingStatus: input.billingStatus,
      trialEndsAt: input.trialEndsAt,
    }),
    billingStatus: input.billingStatus,
    starterModuleSwitchAvailableAt:
      input.starterModuleSwitchAvailableAt?.toISOString() ?? null,
    enabledModules: buildModuleAccessFromCapabilities(capabilities),
    featureAccess: buildFeatureAccessFromCapabilities(capabilities),
    capabilities,
  };
}

function getStarterModuleSwitchAvailableAt(moduleSwitchedAt?: Date | null) {
  if (!moduleSwitchedAt) {
    return null;
  }

  const availableAt = new Date(moduleSwitchedAt);
  availableAt.setHours(
    availableAt.getHours() + STARTER_MODULE_SWITCH_COOLDOWN_HOURS
  );
  return availableAt;
}

async function reconcileCurrentSubscriptionFromShopify(store: NonNullable<StoreWithSubscription>) {
  const activeSubscription = await getActiveAppSubscription(store.shop);

  if (!activeSubscription) {
    return null;
  }

  const planName = normalizePlanName(activeSubscription.name);
  if (!planName || planName === "TRIAL" || planName === "NONE") {
    return null;
  }

  const plan = await ensurePlanRecord(planName);
  const currentPeriodEnd = activeSubscription.currentPeriodEnd
    ? new Date(activeSubscription.currentPeriodEnd)
    : null;
  const billingStatus = activeSubscription.status?.toUpperCase() ?? "ACTIVE";
  const starterModule =
    planName === "STARTER"
      ? normalizeStarterModule(store.subscription?.starterModule) ?? "trustAbuse"
      : null;

  const previousPlanName = store.subscription?.plan?.name ?? null;

  const nextSubscription = await prisma.storeSubscription.upsert({
    where: { storeId: store.id },
    update: {
      planId: plan.id,
      starterModule,
      shopifyChargeId: activeSubscription.id,
      active: true,
      billingStatus,
      planActivatedAt: new Date(),
      lastBillingSyncAt: new Date(),
      cancelledAt: null,
      endsAt: currentPeriodEnd,
    },
    create: {
      storeId: store.id,
      planId: plan.id,
      starterModule,
      shopifyChargeId: activeSubscription.id,
      active: true,
      billingStatus,
      planActivatedAt: new Date(),
      lastBillingSyncAt: new Date(),
      endsAt: currentPeriodEnd,
    },
    include: {
      plan: true,
    },
  });

  if (previousPlanName !== planName) {
    await recordBillingAuditLog({
      storeId: store.id,
      subscriptionId: nextSubscription.id,
      eventType: "billing.reconciled_from_shopify",
      previousPlanName,
      nextPlanName: planName,
      previousStarterModule: store.subscription?.starterModule ?? null,
      nextStarterModule: starterModule,
      billingStatus,
      metadata: {
        shopifyChargeId: activeSubscription.id,
      },
    });
  }

  return nextSubscription;
}

function isPaidSubscriptionActive(subscription?: { active: boolean; endsAt: Date | null } | null) {
  if (!subscription?.active) {
    return false;
  }

  if (!subscription.endsAt) {
    return true;
  }

  return subscription.endsAt.getTime() > Date.now();
}

export async function getCurrentSubscription(
  shopDomain: string
): Promise<CurrentSubscription> {
  const store = await prisma.store.findUnique({
    where: { shop: shopDomain },
    ...storeWithSubscriptionArgs,
  });

  if (!store) {
    throw new Error("Store not found");
  }

  const { trialStartedAt, trialEndsAt } = await ensureStoreTrialState(store);

  let subscription = store.subscription;
  let subscriptionIsActive = isPaidSubscriptionActive(subscription);

  if (!subscriptionIsActive || !subscription?.plan) {
    const reconciled = await reconcileCurrentSubscriptionFromShopify(store);
    if (reconciled) {
      subscription = reconciled;
      subscriptionIsActive = isPaidSubscriptionActive(reconciled);
    }
  }

  if (subscriptionIsActive && subscription?.plan) {
    return buildSubscriptionPayload({
      planName: normalizePlanName(subscription.plan.name) ?? "NONE",
      price: subscription.plan.price,
      trialDays: subscription.plan.trialDays,
      starterModule: normalizeStarterModule(subscription.starterModule),
      active: subscription.active,
      endsAt: subscription.endsAt,
      trialStartedAt,
      trialEndsAt,
      billingStatus: subscription.billingStatus,
      starterModuleSwitchAvailableAt: getStarterModuleSwitchAvailableAt(
        subscription.moduleSwitchedAt
      ),
    });
  }

  if (isDateInFuture(trialEndsAt)) {
    return buildSubscriptionPayload({
      planName: "TRIAL",
      price: 0,
      trialDays: env.billing.trialDays,
      starterModule: null,
      active: true,
      endsAt: trialEndsAt,
      trialStartedAt,
      trialEndsAt,
      billingStatus: null,
    });
  }

  return buildSubscriptionPayload({
    planName: "NONE",
    price: 0,
    trialDays: env.billing.trialDays,
    starterModule: null,
    active: false,
    endsAt: subscription?.endsAt ?? trialEndsAt,
    trialStartedAt,
    trialEndsAt,
    billingStatus: subscription?.billingStatus ?? "INACTIVE",
  });
}

export async function resolveActivePlan(shopDomain: string): Promise<BillingPlanName> {
  const subscription = await getCurrentSubscription(shopDomain);
  return subscription.planName;
}

export async function cancelSubscription(shopDomain: string) {
  const store = await prisma.store.findUnique({
    where: { shop: shopDomain },
    ...storeWithSubscriptionArgs,
  });

  if (!store) throw new Error("Store not found");
  if (!store.subscription) throw new Error("No active subscription");

  if (store.subscription.shopifyChargeId) {
    await cancelAppSubscription(shopDomain, store.subscription.shopifyChargeId, false);
  }

  const cancelled = await prisma.storeSubscription.update({
    where: { id: store.subscription.id },
    data: {
      active: false,
      billingStatus: "CANCELLED",
      cancelledAt: new Date(),
      lastBillingSyncAt: new Date(),
      endsAt: store.subscription.endsAt ?? new Date(),
    },
    include: {
      plan: true,
    },
  });

  await recordBillingAuditLog({
    storeId: store.id,
    subscriptionId: cancelled.id,
    eventType: "billing.cancelled",
    previousPlanName: store.subscription.plan.name,
    nextPlanName: "NONE",
    previousStarterModule: store.subscription.starterModule,
    nextStarterModule: null,
    billingStatus: "CANCELLED",
  });

  return getCurrentSubscription(shopDomain);
}

export async function downgradeToTrial(shopDomain: string) {
  const store = await prisma.store.findUnique({
    where: { shop: shopDomain },
    ...storeWithSubscriptionArgs,
  });

  if (!store) throw new Error("Store not found");

  if (store.subscription?.shopifyChargeId) {
    await cancelAppSubscription(shopDomain, store.subscription.shopifyChargeId, false);
  }

  if (store.subscription) {
    await recordBillingAuditLog({
      storeId: store.id,
      subscriptionId: store.subscription.id,
      eventType: "billing.downgraded_to_trial",
      previousPlanName: store.subscription.plan.name,
      nextPlanName: "TRIAL",
      previousStarterModule: store.subscription.starterModule,
      nextStarterModule: null,
      billingStatus: "CANCELLED",
    });

    await prisma.storeSubscription.delete({
      where: { id: store.subscription.id },
    });
  }

  const trialStartedAt = new Date();
  const trialEndsAt = getTrialEndsAt(trialStartedAt, null);

  await prisma.store.update({
    where: { id: store.id },
    data: {
      trialStartedAt,
      trialEndsAt,
    },
  });

  return buildSubscriptionPayload({
    planName: "TRIAL",
    price: 0,
    trialDays: env.billing.trialDays,
    starterModule: null,
    active: true,
    endsAt: trialEndsAt,
    trialStartedAt,
    trialEndsAt,
    billingStatus: null,
  });
}

export async function updateStarterModuleSelection(
  shopDomain: string,
  starterModule: StarterModule
) {
  const store = await prisma.store.findUnique({
    where: { shop: shopDomain },
    ...storeWithSubscriptionArgs,
  });

  if (!store) throw new Error("Store not found");
  if (!store.subscription || store.subscription.plan.name !== "STARTER") {
    throw new Error("Starter module selection can only be changed on the STARTER plan.");
  }

  const normalizedStarterModule = normalizeStarterModule(starterModule);
  if (!normalizedStarterModule) {
    throw new Error("Invalid Starter module selection.");
  }

  const availableAt = getStarterModuleSwitchAvailableAt(
    store.subscription.moduleSwitchedAt
  );

  if (
    availableAt &&
    availableAt.getTime() > Date.now() &&
    store.subscription.starterModule !== normalizedStarterModule
  ) {
    throw new Error(
      `Starter module can be changed again after ${availableAt.toISOString()}.`
    );
  }

  const updated = await prisma.storeSubscription.update({
    where: { id: store.subscription.id },
    data: {
      starterModule: normalizedStarterModule,
      moduleSwitchedAt: new Date(),
      lastBillingSyncAt: new Date(),
    },
    include: {
      plan: true,
    },
  });

  await recordBillingAuditLog({
    storeId: store.id,
    subscriptionId: updated.id,
    eventType: "starter.module_switched",
    previousPlanName: store.subscription.plan.name,
    nextPlanName: updated.plan.name,
    previousStarterModule: store.subscription.starterModule,
    nextStarterModule: normalizedStarterModule,
    billingStatus: updated.billingStatus,
  });

  return getCurrentSubscription(shopDomain);
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
    ...storeWithSubscriptionArgs,
  });

  if (!store) {
    return null;
  }

  const normalizedStatus = input.status?.toUpperCase() ?? "INACTIVE";
  const isActive =
    normalizedStatus === "ACTIVE" ||
    normalizedStatus === "ACCEPTED" ||
    normalizedStatus === "PENDING";

  const planName = normalizePlanName(input.planName);
  const currentPeriodEnd = input.currentPeriodEnd
    ? new Date(input.currentPeriodEnd)
    : null;

  if (!isActive) {
    if (!store.subscription) {
      return null;
    }

    const updated = await prisma.storeSubscription.update({
      where: { id: store.subscription.id },
      data: {
        active: false,
        billingStatus: normalizedStatus,
        cancelledAt: new Date(),
        lastBillingSyncAt: new Date(),
        endsAt: currentPeriodEnd ?? new Date(),
      },
    });

    await recordBillingAuditLog({
      storeId: store.id,
      subscriptionId: updated.id,
      eventType: "billing.webhook_deactivated",
      previousPlanName: store.subscription.plan.name,
      nextPlanName: "NONE",
      previousStarterModule: store.subscription.starterModule,
      nextStarterModule: null,
      billingStatus: normalizedStatus,
      metadata: {
        shopifyChargeId: input.shopifyChargeId ?? null,
      },
    });

    return updated;
  }

  if (!planName || planName === "TRIAL" || planName === "NONE") {
    return store.subscription;
  }

  const plan = await ensurePlanRecord(planName);

  const updated = await prisma.storeSubscription.upsert({
    where: { storeId: store.id },
    update: {
      planId: plan.id,
      shopifyChargeId: input.shopifyChargeId ?? store.subscription?.shopifyChargeId ?? null,
      active: true,
      billingStatus: normalizedStatus,
      planActivatedAt: new Date(),
      lastBillingSyncAt: new Date(),
      cancelledAt: null,
      endsAt: currentPeriodEnd,
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
      billingStatus: normalizedStatus,
      planActivatedAt: new Date(),
      lastBillingSyncAt: new Date(),
      endsAt: currentPeriodEnd,
      starterModule: planName === "STARTER" ? "trustAbuse" : null,
    },
  });

  await recordBillingAuditLog({
    storeId: store.id,
    subscriptionId: updated.id,
    eventType: "billing.webhook_reconciled",
    previousPlanName: store.subscription?.plan?.name ?? null,
    nextPlanName: planName,
    previousStarterModule: store.subscription?.starterModule ?? null,
    nextStarterModule: updated.starterModule,
    billingStatus: normalizedStatus,
    metadata: {
      shopifyChargeId: input.shopifyChargeId ?? null,
      currentPeriodEnd: input.currentPeriodEnd ?? null,
    },
  });

  return updated;
}

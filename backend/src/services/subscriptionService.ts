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

export type ResolvedBillingState = {
  planName: BillingPlanName;
  normalizedBillingStatus: string | null;
  active: boolean;
  status: SubscriptionLifeCycleStatus;
  starterModule: StarterModule | null;
  endsAt: string | null;
  subscriptionId: string | null;
  shopifyChargeId: string | null;
  planSource: "database" | "shopify_reconciled" | "trial" | "none";
  dbPlanName: BillingPlanName;
  dbBillingStatus: string | null;
  lastBillingSyncAt: string | null;
  lastBillingWebhookProcessedAt: string | null;
  lastBillingResolutionSource: string | null;
  mismatchWarnings: string[];
};

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
      lastBillingResolutionSource: "shopify_api_reconcile",
      lastBillingSubscriptionName: activeSubscription.name,
      cancelledAt: null,
      endsAt: currentPeriodEnd,
    } as any,
    create: {
      storeId: store.id,
      planId: plan.id,
      starterModule,
      shopifyChargeId: activeSubscription.id,
      active: true,
      billingStatus,
      planActivatedAt: new Date(),
      lastBillingSyncAt: new Date(),
      lastBillingResolutionSource: "shopify_api_reconcile",
      lastBillingSubscriptionName: activeSubscription.name,
      endsAt: currentPeriodEnd,
    } as any,
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

export async function resolveBillingState(
  shopDomain: string
): Promise<ResolvedBillingState> {
  const store = await prisma.store.findUnique({
    where: { shop: shopDomain },
    ...storeWithSubscriptionArgs,
  });

  if (!store) {
    throw new Error("Store not found");
  }

  const { trialEndsAt } = await ensureStoreTrialState(store);
  const dbPlanName = normalizePlanName(store.subscription?.plan?.name) ?? "NONE";
  const dbBillingStatus = store.subscription?.billingStatus ?? null;
  let subscription = store.subscription;
  let planSource: ResolvedBillingState["planSource"] = "none";
  let reconciledFromShopify = false;

  if (!isPaidSubscriptionActive(subscription) || !subscription?.plan) {
    const reconciled = await reconcileCurrentSubscriptionFromShopify(store);
    if (reconciled) {
      subscription = reconciled;
      reconciledFromShopify = true;
    }
  }

  if (subscription?.plan && isPaidSubscriptionActive(subscription)) {
    const planName = normalizePlanName(subscription.plan.name) ?? "NONE";
    planSource = reconciledFromShopify ? "shopify_reconciled" : "database";
    return {
      planName,
      normalizedBillingStatus: subscription.billingStatus,
      active: subscription.active,
      status: deriveLifecycleStatus({
        planName,
        active: subscription.active,
        billingStatus: subscription.billingStatus,
        trialEndsAt,
      }),
      starterModule: normalizeStarterModule(subscription.starterModule),
      endsAt: subscription.endsAt?.toISOString() ?? null,
      subscriptionId: subscription.id,
      shopifyChargeId: subscription.shopifyChargeId ?? null,
      planSource,
      dbPlanName,
      dbBillingStatus,
      lastBillingSyncAt: subscription.lastBillingSyncAt?.toISOString() ?? null,
      lastBillingWebhookProcessedAt:
        (subscription as any).lastBillingWebhookProcessedAt?.toISOString() ?? null,
      lastBillingResolutionSource:
        (subscription as any).lastBillingResolutionSource ?? null,
      mismatchWarnings:
        dbPlanName !== "NONE" && dbPlanName !== planName
          ? [
              `Persisted DB plan ${dbPlanName} does not match effective plan ${planName}.`,
            ]
          : [],
    };
  }

  if (isDateInFuture(trialEndsAt)) {
    return {
      planName: "TRIAL",
      normalizedBillingStatus: null,
      active: true,
      status: deriveLifecycleStatus({
        planName: "TRIAL",
        active: true,
        billingStatus: null,
        trialEndsAt,
      }),
      starterModule: null,
      endsAt: trialEndsAt?.toISOString() ?? null,
      subscriptionId: store.subscription?.id ?? null,
      shopifyChargeId: store.subscription?.shopifyChargeId ?? null,
      planSource: "trial",
      dbPlanName,
      dbBillingStatus,
      lastBillingSyncAt: store.subscription?.lastBillingSyncAt?.toISOString() ?? null,
      lastBillingWebhookProcessedAt:
        (store.subscription as any)?.lastBillingWebhookProcessedAt?.toISOString() ?? null,
      lastBillingResolutionSource:
        (store.subscription as any)?.lastBillingResolutionSource ?? null,
      mismatchWarnings: [],
    };
  }

  return {
    planName: "NONE",
    normalizedBillingStatus: store.subscription?.billingStatus ?? "INACTIVE",
    active: false,
    status: deriveLifecycleStatus({
      planName: "NONE",
      active: false,
      billingStatus: store.subscription?.billingStatus ?? "INACTIVE",
      trialEndsAt,
    }),
    starterModule: null,
    endsAt:
      store.subscription?.endsAt?.toISOString() ??
      trialEndsAt?.toISOString() ??
      null,
    subscriptionId: store.subscription?.id ?? null,
    shopifyChargeId: store.subscription?.shopifyChargeId ?? null,
    planSource: "none",
    dbPlanName,
    dbBillingStatus,
    lastBillingSyncAt: store.subscription?.lastBillingSyncAt?.toISOString() ?? null,
    lastBillingWebhookProcessedAt:
      (store.subscription as any)?.lastBillingWebhookProcessedAt?.toISOString() ?? null,
    lastBillingResolutionSource:
      (store.subscription as any)?.lastBillingResolutionSource ?? null,
    mismatchWarnings: [],
  };
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

  const resolved = await resolveBillingState(shopDomain);

  if (resolved.planName !== "NONE" && resolved.planName !== "TRIAL") {
    return buildSubscriptionPayload({
      planName: resolved.planName,
      price: getPlanPrice(resolved.planName),
      trialDays:
        store.subscription?.plan?.trialDays ?? env.billing.trialDays,
      starterModule: resolved.starterModule,
      active: resolved.active,
      endsAt: resolved.endsAt ? new Date(resolved.endsAt) : null,
      trialStartedAt,
      trialEndsAt,
      billingStatus: resolved.normalizedBillingStatus,
      starterModuleSwitchAvailableAt: getStarterModuleSwitchAvailableAt(
        store.subscription?.moduleSwitchedAt
      ),
    });
  }

  if (resolved.planName === "TRIAL") {
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
    endsAt: store.subscription?.endsAt ?? trialEndsAt,
    trialStartedAt,
    trialEndsAt,
    billingStatus: store.subscription?.billingStatus ?? "INACTIVE",
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
      lastBillingResolutionSource: "cancel_api",
      lastBillingSubscriptionName: store.subscription.plan.name,
      endsAt: store.subscription.endsAt ?? new Date(),
    } as any,
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
      lastBillingResolutionSource: "starter_module_switch",
    } as any,
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
        lastBillingWebhookProcessedAt: new Date(),
        lastBillingResolutionSource: "webhook_app_subscriptions_update",
        lastBillingSubscriptionName: input.planName ?? store.subscription.plan.name,
        endsAt: currentPeriodEnd ?? new Date(),
      } as any,
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

    return {
      ...updated,
      plan: store.subscription.plan,
    };
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
      lastBillingWebhookProcessedAt: new Date(),
      lastBillingResolutionSource: "webhook_app_subscriptions_update",
      lastBillingSubscriptionName: input.planName ?? planName,
      cancelledAt: null,
      endsAt: currentPeriodEnd,
      starterModule:
        planName === "STARTER"
          ? normalizeStarterModule(store.subscription?.starterModule) ?? "trustAbuse"
          : null,
    } as any,
    create: {
      storeId: store.id,
      planId: plan.id,
      shopifyChargeId: input.shopifyChargeId ?? null,
      active: true,
      billingStatus: normalizedStatus,
      planActivatedAt: new Date(),
      lastBillingSyncAt: new Date(),
      lastBillingWebhookProcessedAt: new Date(),
      lastBillingResolutionSource: "webhook_app_subscriptions_update",
      lastBillingSubscriptionName: input.planName ?? planName,
      endsAt: currentPeriodEnd,
      starterModule: planName === "STARTER" ? "trustAbuse" : null,
    } as any,
    include: {
      plan: true,
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

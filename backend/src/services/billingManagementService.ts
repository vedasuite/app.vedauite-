import { prisma } from "../db/prismaClient";
import { env } from "../config/env";
import {
  getPlanPrice,
  normalizePlanName,
  normalizeStarterModule,
  normalizeStarterModuleLabel,
  type BillingPlanName,
  type CurrentSubscription,
  type StarterModule,
} from "../billing/capabilities";
import {
  createAppSubscription,
  getActiveAppSubscription,
} from "./shopifyAdminService";
import {
  cancelSubscription,
  getCurrentSubscription,
  reconcileStoreSubscriptionFromWebhook,
  resolveBillingState,
  updateStarterModuleSelection,
} from "./subscriptionService";

const MANAGED_PAID_PLANS: BillingPlanName[] = ["STARTER", "GROWTH", "PRO"];
const BILLING_INTENT_TTL_MS = 60 * 60 * 1000;
const PENDING_INTENT_STATUSES = ["CREATING", "PENDING_APPROVAL"] as const;

type PendingIntentStatus =
  | "CREATING"
  | "PENDING_APPROVAL"
  | "CONFIRMED"
  | "FAILED"
  | "CANCELLED"
  | "EXPIRED";

type BillingActionType =
  | "start_paid_plan"
  | "upgrade"
  | "downgrade"
  | "switch"
  | "update_starter_module"
  | "noop";

type BillingPlanCard = {
  planName: BillingPlanName;
  price: number;
  shortSummary: string;
  current: boolean;
  recommendedForCurrentState: boolean;
  action: "CURRENT_PLAN" | "CHOOSE_PLAN" | "UPGRADE" | "DOWNGRADE" | "SWITCH";
  requiresStarterModule: boolean;
};

type SerializedBillingIntent = {
  id: string;
  requestedPlanName: BillingPlanName;
  requestedStarterModule: StarterModule | null;
  actionType: BillingActionType;
  status: PendingIntentStatus;
  confirmationUrl: string | null;
  shopifyChargeId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  confirmedAt: string | null;
  cancelledAt: string | null;
  expiresAt: string | null;
};

export type BillingManagementState = {
  subscription: CurrentSubscription;
  billing: Awaited<ReturnType<typeof resolveBillingState>>;
  pendingIntent: SerializedBillingIntent | null;
  availableActions: {
    canManagePlans: boolean;
    canCancelSubscription: boolean;
    canChangeStarterModule: boolean;
    awaitingApproval: boolean;
  };
  plans: BillingPlanCard[];
};

export type BillingPlanChangeResult =
  | {
      outcome: "NOOP";
      message: string;
      state: BillingManagementState;
    }
  | {
      outcome: "UPDATED";
      message: string;
      state: BillingManagementState;
    }
  | {
      outcome: "REDIRECT_REQUIRED";
      confirmationUrl: string;
      pendingIntent: SerializedBillingIntent;
      state: BillingManagementState;
    };

function planSummary(planName: BillingPlanName) {
  switch (planName) {
    case "STARTER":
      return "Starter includes one selected module plus reports and settings.";
    case "GROWTH":
      return "Growth includes Trust & Abuse, Competitor, and baseline Pricing & Profit coverage.";
    case "PRO":
      return "Pro includes all core modules and the full profit engine.";
    case "TRIAL":
      return "Trial provides temporary evaluation access before a paid plan is selected.";
    default:
      return "No paid subscription is active yet.";
  }
}

function planRank(planName: BillingPlanName) {
  switch (planName) {
    case "STARTER":
      return 1;
    case "GROWTH":
      return 2;
    case "PRO":
      return 3;
    default:
      return 0;
  }
}

function serializeIntent(intent: any): SerializedBillingIntent {
  return {
    id: intent.id,
    requestedPlanName: (normalizePlanName(intent.requestedPlanName) ?? "NONE") as BillingPlanName,
    requestedStarterModule: normalizeStarterModule(intent.requestedStarterModule),
    actionType: intent.actionType,
    status: intent.status,
    confirmationUrl: intent.confirmationUrl ?? null,
    shopifyChargeId: intent.shopifyChargeId ?? null,
    errorCode: intent.errorCode ?? null,
    errorMessage: intent.errorMessage ?? null,
    createdAt: intent.createdAt.toISOString(),
    updatedAt: intent.updatedAt.toISOString(),
    confirmedAt: intent.confirmedAt?.toISOString() ?? null,
    cancelledAt: intent.cancelledAt?.toISOString() ?? null,
    expiresAt: intent.expiresAt?.toISOString() ?? null,
  };
}

async function getStoreForBilling(shopDomain: string) {
  const store = await prisma.store.findUnique({
    where: { shop: shopDomain },
    include: {
      subscription: {
        include: {
          plan: true,
        },
      },
      billingPlanIntents: {
        orderBy: { createdAt: "desc" },
        take: 5,
      },
    },
  });

  if (!store) {
    throw new Error("Store not found");
  }

  return store;
}

async function expireIntentIfNeeded(intent: any) {
  if (!intent?.expiresAt) {
    return intent;
  }

  if (
    PENDING_INTENT_STATUSES.includes(intent.status) &&
    intent.expiresAt.getTime() <= Date.now()
  ) {
    return prisma.billingPlanIntent.update({
      where: { id: intent.id },
      data: {
        status: "EXPIRED",
        errorCode: "BILLING_APPROVAL_EXPIRED",
        errorMessage: "Shopify billing approval expired before confirmation completed.",
      },
    });
  }

  return intent;
}

async function getLatestRelevantIntent(storeId: string) {
  const latest = await prisma.billingPlanIntent.findFirst({
    where: { storeId },
    orderBy: { createdAt: "desc" },
  });

  if (!latest) {
    return null;
  }

  return expireIntentIfNeeded(latest);
}

function computePlanCardAction(current: CurrentSubscription, target: BillingPlanName): BillingPlanCard["action"] {
  if (current.planName === target && current.active) {
    return "CURRENT_PLAN";
  }

  if (current.planName === "NONE" || current.planName === "TRIAL") {
    return "CHOOSE_PLAN";
  }

  return planRank(target) > planRank(current.planName) ? "UPGRADE" : "DOWNGRADE";
}

function buildPlanCards(current: CurrentSubscription): BillingPlanCard[] {
  return MANAGED_PAID_PLANS.map((planName) => ({
    planName,
    price: getPlanPrice(planName),
    shortSummary: planSummary(planName),
    current: current.planName === planName && current.active,
    recommendedForCurrentState:
      (current.planName === "NONE" || current.planName === "TRIAL") &&
      planName === "STARTER",
    action: computePlanCardAction(current, planName),
    requiresStarterModule: planName === "STARTER",
  }));
}

function buildReturnPath(returnPath?: string | null) {
  if (!returnPath || typeof returnPath !== "string") {
    return "/subscription";
  }

  if (!returnPath.startsWith("/") || returnPath.startsWith("//")) {
    return "/subscription";
  }

  return returnPath;
}

function buildActionType(current: CurrentSubscription, requestedPlan: BillingPlanName): BillingActionType {
  if (current.planName === requestedPlan) {
    return "switch";
  }

  if (current.planName === "NONE" || current.planName === "TRIAL") {
    return "start_paid_plan";
  }

  return planRank(requestedPlan) > planRank(current.planName) ? "upgrade" : "downgrade";
}

export async function getBillingManagementState(
  shopDomain: string
): Promise<BillingManagementState> {
  const [store, subscription, billing] = await Promise.all([
    getStoreForBilling(shopDomain),
    getCurrentSubscription(shopDomain),
    resolveBillingState(shopDomain),
  ]);

  const latestIntent = await getLatestRelevantIntent(store.id);

  return {
    subscription,
    billing,
    pendingIntent:
      latestIntent &&
      ["CREATING", "PENDING_APPROVAL", "FAILED", "CONFIRMED", "EXPIRED"].includes(
        latestIntent.status
      )
        ? serializeIntent(latestIntent)
        : null,
    availableActions: {
      canManagePlans: subscription.capabilities["billing.planManagement"],
      canCancelSubscription:
        subscription.planName !== "NONE" &&
        subscription.planName !== "TRIAL" &&
        !!billing.shopifyChargeId,
      canChangeStarterModule: subscription.planName === "STARTER" && subscription.active,
      awaitingApproval:
        !!latestIntent &&
        ["CREATING", "PENDING_APPROVAL"].includes(latestIntent.status),
    },
    plans: buildPlanCards(subscription),
  };
}

async function createPlanRecordIfMissing(planName: BillingPlanName) {
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

async function cancelSupersededPendingIntents(storeId: string, keepIntentId?: string) {
  await prisma.billingPlanIntent.updateMany({
    where: {
      storeId,
      status: { in: [...PENDING_INTENT_STATUSES] },
      ...(keepIntentId ? { NOT: { id: keepIntentId } } : {}),
    },
    data: {
      status: "CANCELLED",
      cancelledAt: new Date(),
      errorCode: "SUPERSEDED",
      errorMessage: "Superseded by a newer billing plan change request.",
    },
  });
}

export async function requestBillingPlanChange(input: {
  shopDomain: string;
  requestedPlan: BillingPlanName;
  starterModule?: StarterModule | null;
  host?: string | null;
  returnPath?: string | null;
}): Promise<BillingPlanChangeResult> {
  const requestedPlan = input.requestedPlan;
  if (!MANAGED_PAID_PLANS.includes(requestedPlan)) {
    throw new Error("Only paid plans can be requested through the billing change flow.");
  }

  const normalizedStarterModule = normalizeStarterModule(input.starterModule);
  if (requestedPlan === "STARTER" && !normalizedStarterModule) {
    throw new Error("Starter plan requires selecting a starter module.");
  }

  const [store, current] = await Promise.all([
    getStoreForBilling(input.shopDomain),
    getCurrentSubscription(input.shopDomain),
  ]);

  if (current.planName === requestedPlan && current.active) {
    if (
      requestedPlan === "STARTER" &&
      normalizedStarterModule &&
      current.starterModule !== normalizedStarterModule
    ) {
      await updateStarterModuleSelection(input.shopDomain, normalizedStarterModule);
      return {
        outcome: "UPDATED",
        message: `Starter now uses ${normalizeStarterModuleLabel(normalizedStarterModule)}.`,
        state: await getBillingManagementState(input.shopDomain),
      };
    }

    return {
      outcome: "NOOP",
      message: `${requestedPlan} is already the active plan.`,
      state: await getBillingManagementState(input.shopDomain),
    };
  }

  const existingPending = await prisma.billingPlanIntent.findFirst({
    where: {
      storeId: store.id,
      status: { in: [...PENDING_INTENT_STATUSES] },
    },
    orderBy: { createdAt: "desc" },
  });

  if (
    existingPending &&
    existingPending.requestedPlanName === requestedPlan &&
    normalizeStarterModule(existingPending.requestedStarterModule) ===
      normalizedStarterModule &&
    existingPending.confirmationUrl
  ) {
    return {
      outcome: "REDIRECT_REQUIRED",
      confirmationUrl: existingPending.confirmationUrl,
      pendingIntent: serializeIntent(existingPending),
      state: await getBillingManagementState(input.shopDomain),
    };
  }

  await createPlanRecordIfMissing(requestedPlan);

  const actionType = buildActionType(current, requestedPlan);
  const expiresAt = new Date(Date.now() + BILLING_INTENT_TTL_MS);
  const returnPath = buildReturnPath(input.returnPath);
  const createdIntent = await prisma.billingPlanIntent.create({
    data: {
      storeId: store.id,
      requestedPlanName: requestedPlan,
      requestedStarterModule: normalizedStarterModule,
      actionType,
      status: "CREATING",
      host: input.host ?? null,
      returnPath,
      expiresAt,
    },
  });

  try {
    const returnUrl = new URL("/billing/activate", env.shopifyAppUrl);
    returnUrl.searchParams.set("shop", input.shopDomain);
    returnUrl.searchParams.set("intentId", createdIntent.id);
    if (input.host) {
      returnUrl.searchParams.set("host", input.host);
    }

    const result = await createAppSubscription({
      shopDomain: input.shopDomain,
      name: `VedaSuite AI - ${requestedPlan}`,
      price: getPlanPrice(requestedPlan),
      returnUrl: returnUrl.toString(),
      trialDays: requestedPlan === "STARTER" ? env.billing.trialDays : 0,
      test: env.billing.testMode,
    });

    await cancelSupersededPendingIntents(store.id, createdIntent.id);

    const pendingIntent = await prisma.billingPlanIntent.update({
      where: { id: createdIntent.id },
      data: {
        status: "PENDING_APPROVAL",
        confirmationUrl: result.confirmationUrl,
        shopifyChargeId: result.appSubscription?.id ?? null,
      },
    });

    await prisma.billingAuditLog.create({
      data: {
        storeId: store.id,
        subscriptionId: store.subscription?.id ?? null,
        eventType: "billing.intent_created",
        previousPlanName: current.planName,
        nextPlanName: requestedPlan,
        previousStarterModule: current.starterModule,
        nextStarterModule: normalizedStarterModule,
        billingStatus: current.billingStatus ?? null,
        metadataJson: JSON.stringify({
          actionType,
          intentId: pendingIntent.id,
          requestedStarterModule: normalizedStarterModule,
        }),
      },
    });

    return {
      outcome: "REDIRECT_REQUIRED",
      confirmationUrl: result.confirmationUrl!,
      pendingIntent: serializeIntent(pendingIntent),
      state: await getBillingManagementState(input.shopDomain),
    };
  } catch (error) {
    await prisma.billingPlanIntent.update({
      where: { id: createdIntent.id },
      data: {
        status: "FAILED",
        errorCode: "BILLING_REQUEST_FAILED",
        errorMessage:
          error instanceof Error ? error.message : "Unable to create Shopify billing request.",
      },
    });
    throw error;
  }
}

async function applyConfirmedStarterModule(
  shopDomain: string,
  starterModule: StarterModule | null
) {
  if (!starterModule) {
    return;
  }

  const store = await prisma.store.findUnique({
    where: { shop: shopDomain },
    include: {
      subscription: true,
    },
  });

  if (!store?.subscription) {
    return;
  }

  await prisma.storeSubscription.update({
    where: { id: store.subscription.id },
    data: {
      starterModule,
      moduleSwitchedAt: new Date(),
      lastBillingSyncAt: new Date(),
      lastBillingResolutionSource: "billing_callback_confirmed",
      lastBillingSubscriptionName: "STARTER",
    } as any,
  });
}

export async function confirmBillingApprovalReturn(input: {
  shopDomain: string;
  intentId?: string | null;
}): Promise<BillingManagementState> {
  const store = await getStoreForBilling(input.shopDomain);
  const intent = input.intentId
    ? await prisma.billingPlanIntent.findFirst({
        where: {
          id: input.intentId,
          storeId: store.id,
        },
      })
    : await prisma.billingPlanIntent.findFirst({
        where: {
          storeId: store.id,
          status: { in: [...PENDING_INTENT_STATUSES] },
        },
        orderBy: { createdAt: "desc" },
      });

  if (intent) {
    await expireIntentIfNeeded(intent);
  }

  const activeSubscription = await getActiveAppSubscription(input.shopDomain);
  if (!activeSubscription) {
    if (intent) {
      await prisma.billingPlanIntent.update({
        where: { id: intent.id },
        data: {
          status: "FAILED",
          errorCode: "BILLING_NOT_CONFIRMED",
          errorMessage: "No active Shopify app subscription was found after returning from approval.",
        },
      });
    }
    throw new Error("No active Shopify app subscription was found after returning from approval.");
  }

  const effectivePlan = normalizePlanName(activeSubscription.name);
  if (!effectivePlan || effectivePlan === "TRIAL" || effectivePlan === "NONE") {
    throw new Error("Shopify returned an unsupported billing plan.");
  }

  if (intent && effectivePlan !== normalizePlanName(intent.requestedPlanName)) {
    await prisma.billingPlanIntent.update({
      where: { id: intent.id },
      data: {
        status: "FAILED",
        errorCode: "BILLING_PLAN_MISMATCH",
        errorMessage: `Shopify approved ${effectivePlan} but the pending intent expected ${intent.requestedPlanName}.`,
        shopifyChargeId: activeSubscription.id,
      },
    });
    throw new Error(
      `Shopify approved ${effectivePlan} but the pending intent expected ${intent.requestedPlanName}.`
    );
  }

  await reconcileStoreSubscriptionFromWebhook({
    shopDomain: input.shopDomain,
    shopifyChargeId: activeSubscription.id,
    planName: activeSubscription.name,
    status: activeSubscription.status,
    currentPeriodEnd: activeSubscription.currentPeriodEnd ?? null,
  });

  const confirmedStarterModule = normalizeStarterModule(
    intent?.requestedStarterModule ?? null
  );
  if (effectivePlan === "STARTER" && confirmedStarterModule) {
    await applyConfirmedStarterModule(input.shopDomain, confirmedStarterModule);
  }

  if (intent) {
    await prisma.billingPlanIntent.update({
      where: { id: intent.id },
      data: {
        status: "CONFIRMED",
        confirmedAt: new Date(),
        errorCode: null,
        errorMessage: null,
        shopifyChargeId: activeSubscription.id,
      },
    });
  }

  return getBillingManagementState(input.shopDomain);
}

export async function cancelBillingPlan(
  shopDomain: string
): Promise<BillingManagementState> {
  await cancelSubscription(shopDomain);
  return getBillingManagementState(shopDomain);
}

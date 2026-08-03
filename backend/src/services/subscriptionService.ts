import { HttpError } from "../lib/httpError";
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
  getPlanPrice,
  normalizePlanName,
  resolveEntitlements as resolveEntitlementsForPlan,
  normalizeStarterModule,
  normalizeStarterModuleLabel,
  type BillingPlanName,
  type CanonicalModuleKey,
  type CurrentSubscription,
  type StarterModule,
  type SubscriptionLifeCycleStatus,
} from "../billing/capabilities";
import { computeTrialState } from "../billing/trialState";
import {
  hasExistingTrialHistory,
  resolveTrialWindowOnApproval,
} from "./trialEligibilityService";
import { logEvent } from "./observabilityService";

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
  lifecycle:
    | "no_subscription"
    | "pending_approval"
    | "active"
    | "cancelled"
    | "frozen"
    | "test_charge"
    | "uninstalled"
    | "unknown_error";
  planName: BillingPlanName;
  /** Alias of `planName` — the plan the merchant selected/is billed for. */
  selectedPlanName: BillingPlanName;
  planTier: "none" | "trial" | "starter" | "growth" | "pro";
  normalizedBillingStatus: string | null;
  active: boolean;
  accessActive: boolean;
  verified: boolean;
  status: SubscriptionLifeCycleStatus;
  starterModule: StarterModule | null;
  endsAt: string | null;
  renewalAt: string | null;
  showRenewalDate: boolean;
  /**
   * Canonical trial-active flag. Computed once from persisted Store trial
   * dates only (billing/trialState.ts) — never from planName, never from
   * whether a paid subscription is active. A merchant can have
   * selectedPlanName=PRO and trialActive=true at the same time.
   */
  trialActive: boolean;
  trialStartedAt: string | null;
  trialEndsAt: string | null;
  trialDaysRemaining: number;
  /** True when trial dates are not both persisted — read-only signal, never backfilled. */
  trialDatesIncomplete: boolean;
  /**
   * Is this shop still entitled to its ONE free trial?
   *
   * Authoritative and durable: true only when NO ShopTrialHistory row exists
   * for the shop. Any row — active or long expired — makes this false, which is
   * what survives uninstall/reinstall (ShopTrialHistory has no FK to Store, so
   * it outlives a shop/redact purge). An already-running trial is also false,
   * because starting one writes the history row.
   *
   * This is the ONLY field any surface may use to decide whether to promise a
   * free trial. It must never be inferred from trialActive, planName, lifecycle,
   * trial dates, or subscription state — none of those distinguish "never had a
   * trial" from "already used it", which is exactly the distinction that was
   * showing returning merchants a trial the backend would not grant.
   *
   * Fails CLOSED: a database error yields false, never true, so a transient
   * failure can only under-promise. See trialEligibilityService.
   */
  trialEligible: boolean;
  /** Mirrors trialActive — kept as a separate field for existing consumers. */
  showTrialDate: boolean;
  /** "trial" while trialActive, otherwise the tier implied by selectedPlanName. */
  accessTier: "none" | "trial" | "starter" | "growth" | "pro";
  /** Alias of normalizedBillingStatus. */
  subscriptionStatus: string | null;
  /** Alias of lifecycle — the merchant-facing display status. */
  billingDisplayStatus: ResolvedBillingState["lifecycle"];
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
  pendingRequestedStarterModule: StarterModule | null;
  merchantTitle: string;
  merchantDescription: string;
  mismatchWarnings: string[];
};

export type CanonicalEntitlementState = {
  tier: "none" | "trial" | "starter" | "growth" | "pro";
  planName: BillingPlanName;
  starterModule: StarterModule | null;
  accessActive: boolean;
  verified: boolean;
  modules: ReturnType<typeof buildModuleAccessFromCapabilities>;
  featureAccess: ReturnType<typeof buildFeatureAccessFromCapabilities>;
  capabilities: ReturnType<typeof buildCapabilities>;
  title: string;
  description: string;
};

const storeWithSubscriptionArgs =
  Prisma.validator<Prisma.StoreDefaultArgs>()({
    include: {
      subscription: {
        include: {
          plan: true,
        },
      },
      billingPlanIntents: {
        orderBy: {
          createdAt: "desc",
        },
        take: 1,
      },
    },
  });

type StoreWithSubscription = Prisma.StoreGetPayload<
  typeof storeWithSubscriptionArgs
>;

function normalizeTier(planName: BillingPlanName): ResolvedBillingState["planTier"] {
  switch (planName) {
    case "TRIAL":
      return "trial";
    case "STARTER":
      return "starter";
    case "GROWTH":
      return "growth";
    case "PRO":
      return "pro";
    default:
      return "none";
  }
}

function isPendingIntentStatus(value?: string | null) {
  return value === "CREATING" || value === "PENDING_APPROVAL";
}

function isCancelledBillingStatus(value?: string | null) {
  return ["CANCELLED", "EXPIRED", "DECLINED"].includes((value ?? "").toUpperCase());
}

function isFrozenBillingStatus(value?: string | null) {
  return ["FROZEN", "PAUSED", "SUSPENDED", "PAST_DUE", "FROZEN_DUE_TO_MERCHANT"].includes(
    (value ?? "").toUpperCase()
  );
}

function isActiveBillingStatus(value?: string | null) {
  return ["ACTIVE", "ACCEPTED", "PENDING"].includes((value ?? "").toUpperCase());
}

export function deriveCanonicalBillingLifecycle(input: {
  uninstalled: boolean;
  pendingApproval: boolean;
  planName: BillingPlanName;
  accessActive: boolean;
  billingStatus: string | null;
  isTestCharge: boolean;
  /**
   * Canonical trial-active flag (billing/trialState.ts). Optional/defaulted
   * to false only so existing call sites that predate the trial fix keep
   * compiling — every live caller in this codebase now passes it explicitly.
   */
  trialActive?: boolean;
}) {
  void input.isTestCharge;
  const trialActive = input.trialActive ?? false;

  if (input.uninstalled) {
    return "uninstalled" as const;
  }

  if (input.pendingApproval) {
    return "pending_approval" as const;
  }

  if (isFrozenBillingStatus(input.billingStatus)) {
    return "frozen" as const;
  }

  if (isCancelledBillingStatus(input.billingStatus)) {
    return "cancelled" as const;
  }

  if (
    trialActive ||
    (input.planName !== "NONE" && input.accessActive && isActiveBillingStatus(input.billingStatus))
  ) {
    return "active" as const;
  }

  if (input.planName === "NONE" && !trialActive) {
    return "no_subscription" as const;
  }

  return "unknown_error" as const;
}

/**
 * Copy for a merchant with no active subscription. Split out because it is
 * reachable from more than one lifecycle (`no_subscription`, and `cancelled`
 * once access has lapsed) and every one of those paths must respect trial
 * eligibility — promising a "7-day free trial" to a shop whose one trial is
 * already spent is the bug this function exists to prevent.
 */
function buildChoosePlanCopy(trialEligible: boolean) {
  if (trialEligible) {
    return {
      title: "Choose a plan to start your 7-day free trial",
      description:
        "Select STARTER, GROWTH or PRO and approve it in Shopify. You will not be charged until the trial ends.",
    };
  }

  return {
    title: "Choose a plan to activate VedaSuite",
    description:
      "Your free trial has already been used. Select a plan to continue using VedaSuite.",
  };
}

function buildMerchantBillingCopy(input: {
  lifecycle: ResolvedBillingState["lifecycle"];
  planName: BillingPlanName;
  trialActive: boolean;
  trialEligible: boolean;
  pendingRequestedPlanName: BillingPlanName | null;
  accessActive: boolean;
  endsAt: Date | null;
  trialEndsAt: Date | null;
}) {
  switch (input.lifecycle) {
    case "pending_approval":
      return {
        title: input.pendingRequestedPlanName
          ? `${input.pendingRequestedPlanName} approval is waiting in Shopify`
          : "Plan approval is waiting in Shopify",
        description: input.planName !== "NONE" && input.accessActive
          ? `Your current ${input.planName} subscription stays active until Shopify confirms the requested change.`
          : "Open Shopify billing and approve the requested plan before VedaSuite updates your subscription.",
      };
    case "active":
      // trialActive is checked first and independently of planName — a
      // merchant can have selectedPlanName=PRO (or any paid plan) while still
      // inside their local trial window, and must see trial copy, not "PRO
      // plan is active". Plan-selected trial model: the copy names the
      // SELECTED plan, since only that plan's features are unlocked — never
      // a generic "full-access trial".
      if (input.trialActive && input.planName !== "NONE") {
        const planLabel = planDisplayLabel(input.planName);
        return {
          title: `${planLabel} trial active`,
          description: input.trialEndsAt
            ? `Your ${planLabel} features are unlocked until ${input.trialEndsAt.toLocaleString()}. You will not be charged before then.`
            : `Your ${planLabel} features are unlocked during the trial. You will not be charged before it ends.`,
        };
      }
      return {
        title: `${input.planName} plan is active`,
        description:
          "Your subscription is active and included features are available.",
      };
    case "test_charge":
      return {
        title: `${input.planName} plan is active`,
        description:
          "Your subscription is active and included features are available.",
      };
    case "cancelled":
      // Once access has lapsed this is functionally the choose-a-plan state, so
      // it must not promise a trial to an ineligible shop either.
      if (!input.accessActive) {
        const choosePlan = buildChoosePlanCopy(input.trialEligible);
        return {
          title: "The subscription has been cancelled",
          description: input.trialEligible
            ? "Choose a plan in billing if you want to restore paid features."
            : choosePlan.description,
        };
      }
      return {
        title: `${input.planName} is cancelled and stays active until the end of the current period`,
        description: input.endsAt
          ? `Included features remain available until ${input.endsAt.toLocaleString()}.`
          : "Choose a plan in billing if you want to restore paid features.",
      };
    case "frozen":
      return {
        title: "Billing needs attention",
        description:
          "Shopify has paused or restricted the subscription. Resolve billing in Shopify before VedaSuite can restore full access.",
      };
    case "uninstalled":
      return {
        title: "VedaSuite is disconnected from Shopify",
        description:
          "Reconnect the app in Shopify before billing and included features can be verified again.",
      };
    case "no_subscription":
      return buildChoosePlanCopy(input.trialEligible);
    default:
      return {
        title: "Billing status could not be verified",
        description:
          "VedaSuite could not confirm the latest Shopify billing state yet. Refresh the page or try again in a moment.",
      };
  }
}

/** "STARTER" -> "Starter" — for merchant-facing copy only. */
function planDisplayLabel(planName: BillingPlanName): string {
  return planName.charAt(0) + planName.slice(1).toLowerCase();
}

export function buildCanonicalEntitlements(input: {
  planName: BillingPlanName;
  starterModule: StarterModule | null;
  accessActive: boolean;
  verified: boolean;
  trialActive: boolean;
  /**
   * Trial eligibility, when the caller knows it. Only `true` unlocks the
   * "start your 7-day free trial" wording below. Left undefined (eligibility
   * not established), the copy stays neutral — it must never promise a trial
   * off the back of `planName === "NONE"` alone, which is precisely how an
   * already-used-trial shop was being offered another one.
   */
  trialEligible?: boolean;
}): CanonicalEntitlementState {
  // Plan-selected trial model: the trial does not widen entitlements to
  // every module — it only means Shopify has not billed for the SELECTED
  // plan yet. A merchant who approved STARTER during their trial gets
  // exactly STARTER's entitlements, same as if they were already paying.
  // "TRIAL" is never a real chargeable plan (legacy pre-dating this model),
  // so it can never itself grant trial access.
  const grantedByTrial =
    input.trialActive && input.planName !== "NONE" && input.planName !== "TRIAL";
  const accessActive = input.accessActive || grantedByTrial;

  // A legacy standalone TRIAL plan always collapses to NONE — there is no
  // way to know which real plan (STARTER/GROWTH/PRO) it should represent.
  const effectivePlanName =
    accessActive
      ? input.planName === "TRIAL"
        ? "NONE"
        : input.planName
      : "NONE";

  const resolved = resolveEntitlementsForPlan({
    plan: effectivePlanName,
    billingStatus: input.accessActive ? "ACTIVE" : "INACTIVE",
    starterModule: input.starterModule,
    trialActive: grantedByTrial,
  });
  const capabilities = resolved.capabilities;
  const modules = resolved.moduleAccess;
  const featureAccess = resolved.featureAccess;
  const tier = normalizeTier(effectivePlanName);
  const planLabel = planDisplayLabel(effectivePlanName);

  return {
    tier,
    planName: effectivePlanName,
    // The Starter module selection is retained through the trial so it is
    // already in place when Shopify starts billing.
    starterModule:
      effectivePlanName === "STARTER" ? normalizeStarterModule(input.starterModule) : null,
    accessActive,
    verified: input.verified,
    modules,
    featureAccess,
    capabilities,
    title: grantedByTrial
      ? `${planLabel} trial active`
      : effectivePlanName === "NONE"
      ? "Limited access"
      : `${effectivePlanName} access`,
    description: grantedByTrial
      ? `Your ${planLabel} features are unlocked during the trial. You will not be charged until the trial ends.`
      : effectivePlanName === "STARTER" && input.starterModule
      ? `${normalizeStarterModuleLabel(input.starterModule)} is the active Starter workflow.`
      : effectivePlanName === "NONE"
      ? input.trialEligible === true
        ? "Choose a plan to start your 7-day free trial."
        : "Choose a plan to activate VedaSuite."
      : "Included features are based on the active subscription.",
  };
}

function deriveLifecycleStatus(input: {
  planName: BillingPlanName;
  /** Canonical trial-active flag — never inferred from planName. */
  trialActive: boolean;
  /** Whether trial dates were ever persisted, regardless of whether still open. */
  hadTrial: boolean;
  active: boolean;
  billingStatus: string | null;
}): SubscriptionLifeCycleStatus {
  if (input.trialActive) {
    return "trial_active";
  }

  if (input.planName === "NONE") {
    if (input.billingStatus === "CANCELLED") {
      return "cancelled";
    }
    return input.hadTrial ? "trial_expired" : "inactive";
  }

  if (input.billingStatus === "CANCELLED") {
    return "cancelled";
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

function logSubscriptionSaved(input: {
  shop: string;
  savedPlan: BillingPlanName;
  savedStarterModule: StarterModule | null;
}) {
  logEvent("info", "billing.subscription_saved", input);
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
  /** Canonical trial-active flag, passed in — never re-derived here. */
  trialActive: boolean;
  trialDaysRemaining: number;
  /** Canonical trial eligibility, passed in — never re-derived here. */
  trialEligible: boolean;
  billingStatus: string | null;
  starterModuleSwitchAvailableAt?: Date | null;
}): CurrentSubscription {
  const entitlement = buildCanonicalEntitlements({
    planName: input.planName,
    starterModule: input.starterModule,
    accessActive: input.active,
    verified: true,
    trialActive: input.trialActive,
    trialEligible: input.trialEligible,
  });
  const capabilities = entitlement.capabilities;

  return {
    planName: entitlement.planName,
    price: input.price,
    trialDays: input.trialDays,
    starterModule: entitlement.starterModule,
    active: entitlement.accessActive,
    endsAt: input.endsAt?.toISOString() ?? null,
    trialStartedAt: input.trialStartedAt?.toISOString() ?? null,
    trialEndsAt: input.trialEndsAt?.toISOString() ?? null,
    trialActive: input.trialActive,
    trialDaysRemaining: input.trialDaysRemaining,
    trialEligible: input.trialEligible,
    status: deriveLifecycleStatus({
      planName: entitlement.planName,
      trialActive: input.trialActive,
      hadTrial: !!input.trialEndsAt,
      active: entitlement.accessActive,
      billingStatus: input.billingStatus,
    }),
    billingStatus: input.billingStatus,
    starterModuleSwitchAvailableAt:
      input.starterModuleSwitchAvailableAt?.toISOString() ?? null,
    enabledModules: entitlement.modules,
    featureAccess: entitlement.featureAccess,
    capabilities,
  };
}

function getStarterModuleSwitchAvailableAt(moduleSwitchedAt?: Date | null) {
  void moduleSwitchedAt;
  return null;
}

async function reconcileCurrentSubscriptionFromShopify(store: NonNullable<StoreWithSubscription>) {
  const activeSubscription = await getActiveAppSubscription(store.shop);

  if (!activeSubscription) {
    return null;
  }

  // getActiveAppSubscription deliberately also returns PENDING subscriptions —
  // other callers (the stale-intent check in billingManagementService) need to
  // know when one is awaiting approval. This path must not: it writes
  // active: true, and a subscription the merchant has not approved yet must
  // never be reconciled into a locally active one.
  const shopifyStatus = activeSubscription.status?.toUpperCase?.() ?? "";
  if (shopifyStatus !== "ACTIVE" && shopifyStatus !== "ACCEPTED") {
    logEvent("info", "billing.shopify_reconcile_skipped_unapproved", {
      shop: store.shop,
      shopifyStatus,
      shopifyChargeId: activeSubscription.id,
    });
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
      ? normalizeStarterModule(store.subscription?.starterModule) ?? "fraud"
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

  logSubscriptionSaved({
    shop: store.shop,
    savedPlan: planName,
    savedStarterModule: starterModule,
  });

  return nextSubscription;
}

function isPaidSubscriptionActive(
  subscription?: { active: boolean; endsAt: Date | null; billingStatus?: string | null } | null
) {
  if (!subscription?.active) {
    return false;
  }

  // Defense in depth: a PENDING subscription is never a live paid
  // subscription, regardless of the `active` flag. New writes can no longer
  // produce this combination (PENDING never activates), but a row written
  // before that guard existed could still carry active: true + PENDING, and
  // must not be treated as the current paid plan.
  if ((subscription.billingStatus ?? "").toUpperCase() === "PENDING") {
    return false;
  }

  if (!subscription.endsAt) {
    return true;
  }

  return subscription.endsAt.getTime() > Date.now();
}

/**
 * The canonical billing-state resolver. Every backend consumer (Billing,
 * Dashboard, Onboarding, app-state, entitlement resolution) must call this —
 * or read from its return value — rather than re-deriving trial or
 * subscription state independently.
 *
 * Read-only: never initializes, extends, or persists trial dates. Trial
 * dates are written exactly once, only on genuine first installation
 * (authRoutes.ts / shopifyConnectionService.ts). A temporary Shopify
 * reconciliation failure here never creates, extends, or reactivates a
 * trial — it just leaves the persisted subscription state as-is.
 *
 * The open local trial and an active paid subscription are independent,
 * additive facts: a merchant can have selectedPlanName=PRO (an active
 * Shopify subscription) AND trialActive=true (their local 7-day window
 * hasn't closed yet) at the same time. Neither one suppresses the other.
 */
export async function resolveBillingState(
  shopDomain: string
): Promise<ResolvedBillingState> {
  const store = await prisma.store.findUnique({
    where: { shop: shopDomain },
    ...storeWithSubscriptionArgs,
  });

  if (!store) {
    throw new HttpError(404, "Store not found.");
  }

  // Canonical trial state — read-only, derived purely from persisted dates.
  const trial = computeTrialState({
    trialStartedAt: store.trialStartedAt,
    trialEndsAt: store.trialEndsAt,
  });

  // Canonical trial ELIGIBILITY — a separate question from trial state, and the
  // only thing any surface may use to promise a free trial.
  //
  // Read-only (no-write-on-read is preserved: hasExistingTrialHistory performs a
  // single findUnique and never writes). It fails closed to "already used", so a
  // DB error yields trialEligible=false and is logged by that service — never a
  // guess of true, which would promise a trial the billing path would not grant.
  //
  // The `&& !trial.trialActive` term is defence in depth: starting a trial always
  // writes the history row, so an open window already implies ineligible.
  const trialEligible = !(await hasExistingTrialHistory(shopDomain)) && !trial.trialActive;

  const dbPlanName = normalizePlanName(store.subscription?.plan?.name) ?? "NONE";

  // Under the plan-selected trial model, having no trial dates yet is the
  // NORMAL state for any shop that hasn't approved a plan — not an anomaly.
  // Only warn when a plan record exists (an approval happened at some
  // point) but trial dates are still missing, which would indicate the
  // approval-time grant genuinely failed.
  if (trial.trialDatesIncomplete && !store.uninstalledAt && dbPlanName !== "NONE") {
    logEvent("warn", "billing.trial_dates_incomplete", {
      shop: shopDomain,
      hasTrialStartedAt: !!store.trialStartedAt,
      hasTrialEndsAt: !!store.trialEndsAt,
    });
  }
  const dbBillingStatus = store.subscription?.billingStatus ?? null;
  const latestIntent = store.billingPlanIntents[0] ?? null;
  const pendingIntentStatus = latestIntent?.status ?? null;
  const pendingRequestedPlanName =
    normalizePlanName(latestIntent?.requestedPlanName) ?? null;
  const pendingRequestedStarterModule = normalizeStarterModule(
    latestIntent?.requestedStarterModule
  );

  let subscription = store.subscription;
  let reconciledFromShopify = false;

  if (!isPaidSubscriptionActive(subscription) || !subscription?.plan) {
    const reconciled = await reconcileCurrentSubscriptionFromShopify(store).catch((error) => {
      // A reconciliation failure must never create, extend, or reactivate a
      // trial or subscription — just fall back to whatever is persisted.
      logEvent("warn", "billing.shopify_reconciliation_failed", {
        shop: shopDomain,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    });
    if (reconciled) {
      subscription = reconciled;
      reconciledFromShopify = true;
    }
  }

  const hasActivePaidSubscription = !!(
    subscription?.plan && isPaidSubscriptionActive(subscription)
  );
  const selectedPlanName: BillingPlanName = hasActivePaidSubscription
    ? normalizePlanName(subscription!.plan.name) ?? "NONE"
    : "NONE";
  const subscriptionBillingStatus = hasActivePaidSubscription
    ? subscription!.billingStatus
    : null;

  const trialActive = trial.trialActive;
  const accessActive =
    trialActive || (hasActivePaidSubscription && subscription!.active);

  const planSource: ResolvedBillingState["planSource"] = hasActivePaidSubscription
    ? reconciledFromShopify
      ? "shopify_reconciled"
      : "database"
    : trialActive
    ? "trial"
    : "none";

  const lifecycle = deriveCanonicalBillingLifecycle({
    uninstalled: !!store.uninstalledAt,
    pendingApproval: isPendingIntentStatus(pendingIntentStatus),
    planName: selectedPlanName,
    trialActive,
    accessActive,
    billingStatus: subscriptionBillingStatus,
    isTestCharge: env.billing.testMode,
  });

  const endsAt = hasActivePaidSubscription ? subscription!.endsAt ?? null : null;
  const showRenewalDate =
    lifecycle === "active" || (lifecycle === "cancelled" && accessActive);

  const merchantCopy = buildMerchantBillingCopy({
    lifecycle,
    planName: selectedPlanName,
    trialActive,
    trialEligible,
    pendingRequestedPlanName,
    accessActive,
    endsAt,
    trialEndsAt: store.trialEndsAt ?? null,
  });

  const status = deriveLifecycleStatus({
    planName: selectedPlanName,
    trialActive,
    hadTrial: !!store.trialEndsAt,
    active: accessActive,
    billingStatus: subscriptionBillingStatus,
  });

  // Plan-selected trial model: accessTier is always the SELECTED plan's own
  // tier, trial or paid — the trial doesn't widen it to a generic "trial"
  // tier, since only that plan's entitlements are unlocked either way.
  const accessTier: ResolvedBillingState["accessTier"] = normalizeTier(selectedPlanName);

  return {
    lifecycle,
    planName: selectedPlanName,
    selectedPlanName,
    planTier: normalizeTier(selectedPlanName),
    normalizedBillingStatus: subscriptionBillingStatus,
    active: lifecycle === "active",
    accessActive,
    verified: lifecycle !== "unknown_error",
    status,
    starterModule: hasActivePaidSubscription
      ? normalizeStarterModule(subscription!.starterModule)
      : null,
    endsAt: endsAt?.toISOString() ?? null,
    renewalAt: showRenewalDate ? endsAt?.toISOString() ?? null : null,
    showRenewalDate,
    trialActive,
    trialStartedAt: trial.trialStartedAt,
    trialEndsAt: trial.trialEndsAt,
    trialDaysRemaining: trial.trialDaysRemaining,
    trialDatesIncomplete: trial.trialDatesIncomplete,
    trialEligible,
    showTrialDate: trialActive,
    accessTier,
    subscriptionStatus: subscriptionBillingStatus,
    billingDisplayStatus: lifecycle,
    subscriptionId: hasActivePaidSubscription
      ? subscription!.id
      : store.subscription?.id ?? null,
    shopifyChargeId: hasActivePaidSubscription
      ? subscription!.shopifyChargeId ?? null
      : store.subscription?.shopifyChargeId ?? null,
    planSource,
    dbPlanName,
    dbBillingStatus,
    lastBillingSyncAt: hasActivePaidSubscription
      ? subscription!.lastBillingSyncAt?.toISOString() ?? null
      : null,
    lastBillingWebhookProcessedAt: hasActivePaidSubscription
      ? (subscription as any).lastBillingWebhookProcessedAt?.toISOString() ?? null
      : null,
    lastBillingResolutionSource: hasActivePaidSubscription
      ? (subscription as any).lastBillingResolutionSource ?? null
      : null,
    pendingIntentStatus,
    pendingRequestedPlanName,
    pendingRequestedStarterModule,
    merchantTitle: merchantCopy.title,
    merchantDescription: merchantCopy.description,
    mismatchWarnings:
      dbPlanName !== "NONE" && dbPlanName !== selectedPlanName
        ? [
            `Persisted DB plan ${dbPlanName} does not match effective plan ${selectedPlanName}.`,
          ]
        : [],
  };
}

/**
 * Read-only. Builds the merchant-facing subscription payload purely from
 * `resolveBillingState`'s canonical fields — no independent trial
 * derivation, no Store writes.
 */
export async function getCurrentSubscription(
  shopDomain: string
): Promise<CurrentSubscription> {
  const resolved = await resolveBillingState(shopDomain);

  return buildSubscriptionPayload({
    planName: resolved.selectedPlanName,
    price: getPlanPrice(resolved.selectedPlanName),
    trialDays: env.billing.trialDays,
    starterModule: resolved.starterModule,
    active: resolved.accessActive,
    endsAt: resolved.endsAt ? new Date(resolved.endsAt) : null,
    trialStartedAt: resolved.trialStartedAt ? new Date(resolved.trialStartedAt) : null,
    trialEndsAt: resolved.trialEndsAt ? new Date(resolved.trialEndsAt) : null,
    trialActive: resolved.trialActive,
    trialDaysRemaining: resolved.trialDaysRemaining,
    // Passed straight through from the canonical state — never recomputed.
    trialEligible: resolved.trialEligible,
    billingStatus: resolved.normalizedBillingStatus,
    // getStarterModuleSwitchAvailableAt is currently a stub that always
    // returns null regardless of input — no Store fetch needed for it here.
    starterModuleSwitchAvailableAt: getStarterModuleSwitchAvailableAt(null),
  });
}

export async function reconcileBillingState(shopDomain: string) {
  const [billingState, subscription] = await Promise.all([
    resolveBillingState(shopDomain),
    getCurrentSubscription(shopDomain),
  ]);

  const entitlements = buildCanonicalEntitlements({
    planName: billingState.selectedPlanName,
    starterModule: billingState.starterModule,
    accessActive: billingState.accessActive,
    verified: billingState.verified,
    // Canonical flag, read directly — never re-derived from planName.
    trialActive: billingState.trialActive,
  });

  logEvent("info", "billing.entitlements_resolved", {
    shop: shopDomain,
    selectedPlanName: billingState.selectedPlanName,
    trialActive: billingState.trialActive,
    planName: entitlements.planName,
    starterModule: entitlements.starterModule,
    enabledModules: Object.entries(entitlements.modules)
      .filter(([key, value]) =>
        ["fraud", "competitor", "pricing", "profit"].includes(key) && value
      )
      .map(([key]) => key),
  });

  return {
    billingState,
    subscription,
    entitlements,
  };
}

/**
 * Server-side entitlement source of truth for API routes (including
 * GET /api/insights/dashboard).
 *
 * Derives the module list from the canonical entitlement state rather than
 * re-resolving from the plan name. Re-resolving is what previously dropped the
 * trial override — a merchant on an active trial reported planName=TRIAL with
 * an empty enabledModules list, so every module stayed locked. Reading the
 * already-computed state keeps this path and the billing UI in lockstep.
 */
export async function resolveEntitlements(shopDomain: string) {
  const { billingState, entitlements } = await reconcileBillingState(shopDomain);
  const moduleKeys: CanonicalModuleKey[] = ["fraud", "competitor", "pricing", "profit"];

  return {
    plan: entitlements.planName,
    billingStatus: billingState.normalizedBillingStatus,
    starterModule: entitlements.starterModule,
    enabledModules: moduleKeys.filter((key) => entitlements.modules[key]),
    lockedModules: moduleKeys.filter((key) => !entitlements.modules[key]),
    // Canonical flag, read directly from billingState — never re-derived
    // from entitlements.tier or planName.
    trialActive: billingState.trialActive,
    trialEndsAt: billingState.trialEndsAt,
    trialDaysRemaining: billingState.trialDaysRemaining,
    accessActive: entitlements.accessActive,
  };
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

  if (!store) throw new HttpError(404, "Store not found.");
  if (!store.subscription) throw new HttpError(400, "No active subscription to cancel.");

  const activeSubscriptionBeforeCancel =
    store.subscription.shopifyChargeId
      ? await getActiveAppSubscription(shopDomain).catch(() => null)
      : null;
  const currentPeriodEnd = activeSubscriptionBeforeCancel?.currentPeriodEnd
    ? new Date(activeSubscriptionBeforeCancel.currentPeriodEnd)
    : store.subscription.endsAt;
  const accessRemainsActive =
    !!currentPeriodEnd && currentPeriodEnd.getTime() > Date.now();

  if (store.subscription.shopifyChargeId) {
    await cancelAppSubscription(shopDomain, store.subscription.shopifyChargeId, false);
  }

  const cancelled = await prisma.storeSubscription.update({
    where: { id: store.subscription.id },
    data: {
      active: accessRemainsActive,
      billingStatus: "CANCELLED",
      cancelledAt: new Date(),
      lastBillingSyncAt: new Date(),
      lastBillingResolutionSource: "cancel_api",
      lastBillingSubscriptionName: store.subscription.plan.name,
      endsAt: currentPeriodEnd ?? new Date(),
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
    metadata: {
      accessRemainsActive,
      currentPeriodEnd: currentPeriodEnd?.toISOString() ?? null,
    },
  });

  return getCurrentSubscription(shopDomain);
}

export async function downgradeToTrial(shopDomain: string) {
  const store = await prisma.store.findUnique({
    where: { shop: shopDomain },
    ...storeWithSubscriptionArgs,
  });

  if (!store) throw new HttpError(404, "Store not found.");

  if (store.subscription?.shopifyChargeId) {
    await cancelAppSubscription(shopDomain, store.subscription.shopifyChargeId, false);
  }

  if (store.subscription) {
    await recordBillingAuditLog({
      storeId: store.id,
      subscriptionId: store.subscription.id,
      eventType: "billing.downgraded_to_trial",
      previousPlanName: store.subscription.plan.name,
      nextPlanName: "NONE",
      previousStarterModule: store.subscription.starterModule,
      nextStarterModule: null,
      billingStatus: "CANCELLED",
    });

    await prisma.storeSubscription.delete({
      where: { id: store.subscription.id },
    });
  }

  // Plan downgrade/cancellation must never grant a new trial. Trial dates on
  // the Store row are intentionally left untouched here — whatever is
  // already persisted (open or expired) remains authoritative, and
  // resolveBillingState/getCurrentSubscription compute access from it
  // independently. If the merchant's original trial window genuinely is
  // still open, they will correctly see it as active; if it already expired,
  // they correctly fall back to no-plan access.
  logEvent("info", "billing.trial_reinitialization_blocked", {
    shop: shopDomain,
    route: "downgrade_to_trial",
    reason: "plan downgrade/cancellation must not grant a new trial — trial dates left untouched",
  });

  return getCurrentSubscription(shopDomain);
}

export async function updateStarterModuleSelection(
  shopDomain: string,
  starterModule: StarterModule
) {
  logEvent("info", "starter_module.update_requested", {
    shop: shopDomain,
    requestedStarterModule: starterModule,
    normalizedStarterModule: normalizeStarterModule(starterModule),
  });

  const store = await prisma.store.findUnique({
    where: { shop: shopDomain },
    ...storeWithSubscriptionArgs,
  });

  if (!store) throw new HttpError(404, "Store not found.");
  if (!store.subscription || store.subscription.plan.name !== "STARTER") {
    throw new HttpError(400, "Starter feature selection can only be changed on the STARTER plan.");
  }

  const normalizedStarterModule = normalizeStarterModule(starterModule);
  if (!normalizedStarterModule) {
    throw new HttpError(400, "Invalid Starter feature selection.");
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

  logEvent("info", "starter_module.db_updated", {
    shop: shopDomain,
    savedPlan: "STARTER",
    savedStarterModule: normalizedStarterModule,
  });

  logSubscriptionSaved({
    shop: shopDomain,
    savedPlan: "STARTER",
    savedStarterModule: normalizedStarterModule,
  });

  return getCurrentSubscription(shopDomain);
}

/**
 * Grants — or recovers — the one durable trial window once a subscription is
 * confirmed approved. Shared by the webhook path and the live-Shopify recovery
 * path so both behave identically.
 *
 * Failures are RE-THROWN. The merchant has a Shopify-approved subscription, so
 * permanently losing their promised trial to a transient DB error is not
 * acceptable; throwing makes the webhook answer non-2xx and hands recovery to
 * Shopify's own durable redelivery schedule. Retries converge safely:
 * ShopTrialHistory yields exactly one window per shop forever, so a retry can
 * neither create a second trial nor extend an existing trialEndsAt.
 */
async function persistTrialWindowAfterApproval(
  store: NonNullable<StoreWithSubscription>,
  context: { subscriptionId: string; shopifyChargeId: string | null }
) {
  try {
    const trialWindow = await resolveTrialWindowOnApproval(
      store.shop,
      new Date(),
      store.trialStartedAt && store.trialEndsAt
        ? { trialStartedAt: store.trialStartedAt, trialEndsAt: store.trialEndsAt }
        : null
    );
    if (trialWindow && (!store.trialStartedAt || !store.trialEndsAt)) {
      await prisma.store.update({
        where: { id: store.id },
        data: {
          trialStartedAt: trialWindow.trialStartedAt,
          trialEndsAt: trialWindow.trialEndsAt,
        },
      });
    }
  } catch (error) {
    logEvent("error", "billing.trial_grant_after_approval_failed", {
      shop: store.shop,
      subscriptionId: context.subscriptionId,
      shopifyChargeId: context.shopifyChargeId,
      retryable: true,
      reason:
        "subscription is reconciled but the trial could not be persisted — failing so Shopify redelivers this webhook",
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * An incomplete or unverifiable webhook must never mutate billing state from
 * its own missing fields. Instead, ask Shopify what is authoritative right now
 * and reconcile from that.
 *
 * The lookup is best-effort: if Shopify is unreachable nothing has been
 * corrupted, and the read path (resolveBillingState) reconciles lazily on the
 * merchant's next load. A trial-persistence failure after a CONFIRMED approval
 * does propagate, matching the approved-webhook path.
 */
async function recoverBillingStateFromShopify(
  store: NonNullable<StoreWithSubscription>,
  reason: string
) {
  let reconciled: Awaited<
    ReturnType<typeof reconcileCurrentSubscriptionFromShopify>
  > = null;

  try {
    reconciled = await reconcileCurrentSubscriptionFromShopify(store);
  } catch (error) {
    logEvent("warn", "billing.webhook_live_reconciliation_failed", {
      shop: store.shop,
      reason,
      error: error instanceof Error ? error.message : String(error),
      note: "local billing state left untouched; the read path reconciles lazily",
    });
    return store.subscription;
  }

  if (!reconciled) {
    logEvent("info", "billing.webhook_live_reconciliation_no_active_subscription", {
      shop: store.shop,
      reason,
      note: "Shopify reports no approved subscription; local state left untouched",
    });
    return store.subscription;
  }

  logEvent("info", "billing.webhook_live_reconciliation_applied", {
    shop: store.shop,
    reason,
    recoveredPlan: reconciled.plan?.name ?? null,
    shopifyChargeId: reconciled.shopifyChargeId ?? null,
  });

  await persistTrialWindowAfterApproval(store, {
    subscriptionId: reconciled.id,
    shopifyChargeId: reconciled.shopifyChargeId ?? null,
  });

  return reconciled;
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

  const planName = normalizePlanName(input.planName);
  const currentPeriodEnd = input.currentPeriodEnd
    ? new Date(input.currentPeriodEnd)
    : null;
  const incomingChargeId = input.shopifyChargeId?.trim() || null;
  const storedChargeId = store.subscription?.shopifyChargeId ?? null;

  // The status is the one field this decision cannot be made without.
  // Defaulting a missing status to "INACTIVE" — as this previously did — turns
  // an incomplete or misparsed delivery into a deactivation of a live
  // subscription. That is precisely how a just-approved plan was being wiped to
  // NONE in production, so a missing status is now an explicit refusal to act.
  const normalizedStatus = input.status?.trim().toUpperCase() || null;

  // --- INCOMPLETE: no usable status -> mutate nothing, ask Shopify ----------
  if (!normalizedStatus) {
    logEvent("warn", "billing.webhook_incomplete_ignored", {
      shop: input.shopDomain,
      incomingChargeId,
      incomingPlanName: input.planName ?? null,
      storedChargeId,
      existingPlanName: store.subscription?.plan?.name ?? null,
      reason:
        "webhook carried no usable status — refusing to infer one; reconciling from the live Shopify subscription instead",
    });
    return recoverBillingStateFromShopify(store, "webhook_missing_status");
  }

  // ONLY these two mean "the merchant approved and Shopify considers the
  // subscription live". PENDING is deliberately excluded — it means Shopify
  // created the subscription but the merchant has not decided yet, so it must
  // never set active=true, become the current paid plan, grant a trial, or
  // suppress the choose-a-plan state.
  const isApproved = normalizedStatus === "ACTIVE" || normalizedStatus === "ACCEPTED";
  const isPending = normalizedStatus === "PENDING";

  // --- PENDING: record nothing -------------------------------------------
  // Writing no local state at once satisfies every PENDING requirement: it
  // cannot activate, cannot overwrite an existing ACTIVE subscription for a
  // different plan, cannot be mistaken for the current paid plan, cannot
  // grant a trial, and cannot suppress the choose-a-plan state. The
  // ACTIVE/ACCEPTED webhook that follows a real approval is what reconciles.
  if (isPending) {
    logEvent("info", "billing.webhook_pending_ignored", {
      shop: input.shopDomain,
      incomingChargeId: input.shopifyChargeId ?? null,
      incomingPlanName: input.planName ?? null,
      hasExistingSubscription: !!store.subscription,
      existingChargeId: store.subscription?.shopifyChargeId ?? null,
      existingPlanName: store.subscription?.plan?.name ?? null,
    });
    return store.subscription;
  }

  if (!isApproved) {
    if (!store.subscription) {
      return null;
    }

    // Deactivation is only ever safe when this webhook is POSITIVELY about the
    // subscription currently stored: a valid incoming id, a stored id, and an
    // exact match between them. Anything less is unverifiable.
    //
    // Deactivating on an unverifiable match — as this previously did — lets a
    // stale, delayed, or incomplete delivery destroy a newer valid subscription
    // and reset its plan to NONE. That is the production defect this guard
    // exists to prevent, so an unverifiable inactive event now mutates nothing
    // and defers to Shopify's authoritative state instead.
    if (!incomingChargeId || !storedChargeId) {
      logEvent("warn", "billing.webhook_inactive_ignored_unverifiable", {
        shop: input.shopDomain,
        normalizedStatus,
        incomingChargeId,
        storedChargeId,
        existingPlanName: store.subscription.plan?.name ?? null,
        reason:
          "could not positively match the webhook to the stored subscription — refusing to deactivate; reconciling from the live Shopify subscription instead",
      });
      return recoverBillingStateFromShopify(
        store,
        "inactive_webhook_unverifiable_charge"
      );
    }

    // A delayed inactive event (CANCELLED/DECLINED/EXPIRED) for an OLDER,
    // already-replaced subscription must never deactivate the newer one that
    // replaced it.
    if (incomingChargeId !== storedChargeId) {
      logEvent("info", "billing.webhook_inactive_ignored_stale_charge", {
        shop: input.shopDomain,
        normalizedStatus,
        incomingChargeId,
        storedChargeId,
        reason:
          "inactive event is for a different (older/replaced) subscription — the current subscription is left untouched",
      });
      return store.subscription;
    }

    const accessRemainsActive =
      normalizedStatus === "CANCELLED" &&
      !!currentPeriodEnd &&
      currentPeriodEnd.getTime() > Date.now();

    const updated = await prisma.storeSubscription.update({
      where: { id: store.subscription.id },
      data: {
        active: accessRemainsActive,
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
        accessRemainsActive,
        currentPeriodEnd: currentPeriodEnd?.toISOString() ?? null,
      },
    });

    logSubscriptionSaved({
      shop: input.shopDomain,
      savedPlan: "NONE",
      savedStarterModule: null,
    });

    return {
      ...updated,
      plan: store.subscription.plan,
    };
  }

  // An approved status we cannot attribute to a real plan is an incomplete
  // delivery. Never write NONE over a live subscription on the strength of a
  // missing plan name — ask Shopify which subscription is actually approved.
  if (!planName || planName === "TRIAL" || planName === "NONE") {
    logEvent("warn", "billing.webhook_approved_unresolved_plan", {
      shop: input.shopDomain,
      normalizedStatus,
      incomingChargeId,
      incomingPlanName: input.planName ?? null,
      existingPlanName: store.subscription?.plan?.name ?? null,
      reason:
        "approved webhook carried no resolvable plan name — reconciling from the live Shopify subscription instead of leaving state unattributed",
    });
    return recoverBillingStateFromShopify(
      store,
      "approved_webhook_unresolved_plan"
    );
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
          ? normalizeStarterModule(store.subscription?.starterModule) ?? "fraud"
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
      starterModule: planName === "STARTER" ? "fraud" : null,
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

  logSubscriptionSaved({
    shop: input.shopDomain,
    savedPlan: planName,
    savedStarterModule: normalizeStarterModule(updated.starterModule),
  });

  // Plan-selected trial model: the trial is granted here — the ONE place
  // both the browser return-redirect (confirmBillingApprovalReturn) and the
  // independent app_subscriptions_update webhook funnel through once a
  // subscription is reconciled. This makes trial granting redirect-
  // independent: an approval that never completes the redirect (abandoned
  // tab, browser crash) still gets its trial via the webhook alone, and a
  // duplicate/replayed call from either path is a no-op (durable
  // ShopTrialHistory grants exactly once, ever, per shop).
  //
  // Only reachable for an APPROVED status — PENDING returned early above and
  // never reaches this point, so a subscription still awaiting the merchant's
  // decision can never start a trial or write Store.trialStartedAt/trialEndsAt.
  //
  // A failure here is RE-THROWN, not swallowed. The merchant has a
  // Shopify-approved subscription, so permanently losing their promised trial
  // to a transient DB error is not acceptable. Throwing makes the webhook
  // handler return non-2xx so Shopify redelivers (its own durable, hours-long
  // retry schedule) and makes the redirect path show a recoverable error.
  // Retries converge safely and cannot double-grant: the StoreSubscription
  // upsert above is idempotent, and ShopTrialHistory yields exactly one
  // window per shop forever, so a retry can neither create a second trial nor
  // extend an existing trialEndsAt.
  await persistTrialWindowAfterApproval(store, {
    subscriptionId: updated.id,
    shopifyChargeId: incomingChargeId,
  });

  return updated;
}

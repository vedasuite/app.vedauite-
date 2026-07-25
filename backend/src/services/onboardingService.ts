import { prisma } from "../db/prismaClient";
import { env } from "../config/env";
import { HttpError } from "../lib/httpError";
import {
  normalizeStarterModuleLabel,
  type StarterModule,
} from "../billing/capabilities";
import { getConnectionHealth } from "./shopifyConnectionService";
import { getUnifiedReadinessState } from "./readinessEngineService";
import { getCurrentSubscription, resolveBillingState } from "./subscriptionService";
import {
  deriveSyncStatus,
  getStoreOperationalSnapshot,
  type StoreSyncStatus,
} from "./storeOperationalStateService";

export type OnboardingStage =
  | "DATA_SYNC"
  | "MODULE_SELECTION"
  | "FIRST_INSIGHT_VIEW"
  | "PLAN_CONFIRMATION"
  | "COMPLETE";

export type OnboardingActionKey =
  | "RECONNECT_SHOPIFY"
  | "SYNC_LIVE_DATA"
  | "CHOOSE_MODULE"
  | "VIEW_FIRST_INSIGHT"
  | "GOTO_BILLING"
  | "CONFIRM_PLAN"
  | "OPEN_DASHBOARD";

type OnboardingModuleKey = "fraud" | "competitor" | "pricing";

type OnboardingStep = {
  key: OnboardingStage;
  label: string;
  complete: boolean;
  active: boolean;
  locked: boolean;
  description: string;
  helper: string;
  ctaLabel: string;
};

function normalizeOnboardingModule(
  value?: string | null
): OnboardingModuleKey | null {
  if (value === "fraud" || value === "competitor" || value === "pricing") {
    return value;
  }
  if (value === "trustAbuse" || value === "creditScore") {
    return "fraud";
  }
  if (value === "pricingProfit" || value === "profit") {
    return "pricing";
  }
  return null;
}

function moduleRoute(moduleKey: OnboardingModuleKey) {
  switch (moduleKey) {
    case "fraud":
      return "/app/fraud-intelligence";
    case "competitor":
      return "/app/competitor-intelligence";
    case "pricing":
      return "/app/ai-pricing-engine";
  }
}

function moduleTitle(moduleKey: OnboardingModuleKey) {
  switch (moduleKey) {
    case "fraud":
      return "Fraud Intelligence";
    case "competitor":
      return "Competitor Intelligence";
    case "pricing":
      return "AI Pricing Engine";
  }
}

function mapDashboardState(syncStatus: StoreSyncStatus) {
  switch (syncStatus) {
    case "NOT_CONNECTED":
      return "NOT_CONNECTED";
    case "SYNC_REQUIRED":
      return "SYNC_REQUIRED";
    case "SYNC_IN_PROGRESS":
      return "SYNC_IN_PROGRESS";
    case "SYNC_COMPLETED_PROCESSING_PENDING":
      return "PROCESSING_PENDING";
    case "EMPTY_STORE_DATA":
      return "EMPTY_STORE_DATA";
    case "FAILED":
      return "FAILED";
    default:
      return "READY_WITH_DATA";
  }
}

function firstIncompleteIndex(steps: Array<{ complete: boolean }>) {
  const index = steps.findIndex((step) => !step.complete);
  return index === -1 ? steps.length - 1 : index;
}

export async function getOnboardingState(shopDomain: string) {
  const [storeResult, connection, operational, billing, subscription, readiness] = await Promise.all([
    prisma.store.findUnique({
      where: { shop: shopDomain },
      select: {
        id: true,
        shop: true,
        installedAt: true,
        webhooksRegisteredAt: true,
        lastWebhookRegistrationStatus: true,
        onboardingCompletedAt: true,
        onboardingDismissedAt: true,
        onboardingSelectedModule: true,
        onboardingFirstInsightViewedAt: true,
        onboardingPlanConfirmedAt: true,
      } as any,
    }),
    getConnectionHealth(shopDomain, { probeApi: false }),
    getStoreOperationalSnapshot(shopDomain),
    resolveBillingState(shopDomain),
    getCurrentSubscription(shopDomain),
    getUnifiedReadinessState(shopDomain),
  ]);

  const store = storeResult as any;
  if (!store) {
    throw new HttpError(404, "Store not found.");
  }

  const syncState = deriveSyncStatus({
    connectionStatus: operational.store.lastConnectionStatus,
    latestSyncJobStatus: operational.latestSyncJob?.status ?? null,
    lastSyncStatus: operational.store.lastSyncStatus,
    products: operational.counts.products,
    orders: operational.counts.orders,
    customers: operational.counts.customers,
    priceRows: operational.counts.pricingRows,
    profitRows: operational.counts.profitRows,
    timelineEvents: operational.counts.timelineEvents,
  });

  const hasAnyRawData =
    operational.counts.products + operational.counts.orders + operational.counts.customers > 0;
  const hasAnyProcessedData =
    operational.counts.pricingRows +
      operational.counts.profitRows +
      operational.counts.timelineEvents +
      operational.counts.competitorRows >
    0;
  const webhooksReady =
    !!store.webhooksRegisteredAt &&
    store.lastWebhookRegistrationStatus !== "FAILED";
  const selectedModule =
    normalizeOnboardingModule(store.onboardingSelectedModule) ??
    (subscription.planName === "STARTER"
      ? normalizeOnboardingModule(subscription.starterModule)
      : null);

  const moduleAvailability = [
    {
      key: "fraud" as const,
      title: "Fraud Intelligence",
      route: moduleRoute("fraud"),
      summary: "Flags risky customers, detects refund abuse, and surfaces chargeback-risk orders.",
      planLabel: "Starter · Growth · Pro",
      benefits: [
        "Detect refund abuse",
        "Flag risky customers",
        "Reduce chargebacks",
      ],
      available: subscription.enabledModules.fraud,
      lockReason: subscription.enabledModules.fraud
        ? null
        : "Included in Starter plan (choose Fraud Intelligence as your starter feature), Growth, and Pro. Go to Billing to choose a plan.",
    },
    {
      key: "competitor" as const,
      title: "Competitor Intelligence",
      route: moduleRoute("competitor"),
      summary: "Tracks competitor prices, monitors promotions, and surfaces ad activity on your product handles.",
      planLabel: "Growth · Pro",
      benefits: [
        "Track competitor pricing",
        "Monitor promotions",
        "Detect ad activity",
      ],
      available: subscription.enabledModules.competitor,
      lockReason: subscription.enabledModules.competitor
        ? null
        : "Included in Growth and Pro plans. Go to Billing to choose a plan.",
    },
    {
      key: "pricing" as const,
      title: "AI Pricing Engine",
      route: moduleRoute("pricing"),
      summary: "Recommends optimal prices for your products, balancing margin and demand signals.",
      planLabel: "Growth · Pro",
      benefits: [
        "Suggest optimal pricing",
        "Balance margin vs demand",
        "Improve conversion",
      ],
      available: subscription.enabledModules.pricing,
      lockReason: subscription.enabledModules.pricing
        ? null
        : "Included in Growth and Pro plans. Go to Billing to choose a plan.",
    },
  ];

  const selectedModuleAvailable =
    !!selectedModule &&
    moduleAvailability.some(
      (module) => module.key === selectedModule && module.available
    );
  const selectedModuleReadiness =
    selectedModule === "fraud"
      ? readiness.modules.fraud
      : selectedModule === "competitor"
      ? readiness.modules.competitor
      : selectedModule === "pricing"
      ? readiness.modules.pricing
      : null;
  // Choosing a module during onboarding is a preference, not a purchase —
  // anyone should be able to pick one and walk through onboarding without
  // paying first. Only actually USING a module's real data still requires
  // an entitled plan, already enforced by ModuleGate + requireFeature on
  // the module pages themselves. `selectedModuleAvailable` is still tracked
  // above for display (e.g. "your pick isn't in your plan yet"), but it no
  // longer gates step completion.
  const moduleSelectionComplete = readiness.initialSync.ready && !!selectedModule;
  const firstInsightViewedComplete =
    moduleSelectionComplete && !!store.onboardingFirstInsightViewedAt;
  const planConfirmationComplete =
    readiness.billing.ready && !!store.onboardingPlanConfirmedAt;
  const canAccessDashboard =
    readiness.setup.minimumComplete &&
    firstInsightViewedComplete &&
    planConfirmationComplete;

  const stepTemplates: Array<Omit<OnboardingStep, "locked" | "active">> = [
    {
      key: "DATA_SYNC",
      label: "Step 1: Sync Data",
      complete: readiness.initialSync.ready,
      description:
        "Sync live Shopify products, customers, and orders so VedaSuite can analyze the store.",
      helper: readiness.initialSync.description,
      ctaLabel: readiness.connection.healthy ? "Sync Data" : "Reconnect Shopify",
    },
    {
      key: "MODULE_SELECTION",
      label: "Step 2: Pick a feature to start with",
      complete: moduleSelectionComplete,
      description:
        "Choose which VedaSuite feature to open first: Fraud Intelligence, Competitor Intelligence, or AI Pricing Engine.",
      helper:
        !readiness.initialSync.ready
          ? "Finish syncing Shopify data first, then pick a feature below."
          : !selectedModule
          ? "Pick any feature to start with — you can switch later from the dashboard."
          : selectedModuleAvailable && selectedModuleReadiness?.ready
          ? `${moduleTitle(selectedModule)} is selected and ready to open.`
          : selectedModuleAvailable && selectedModuleReadiness
          ? `${moduleTitle(selectedModule)} is selected, but ${selectedModuleReadiness.description.toLowerCase()}`
          : `${moduleTitle(selectedModule)} is selected. It is included in your plan once you choose one on the Billing page.`,
      ctaLabel: selectedModule ? `${moduleTitle(selectedModule)} selected` : "Pick a feature",
    },
    {
      key: "FIRST_INSIGHT_VIEW",
      label: selectedModule
        ? `Step 3: Open ${moduleTitle(selectedModule)}`
        : "Step 3: Open your first feature",
      complete: firstInsightViewedComplete,
      description: selectedModule
        ? `Open ${moduleTitle(selectedModule)} and see what it offers before moving to the dashboard.`
        : "Open the feature you selected and take a look at what it offers.",
      helper:
        !moduleSelectionComplete
          ? "Pick a feature to start with first (Step 2 above)."
          : store.onboardingFirstInsightViewedAt
          ? `${selectedModule ? moduleTitle(selectedModule) : "Feature"} opened successfully.`
          : !selectedModuleAvailable
          ? `You can open ${moduleTitle(selectedModule!)} now to see a preview. To unlock its full data, choose a plan on the Billing page.`
          : selectedModuleReadiness && !selectedModuleReadiness.ready
          ? selectedModuleReadiness.description
          : !hasAnyProcessedData
          ? "VedaSuite is still processing synced Shopify data — this takes a minute."
          : `Open ${selectedModule ? moduleTitle(selectedModule) : "your chosen feature"} to see the first insight.`,
      ctaLabel: selectedModule ? `Open ${moduleTitle(selectedModule)}` : "Open first feature",
    },
    {
      key: "PLAN_CONFIRMATION",
      label: "Step 4: Confirm Plan",
      complete: planConfirmationComplete,
      description:
        "Confirm the current plan so VedaSuite can unlock the right modules and take you to the dashboard.",
      helper: planConfirmationComplete
        ? `Plan confirmed: ${billing.planName}.`
        : readiness.billing.description,
      ctaLabel: "Confirm Plan",
    },
  ];

  const activeStepIndex = canAccessDashboard
    ? stepTemplates.length - 1
    : firstIncompleteIndex(stepTemplates);
  const steps: OnboardingStep[] = stepTemplates.map((step, index) => ({
    ...step,
    locked: index > 0 && !stepTemplates[index - 1].complete,
    active: !canAccessDashboard && index === activeStepIndex,
  }));

  let stage: OnboardingStage = "COMPLETE";
  if (!canAccessDashboard) {
    stage = stepTemplates[activeStepIndex].key;
  }

  const primaryAction =
    !readiness.connection.healthy
      ? {
          key: "RECONNECT_SHOPIFY" as const,
          label: "Reconnect Shopify",
          route: "/app/onboarding",
        }
      : stage === "DATA_SYNC"
      ? {
          key: "SYNC_LIVE_DATA" as const,
          label:
            readiness.initialSync.state === "collecting_data" ? "Preparing results" : "Sync Data",
          route: "/app/onboarding",
        }
      : stage === "MODULE_SELECTION"
      ? readiness.billing.ready
        ? {
            key: "CHOOSE_MODULE" as const,
            label: "Pick a feature to start with",
            route: "/app/onboarding",
          }
        : // Every module is locked until a plan is active, so sending the
          // merchant to pick one first is a dead end. Route to billing instead.
          {
            key: "GOTO_BILLING" as const,
            label: "Choose billing plan to unlock features",
            route: "/app/billing",
          }
      : stage === "FIRST_INSIGHT_VIEW"
      ? {
          key: "VIEW_FIRST_INSIGHT" as const,
          label: selectedModule ? `Open ${moduleTitle(selectedModule)}` : "Open first feature",
          route: selectedModule ? moduleRoute(selectedModule) : "/app/onboarding",
        }
      : stage === "PLAN_CONFIRMATION"
      ? readiness.billing.ready
        ? {
            key: "CONFIRM_PLAN" as const,
            label: "Confirm Plan",
            route: "/app/onboarding",
          }
        : {
            key: "GOTO_BILLING" as const,
            label: "Go to billing to select a plan",
            route: "/app/billing",
          }
      : {
          key: "OPEN_DASHBOARD" as const,
          label: "Open Dashboard",
          route: "/app/dashboard",
        };

  const stateSummary =
    readiness.setup.minimumComplete
      ? {
          tone: readiness.setup.allCoreModulesReady ? "success" : "info",
          title: readiness.setup.summaryTitle,
          description: readiness.setup.summaryDescription,
          ctaLabel: readiness.setup.nextAction.label,
        }
      : readiness.connection.state === "error"
      ? {
          tone: "critical" as const,
          title: readiness.setup.summaryTitle,
          description: readiness.setup.summaryDescription,
          ctaLabel: readiness.setup.nextAction.label,
        }
      : readiness.initialSync.state === "collecting_data" ||
        readiness.billing.state === "collecting_data"
      ? {
          tone: "info" as const,
          title: readiness.setup.summaryTitle,
          description: readiness.setup.summaryDescription,
          ctaLabel: readiness.setup.nextAction.label,
        }
      : readiness.initialSync.state === "error" || readiness.billing.state === "error"
      ? {
          tone: "critical" as const,
          title: readiness.setup.summaryTitle,
          description: readiness.setup.summaryDescription,
          ctaLabel: readiness.setup.nextAction.label,
        }
      : {
          tone: "info" as const,
          title: readiness.setup.summaryTitle,
          description: readiness.setup.summaryDescription,
          ctaLabel: readiness.setup.nextAction.label,
        };

  return {
    stage,
    canAccessDashboard,
    dashboardEntryState: mapDashboardState(readiness.initialSync.syncStatus),
    isCompleted: !!store.onboardingCompletedAt && readiness.setup.minimumComplete,
    isDismissed: !!store.onboardingDismissedAt,
    title: "Turn Your Store Data Into Fraud Detection & Profit Insights",
    description:
      "VedaSuite turns Shopify orders, customers, and products into fraud detection, competitor tracking, and pricing guidance for your store.",
    primaryAction,
    progress: {
      completedSteps: stepTemplates.filter((step) => step.complete).length,
      totalSteps: stepTemplates.length,
      percent: Math.round(
        (stepTemplates.filter((step) => step.complete).length / stepTemplates.length) * 100
      ),
    },
    steps,
    hero: {
      headline: "Turn Your Store Data Into Fraud Detection & Profit Insights",
      subtext:
        "VedaSuite syncs Shopify data, detects refund and fraud abuse, tracks competitor pricing and ads, and surfaces pricing opportunities that protect profit.",
      benefits: [
        "Detect refund & fraud abuse",
        "Track competitor pricing & ads",
        "Optimize pricing for profit",
      ],
    },
    dataReadiness: {
      syncStatus: readiness.initialSync.syncStatus,
      syncReason: readiness.initialSync.description,
      connectionHealthy: readiness.connection.healthy,
      webhooksReady,
      hasAnyRawData,
      hasAnyProcessedData,
      stateLabel: readiness.initialSync.status,
    },
    stateSummary,
    moduleOverview: moduleAvailability,
    selectedModule,
    selectedModuleTitle: selectedModule ? moduleTitle(selectedModule) : null,
    selectedModuleRoute: selectedModule ? moduleRoute(selectedModule) : null,
    guidedInsights: env.enableGuidedSetupData
      ? [
          {
            key: "fraud-guided",
            module: "Fraud Intelligence",
            title: "Guided setup: Customer flagged for repeated refund behaviour",
            detail:
              "Fraud insights appear here after Shopify orders and customer history are available.",
          },
          {
            key: "competitor-guided",
            module: "Competitor Intelligence",
            title: "Guided setup: Competitor changed price on a tracked product",
            detail:
              "Competitor changes appear after competitor websites are connected and analysis completes.",
          },
          {
            key: "pricing-guided",
            module: "AI Pricing Engine",
            title: "Guided setup: Suggested price change based on baseline store data",
            detail:
              "Pricing actions appear after enough product and order history is available.",
          },
        ]
      : [],
    planSummary: {
      planName: billing.planName,
      billingActive: readiness.billing.accessActive,
      starterModule:
        normalizeStarterModuleLabel(subscription.starterModule as StarterModule | null) ??
        null,
      unlockedFeatures: [
        subscription.enabledModules.fraud ? "Fraud detection" : null,
        subscription.enabledModules.competitor ? "Competitor analysis" : null,
        subscription.enabledModules.pricing ? "Pricing optimization" : null,
      ].filter((value): value is string => !!value),
      lockedFeatures: [
        subscription.enabledModules.fraud ? null : "Fraud detection",
        subscription.enabledModules.competitor ? null : "Competitor analysis",
        subscription.enabledModules.pricing ? null : "Pricing optimization",
      ].filter((value): value is string => !!value),
      manageRoute: "/app/billing",
      canConfirmPlan: stage === "PLAN_CONFIRMATION" || canAccessDashboard,
    },
    privacySummary: {
      title: "Your Data & Privacy",
      description:
        "VedaSuite accesses Shopify orders, customers, and products to generate insights inside the app.",
      bullets: [
        "Reads Shopify orders, customers, and products to generate fraud, competitor, and pricing insights.",
        "Uses store data only to power VedaSuite workflows and merchant guidance.",
        "Keeps data encrypted and does not sell merchant data.",
      ],
    },
    currentPlan: billing.planName,
    billingActive: readiness.billing.accessActive,
    limitedDataReason:
      syncState.status === "EMPTY_STORE_DATA"
        ? "Shopify synced successfully, but the store currently has limited order or customer history."
        : !hasAnyProcessedData && hasAnyRawData
        ? "VedaSuite is still turning synced store data into dashboard-ready outputs."
        : null,
    readiness,
  };
}

// Selecting a module during onboarding is a preference, not a purchase —
// anyone can pick any module regardless of their current plan. Actually
// using that module's real data is separately enforced by ModuleGate +
// requireFeature on the module page itself, which is the correct place to
// require payment, not here during onboarding.
export async function selectOnboardingModule(input: {
  shopDomain: string;
  moduleKey: string;
}) {
  const normalizedModule = normalizeOnboardingModule(input.moduleKey);

  if (!normalizedModule) {
    throw new HttpError(400, "Invalid onboarding module.");
  }

  await prisma.store.update({
    where: { shop: input.shopDomain },
    data: {
      onboardingSelectedModule: normalizedModule,
      onboardingDismissedAt: null,
    } as any,
  });

  return getOnboardingState(input.shopDomain);
}

export async function markOnboardingInsightViewed(input: {
  shopDomain: string;
  moduleKey?: string | null;
}) {
  const nextModule = normalizeOnboardingModule(input.moduleKey);

  await prisma.store.update({
    where: { shop: input.shopDomain },
    data: {
      onboardingSelectedModule: nextModule ?? undefined,
      onboardingFirstInsightViewedAt: new Date(),
      onboardingDismissedAt: null,
    } as any,
  });

  return getOnboardingState(input.shopDomain);
}

export async function confirmOnboardingPlan(shopDomain: string) {
  const onboarding = await getOnboardingState(shopDomain);

  if (!onboarding.steps.find((step) => step.key === "FIRST_INSIGHT_VIEW")?.complete) {
    throw new HttpError(400, "View the first insight before confirming the plan.");
  }

  // "Confirming" a plan that was never actually chosen makes no sense —
  // without this check, clicking Confirm Plan before ever subscribing
  // silently set onboardingPlanConfirmedAt anyway, which the frontend
  // then misreported as "Onboarding completed" even though
  // canAccessDashboard was still false, landing the merchant back on
  // onboarding with no clear next step.
  if (!onboarding.readiness.billing.ready) {
    throw new HttpError(
      400,
      "Choose and subscribe to a plan on the Billing page before confirming this step."
    );
  }

  await prisma.store.update({
    where: { shop: shopDomain },
    data: {
      onboardingPlanConfirmedAt: new Date(),
      onboardingCompletedAt: onboarding.canAccessDashboard ? new Date() : null,
      onboardingDismissedAt: null,
    } as any,
  });

  return getOnboardingState(shopDomain);
}

export async function markOnboardingComplete(shopDomain: string) {
  const onboarding = await getOnboardingState(shopDomain);
  if (!onboarding.canAccessDashboard) {
    throw new HttpError(400, "Complete the onboarding flow before entering the dashboard.");
  }

  await prisma.store.update({
    where: { shop: shopDomain },
    data: {
      onboardingCompletedAt: new Date(),
      onboardingDismissedAt: null,
    },
  });

  return getOnboardingState(shopDomain);
}

export async function dismissOnboarding(shopDomain: string) {
  await prisma.store.update({
    where: { shop: shopDomain },
    data: {
      onboardingDismissedAt: new Date(),
    },
  });

  return getOnboardingState(shopDomain);
}

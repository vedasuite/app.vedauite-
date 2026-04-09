import { prisma } from "../db/prismaClient";
import {
  normalizeStarterModuleLabel,
  type BillingPlanName,
  type StarterModule,
} from "../billing/capabilities";
import { getConnectionHealth } from "./shopifyConnectionService";
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
  | "CONFIRM_PLAN"
  | "OPEN_DASHBOARD";

type OnboardingModuleKey = "trustAbuse" | "competitor" | "pricingProfit";

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
  if (value === "trustAbuse" || value === "competitor" || value === "pricingProfit") {
    return value;
  }
  if (value === "fraud" || value === "creditScore") {
    return "trustAbuse";
  }
  if (value === "pricing" || value === "profit") {
    return "pricingProfit";
  }
  return null;
}

function moduleRoute(moduleKey: OnboardingModuleKey) {
  switch (moduleKey) {
    case "trustAbuse":
      return "/app/fraud-intelligence";
    case "competitor":
      return "/app/competitor-intelligence";
    case "pricingProfit":
      return "/app/ai-pricing-engine";
  }
}

function moduleTitle(moduleKey: OnboardingModuleKey) {
  switch (moduleKey) {
    case "trustAbuse":
      return "Fraud Intelligence";
    case "competitor":
      return "Competitor Intelligence";
    case "pricingProfit":
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
  const [storeResult, connection, operational, billing, subscription] = await Promise.all([
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
  ]);

  const store = storeResult as any;

  if (!store) {
    throw new Error("Store not found");
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
      key: "trustAbuse" as const,
      title: "Fraud Intelligence",
      route: moduleRoute("trustAbuse"),
      summary: "Detect refund abuse, flag risky customers, and reduce chargeback exposure.",
      benefits: [
        "Detect refund abuse",
        "Flag risky customers",
        "Reduce chargebacks",
      ],
      available: subscription.enabledModules.trustAbuse,
      lockReason: subscription.enabledModules.trustAbuse
        ? null
        : "Upgrade your plan to unlock Fraud Intelligence.",
    },
    {
      key: "competitor" as const,
      title: "Competitor Intelligence",
      route: moduleRoute("competitor"),
      summary: "Track competitor pricing, monitor promotions, and detect ad activity.",
      benefits: [
        "Track competitor pricing",
        "Monitor promotions",
        "Detect ad activity",
      ],
      available: subscription.enabledModules.competitor,
      lockReason: subscription.enabledModules.competitor
        ? null
        : "Upgrade your plan to unlock Competitor Intelligence.",
    },
    {
      key: "pricingProfit" as const,
      title: "AI Pricing Engine",
      route: moduleRoute("pricingProfit"),
      summary: "Suggest optimal pricing, balance margin versus demand, and improve conversion.",
      benefits: [
        "Suggest optimal pricing",
        "Balance margin vs demand",
        "Improve conversion",
      ],
      available: subscription.enabledModules.pricingProfit,
      lockReason: subscription.enabledModules.pricingProfit
        ? null
        : "Upgrade to Growth or Pro to unlock AI Pricing Engine.",
    },
  ];

  const dataSyncComplete =
    connection.healthy &&
    !!operational.store.lastSyncAt &&
    syncState.status !== "SYNC_REQUIRED" &&
    syncState.status !== "SYNC_IN_PROGRESS" &&
    syncState.status !== "FAILED" &&
    syncState.status !== "NOT_CONNECTED";
  const selectedModuleAvailable =
    !!selectedModule &&
    moduleAvailability.some(
      (module) => module.key === selectedModule && module.available
    );
  const moduleSelectionComplete = dataSyncComplete && selectedModuleAvailable;
  const firstInsightViewedComplete =
    moduleSelectionComplete && !!store.onboardingFirstInsightViewedAt;
  const planConfirmationComplete = !!store.onboardingPlanConfirmedAt;
  const canAccessDashboard =
    !!store.onboardingCompletedAt ||
    (dataSyncComplete &&
      moduleSelectionComplete &&
      firstInsightViewedComplete &&
      planConfirmationComplete);

  const stepTemplates: Array<Omit<OnboardingStep, "locked" | "active">> = [
    {
      key: "DATA_SYNC",
      label: "Step 1: Sync Data",
      complete: dataSyncComplete,
      description:
        "Sync live Shopify products, customers, and orders so VedaSuite can analyze the store.",
      helper:
        !connection.healthy
          ? connection.message
          : syncState.status === "SYNC_IN_PROGRESS"
          ? "We’re analyzing your store. Insights will appear soon."
          : syncState.status === "FAILED"
          ? syncState.reason
          : syncState.status === "SYNC_COMPLETED_PROCESSING_PENDING"
          ? "Data synced successfully. Processing is still preparing the first insights."
          : syncState.reason,
      ctaLabel: !connection.healthy ? "Reconnect Shopify" : "Sync Data",
    },
    {
      key: "MODULE_SELECTION",
      label: "Step 2: Choose Module",
      complete: moduleSelectionComplete,
      description:
        "Pick one module to start with so the first guided workflow is clear and focused.",
      helper:
        !dataSyncComplete
          ? "Finish data sync before selecting the first workflow."
          : selectedModuleAvailable
          ? `${moduleTitle(selectedModule!)} is selected as the first workflow.`
          : billing.planName === "STARTER" &&
            subscription.starterModule === null
          ? "Starter requires one selected module in billing before you can continue."
          : "Choose one available module to start with.",
      ctaLabel: selectedModuleAvailable ? "Module selected" : "Choose Module",
    },
    {
      key: "FIRST_INSIGHT_VIEW",
      label: "Step 3: View First Insight",
      complete: firstInsightViewedComplete,
      description:
        "Open the first module view and review the first real or limited-data insight from your store.",
      helper:
        !moduleSelectionComplete
          ? "Select a module first."
          : store.onboardingFirstInsightViewedAt
          ? "First insight viewed."
          : !hasAnyProcessedData
          ? "If the store has little history, VedaSuite will explain why insights are still limited."
          : "Review the first insight in the selected module.",
      ctaLabel: "View First Insight",
    },
    {
      key: "PLAN_CONFIRMATION",
      label: "Step 4: Confirm Plan",
      complete: planConfirmationComplete,
      description:
        "Confirm the current plan so VedaSuite can unlock the right modules and take you to the dashboard.",
      helper:
        planConfirmationComplete
          ? `Plan confirmed: ${billing.planName}.`
          : `Current plan: ${billing.planName}. Confirm it or manage the subscription before entering the dashboard.`,
      ctaLabel: "Confirm Plan",
    },
  ];

  const activeStepIndex = canAccessDashboard ? stepTemplates.length - 1 : firstIncompleteIndex(stepTemplates);
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
    !connection.healthy
      ? {
          key: "RECONNECT_SHOPIFY" as const,
          label: "Reconnect Shopify",
          route: "/app/onboarding",
        }
      : stage === "DATA_SYNC"
      ? {
          key: "SYNC_LIVE_DATA" as const,
          label:
            syncState.status === "SYNC_IN_PROGRESS" ? "Analyzing store" : "Sync Data",
          route: "/app/onboarding",
        }
      : stage === "MODULE_SELECTION"
      ? {
          key: "CHOOSE_MODULE" as const,
          label: "Choose Module",
          route: "/app/onboarding",
        }
      : stage === "FIRST_INSIGHT_VIEW"
      ? {
          key: "VIEW_FIRST_INSIGHT" as const,
          label: "Open First Module",
          route: selectedModule ? moduleRoute(selectedModule) : "/app/onboarding",
        }
      : stage === "PLAN_CONFIRMATION"
      ? {
          key: "CONFIRM_PLAN" as const,
          label: "Confirm Plan",
          route: "/app/billing",
        }
      : {
          key: "OPEN_DASHBOARD" as const,
          label: "Open Dashboard",
          route: "/app/dashboard",
        };

  return {
    stage,
    canAccessDashboard,
    dashboardEntryState: mapDashboardState(syncState.status),
    isCompleted: !!store.onboardingCompletedAt,
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
      syncStatus: syncState.status,
      syncReason: syncState.reason,
      connectionHealthy: connection.healthy,
      webhooksReady,
      hasAnyRawData,
      hasAnyProcessedData,
      stateLabel:
        syncState.status === "SYNC_IN_PROGRESS"
          ? "Analyzing store"
          : syncState.status === "SYNC_COMPLETED_PROCESSING_PENDING" ||
            syncState.status === "EMPTY_STORE_DATA"
          ? "Limited insights"
          : syncState.status === "FAILED"
          ? "Needs attention"
          : syncState.status === "READY_WITH_DATA"
          ? "Ready with data"
          : "Sync required",
    },
    stateSummary:
      !connection.healthy
        ? {
            tone: "critical",
            title: "Shopify connection needs attention",
            description: connection.message,
            ctaLabel: "Reconnect Shopify",
          }
        : syncState.status === "SYNC_IN_PROGRESS"
        ? {
            tone: "info",
            title: "We’re analyzing your store. Insights will appear soon.",
            description:
              "VedaSuite is syncing Shopify data and preparing the first insight views.",
            ctaLabel: "Refresh state",
          }
        : syncState.status === "SYNC_COMPLETED_PROCESSING_PENDING"
        ? {
            tone: "info",
            title: "Store data is synced. Insights are still being prepared.",
            description:
              "You can continue onboarding while VedaSuite finalizes the first insights.",
            ctaLabel: "Continue onboarding",
          }
        : syncState.status === "EMPTY_STORE_DATA"
        ? {
            tone: "attention",
            title: "Store synced, but there is limited historical data to analyze.",
            description:
              "VedaSuite will show limited insights until Shopify has more order and customer history.",
            ctaLabel: "Continue onboarding",
          }
        : syncState.status === "FAILED"
        ? {
            tone: "critical",
            title: "Store analysis needs attention",
            description: syncState.reason,
            ctaLabel: "Retry sync",
          }
        : {
            tone: "success",
            title: "Store data is ready for guided setup",
            description:
              "VedaSuite has enough synced data to guide you through the first workflow.",
            ctaLabel: "Continue onboarding",
          },
    moduleOverview: moduleAvailability,
    selectedModule,
    selectedModuleTitle: selectedModule ? moduleTitle(selectedModule) : null,
    selectedModuleRoute: selectedModule ? moduleRoute(selectedModule) : null,
    sampleInsights: [
      {
        key: "fraud-sample",
        module: "Fraud Intelligence",
        title: "Customer flagged: High refund frequency (Score: 82/100)",
        detail:
          "Sample insight: VedaSuite highlights refund-heavy shopper behavior so you can review risky orders faster.",
      },
      {
        key: "competitor-sample",
        module: "Competitor Intelligence",
        title: "Competitor reduced price by 12% on top product",
        detail:
          "Sample insight: competitor monitoring surfaces price moves, promotions, and market pressure worth reacting to.",
      },
      {
        key: "pricing-sample",
        module: "AI Pricing Engine",
        title: "Suggested price increase: +8% to improve margin",
        detail:
          "Sample insight: pricing recommendations weigh margin protection against current demand signals.",
      },
    ],
    planSummary: {
      planName: billing.planName,
      billingActive: billing.active,
      starterModule:
        normalizeStarterModuleLabel(subscription.starterModule as StarterModule | null) ??
        null,
      unlockedFeatures: [
        subscription.enabledModules.trustAbuse ? "Fraud detection" : null,
        subscription.enabledModules.competitor ? "Competitor tracking" : null,
        subscription.enabledModules.pricingProfit ? "Pricing optimization" : null,
      ].filter((value): value is string => !!value),
      lockedFeatures: [
        subscription.enabledModules.trustAbuse ? null : "Fraud detection",
        subscription.enabledModules.competitor ? null : "Competitor tracking",
        subscription.enabledModules.pricingProfit ? null : "Pricing optimization",
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
    billingActive: billing.active,
    limitedDataReason:
      syncState.status === "EMPTY_STORE_DATA"
        ? "Shopify synced successfully, but the store currently has limited order or customer history."
        : !hasAnyProcessedData && hasAnyRawData
        ? "VedaSuite is still turning synced store data into dashboard-ready outputs."
        : null,
  };
}

export async function selectOnboardingModule(input: {
  shopDomain: string;
  moduleKey: string;
}) {
  const onboarding = await getOnboardingState(input.shopDomain);
  const normalizedModule = normalizeOnboardingModule(input.moduleKey);

  if (!normalizedModule) {
    throw new Error("Invalid onboarding module.");
  }

  const module = onboarding.moduleOverview.find((item) => item.key === normalizedModule);
  if (!module?.available) {
    throw new Error("That module is not available on the current plan.");
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
    throw new Error("View the first insight before confirming the plan.");
  }

  await prisma.store.update({
    where: { shop: shopDomain },
    data: {
      onboardingPlanConfirmedAt: new Date(),
      onboardingCompletedAt: new Date(),
      onboardingDismissedAt: null,
    } as any,
  });

  return getOnboardingState(shopDomain);
}

export async function markOnboardingComplete(shopDomain: string) {
  const onboarding = await getOnboardingState(shopDomain);
  if (!onboarding.canAccessDashboard) {
    throw new Error("Complete the onboarding flow before entering the dashboard.");
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

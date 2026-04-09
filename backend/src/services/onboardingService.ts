import { prisma } from "../db/prismaClient";
import { getConnectionHealth } from "./shopifyConnectionService";
import { normalizeStarterModuleLabel } from "../billing/capabilities";
import { getCurrentSubscription, resolveBillingState } from "./subscriptionService";
import {
  deriveSyncStatus,
  getStoreOperationalSnapshot,
  type StoreSyncStatus,
} from "./storeOperationalStateService";

export type OnboardingStage =
  | "WELCOME"
  | "CONNECTION_CHECK"
  | "FIRST_SYNC"
  | "PLAN_SELECTION_OR_SKIP"
  | "FIRST_VALUE_GUIDE"
  | "COMPLETE";

export type OnboardingActionKey =
  | "RECONNECT_SHOPIFY"
  | "SYNC_LIVE_DATA"
  | "VIEW_PRICING"
  | "OPEN_TRUST_ABUSE"
  | "OPEN_PRICING_PROFIT"
  | "OPEN_COMPETITOR"
  | "OPEN_DASHBOARD";

export type DashboardEntryState =
  | "NOT_CONNECTED"
  | "SYNC_REQUIRED"
  | "SYNC_IN_PROGRESS"
  | "PROCESSING_PENDING"
  | "READY_WITH_DATA"
  | "EMPTY_STORE_DATA"
  | "PLAN_SELECTION";

type OnboardingStep = {
  key: "DATA_SYNC" | "MODULE_SELECTION" | "FIRST_INSIGHT_VIEW" | "PLAN_CONFIRMATION";
  label: string;
  complete: boolean;
  active: boolean;
  locked: boolean;
  description: string;
  helper: string;
  ctaLabel: string;
};

type ModuleAvailability = {
  key: "trustAbuse" | "competitor" | "pricingProfit";
  title: string;
  summary: string;
  route: string;
  available: boolean;
  lockReason: string | null;
};

type InsightPreview = {
  key: string;
  module: string;
  badge: string;
  title: string;
  detail: string;
};

function firstIncompleteIndex(steps: Array<{ complete: boolean }>) {
  const index = steps.findIndex((step) => !step.complete);
  return index === -1 ? steps.length - 1 : index;
}

function mapSyncStateToDashboardEntry(
  syncStatus: StoreSyncStatus,
  planName: string
): DashboardEntryState {
  if (syncStatus === "NOT_CONNECTED") return "NOT_CONNECTED";
  if (syncStatus === "SYNC_REQUIRED") return "SYNC_REQUIRED";
  if (syncStatus === "SYNC_IN_PROGRESS") return "SYNC_IN_PROGRESS";
  if (syncStatus === "SYNC_COMPLETED_PROCESSING_PENDING") {
    return "PROCESSING_PENDING";
  }
  if (syncStatus === "EMPTY_STORE_DATA") return "EMPTY_STORE_DATA";
  if ((planName === "NONE" || planName === "TRIAL") && syncStatus === "READY_WITH_DATA") {
    return "PLAN_SELECTION";
  }
  return "READY_WITH_DATA";
}

function buildNextAction(input: {
  stage: OnboardingStage;
  syncStatus: StoreSyncStatus;
  planName: string;
}) {
  switch (input.stage) {
    case "CONNECTION_CHECK":
      return {
        key: "RECONNECT_SHOPIFY" as OnboardingActionKey,
        label: "Reconnect Shopify",
        route: "/",
      };
    case "FIRST_SYNC":
      return {
        key: "SYNC_LIVE_DATA" as OnboardingActionKey,
        label:
          input.syncStatus === "SYNC_IN_PROGRESS"
            ? "Sync in progress"
            : "Start Analysis",
        route: "/",
      };
    case "PLAN_SELECTION_OR_SKIP":
      return {
        key: "VIEW_PRICING" as OnboardingActionKey,
        label: "Manage plan",
        route: "/subscription",
      };
    case "FIRST_VALUE_GUIDE":
      if (input.planName === "STARTER") {
        return {
          key: "OPEN_TRUST_ABUSE" as OnboardingActionKey,
          label: "Open selected Starter module",
          route: "/trust-abuse",
        };
      }
      return {
        key: "OPEN_TRUST_ABUSE" as OnboardingActionKey,
        label: "Open first insight view",
        route: "/trust-abuse",
      };
    default:
      return {
        key: "OPEN_DASHBOARD" as OnboardingActionKey,
        label: "Open dashboard",
        route: "/",
      };
  }
}

export async function getOnboardingState(shopDomain: string) {
  const [store, connection, operational, billing, subscription] = await Promise.all([
    prisma.store.findUnique({
      where: { shop: shopDomain },
      select: {
        id: true,
        shop: true,
        onboardingCompletedAt: true,
        onboardingDismissedAt: true,
        webhooksRegisteredAt: true,
        lastWebhookRegistrationStatus: true,
        installedAt: true,
      },
    }),
    getConnectionHealth(shopDomain, { probeApi: false }),
    getStoreOperationalSnapshot(shopDomain),
    resolveBillingState(shopDomain),
    getCurrentSubscription(shopDomain),
  ]);

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
  const hasPaidPlan =
    billing.planName === "STARTER" ||
    billing.planName === "GROWTH" ||
    billing.planName === "PRO";
  const moduleSelectionSettled =
    billing.planName !== "STARTER" ||
    !!subscription.starterModule;
  const webhooksReady =
    !!store.webhooksRegisteredAt &&
    store.lastWebhookRegistrationStatus !== "FAILED";
  const isDismissed = !!store.onboardingDismissedAt;
  const isCompleted = !!store.onboardingCompletedAt;

  let stage: OnboardingStage;

  if (
    connection.healthy &&
    !operational.store.lastSyncAt &&
    !store.onboardingCompletedAt &&
    !store.onboardingDismissedAt
  ) {
    stage = "WELCOME";
  } else if (!connection.healthy) {
    stage = "CONNECTION_CHECK";
  } else if (!operational.store.lastSyncAt || syncState.status === "SYNC_REQUIRED") {
    stage = "FIRST_SYNC";
  } else if (
    syncState.status === "SYNC_IN_PROGRESS" ||
    syncState.status === "SYNC_COMPLETED_PROCESSING_PENDING"
  ) {
    stage = "FIRST_SYNC";
  } else if (!hasPaidPlan && !isDismissed) {
    stage = "PLAN_SELECTION_OR_SKIP";
  } else if (!isCompleted) {
    stage = "FIRST_VALUE_GUIDE";
  } else {
    stage = "COMPLETE";
  }

  const dashboardEntryState = mapSyncStateToDashboardEntry(
    syncState.status,
    billing.planName
  );
  const nextAction = buildNextAction({
    stage,
    syncStatus: syncState.status,
    planName: billing.planName,
  });

  const unlockedFeatures = [
    subscription.enabledModules.trustAbuse ? "Fraud detection" : null,
    subscription.enabledModules.competitor ? "Competitor tracking" : null,
    subscription.enabledModules.pricingProfit ? "AI pricing insights" : null,
  ].filter((value): value is string => !!value);
  const lockedFeatures = [
    subscription.enabledModules.trustAbuse ? null : "Fraud detection",
    subscription.enabledModules.competitor ? null : "Competitor tracking",
    subscription.enabledModules.pricingProfit ? null : "AI pricing insights",
  ].filter((value): value is string => !!value);
  const moduleAvailability: ModuleAvailability[] = [
    {
      key: "trustAbuse",
      title: "Fraud Intelligence",
      summary: "Detect refund abuse, flag risky customers, and reduce chargeback exposure.",
      route: "/trust-abuse",
      available: subscription.enabledModules.trustAbuse,
      lockReason: subscription.enabledModules.trustAbuse
        ? null
        : "Upgrade your plan to unlock Fraud Intelligence.",
    },
    {
      key: "competitor",
      title: "Competitor Intelligence",
      summary: "Track competitor pricing, promotions, and market movement from one workflow.",
      route: "/competitor",
      available: subscription.enabledModules.competitor,
      lockReason: subscription.enabledModules.competitor
        ? null
        : "Upgrade your plan to unlock Competitor Intelligence.",
    },
    {
      key: "pricingProfit",
      title: "AI Pricing Engine",
      summary: "Suggest pricing moves, balance margin and demand, and improve conversion.",
      route: "/pricing-profit",
      available: subscription.enabledModules.pricingProfit,
      lockReason: subscription.enabledModules.pricingProfit
        ? null
        : "Upgrade to Growth or Pro to unlock AI Pricing Engine.",
    },
  ];
  const insightPreviews: InsightPreview[] = [
    {
      key: "fraud-preview",
      module: "Fraud Intelligence",
      badge: hasAnyProcessedData && subscription.enabledModules.trustAbuse ? "Preview" : "Sample",
      title: "Customer flagged: High refund frequency (Score: 82/100)",
      detail:
        "VedaSuite can identify refund-heavy customer behavior so merchants can review risky orders faster.",
    },
    {
      key: "competitor-preview",
      module: "Competitor Intelligence",
      badge: operational.counts.competitorRows > 0 ? "Preview" : "Sample",
      title: "Competitor reduced price by 12% on a top product",
      detail:
        "Competitive monitoring highlights pricing changes, promotions, and market pressure worth reacting to.",
    },
    {
      key: "pricing-preview",
      module: "AI Pricing Engine",
      badge:
        subscription.enabledModules.pricingProfit && hasAnyProcessedData
          ? "Preview"
          : "Sample",
      title: "Suggested price increase: +8% to improve margin",
      detail:
        "Pricing recommendations balance margin protection against demand signals from synced store history.",
    },
  ];

  const dataSyncComplete =
    !!operational.store.lastSyncAt &&
    syncState.status !== "SYNC_REQUIRED" &&
    syncState.status !== "SYNC_IN_PROGRESS" &&
    syncState.status !== "NOT_CONNECTED";
  const moduleSelectionComplete =
    dataSyncComplete &&
    moduleSelectionSettled &&
    moduleAvailability.some((module) => module.available);
  const firstInsightComplete =
    moduleSelectionComplete &&
    (hasAnyProcessedData || syncState.status === "EMPTY_STORE_DATA");
  const planConfirmationComplete =
    firstInsightComplete && (hasPaidPlan || isDismissed || isCompleted);

  const baseSteps: Array<Omit<OnboardingStep, "locked" | "active">> = [
    {
      key: "DATA_SYNC",
      label: "Step 1: Data Sync",
      complete: dataSyncComplete,
      description:
        "Connect your store and sync live Shopify orders, customers, and products so VedaSuite can begin analysis.",
      helper:
        syncState.status === "SYNC_IN_PROGRESS"
          ? "We’re analyzing your store. Insights will appear soon."
          : syncState.status === "FAILED"
          ? "Sync needs attention before onboarding can continue."
          : syncState.reason,
      ctaLabel: "Start Analysis",
    },
    {
      key: "MODULE_SELECTION",
      label: "Step 2: Module Selection",
      complete: moduleSelectionComplete,
      description:
        "Choose the first module to explore based on your plan and the type of store signal you want to review.",
      helper:
        !dataSyncComplete
          ? "Complete the data sync first so VedaSuite can route you to the right workflow."
          : billing.planName === "STARTER" && !subscription.starterModule
          ? "Starter requires one selected module before the first workflow is unlocked."
          : "Fraud, competitor, and pricing access follow the current billing plan.",
      ctaLabel: "Choose module",
    },
    {
      key: "FIRST_INSIGHT_VIEW",
      label: "Step 3: First Insight View",
      complete: firstInsightComplete,
      description:
        "Open the first insight view and understand whether VedaSuite already has enough history for live recommendations.",
      helper:
        !moduleSelectionComplete
          ? "Select the first workflow before reviewing insights."
          : hasAnyProcessedData
          ? "Live store signals are ready to review."
          : syncState.status === "EMPTY_STORE_DATA"
          ? "Shopify synced successfully, but the store still has limited history."
          : "Processed outputs are still being prepared from synced data.",
      ctaLabel: "View first insight",
    },
    {
      key: "PLAN_CONFIRMATION",
      label: "Step 4: Plan Confirmation",
      complete: planConfirmationComplete,
      description:
        "Confirm the current plan, see which modules are unlocked, and manage the subscription if broader coverage is needed.",
      helper:
        hasPaidPlan
          ? `Current plan: ${billing.planName}.`
          : "You can continue evaluating on the current state, or confirm a paid plan to unlock broader coverage.",
      ctaLabel: "Manage plan",
    },
  ];
  const activeStepIndex = firstIncompleteIndex(baseSteps);
  const steps: OnboardingStep[] = baseSteps.map((step, index) => ({
    ...step,
    locked: index > 0 && !baseSteps[index - 1].complete,
    active: index === activeStepIndex,
  }));
  const completedSteps = steps.filter((step) => step.complete).length;
  const progressPercent = Math.round((completedSteps / steps.length) * 100);

  const titleMap: Record<OnboardingStage, string> = {
    WELCOME: "Turn Your Store Data Into Fraud Detection & Profit Insights",
    CONNECTION_CHECK: "Turn Your Store Data Into Fraud Detection & Profit Insights",
    FIRST_SYNC: syncState.status === "SYNC_IN_PROGRESS"
      ? "Turn Your Store Data Into Fraud Detection & Profit Insights"
      : "Turn Your Store Data Into Fraud Detection & Profit Insights",
    PLAN_SELECTION_OR_SKIP: "Turn Your Store Data Into Fraud Detection & Profit Insights",
    FIRST_VALUE_GUIDE: "Turn Your Store Data Into Fraud Detection & Profit Insights",
    COMPLETE: "Turn Your Store Data Into Fraud Detection & Profit Insights",
  };

  const descriptionMap: Record<OnboardingStage, string> = {
    WELCOME:
      "VedaSuite syncs Shopify store data, detects refund and fraud abuse, tracks competitor pricing and ads, and surfaces pricing opportunities to protect profit.",
    CONNECTION_CHECK:
      "VedaSuite analyzes Shopify orders, customers, products, and competitor signals to surface risk and profit opportunities for your store.",
    FIRST_SYNC:
      syncState.status === "SYNC_IN_PROGRESS"
        ? "Live Shopify data is syncing now. VedaSuite will unlock insights as soon as enough store history is processed."
        : "Connect your store and sync live Shopify data to unlock fraud, competitor, and pricing analysis.",
    PLAN_SELECTION_OR_SKIP:
      "Choose the plan that matches the modules your store needs. Starter includes one selected module, while Growth and Pro unlock broader coverage.",
    FIRST_VALUE_GUIDE:
      syncState.status === "EMPTY_STORE_DATA"
        ? "Your store synced successfully, but Shopify did not return enough history yet. Some dashboards stay limited until more activity exists."
        : "Review the first insight view and see how VedaSuite turns synced data into workflow-ready recommendations.",
    COMPLETE:
      "Your connection, sync, and plan state are settled. VedaSuite is ready to guide fraud reviews, competitor monitoring, and pricing decisions.",
  };

  const stateSummary =
    !connection.healthy
      ? {
          tone: "critical",
          title: "Connection needs attention",
          description: connection.message,
          badge: "Reconnect required",
        }
      : syncState.status === "SYNC_IN_PROGRESS"
      ? {
          tone: "info",
          title: "We’re analyzing your store. Insights will appear soon.",
          description:
            "Live Shopify data is still syncing and processing. You can stay here while VedaSuite prepares the first outputs.",
          badge: "Sync in progress",
        }
      : syncState.status === "SYNC_COMPLETED_PROCESSING_PENDING"
      ? {
          tone: "info",
          title: "Sync completed. Processing is still finishing.",
          description:
            "VedaSuite has raw store data and is still building dashboard-ready signals from it.",
          badge: "Limited Data",
        }
      : syncState.status === "EMPTY_STORE_DATA"
      ? {
          tone: "attention",
          title: "Your store is connected, but there is limited history to analyze.",
          description:
            "Shopify returned little or no order or customer history, so some insights will remain limited until more activity exists.",
          badge: "Limited Data",
        }
      : syncState.status === "FAILED"
      ? {
          tone: "critical",
          title: "Analysis needs attention before insights can load.",
          description: syncState.reason,
          badge: "Retry required",
        }
      : {
          tone: "success",
          title: "Your store is ready for guided analysis.",
          description:
            "VedaSuite has enough synced data to begin surfacing module-specific guidance.",
          badge: "Ready with data",
        };

  return {
    stage,
    dashboardEntryState,
    isCompleted,
    isDismissed,
    canDismiss: stage === "PLAN_SELECTION_OR_SKIP" || stage === "FIRST_VALUE_GUIDE",
    showPersistentNextStep:
      stage !== "COMPLETE" ||
      !connection.healthy ||
      syncState.status !== "READY_WITH_DATA",
    title: titleMap[stage],
    description: descriptionMap[stage],
    nextAction,
    progress: {
      completedSteps,
      totalSteps: steps.length,
      percent: progressPercent,
    },
    steps,
    hero: {
      headline: "Turn Your Store Data Into Fraud Detection & Profit Insights",
      subtext:
        "VedaSuite syncs Shopify orders, customers, and products to detect fraud abuse, track competitor pricing and ads, and optimize pricing for profit.",
      benefits: [
        "Detect refund & fraud abuse",
        "Track competitor pricing & ads",
        "Optimize pricing for profit",
      ],
    },
    stateSummary,
    moduleAvailability,
    sampleInsights: insightPreviews,
    planSummary: {
      planName: billing.planName,
      billingActive: billing.active,
      starterModule:
        normalizeStarterModuleLabel(subscription.starterModule) ?? null,
      unlockedFeatures,
      lockedFeatures,
      manageRoute: "/subscription",
    },
    privacySummary: {
      title: "Your Data & Privacy",
      description:
        "VedaSuite reads Shopify orders, customers, and products to generate guidance inside the app.",
      bullets: [
        "Accesses Shopify orders, customers, and products to generate insights.",
        "Uses store data to detect fraud, monitor competition, and support pricing decisions.",
        "Keeps data encrypted in transit and at rest, and does not sell merchant data.",
      ],
    },
    connectionHealthy: connection.healthy,
    webhooksReady,
    syncStatus: syncState.status,
    syncReason: syncState.reason,
    hasAnyRawData,
    hasAnyProcessedData,
    currentPlan: billing.planName,
    billingActive: billing.active,
    limitedDataReason:
      syncState.status === "EMPTY_STORE_DATA"
        ? "Shopify synced successfully, but the store currently has little or no historical data."
        : !hasAnyProcessedData && hasAnyRawData
        ? "VedaSuite is still turning synced store data into dashboard-ready module outputs."
        : null,
    recommendedModuleRoute:
      billing.planName === "STARTER" && billing.starterModule === "competitor"
        ? "/competitor"
        : billing.planName === "STARTER"
        ? "/trust-abuse"
        : "/trust-abuse",
  };
}

export async function markOnboardingComplete(shopDomain: string) {
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

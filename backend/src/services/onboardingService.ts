import { prisma } from "../db/prismaClient";
import { getConnectionHealth } from "./shopifyConnectionService";
import { resolveBillingState } from "./subscriptionService";
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
  key: OnboardingStage;
  label: string;
  complete: boolean;
  active: boolean;
  description: string;
};

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
        label: input.syncStatus === "SYNC_IN_PROGRESS" ? "Sync in progress" : "Sync live Shopify data",
        route: "/",
      };
    case "PLAN_SELECTION_OR_SKIP":
      return {
        key: "VIEW_PRICING" as OnboardingActionKey,
        label: "View pricing plans",
        route: "/subscription",
      };
    case "FIRST_VALUE_GUIDE":
      if (input.planName === "STARTER") {
        return {
          key: "OPEN_TRUST_ABUSE" as OnboardingActionKey,
          label: "Open your active Starter module",
          route: "/trust-abuse",
        };
      }
      return {
        key: "OPEN_TRUST_ABUSE" as OnboardingActionKey,
        label: "Review first insights",
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
  const [store, connection, operational, billing] = await Promise.all([
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

  const steps: OnboardingStep[] = [
    {
      key: "WELCOME",
      label: "Welcome",
      active: stage === "WELCOME",
      complete: !!store.installedAt,
      description:
        "Understand what VedaSuite does, which modules it includes, and how the app turns Shopify data into actionable guidance.",
    },
    {
      key: "CONNECTION_CHECK",
      label: "Connection check",
      active: stage === "CONNECTION_CHECK",
      complete: connection.healthy && webhooksReady,
      description:
        "Confirm the Shopify connection is healthy and required sync webhooks are registered.",
    },
    {
      key: "FIRST_SYNC",
      label: "First sync",
      active: stage === "FIRST_SYNC",
      complete: !!operational.store.lastSyncAt && syncState.status !== "SYNC_REQUIRED",
      description:
        "Sync live Shopify products, orders, and customers so VedaSuite can start processing store signals.",
    },
    {
      key: "PLAN_SELECTION_OR_SKIP",
      label: "Plan selection",
      active: stage === "PLAN_SELECTION_OR_SKIP",
      complete: hasPaidPlan || isDismissed,
      description:
        "Choose a plan based on the modules your store needs most, or continue on the current state if you are still evaluating.",
    },
    {
      key: "FIRST_VALUE_GUIDE",
      label: "First value",
      active: stage === "FIRST_VALUE_GUIDE",
      complete: hasAnyProcessedData || syncState.status === "EMPTY_STORE_DATA",
      description:
        "Review the first module view, understand any limited-data states, and see how recommendations improve as more history is available.",
    },
    {
      key: "COMPLETE",
      label: "Complete",
      active: stage === "COMPLETE",
      complete: isCompleted,
      description:
        "Core setup is complete. VedaSuite can now operate as a steady commerce intelligence layer for this store.",
    },
  ];

  const titleMap: Record<OnboardingStage, string> = {
    WELCOME: "Welcome to VedaSuite",
    CONNECTION_CHECK: "Confirm the Shopify connection first",
    FIRST_SYNC: syncState.status === "SYNC_IN_PROGRESS"
      ? "VedaSuite is syncing your Shopify data"
      : "Run the first sync to unlock store signals",
    PLAN_SELECTION_OR_SKIP: "Choose a plan based on the modules your store needs",
    FIRST_VALUE_GUIDE: "Review the first insights VedaSuite produced",
    COMPLETE: "VedaSuite is ready for everyday use",
  };

  const descriptionMap: Record<OnboardingStage, string> = {
    WELCOME:
      "VedaSuite syncs Shopify store data, processes trust, pricing, and competitor signals, and then surfaces module-specific guidance in the app.",
    CONNECTION_CHECK:
      connection.message,
    FIRST_SYNC:
      syncState.status === "SYNC_IN_PROGRESS"
        ? "Live Shopify data is still syncing and processing. Keep this page open or check back in a moment."
        : "Connect your store and sync live Shopify data to unlock VedaSuite insights.",
    PLAN_SELECTION_OR_SKIP:
      "Starter includes one selected module. Growth broadens coverage. Pro unlocks the full operating layer.",
    FIRST_VALUE_GUIDE:
      syncState.status === "EMPTY_STORE_DATA"
        ? "Your store synced successfully, but Shopify did not return enough historical data yet. Some analytics will stay limited until more activity exists."
        : "Start with the recommended module, then explore additional workflows as VedaSuite processes more history.",
    COMPLETE:
      "Your connection, sync, and plan state are settled. Use the dashboard to move between trust, competitor, pricing, and reporting workflows.",
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
    steps,
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

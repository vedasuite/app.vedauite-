import { getConnectionHealth } from "./shopifyConnectionService";
import { derivePricingEngineViewState } from "./pricingEngineStateService";
import {
  deriveSyncStatus,
  getStoreOperationalSnapshot,
  type StoreSyncStatus,
} from "./storeOperationalStateService";
import {
  createUnifiedModuleState,
  isStaleTimestamp,
  toIsoString,
  type UnifiedModuleState,
} from "./unifiedModuleStateService";
import { getCurrentSubscription, resolveBillingState } from "./subscriptionService";

export type CanonicalReadinessStatus =
  | "locked"
  | "setup_needed"
  | "collecting_data"
  | "ready"
  | "error";

export type CanonicalQuickAccessStatus =
  | "Locked"
  | "Setup needed"
  | "Collecting data"
  | "Ready"
  | "Error";

export type ReadinessItem = {
  state: CanonicalReadinessStatus;
  status: CanonicalQuickAccessStatus;
  title: string;
  description: string;
  nextAction: string | null;
  route: string | null;
  ready: boolean;
  locked: boolean;
  freshnessAt: string | null;
  detail: Record<string, unknown>;
};

export type UnifiedReadinessState = {
  generatedAt: string;
  connection: ReadinessItem & {
    healthy: boolean;
    code: string;
  };
  initialSync: ReadinessItem & {
    syncStatus: StoreSyncStatus;
    hasRawData: boolean;
    hasProcessedData: boolean;
  };
  billing: ReadinessItem & {
    lifecycle: string;
    planName: string;
    accessActive: boolean;
    verified: boolean;
  };
  modules: {
    fraud: ReadinessItem;
    competitor: ReadinessItem;
    pricing: ReadinessItem;
  };
  setup: {
    minimumComplete: boolean;
    allCoreModulesReady: boolean;
    blockers: string[];
    nextAction: {
      label: string;
      route: string;
    };
    percent: number;
    summaryTitle: string;
    summaryDescription: string;
  };
  moduleStates: {
    fraud: UnifiedModuleState;
    competitor: UnifiedModuleState;
    pricing: UnifiedModuleState;
  };
  quickAccess: {
    fraud: {
      status: CanonicalQuickAccessStatus;
      freshnessAt: string | null;
      reason: string;
      state: CanonicalReadinessStatus;
    };
    competitor: {
      status: CanonicalQuickAccessStatus;
      freshnessAt: string | null;
      reason: string;
      state: CanonicalReadinessStatus;
    };
    pricing: {
      status: CanonicalQuickAccessStatus;
      freshnessAt: string | null;
      reason: string;
      state: CanonicalReadinessStatus;
    };
  };
};

function toQuickAccessStatus(state: CanonicalReadinessStatus): CanonicalQuickAccessStatus {
  switch (state) {
    case "locked":
      return "Locked";
    case "setup_needed":
      return "Setup needed";
    case "collecting_data":
      return "Collecting data";
    case "ready":
      return "Ready";
    default:
      return "Error";
  }
}

function createReadinessItem(input: {
  state: CanonicalReadinessStatus;
  title: string;
  description: string;
  nextAction?: string | null;
  route?: string | null;
  freshnessAt?: string | null;
  detail?: Record<string, unknown>;
}): ReadinessItem {
  return {
    state: input.state,
    status: toQuickAccessStatus(input.state),
    title: input.title,
    description: input.description,
    nextAction: input.nextAction ?? null,
    route: input.route ?? null,
    ready: input.state === "ready",
    locked: input.state === "locked",
    freshnessAt: input.freshnessAt ?? null,
    detail: input.detail ?? {},
  };
}

function readinessStateToModuleStatus(state: CanonicalReadinessStatus): UnifiedModuleState["dataStatus"] {
  switch (state) {
    case "ready":
      return "ready";
    case "collecting_data":
      return "processing";
    case "error":
      return "failed";
    case "locked":
      return "partial";
    case "setup_needed":
    default:
      return "empty";
  }
}

function buildModuleStateFromReadiness(input: {
  readiness: ReadinessItem;
  syncStatus: UnifiedModuleState["syncStatus"];
  lastSuccessfulSyncAt: string | null;
  lastAttemptAt: string | null;
  coverage: UnifiedModuleState["coverage"];
  dependencies: UnifiedModuleState["dependencies"];
  dataChanged?: boolean;
  setupStatus?: UnifiedModuleState["setupStatus"];
}): UnifiedModuleState {
  return createUnifiedModuleState({
    setupStatus:
      input.setupStatus ??
      (input.readiness.state === "setup_needed" || input.readiness.state === "locked"
        ? "incomplete"
        : "complete"),
    syncStatus: input.syncStatus,
    dataStatus: readinessStateToModuleStatus(input.readiness.state),
    lastSuccessfulSyncAt: input.lastSuccessfulSyncAt,
    lastAttemptAt: input.lastAttemptAt,
    coverage: input.coverage,
    dataChanged: input.dataChanged ?? false,
    dependencies: input.dependencies,
    title: input.readiness.title,
    description: input.readiness.description,
    nextAction: input.readiness.nextAction,
  });
}

function syncStatusToCanonicalState(syncStatus: StoreSyncStatus) {
  switch (syncStatus) {
    case "READY_WITH_DATA":
      return "ready";
    case "SYNC_IN_PROGRESS":
    case "SYNC_COMPLETED_PROCESSING_PENDING":
      return "collecting_data";
    case "FAILED":
    case "NOT_CONNECTED":
      return "error";
    default:
      return "setup_needed";
  }
}

function buildSetupSummary(input: {
  connection: ReadinessItem;
  sync: ReadinessItem;
  billing: ReadinessItem;
  fraud: ReadinessItem;
  competitor: ReadinessItem;
  pricing: ReadinessItem;
  selectedModuleState: CanonicalReadinessStatus | null;
}) {
  const milestoneStates = [
    input.connection.ready,
    input.sync.ready,
    input.billing.ready,
    input.selectedModuleState === "ready",
  ];
  const completedCount = milestoneStates.filter(Boolean).length;
  const blockers = [
    input.connection.ready ? null : input.connection.description,
    input.sync.ready ? null : input.sync.description,
    input.billing.ready ? null : input.billing.description,
    input.selectedModuleState === "ready"
      ? null
      : "Choose a workflow with enough activity before marking the store ready.",
  ].filter((value): value is string => !!value);

  const nextAction =
    !input.connection.ready
      ? { label: "Reconnect Shopify", route: "/app/onboarding" }
      : !input.sync.ready
      ? { label: "Update store insights", route: "/app/onboarding" }
      : !input.billing.ready
      ? { label: "Review billing", route: "/app/billing" }
      : input.selectedModuleState !== "ready"
      ? { label: "Choose workflow", route: "/app/onboarding" }
      : { label: "Open dashboard", route: "/app/dashboard" };

  const allCoreModulesReady =
    input.fraud.ready && input.competitor.ready && input.pricing.ready;
  const minimumComplete =
    input.connection.ready &&
    input.sync.ready &&
    input.billing.ready &&
    input.selectedModuleState === "ready";

  const summaryTitle = !input.connection.ready
    ? "Shopify connection needs attention"
    : !input.sync.ready
    ? "Store insights are being prepared"
    : !input.billing.ready
    ? "Billing still needs confirmation"
    : !minimumComplete
    ? "Complete setup to begin receiving insights"
    : allCoreModulesReady
    ? "Your store is connected and ready"
    : "Your store is connected and ready";

  const summaryDescription = !minimumComplete
    ? blockers[0] ?? "Complete the remaining steps before insights appear."
    : allCoreModulesReady
    ? "Connection, billing, and core insights are ready for normal use."
    : "Connection and billing are ready. Additional insights will appear as store activity grows.";

  return {
    minimumComplete,
    allCoreModulesReady,
    blockers,
    nextAction,
    percent: Math.round((completedCount / milestoneStates.length) * 100),
    summaryTitle,
    summaryDescription,
  };
}

function normalizeSelectedModule(value?: string | null) {
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

export function deriveReadinessState(input: {
  entitled: boolean;
  connectionHealthy: boolean;
  syncStatus: StoreSyncStatus;
  setupComplete: boolean;
  dataReady: boolean;
  isRunning?: boolean;
  hasFailed?: boolean;
}): CanonicalReadinessStatus {
  if (!input.entitled) {
    return "locked";
  }

  if (input.hasFailed || !input.connectionHealthy || input.syncStatus === "FAILED") {
    return "error";
  }

  if (input.isRunning || input.syncStatus === "SYNC_IN_PROGRESS") {
    return "collecting_data";
  }

  if (!input.setupComplete || input.syncStatus === "SYNC_REQUIRED") {
    return "setup_needed";
  }

  if (!input.dataReady || input.syncStatus === "SYNC_COMPLETED_PROCESSING_PENDING") {
    return "collecting_data";
  }

  return "ready";
}

export async function getUnifiedReadinessState(shopDomain: string): Promise<UnifiedReadinessState> {
  const [connectionHealth, operational, billing, subscription] = await Promise.all([
    getConnectionHealth(shopDomain, { probeApi: false }),
    getStoreOperationalSnapshot(shopDomain),
    resolveBillingState(shopDomain),
    getCurrentSubscription(shopDomain),
  ]);

  const syncStatus = deriveSyncStatus({
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

  const hasRawData =
    operational.counts.products + operational.counts.orders + operational.counts.customers > 0;
  const hasProcessedData =
    operational.counts.pricingRows +
      operational.counts.profitRows +
      operational.counts.timelineEvents +
      operational.counts.competitorRows >
    0;
  const lastProcessingAt = toIsoString(operational.latestProcessingAt);
  const lastCompetitorAt = toIsoString(operational.latestCompetitorAt);
  const lastSyncAttemptAt = toIsoString(
    operational.latestSyncJob?.finishedAt ?? operational.latestSyncJob?.startedAt ?? null
  );
  const lastCompetitorAttemptAt = toIsoString(
    operational.latestCompetitorIngestJob?.finishedAt ??
      operational.latestCompetitorIngestJob?.startedAt ??
      null
  );

  const connection = createReadinessItem({
    state: connectionHealth.healthy ? "ready" : "error",
    title: connectionHealth.healthy
      ? "Shopify connection verified"
      : "Shopify connection needs attention",
    description: connectionHealth.healthy
      ? "VedaSuite is connected to Shopify and ready to support store insights."
      : connectionHealth.message,
    nextAction: connectionHealth.healthy ? "Continue setup" : "Reconnect Shopify",
    route: "/app/onboarding",
    detail: {
      code: connectionHealth.code,
      reauthorizeUrl: connectionHealth.reauthorizeUrl ?? null,
    },
  });

  const initialSyncState = syncStatusToCanonicalState(syncStatus.status);
  const initialSync = createReadinessItem({
    state: initialSyncState,
    title:
      syncStatus.status === "READY_WITH_DATA"
        ? "Shopify store data is ready"
        : syncStatus.status === "SYNC_IN_PROGRESS"
        ? "Store insights are updating"
        : syncStatus.status === "SYNC_COMPLETED_PROCESSING_PENDING"
        ? "Store insights are being prepared"
        : syncStatus.status === "FAILED"
        ? "Store connection needs attention"
        : "Update store insights",
    description: syncStatus.reason,
    nextAction:
      initialSyncState === "ready"
        ? "Continue setup"
        : initialSyncState === "error"
        ? "Try again"
        : "Update store insights",
    route: "/app/onboarding",
    freshnessAt: toIsoString(operational.store.lastSyncAt),
    detail: {
      products: operational.counts.products,
      orders: operational.counts.orders,
      customers: operational.counts.customers,
      processedOutputs: {
        pricingRows: operational.counts.pricingRows,
        profitRows: operational.counts.profitRows,
        timelineEvents: operational.counts.timelineEvents,
        competitorRows: operational.counts.competitorRows,
      },
    },
  });

  const billingState =
    billing.lifecycle === "active"
      ? "ready"
      : billing.lifecycle === "pending_approval"
      ? "collecting_data"
      : billing.lifecycle === "unknown_error" || billing.lifecycle === "frozen"
      ? "error"
      : "setup_needed";
  const billingReadiness = createReadinessItem({
    state: billingState,
    title:
      billingState === "ready"
        ? `Your ${billing.planName} subscription is active`
        : billingState === "collecting_data"
        ? "Billing approval is waiting in Shopify"
        : billingState === "error"
        ? "Billing needs attention"
        : "Choose a plan to unlock included features",
    description: billing.merchantDescription,
    nextAction:
      billingState === "ready"
        ? "Open dashboard"
        : billingState === "collecting_data"
        ? "Wait for Shopify confirmation"
        : "Open billing",
    route: "/app/billing",
    freshnessAt: billing.lastBillingSyncAt,
    detail: {
      lifecycle: billing.lifecycle,
      planName: billing.planName,
      accessActive: billing.accessActive,
      verified: billing.verified,
    },
  });

  const fraudReadiness = createReadinessItem({
    state: deriveReadinessState({
      entitled: subscription.enabledModules.fraud,
      connectionHealthy: connectionHealth.healthy,
      syncStatus: syncStatus.status,
      setupComplete: hasRawData,
      dataReady: operational.counts.timelineEvents > 0,
      isRunning: syncStatus.status === "SYNC_IN_PROGRESS",
      hasFailed: syncStatus.status === "FAILED",
    }),
    title:
      !subscription.enabledModules.fraud
        ? "Fraud Intelligence is locked"
        : operational.counts.timelineEvents > 0
        ? "Fraud protection enabled"
        : syncStatus.status === "SYNC_IN_PROGRESS" ||
          syncStatus.status === "SYNC_COMPLETED_PROCESSING_PENDING"
        ? "Fraud protection is analyzing new orders"
        : "Sync orders to enable fraud protection",
    description:
      !subscription.enabledModules.fraud
        ? "Upgrade the current plan to unlock Fraud Intelligence."
      : operational.counts.timelineEvents > 0
        ? "Risk checks and refund-abuse signals are available from recent store activity."
      : syncStatus.status === "FAILED"
        ? "Store data needs attention before fraud checks can finish."
        : "More order and customer activity is needed before advanced fraud insights appear.",
    nextAction:
      !subscription.enabledModules.fraud
        ? "Open billing"
      : operational.counts.timelineEvents > 0
        ? "Open Fraud Intelligence"
        : "Update store insights",
    route: subscription.enabledModules.fraud ? "/app/fraud-intelligence" : "/app/billing",
    freshnessAt: lastProcessingAt,
    detail: {
      timelineEvents: operational.counts.timelineEvents,
      orders: operational.counts.orders,
      customers: operational.counts.customers,
    },
  });

  const competitorHasSetup = operational.counts.competitorDomains > 0;
  const competitorCollecting =
    operational.latestCompetitorIngestJob?.status === "RUNNING" ||
    (syncStatus.status === "SYNC_COMPLETED_PROCESSING_PENDING" && competitorHasSetup);
  const competitorFailed = operational.latestCompetitorIngestJob?.status === "FAILED";
  const competitorState = deriveReadinessState({
    entitled: subscription.enabledModules.competitor,
    connectionHealthy: connectionHealth.healthy,
    syncStatus: syncStatus.status,
    setupComplete: competitorHasSetup,
    dataReady: operational.counts.competitorRows > 0,
    isRunning: competitorCollecting,
    hasFailed: competitorFailed,
  });
  const competitorDescription =
    !subscription.enabledModules.competitor
      ? "Upgrade the current plan to unlock Competitor Intelligence."
      : !competitorHasSetup
      ? "Add competitor websites to begin tracking pricing and product trends."
      : competitorFailed
      ? operational.latestCompetitorIngestJob?.errorMessage ??
        "The latest competitor analysis needs attention."
      : operational.counts.competitorRows > 0
      ? isStaleTimestamp(operational.latestCompetitorAt)
        ? "Competitor analysis has not been updated recently."
        : "Comparable competitor products were matched and analysis is available."
      : competitorCollecting
      ? "Competitor analysis is reviewing your selected websites."
      : "Competitor analysis completed. No matching products were identified yet.";
  const competitorReadiness = createReadinessItem({
    state:
      competitorState === "ready" && isStaleTimestamp(operational.latestCompetitorAt)
        ? "collecting_data"
        : competitorState,
    title:
      !subscription.enabledModules.competitor
        ? "Competitor Intelligence is locked"
        : !competitorHasSetup
        ? "Add competitor websites to begin analysis"
        : operational.counts.competitorRows > 0 && !isStaleTimestamp(operational.latestCompetitorAt)
        ? "Competitor analysis is active"
        : competitorCollecting
        ? "Competitor analysis is updating"
        : "Add competitor websites to begin analysis",
    description: competitorDescription,
    nextAction:
      !subscription.enabledModules.competitor
        ? "Open billing"
      : !competitorHasSetup
        ? "Add competitor websites"
      : operational.counts.competitorRows > 0
        ? "Open Competitor Intelligence"
        : "Review competitor websites and tracked products",
    route: subscription.enabledModules.competitor
      ? "/app/competitor-intelligence"
      : "/app/billing",
    freshnessAt: lastCompetitorAt,
    detail: {
      competitorDomains: operational.counts.competitorDomains,
      competitorRows: operational.counts.competitorRows,
      lastCompetitorJobStatus: operational.latestCompetitorIngestJob?.status ?? null,
    },
  });

  const provisionalPricingModuleState = createUnifiedModuleState({
    setupStatus: hasRawData ? "complete" : "incomplete",
    syncStatus:
      syncStatus.status === "FAILED"
        ? "failed"
        : syncStatus.status === "SYNC_IN_PROGRESS" ||
          syncStatus.status === "SYNC_COMPLETED_PROCESSING_PENDING"
        ? "running"
        : "completed",
    dataStatus:
      operational.counts.pricingRows + operational.counts.profitRows > 0
        ? "ready"
        : syncStatus.status === "SYNC_IN_PROGRESS" ||
          syncStatus.status === "SYNC_COMPLETED_PROCESSING_PENDING"
        ? "processing"
        : "empty",
    lastSuccessfulSyncAt: lastProcessingAt,
    lastAttemptAt: lastSyncAttemptAt,
    coverage: operational.counts.competitorRows > 0 ? "full" : "partial",
    dependencies: {
      fraud: operational.counts.timelineEvents > 0 ? "ready" : "missing",
      competitor: operational.counts.competitorRows > 0 ? "ready" : "missing",
      pricing:
        operational.counts.pricingRows + operational.counts.profitRows > 0
          ? "ready"
          : "missing",
    },
    title: "Pricing insights",
    description: "Pricing insights are based on available store activity.",
  });
  const pricingViewState = derivePricingEngineViewState({
    syncStatus: syncStatus.status,
    moduleState: provisionalPricingModuleState,
    productsCount: operational.counts.products,
    ordersCount: operational.counts.orders,
    competitorCount: operational.counts.competitorRows,
    pricingRows: operational.counts.pricingRows,
    profitRows: operational.counts.profitRows,
    recommendationCount: operational.counts.pricingRows,
    invalidRecommendationCount: 0,
    timedOutSources: [],
  });
  const pricingReadiness = createReadinessItem({
    state:
      !subscription.enabledModules.pricing
        ? "locked"
        : pricingViewState.status === "ready"
        ? "ready"
        : pricingViewState.status === "failed_timeout" ||
          pricingViewState.status === "failed_error"
        ? "error"
        : pricingViewState.status === "syncing"
        ? "collecting_data"
        : "setup_needed",
    title:
      !subscription.enabledModules.pricing
        ? "AI Pricing Engine is locked"
        : pricingViewState.status === "ready"
        ? "Pricing analysis ready"
        : pricingViewState.status === "failed_timeout" ||
          pricingViewState.status === "failed_error"
        ? "AI Pricing Engine needs attention"
        : pricingViewState.status === "syncing"
        ? "Pricing analysis is updating"
        : "More store activity is needed before pricing analysis is ready",
    description: pricingViewState.description,
    nextAction:
      !subscription.enabledModules.pricing
        ? "Open billing"
        : pricingViewState.status === "ready"
        ? "Open AI Pricing Engine"
        : pricingViewState.nextAction ?? "Update store insights",
    route: subscription.enabledModules.pricing ? "/app/ai-pricing-engine" : "/app/billing",
    freshnessAt: pricingViewState.lastSuccessfulRunAt,
    detail: {
      viewStatus: pricingViewState.status,
      emptyReason: pricingViewState.emptyReason,
      processingSummary: pricingViewState.processingSummary,
    },
  });

  const moduleStates = {
    fraud: buildModuleStateFromReadiness({
      readiness: fraudReadiness,
      syncStatus:
        fraudReadiness.state === "error"
          ? "failed"
          : fraudReadiness.state === "collecting_data"
          ? "running"
          : "completed",
      lastSuccessfulSyncAt: lastProcessingAt,
      lastAttemptAt: lastSyncAttemptAt,
      coverage: operational.counts.timelineEvents > 0 ? "full" : "none",
      dependencies: {
        fraud: operational.counts.timelineEvents > 0 ? "ready" : "missing",
        competitor: operational.counts.competitorRows > 0 ? "ready" : "missing",
        pricing:
          operational.counts.pricingRows + operational.counts.profitRows > 0
            ? "ready"
            : "missing",
      },
      dataChanged: operational.counts.timelineEvents > 0,
    }),
    competitor: buildModuleStateFromReadiness({
      readiness: competitorReadiness,
      syncStatus:
        competitorReadiness.state === "error"
          ? "failed"
          : competitorReadiness.state === "collecting_data"
          ? "running"
          : competitorHasSetup
          ? "completed"
          : "idle",
      lastSuccessfulSyncAt: lastCompetitorAt,
      lastAttemptAt: lastCompetitorAttemptAt,
      coverage:
        operational.counts.competitorRows > 0
          ? "full"
          : competitorHasSetup
          ? "partial"
          : "none",
      dependencies: {
        fraud: operational.counts.timelineEvents > 0 ? "ready" : "missing",
        competitor: operational.counts.competitorRows > 0 ? "ready" : "missing",
        pricing:
          operational.counts.pricingRows + operational.counts.profitRows > 0
            ? "ready"
            : "missing",
      },
      dataChanged: operational.counts.competitorRows > 0,
    }),
    pricing: buildModuleStateFromReadiness({
      readiness: pricingReadiness,
      syncStatus:
        pricingReadiness.state === "error"
          ? "failed"
          : pricingReadiness.state === "collecting_data"
          ? "running"
          : hasRawData
          ? "completed"
          : "idle",
      lastSuccessfulSyncAt: pricingViewState.lastSuccessfulRunAt,
      lastAttemptAt: lastSyncAttemptAt,
      coverage:
        operational.counts.pricingRows + operational.counts.profitRows > 0
          ? operational.counts.competitorRows > 0
            ? "full"
            : "partial"
          : "none",
      dependencies: {
        fraud: operational.counts.timelineEvents > 0 ? "ready" : "missing",
        competitor: operational.counts.competitorRows > 0 ? "ready" : "missing",
        pricing:
          operational.counts.pricingRows + operational.counts.profitRows > 0
            ? "ready"
            : "missing",
      },
      dataChanged:
        operational.counts.pricingRows + operational.counts.profitRows > 0,
    }),
  };

  const selectedModule =
    normalizeSelectedModule(operational.store.onboardingSelectedModule) ??
    normalizeSelectedModule(subscription.starterModule);
  const selectedModuleState =
    selectedModule === "fraud"
      ? fraudReadiness.state
      : selectedModule === "competitor"
      ? competitorReadiness.state
      : selectedModule === "pricing"
      ? pricingReadiness.state
      : null;

  const setup = buildSetupSummary({
    connection,
    sync: initialSync,
    billing: billingReadiness,
    fraud: fraudReadiness,
    competitor: competitorReadiness,
    pricing: pricingReadiness,
    selectedModuleState,
  });

  return {
    generatedAt: new Date().toISOString(),
    connection: {
      ...connection,
      healthy: connectionHealth.healthy,
      code: connectionHealth.code,
    },
    initialSync: {
      ...initialSync,
      syncStatus: syncStatus.status,
      hasRawData,
      hasProcessedData,
    },
    billing: {
      ...billingReadiness,
      lifecycle: billing.lifecycle,
      planName: billing.planName,
      accessActive: billing.accessActive,
      verified: billing.verified,
    },
    modules: {
      fraud: fraudReadiness,
      competitor: competitorReadiness,
      pricing: pricingReadiness,
    },
    setup,
    moduleStates,
    quickAccess: {
      fraud: {
        state: fraudReadiness.state,
        status: fraudReadiness.status,
        freshnessAt: fraudReadiness.freshnessAt,
        reason: fraudReadiness.description,
      },
      competitor: {
        state: competitorReadiness.state,
        status: competitorReadiness.status,
        freshnessAt: competitorReadiness.freshnessAt,
        reason: competitorReadiness.description,
      },
      pricing: {
        state: pricingReadiness.state,
        status: pricingReadiness.status,
        freshnessAt: pricingReadiness.freshnessAt,
        reason: pricingReadiness.description,
      },
    },
  };
}

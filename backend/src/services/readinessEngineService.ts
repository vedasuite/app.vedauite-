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
      : "Choose a module with enough data before marking setup complete.",
  ].filter((value): value is string => !!value);

  const nextAction =
    !input.connection.ready
      ? { label: "Reconnect Shopify", route: "/app/onboarding" }
      : !input.sync.ready
      ? { label: "Sync store data", route: "/app/onboarding" }
      : !input.billing.ready
      ? { label: "Review billing", route: "/app/billing" }
      : input.selectedModuleState !== "ready"
      ? { label: "Open onboarding", route: "/app/onboarding" }
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
    ? "Store sync still needs to finish"
    : !input.billing.ready
    ? "Billing still needs confirmation"
    : !minimumComplete
    ? "Setup is still in progress"
    : allCoreModulesReady
    ? "Store setup is complete"
    : "Core setup is complete";

  const summaryDescription = !minimumComplete
    ? blockers[0] ?? "Complete the remaining setup steps before the store is marked ready."
    : allCoreModulesReady
    ? "Connection, sync, billing, and all core modules are ready for normal use."
    : "Connection, sync, and billing are ready. Some modules are still collecting data.";

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
      ? "Store access, embedded authentication, and webhook coverage are available."
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
        ? "Initial Shopify sync is complete"
        : syncStatus.status === "SYNC_IN_PROGRESS"
        ? "Shopify sync is running"
        : syncStatus.status === "SYNC_COMPLETED_PROCESSING_PENDING"
        ? "Store data is still being processed"
        : syncStatus.status === "FAILED"
        ? "Sync needs attention"
        : "Run the first sync",
    description: syncStatus.reason,
    nextAction:
      initialSyncState === "ready"
        ? "Continue setup"
        : initialSyncState === "error"
        ? "Retry sync"
        : "Sync store data",
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
    billing.lifecycle === "active" || billing.lifecycle === "test_charge"
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
        ? `${billing.planName} access is verified`
        : billingState === "collecting_data"
        ? "Billing approval is still being confirmed"
        : billingState === "error"
        ? "Billing needs attention"
        : "Choose a plan to unlock modules",
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
      entitled: subscription.enabledModules.trustAbuse,
      connectionHealthy: connectionHealth.healthy,
      syncStatus: syncStatus.status,
      setupComplete: hasRawData,
      dataReady: operational.counts.timelineEvents > 0,
      isRunning: syncStatus.status === "SYNC_IN_PROGRESS",
      hasFailed: syncStatus.status === "FAILED",
    }),
    title:
      !subscription.enabledModules.trustAbuse
        ? "Fraud Intelligence is locked"
        : operational.counts.timelineEvents > 0
        ? "Fraud Intelligence is ready"
        : syncStatus.status === "SYNC_IN_PROGRESS" ||
          syncStatus.status === "SYNC_COMPLETED_PROCESSING_PENDING"
        ? "Fraud Intelligence is collecting data"
        : "Fraud Intelligence needs more store history",
    description:
      !subscription.enabledModules.trustAbuse
        ? "Upgrade the current plan to unlock Fraud Intelligence."
        : operational.counts.timelineEvents > 0
        ? "Risk checks and refund-abuse signals are available from the latest synced data."
        : syncStatus.status === "FAILED"
        ? "The latest sync failed before fraud checks could finish."
        : "Sync more orders and customers so VedaSuite can build fraud and refund-abuse signals.",
    nextAction:
      !subscription.enabledModules.trustAbuse
        ? "Open billing"
        : operational.counts.timelineEvents > 0
        ? "Open Fraud Intelligence"
        : "Sync store data",
    route: subscription.enabledModules.trustAbuse ? "/app/fraud-intelligence" : "/app/billing",
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
      ? "Add competitor domains before VedaSuite can compare products and pricing."
      : competitorFailed
      ? operational.latestCompetitorIngestJob?.errorMessage ??
        "The latest competitor refresh failed."
      : operational.counts.competitorRows > 0
      ? isStaleTimestamp(operational.latestCompetitorAt)
        ? "Competitor data exists, but it has not refreshed recently enough to count as ready."
        : "Comparable competitor products were matched and monitoring outputs are available."
      : competitorCollecting
      ? "Competitor monitoring is configured and still collecting comparable product data."
      : "Competitor monitoring ran, but no comparable competitor products were found yet.";
  const competitorReadiness = createReadinessItem({
    state:
      competitorState === "ready" && isStaleTimestamp(operational.latestCompetitorAt)
        ? "collecting_data"
        : competitorState,
    title:
      !subscription.enabledModules.competitor
        ? "Competitor Intelligence is locked"
        : !competitorHasSetup
        ? "Competitor setup is incomplete"
        : operational.counts.competitorRows > 0 && !isStaleTimestamp(operational.latestCompetitorAt)
        ? "Competitor Intelligence is ready"
        : competitorCollecting
        ? "Competitor Intelligence is collecting data"
        : "Competitor Intelligence needs more setup",
    description: competitorDescription,
    nextAction:
      !subscription.enabledModules.competitor
        ? "Open billing"
        : !competitorHasSetup
        ? "Add competitor domains"
        : operational.counts.competitorRows > 0
        ? "Open Competitor Intelligence"
        : "Review domains and tracked products",
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
    title: "Pricing readiness",
    description: "Pricing readiness is being derived from persisted store data.",
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
      !subscription.enabledModules.pricingProfit
        ? "locked"
        : pricingViewState.status === "ready"
        ? "ready"
        : pricingViewState.status === "failed"
        ? "error"
        : pricingViewState.status === "syncing_data" ||
          pricingViewState.status === "initializing"
        ? "collecting_data"
        : "setup_needed",
    title:
      !subscription.enabledModules.pricingProfit
        ? "AI Pricing Engine is locked"
        : pricingViewState.status === "ready"
        ? "AI Pricing Engine is ready"
        : pricingViewState.status === "failed"
        ? "AI Pricing Engine needs attention"
        : pricingViewState.status === "syncing_data"
        ? "AI Pricing Engine is collecting data"
        : "AI Pricing Engine needs more store data",
    description: pricingViewState.description,
    nextAction:
      !subscription.enabledModules.pricingProfit
        ? "Open billing"
        : pricingViewState.status === "ready"
        ? "Open AI Pricing Engine"
        : pricingViewState.nextAction ?? "Sync store data",
    route: subscription.enabledModules.pricingProfit ? "/app/ai-pricing-engine" : "/app/billing",
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
    selectedModule === "trustAbuse"
      ? fraudReadiness.state
      : selectedModule === "competitor"
      ? competitorReadiness.state
      : selectedModule === "pricingProfit"
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

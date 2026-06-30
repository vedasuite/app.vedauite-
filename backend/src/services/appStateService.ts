import { getDashboardMetrics } from "./dashboardService";
import { getOnboardingState } from "./onboardingService";
import { logEvent } from "./observabilityService";
import { getUnifiedReadinessState } from "./readinessEngineService";
import { getConnectionHealth } from "./shopifyConnectionService";
import { getStoreReadinessState } from "./storeReadinessService";
import { getCurrentSubscription, resolveBillingState } from "./subscriptionService";

type MerchantOnboardingAppState = Awaited<
  ReturnType<typeof getOnboardingState>
> & {
  nextRoute: string;
};

export type MerchantAppState = {
  appStatus: "ready" | "action_required" | "failed";
  install: {
    status: "installed" | "reauthorize_required" | "missing_installation" | "uninstalled";
    title: string;
    description: string;
    reauthorizeUrl: string | null;
  };
  connection: {
    status: "healthy" | "attention" | "failed";
    title: string;
    description: string;
  };
  sync: {
    status: string;
    title: string;
    description: string;
    lastUpdatedAt: string | null;
  };
    billing: {
      planName: string;
      status: string;
      active: boolean;
      accessActive: boolean;
      endsAt: string | null;
      trialEndsAt: string | null;
      title: string;
      description: string;
    };
  onboarding: MerchantOnboardingAppState;
  entitlements: {
    fraud: boolean;
    trustAbuse: boolean;
    competitor: boolean;
    pricing: boolean;
    pricingProfit: boolean;
    profit: boolean;
    reports: boolean;
    settings: boolean;
  };
  modules: {
    fraud: {
      status: string;
      title: string;
      description: string;
    };
    competitor: {
      status: string;
      title: string;
      description: string;
    };
    pricing: {
      status: string;
      title: string;
      description: string;
    };
  };
  readiness: Awaited<ReturnType<typeof getUnifiedReadinessState>>;
  storeReadiness: Awaited<ReturnType<typeof getStoreReadinessState>>;
};

export function deriveInstallState(health: Awaited<ReturnType<typeof getConnectionHealth>>) {
  if (health.code === "UNINSTALLED") {
    return {
      status: "uninstalled" as const,
      title: "Reconnect VedaSuite to continue",
      description: "Shopify needs the app to be reconnected before VedaSuite can load your store.",
      reauthorizeUrl: health.reauthorizeUrl ?? null,
    };
  }

  if (health.code === "MISSING_INSTALLATION") {
    return {
      status: "missing_installation" as const,
      title: "Finish connecting VedaSuite",
      description: "VedaSuite could not find a valid Shopify installation for this store yet.",
      reauthorizeUrl: health.reauthorizeUrl ?? null,
    };
  }

  if (
    health.reauthRequired ||
    [
      "MISSING_OFFLINE_TOKEN",
      "OFFLINE_TOKEN_EXPIRED",
      "REFRESH_TOKEN_EXPIRED",
      "TOKEN_REFRESH_FAILED",
      "SHOPIFY_RECONNECT_REQUIRED",
      "SHOPIFY_AUTH_REQUIRED",
    ].includes(health.code)
  ) {
    return {
      status: "reauthorize_required" as const,
      title: "Reconnect Shopify to continue",
      description: "VedaSuite needs Shopify authorization refreshed before the app can continue loading.",
      reauthorizeUrl: health.reauthorizeUrl ?? null,
    };
  }

  return {
    status: "installed" as const,
    title: "Store connection is active",
    description: health.message,
    reauthorizeUrl: null,
  };
}

export function deriveConnectionState(health: Awaited<ReturnType<typeof getConnectionHealth>>) {
  if (health.healthy) {
    return {
      status: "healthy" as const,
      title: "Shopify connection is healthy",
      description: "Store access, embedded auth, and webhook registration are available.",
    };
  }

  if (health.code === "WEBHOOKS_MISSING" || health.code === "WEBHOOK_REGISTRATION_FAILED") {
    return {
      status: "attention" as const,
      title: "Store connection needs attention",
      description: "VedaSuite is connected, but Shopify setup still needs a follow-up before all features are dependable.",
    };
  }

  return {
    status: "failed" as const,
    title: "Store connection could not be verified",
    description: health.message,
  };
}

const FALLBACK_MODULE_STATE = {
  state: "error",
  status: "unavailable",
  title: "Module unavailable",
  description: "This module is temporarily unavailable.",
  ready: false,
};

const FALLBACK_READINESS: Awaited<ReturnType<typeof getUnifiedReadinessState>> = {
  connection: { state: "error", status: "unavailable", title: "Connection status unavailable", description: "", ready: false, healthy: false, code: "UNKNOWN" },
  initialSync: { state: "error", status: "unavailable", title: "Sync status unavailable", description: "", ready: false, syncStatus: "NOT_CONNECTED", hasRawData: false, hasProcessedData: false },
  billing: { state: "error", status: "unavailable", title: "Billing unavailable", description: "", ready: false, lifecycle: "unknown", planName: "UNKNOWN", accessActive: false, verified: false },
  modules: {
    fraud: FALLBACK_MODULE_STATE,
    competitor: FALLBACK_MODULE_STATE,
    pricing: FALLBACK_MODULE_STATE,
  },
  setup: { minimumComplete: false, allCoreModulesReady: false, blockers: [], nextAction: { label: "Continue setup", route: "/app/onboarding" }, percent: 0, summaryTitle: "Setup unavailable", summaryDescription: "" },
  quickAccess: {
    fraud: { state: "error", status: "unavailable", freshnessAt: null, reason: "" },
    competitor: { state: "error", status: "unavailable", freshnessAt: null, reason: "" },
    pricing: { state: "error", status: "unavailable", freshnessAt: null, reason: "" },
  },
  moduleStates: null,
} as any;

const FALLBACK_STORE_READINESS: Awaited<ReturnType<typeof getStoreReadinessState>> = {
  billing: {
    plan: "UNKNOWN",
    isActive: false,
    isTrial: false,
    starterModule: null,
    enabledModules: { fraud: false, competitor: false, pricing: false, profit: false, reports: false, settings: true },
  },
  onboarding: { complete: false, stepsRemaining: [] },
  data: { hasOrders: false, hasProducts: false, hasCompetitors: false, hasPricingData: false, hasProfitData: false },
  modules: { fraudReady: false, competitorReady: false, pricingReady: false, profitReady: false },
  guidedMode: false,
} as any;

export async function getMerchantAppState(shopDomain: string): Promise<MerchantAppState> {
  const [health, subscription, billing, onboarding, dashboard, readiness, storeReadiness] = await Promise.all([
    getConnectionHealth(shopDomain, { probeApi: false }),
    getCurrentSubscription(shopDomain),
    resolveBillingState(shopDomain),
    getOnboardingState(shopDomain),
    getDashboardMetrics(shopDomain),
    getUnifiedReadinessState(shopDomain).catch((err) => {
      logEvent("error", "app_state.readiness_failed", { shop: shopDomain, error: err });
      return FALLBACK_READINESS;
    }),
    getStoreReadinessState(shopDomain).catch((err) => {
      logEvent("error", "app_state.store_readiness_failed", { shop: shopDomain, error: err });
      return FALLBACK_STORE_READINESS;
    }),
  ]);

  if (!dashboard) {
    logEvent("warn", "app_state.dashboard_missing", { shop: shopDomain });
    throw new Error("Store dashboard state is unavailable.");
  }

  const install = deriveInstallState(health);
  const connection = deriveConnectionState(health);
  const enabledModules = storeReadiness.billing.enabledModules;
  const lockedModules = Object.entries(enabledModules)
    .filter(([key, value]) =>
      ["fraud", "competitor", "pricing", "profit"].includes(key) && !value
    )
    .map(([key]) => key);
  const appStatus =
    install.status !== "installed" || connection.status === "failed"
      ? "action_required"
      : dashboard.dashboardState.syncHealth.status === "FAILED"
      ? "failed"
      : "ready";

  logEvent("info", "app_state.entitlements_returned", {
    shop: shopDomain,
    plan: storeReadiness.billing.plan,
    starterModule: storeReadiness.billing.starterModule,
    enabledModules: Object.entries(enabledModules)
      .filter(([key, value]) =>
        ["fraud", "competitor", "pricing", "profit"].includes(key) && value
      )
      .map(([key]) => key),
    lockedModules,
  });

  return {
    appStatus,
    install,
    connection,
    sync: {
      status: dashboard.dashboardState.syncHealth.status,
      title: dashboard.dashboardState.syncHealth.title,
      description: dashboard.dashboardState.syncHealth.reason,
      lastUpdatedAt: dashboard.lastRefreshedAt,
    },
    billing: {
      planName: billing.planName,
      status: billing.lifecycle,
      active: billing.lifecycle === "active",
      accessActive: billing.accessActive,
      endsAt: billing.showRenewalDate ? billing.renewalAt : null,
      trialEndsAt: billing.showTrialDate ? subscription.trialEndsAt : null,
      title: billing.merchantTitle,
      description: billing.merchantDescription,
    },
    onboarding: {
      ...onboarding,
      nextRoute: onboarding.canAccessDashboard ? "/app/dashboard" : "/app/onboarding",
    },
    entitlements: {
      fraud: enabledModules.fraud,
      trustAbuse: enabledModules.fraud,
      competitor: enabledModules.competitor,
      pricing: enabledModules.pricing,
      pricingProfit: enabledModules.pricing,
      profit: enabledModules.profit,
      reports: enabledModules.reports,
      settings: enabledModules.settings,
    },
    modules: {
      fraud: {
        status: readiness.modules.fraud.state,
        title: readiness.modules.fraud.title,
        description: readiness.modules.fraud.description,
      },
      competitor: {
        status: readiness.modules.competitor.state,
        title: readiness.modules.competitor.title,
        description: readiness.modules.competitor.description,
      },
      pricing: {
        status: readiness.modules.pricing.state,
        title: readiness.modules.pricing.title,
        description: readiness.modules.pricing.description,
      },
    },
    readiness,
    storeReadiness,
  };
}

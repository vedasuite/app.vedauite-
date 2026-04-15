import { getDashboardMetrics } from "./dashboardService";
import { getOnboardingState } from "./onboardingService";
import { logEvent } from "./observabilityService";
import { getUnifiedReadinessState } from "./readinessEngineService";
import { getConnectionHealth } from "./shopifyConnectionService";
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
    trustAbuse: boolean;
    competitor: boolean;
    pricingProfit: boolean;
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

export async function getMerchantAppState(shopDomain: string): Promise<MerchantAppState> {
  const [health, subscription, billing, onboarding, dashboard, readiness] = await Promise.all([
    getConnectionHealth(shopDomain, { probeApi: false }),
    getCurrentSubscription(shopDomain),
    resolveBillingState(shopDomain),
    getOnboardingState(shopDomain),
    getDashboardMetrics(shopDomain),
    getUnifiedReadinessState(shopDomain),
  ]);

  if (!dashboard) {
    logEvent("warn", "app_state.dashboard_missing", { shop: shopDomain });
    throw new Error("Store dashboard state is unavailable.");
  }

  const install = deriveInstallState(health);
  const connection = deriveConnectionState(health);
  const appStatus =
    install.status !== "installed" || connection.status === "failed"
      ? "action_required"
      : dashboard.dashboardState.syncHealth.status === "FAILED"
      ? "failed"
      : "ready";

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
      active: billing.lifecycle === "active" || billing.lifecycle === "test_charge",
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
      trustAbuse: subscription.enabledModules.trustAbuse,
      competitor: subscription.enabledModules.competitor,
      pricingProfit: subscription.enabledModules.pricingProfit,
      reports: subscription.enabledModules.reports,
      settings: subscription.enabledModules.settings,
    },
    modules: {
      fraud: {
        status: readiness.modules.fraud.state,
        title: readiness.modules.fraud.title,
        description:
          readiness.modules.fraud.description,
      },
      competitor: {
        status: readiness.modules.competitor.state,
        title: readiness.modules.competitor.title,
        description:
          readiness.modules.competitor.description,
      },
      pricing: {
        status: readiness.modules.pricing.state,
        title: readiness.modules.pricing.title,
        description:
          readiness.modules.pricing.description,
      },
    },
    readiness,
  };
}

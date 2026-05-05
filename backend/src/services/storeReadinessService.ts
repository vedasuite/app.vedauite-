import { env } from "../config/env";
import { getOnboardingState } from "./onboardingService";
import { getStoreOperationalSnapshot } from "./storeOperationalStateService";
import {
  getCurrentSubscription,
  resolveBillingState,
  resolveEntitlements,
} from "./subscriptionService";

export async function getStoreReadinessState(shopDomain: string) {
  const [subscription, billing, onboarding, operational, entitlements] = await Promise.all([
    getCurrentSubscription(shopDomain),
    resolveBillingState(shopDomain),
    getOnboardingState(shopDomain),
    getStoreOperationalSnapshot(shopDomain),
    resolveEntitlements(shopDomain),
  ]);

  const hasOrders = operational.counts.orders > 0;
  const hasProducts = operational.counts.products > 0;
  const hasCompetitors =
    operational.counts.competitorDomains > 0 && operational.counts.competitorRows > 0;
  const hasPricingData = operational.counts.pricingRows > 0;
  const hasProfitData = operational.counts.profitRows > 0;

  const stepsRemaining = onboarding.steps
    .filter((step) => !step.complete)
    .map((step) => step.label);

  return {
    billing: {
      plan: billing.planName,
      isActive: billing.accessActive,
      isTrial: billing.planName === "TRIAL" && billing.accessActive,
      starterModule: entitlements.starterModule,
      enabledModules: {
        fraud: entitlements.enabledModules.includes("fraud"),
        competitor: entitlements.enabledModules.includes("competitor"),
        pricing: entitlements.enabledModules.includes("pricing"),
        profit: entitlements.enabledModules.includes("profit"),
        reports: subscription.enabledModules.reports,
        settings: subscription.enabledModules.settings,
      },
    },
    onboarding: {
      complete: onboarding.canAccessDashboard,
      stepsRemaining,
    },
    data: {
      hasOrders,
      hasProducts,
      hasCompetitors,
      hasPricingData,
      hasProfitData,
    },
    modules: {
      fraudReady: entitlements.enabledModules.includes("fraud") && hasOrders,
      competitorReady:
        entitlements.enabledModules.includes("competitor") &&
        operational.counts.competitorDomains > 0 &&
        operational.counts.competitorRows > 0,
      pricingReady: entitlements.enabledModules.includes("pricing") && hasPricingData,
      profitReady: entitlements.enabledModules.includes("profit") && hasProfitData,
    },
    sampleMode: env.enableSampleData,
  };
}

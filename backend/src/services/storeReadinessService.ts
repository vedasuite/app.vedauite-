import { env } from "../config/env";
import { getOnboardingState } from "./onboardingService";
import { getStoreOperationalSnapshot } from "./storeOperationalStateService";
import { getCurrentSubscription, resolveBillingState } from "./subscriptionService";

export async function getStoreReadinessState(shopDomain: string) {
  const [subscription, billing, onboarding, operational] = await Promise.all([
    getCurrentSubscription(shopDomain),
    resolveBillingState(shopDomain),
    getOnboardingState(shopDomain),
    getStoreOperationalSnapshot(shopDomain),
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
      starterModule: subscription.starterModule,
      enabledModules: {
        fraud: subscription.enabledModules.fraud,
        competitor: subscription.enabledModules.competitor,
        pricing: subscription.enabledModules.pricing,
        profit: subscription.enabledModules.profit,
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
      fraudReady: subscription.enabledModules.fraud && hasOrders,
      competitorReady:
        subscription.enabledModules.competitor &&
        operational.counts.competitorDomains > 0 &&
        operational.counts.competitorRows > 0,
      pricingReady: subscription.enabledModules.pricing && hasPricingData,
      profitReady: subscription.enabledModules.profit && hasProfitData,
    },
    sampleMode: env.enableSampleData,
  };
}

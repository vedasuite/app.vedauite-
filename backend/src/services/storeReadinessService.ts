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
      // Canonical full-access-trial flag, taken straight from the entitlement
      // resolver that Billing already uses. `isTrial` above only ever matched
      // the legacy standalone TRIAL plan; under the current model the plan is
      // the merchant's selected STARTER/GROWTH/PRO while the trial window is
      // open, so it is not a usable trial signal. Exposed here purely so
      // Onboarding and the Dashboard can display the same trial state as the
      // Billing page without inferring it from a date.
      trialActive: entitlements.trialActive,
      trialEndsAt: subscription.trialEndsAt,
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
    guidedMode: env.enableGuidedSetupData,
  };
}

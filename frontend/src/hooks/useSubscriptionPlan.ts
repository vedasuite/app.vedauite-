import { useContext } from "react";
import { SubscriptionContext } from "../providers/SubscriptionProvider";
import type {
  BillingState,
  BillingPlanName,
  Capability,
  CapabilityMap,
  EntitlementState,
  FeatureAccess,
  ModuleAccess,
  StarterModule,
  SubscriptionInfo,
  SubscriptionLifecycleStatus,
} from "../lib/billingCapabilities";
import { normalizeSubscriptionInfo } from "../lib/subscriptionState";

export type {
  BillingState,
  BillingPlanName,
  Capability,
  CapabilityMap,
  EntitlementState,
  FeatureAccess,
  ModuleAccess,
  StarterModule,
  SubscriptionInfo,
  SubscriptionLifecycleStatus,
};

export function useSubscriptionPlan() {
  const context = useContext(SubscriptionContext);

  if (!context) {
    return {
      subscription: null,
      billingState: null,
      entitlements: null,
      loading: true,
      refresh: async () => normalizeSubscriptionInfo(null),
      billingFlowState: "IDLE" as const,
      billingMessage: null,
      billingError: null,
      startBillingRedirect: () => undefined,
      retryBillingConfirmation: async () => undefined,
      dismissBillingMessage: () => undefined,
      clearBillingError: () => undefined,
    };
  }

  return context;
}

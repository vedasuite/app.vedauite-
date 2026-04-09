import { useContext } from "react";
import { SubscriptionContext } from "../providers/SubscriptionProvider";
import type {
  BillingPlanName,
  Capability,
  CapabilityMap,
  FeatureAccess,
  ModuleAccess,
  StarterModule,
  SubscriptionInfo,
  SubscriptionLifecycleStatus,
} from "../lib/billingCapabilities";
import { normalizeSubscriptionInfo } from "../lib/subscriptionState";

export type {
  BillingPlanName,
  Capability,
  CapabilityMap,
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

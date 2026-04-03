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
      refresh: async () => undefined,
      applyOptimistic: (_subscription: SubscriptionInfo) => undefined,
    };
  }

  return context;
}

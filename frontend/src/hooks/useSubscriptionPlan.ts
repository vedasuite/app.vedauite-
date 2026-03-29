import { useContext } from "react";
import { SubscriptionContext } from "../providers/SubscriptionProvider";

export type SubscriptionInfo = {
  planName: string;
  price: number;
  trialDays: number;
  starterModule: "fraud" | "competitor" | null;
  active?: boolean;
  endsAt?: string | null;
  enabledModules: {
    fraud: boolean;
    competitor: boolean;
    pricing: boolean;
    creditScore: boolean;
    profitOptimization: boolean;
  };
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

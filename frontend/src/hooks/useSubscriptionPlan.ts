import { useContext } from "react";
import { SubscriptionContext } from "../providers/SubscriptionProvider";

export type StarterModule = "trustAbuse" | "competitor" | null;

export type ModuleAccess = {
  trustAbuse: boolean;
  competitor: boolean;
  pricingProfit: boolean;
  reports: boolean;
  settings: boolean;
  fraud: boolean;
  pricing: boolean;
  creditScore: boolean;
  profitOptimization: boolean;
};

export type FeatureAccess = {
  shopperTrustScore: boolean;
  returnAbuseIntelligence: boolean;
  fraudReviewQueue: boolean;
  supportCopilot: boolean;
  evidencePackExport: boolean;
  competitorMoveFeed: boolean;
  competitorStrategyDetection: boolean;
  weeklyCompetitorReports: boolean;
  pricingRecommendations: boolean;
  scenarioSimulator: boolean;
  profitLeakDetector: boolean;
  marginAtRisk: boolean;
  dailyActionBoard: boolean;
  advancedAutomation: boolean;
  fullProfitEngine: boolean;
};

export type SubscriptionInfo = {
  planName: string;
  price: number;
  trialDays: number;
  starterModule: StarterModule;
  active?: boolean;
  endsAt?: string | null;
  enabledModules: ModuleAccess;
  featureAccess: FeatureAccess;
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

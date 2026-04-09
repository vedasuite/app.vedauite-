import { createContext, ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { embeddedShopRequest } from "../lib/embeddedShopRequest";
import { useSubscriptionPlan } from "../hooks/useSubscriptionPlan";

export type OnboardingModuleKey = "trustAbuse" | "competitor" | "pricingProfit";

export type OnboardingState = {
  stage: string;
  canAccessDashboard: boolean;
  dashboardEntryState: string;
  isCompleted: boolean;
  isDismissed: boolean;
  title: string;
  description: string;
  primaryAction: {
    key: string;
    label: string;
    route: string;
  };
  progress: {
    completedSteps: number;
    totalSteps: number;
    percent: number;
  };
  steps: Array<{
    key: string;
    label: string;
    complete: boolean;
    active: boolean;
    locked: boolean;
    description: string;
    helper: string;
    ctaLabel: string;
  }>;
  hero: {
    headline: string;
    subtext: string;
    benefits: string[];
  };
  dataReadiness: {
    syncStatus: string;
    syncReason: string;
    connectionHealthy: boolean;
    webhooksReady: boolean;
    hasAnyRawData: boolean;
    hasAnyProcessedData: boolean;
    stateLabel: string;
  };
  stateSummary: {
    tone: "success" | "info" | "attention" | "critical";
    title: string;
    description: string;
    ctaLabel: string;
  };
  moduleOverview: Array<{
    key: OnboardingModuleKey;
    title: string;
    route: string;
    summary: string;
    benefits: string[];
    available: boolean;
    lockReason: string | null;
  }>;
  selectedModule: OnboardingModuleKey | null;
  selectedModuleTitle: string | null;
  selectedModuleRoute: string | null;
  sampleInsights: Array<{
    key: string;
    module: string;
    title: string;
    detail: string;
  }>;
  planSummary: {
    planName: string;
    billingActive: boolean;
    starterModule: string | null;
    unlockedFeatures: string[];
    lockedFeatures: string[];
    manageRoute: string;
    canConfirmPlan: boolean;
  };
  privacySummary: {
    title: string;
    description: string;
    bullets: string[];
  };
  currentPlan: string;
  billingActive: boolean;
  limitedDataReason: string | null;
};

type OnboardingContextValue = {
  onboarding: OnboardingState | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<OnboardingState>;
  selectModule: (moduleKey: OnboardingModuleKey) => Promise<OnboardingState>;
  markInsightViewed: (moduleKey?: OnboardingModuleKey | null) => Promise<OnboardingState>;
  confirmPlan: () => Promise<OnboardingState>;
  complete: () => Promise<OnboardingState>;
  dismiss: () => Promise<OnboardingState>;
};

export const OnboardingContext = createContext<OnboardingContextValue | null>(null);

type OnboardingResponse = {
  onboarding: OnboardingState;
};

export function OnboardingProvider({ children }: { children: ReactNode }) {
  const { subscription } = useSubscriptionPlan();
  const [onboarding, setOnboarding] = useState<OnboardingState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const response = await embeddedShopRequest<OnboardingResponse>(
      "/api/dashboard/onboarding",
      { timeoutMs: 30000 }
    );
    setOnboarding(response.onboarding);
    setError(null);
    return response.onboarding;
  }, []);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    refresh()
      .catch((nextError) => {
        if (!mounted) return;
        setError(
          nextError instanceof Error
            ? nextError.message
            : "Unable to load onboarding state."
        );
      })
      .finally(() => {
        if (!mounted) return;
        setLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, [refresh, subscription?.planName, subscription?.starterModule]);

  const mutate = useCallback(
    async (path: string, body?: Record<string, unknown>) => {
      const response = await embeddedShopRequest<OnboardingResponse>(path, {
        method: "POST",
        body,
        timeoutMs: 30000,
      });
      setOnboarding(response.onboarding);
      setError(null);
      return response.onboarding;
    },
    []
  );

  const value = useMemo(
    () => ({
      onboarding,
      loading,
      error,
      refresh,
      selectModule: (moduleKey: OnboardingModuleKey) =>
        mutate("/api/dashboard/onboarding/select-module", { moduleKey }),
      markInsightViewed: (moduleKey?: OnboardingModuleKey | null) =>
        mutate("/api/dashboard/onboarding/view-insight", { moduleKey: moduleKey ?? null }),
      confirmPlan: () => mutate("/api/dashboard/onboarding/confirm-plan"),
      complete: () => mutate("/api/dashboard/onboarding/complete"),
      dismiss: () => mutate("/api/dashboard/onboarding/dismiss"),
    }),
    [error, loading, mutate, onboarding, refresh]
  );

  return (
    <OnboardingContext.Provider value={value}>
      {children}
    </OnboardingContext.Provider>
  );
}

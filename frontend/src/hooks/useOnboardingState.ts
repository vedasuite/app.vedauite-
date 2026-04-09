import { useContext } from "react";
import { OnboardingContext } from "../providers/OnboardingProvider";

export function useOnboardingState() {
  const context = useContext(OnboardingContext);

  if (!context) {
    return {
      onboarding: null,
      loading: true,
      error: null,
      refresh: async () => {
        throw new Error("Onboarding context is not available.");
      },
      selectModule: async () => {
        throw new Error("Onboarding context is not available.");
      },
      markInsightViewed: async () => {
        throw new Error("Onboarding context is not available.");
      },
      confirmPlan: async () => {
        throw new Error("Onboarding context is not available.");
      },
      complete: async () => {
        throw new Error("Onboarding context is not available.");
      },
      dismiss: async () => {
        throw new Error("Onboarding context is not available.");
      },
    };
  }

  return context;
}

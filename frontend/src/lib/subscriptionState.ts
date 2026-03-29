import type { SubscriptionInfo } from "../hooks/useSubscriptionPlan";

export const fallbackSubscription: SubscriptionInfo = {
  planName: "TRIAL",
  price: 0,
  trialDays: 3,
  starterModule: null,
  active: false,
  endsAt: null,
  enabledModules: {
    fraud: true,
    competitor: true,
    pricing: false,
    creditScore: false,
    profitOptimization: false,
  },
};

function getPlanPrice(planName: string) {
  switch (planName) {
    case "STARTER":
      return 19;
    case "GROWTH":
      return 49;
    case "PRO":
      return 99;
    default:
      return 0;
  }
}

function getEnabledModules(
  planName: string,
  starterModule: "fraud" | "competitor" | null
) {
  return {
    fraud:
      planName === "TRIAL" ||
      planName === "GROWTH" ||
      planName === "PRO" ||
      (planName === "STARTER" && starterModule === "fraud"),
    competitor:
      planName === "TRIAL" ||
      planName === "GROWTH" ||
      planName === "PRO" ||
      (planName === "STARTER" && starterModule === "competitor"),
    pricing: planName === "GROWTH" || planName === "PRO",
    creditScore: planName === "GROWTH" || planName === "PRO",
    profitOptimization: planName === "PRO",
  };
}

export function buildOptimisticSubscription(params: {
  planName: string;
  starterModule?: "fraud" | "competitor" | null;
}) {
  const normalizedPlan = params.planName.toUpperCase();
  const starterModule = params.starterModule ?? null;

  return {
    planName: normalizedPlan,
    price: getPlanPrice(normalizedPlan),
    trialDays: normalizedPlan === "TRIAL" ? 3 : 0,
    starterModule,
    active: normalizedPlan !== "TRIAL",
    endsAt: null,
    enabledModules: getEnabledModules(normalizedPlan, starterModule),
  } satisfies SubscriptionInfo;
}

export function readOptimisticSubscriptionFromSearch(search: string) {
  const params = new URLSearchParams(search);
  const billing = params.get("billing");
  const planName = params.get("plan");
  const starterModule = params.get("starterModule");

  if (billing !== "activated" || !planName) {
    return null;
  }

  return buildOptimisticSubscription({
    planName,
    starterModule:
      starterModule === "fraud" || starterModule === "competitor"
        ? starterModule
        : null,
  });
}

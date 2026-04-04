import { createContext, ReactNode, useCallback, useEffect, useState } from "react";
import type { SubscriptionInfo } from "../hooks/useSubscriptionPlan";
import {
  clearModuleCache,
  readModuleCache,
  writeModuleCache,
} from "../lib/moduleCache";
import { embeddedShopRequest } from "../lib/embeddedShopRequest";
import {
  fallbackSubscription,
  normalizeSubscriptionInfo,
  readOptimisticSubscriptionFromSearch,
} from "../lib/subscriptionState";

function isPaidSubscription(subscription: SubscriptionInfo | null | undefined) {
  return !!subscription && subscription.planName !== "TRIAL" && !!subscription.active;
}

type SubscriptionContextValue = {
  subscription: SubscriptionInfo | null;
  loading: boolean;
  refresh: () => Promise<void>;
  applyOptimistic: (nextSubscription: SubscriptionInfo) => void;
};

export const SubscriptionContext =
  createContext<SubscriptionContextValue | null>(null);

type Props = {
  children: ReactNode;
};

export function SubscriptionProvider({ children }: Props) {
  const rawCachedSubscription =
    readModuleCache<SubscriptionInfo>("subscription-plan");
  const cachedSubscription = rawCachedSubscription
    ? normalizeSubscriptionInfo(rawCachedSubscription)
    : null;
  const optimisticSubscription = readOptimisticSubscriptionFromSearch(
    window.location.search
  );
  const [subscription, setSubscription] = useState<SubscriptionInfo | null>(
    optimisticSubscription ?? cachedSubscription ?? fallbackSubscription
  );
  const [loading, setLoading] = useState(!cachedSubscription && !optimisticSubscription);

  const applyOptimistic = useCallback((nextSubscription: SubscriptionInfo) => {
    const normalizedSubscription = normalizeSubscriptionInfo(nextSubscription);
    setSubscription(normalizedSubscription);
    writeModuleCache("subscription-plan", normalizedSubscription);
  }, []);

  const refresh = useCallback(async () => {
    const res = await embeddedShopRequest<{ subscription: SubscriptionInfo }>(
      "/api/subscription/plan",
      { timeoutMs: 45000 }
    );
    const normalizedSubscription = normalizeSubscriptionInfo(res.subscription);

    setSubscription((currentSubscription) => {
      const shouldPreserveOptimisticPaidPlan =
        isPaidSubscription(currentSubscription) &&
        normalizedSubscription.planName === "TRIAL";

      const nextSubscription = shouldPreserveOptimisticPaidPlan
        ? currentSubscription
        : normalizedSubscription;

      if (nextSubscription) {
        writeModuleCache("subscription-plan", nextSubscription);
      }

      return nextSubscription;
    });
  }, []);

  useEffect(() => {
    let mounted = true;

    if (optimisticSubscription) {
      applyOptimistic(optimisticSubscription);
      const nextUrl = new URL(window.location.href);
      nextUrl.searchParams.delete("billing");
      nextUrl.searchParams.delete("plan");
      nextUrl.searchParams.delete("starterModule");
      window.history.replaceState(
        {},
        "",
        `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`
      );
    }

    refresh()
      .then(() => {
        if (!mounted) return;
      })
      .catch(() => {
        if (!mounted) return;
        if (
          !cachedSubscription &&
          !optimisticSubscription
        ) {
          applyOptimistic(fallbackSubscription);
          clearModuleCache("subscription-plan");
        }
      })
      .finally(() => {
        if (!mounted) return;
        setLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, [refresh]);

  return (
    <SubscriptionContext.Provider
      value={{ subscription, loading, refresh, applyOptimistic }}
    >
      {children}
    </SubscriptionContext.Provider>
  );
}

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
} from "../lib/subscriptionState";

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
  const [subscription, setSubscription] = useState<SubscriptionInfo | null>(
    cachedSubscription ?? fallbackSubscription
  );
  const [loading, setLoading] = useState(!cachedSubscription);

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

    setSubscription(normalizedSubscription);
    writeModuleCache("subscription-plan", normalizedSubscription);
  }, []);

  useEffect(() => {
    let mounted = true;

    refresh()
      .then(() => {
        if (!mounted) return;
      })
      .catch(() => {
        if (!mounted) return;
        if (!cachedSubscription) {
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
  }, [applyOptimistic, cachedSubscription, refresh]);

  return (
    <SubscriptionContext.Provider
      value={{ subscription, loading, refresh, applyOptimistic }}
    >
      {children}
    </SubscriptionContext.Provider>
  );
}

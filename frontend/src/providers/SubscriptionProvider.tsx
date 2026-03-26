import { createContext, ReactNode, useCallback, useEffect, useState } from "react";
import { useApiClient } from "../api/client";
import type { SubscriptionInfo } from "../hooks/useSubscriptionPlan";
import { readModuleCache, writeModuleCache } from "../lib/moduleCache";

type SubscriptionContextValue = {
  subscription: SubscriptionInfo | null;
  loading: boolean;
  refresh: () => Promise<void>;
};

export const SubscriptionContext =
  createContext<SubscriptionContextValue | null>(null);

type Props = {
  children: ReactNode;
};

export function SubscriptionProvider({ children }: Props) {
  const api = useApiClient();
  const cachedSubscription = readModuleCache<SubscriptionInfo>("subscription-plan");
  const [subscription, setSubscription] = useState<SubscriptionInfo | null>(
    cachedSubscription ?? null
  );
  const [loading, setLoading] = useState(!cachedSubscription);

  const refresh = useCallback(async () => {
    const res = await api.get<{ subscription: SubscriptionInfo }>(
      "/api/subscription/plan"
    );
    setSubscription(res.data.subscription);
    writeModuleCache("subscription-plan", res.data.subscription);
  }, [api]);

  useEffect(() => {
    let mounted = true;

    refresh()
      .then(() => {
        if (!mounted) return;
      })
      .catch(() => {
        if (!mounted) return;
        setSubscription(null);
      })
      .finally(() => {
        if (!mounted) return;
        setLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, [refresh]);

  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        refresh().catch(() => undefined);
      }
    };

    window.addEventListener("focus", handleVisibility);
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      window.removeEventListener("focus", handleVisibility);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [refresh]);

  return (
    <SubscriptionContext.Provider value={{ subscription, loading, refresh }}>
      {children}
    </SubscriptionContext.Provider>
  );
}

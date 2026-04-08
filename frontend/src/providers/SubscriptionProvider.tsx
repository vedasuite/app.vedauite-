import { createContext, ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import type { SubscriptionInfo } from "../hooks/useSubscriptionPlan";
import {
  clearModuleCache,
  readModuleCache,
  writeModuleCache,
} from "../lib/moduleCache";
import { embeddedShopRequest } from "../lib/embeddedShopRequest";
import {
  fallbackSubscription,
  normalizeStarterModule,
  normalizeSubscriptionInfo,
} from "../lib/subscriptionState";

const SUBSCRIPTION_CACHE_KEY = "subscription-plan";
const BILLING_CONFIRMATION_TIMEOUT_MS = 45000;
const BILLING_CONFIRMATION_POLL_MS = 1500;

export type BillingFlowState =
  | "IDLE"
  | "BILLING_REDIRECT"
  | "PENDING_CONFIRMATION"
  | "SUCCESS"
  | "FAILED";

type SubscriptionContextValue = {
  subscription: SubscriptionInfo | null;
  loading: boolean;
  refresh: (options?: { clearCache?: boolean }) => Promise<SubscriptionInfo>;
  billingFlowState: BillingFlowState;
  billingMessage: string | null;
  billingError: string | null;
  startBillingRedirect: () => void;
  dismissBillingMessage: () => void;
  clearBillingError: () => void;
};

export const SubscriptionContext =
  createContext<SubscriptionContextValue | null>(null);

type Props = {
  children: ReactNode;
};

function cleanupBillingQueryParams() {
  const url = new URL(window.location.href);
  url.searchParams.delete("billingResult");
  url.searchParams.delete("billingMessage");
  url.searchParams.delete("intentId");
  url.searchParams.delete("plan");
  url.searchParams.delete("starterModule");
  window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
}

export function SubscriptionProvider({ children }: Props) {
  const location = useLocation();
  const rawCachedSubscription =
    readModuleCache<SubscriptionInfo>(SUBSCRIPTION_CACHE_KEY);
  const cachedSubscription = rawCachedSubscription
    ? normalizeSubscriptionInfo(rawCachedSubscription)
    : null;

  const [subscription, setSubscription] = useState<SubscriptionInfo | null>(
    cachedSubscription ?? fallbackSubscription
  );
  const [loading, setLoading] = useState(true);
  const [billingFlowState, setBillingFlowState] =
    useState<BillingFlowState>("IDLE");
  const [billingMessage, setBillingMessage] = useState<string | null>(null);
  const [billingError, setBillingError] = useState<string | null>(null);

  const commitSubscription = useCallback(
    (nextSubscription: SubscriptionInfo, options?: { clearCache?: boolean }) => {
      if (options?.clearCache) {
        clearModuleCache(SUBSCRIPTION_CACHE_KEY);
      }
      setSubscription(nextSubscription);
      writeModuleCache(SUBSCRIPTION_CACHE_KEY, nextSubscription);
      return nextSubscription;
    },
    []
  );

  const fetchSubscription = useCallback(async () => {
    const response = await embeddedShopRequest<{ subscription: SubscriptionInfo }>(
      "/api/subscription/plan",
      { timeoutMs: 45000 }
    );
    return normalizeSubscriptionInfo(response.subscription);
  }, []);

  const refresh = useCallback(
    async (options?: { clearCache?: boolean }) => {
      const nextSubscription = await fetchSubscription();
      return commitSubscription(nextSubscription, options);
    },
    [commitSubscription, fetchSubscription]
  );

  const startBillingRedirect = useCallback(() => {
    setBillingFlowState("BILLING_REDIRECT");
    setBillingError(null);
    setBillingMessage(null);
  }, []);

  const dismissBillingMessage = useCallback(() => {
    setBillingMessage(null);
    setBillingFlowState((current) => (current === "SUCCESS" ? "IDLE" : current));
  }, []);

  const clearBillingError = useCallback(() => {
    setBillingError(null);
    setBillingFlowState((current) => (current === "FAILED" ? "IDLE" : current));
  }, []);

  useEffect(() => {
    let mounted = true;

    const params = new URLSearchParams(location.search);
    const billingResult = params.get("billingResult");
    const expectedPlan = params.get("plan");
    const expectedStarterModule = normalizeStarterModule(
      params.get("starterModule")
    );
    const billingMessageFromUrl = params.get("billingMessage");

    const hydrate = async () => {
      try {
        if (billingResult === "confirmed") {
          setLoading(true);
          setBillingFlowState("PENDING_CONFIRMATION");
          setBillingMessage(null);
          setBillingError(null);
          clearModuleCache(SUBSCRIPTION_CACHE_KEY);

          const startedAt = Date.now();
          while (Date.now() - startedAt < BILLING_CONFIRMATION_TIMEOUT_MS) {
            const nextSubscription = await fetchSubscription();
            const planMatches =
              !expectedPlan || nextSubscription.planName === expectedPlan;
            const starterMatches =
              expectedPlan !== "STARTER" ||
              !expectedStarterModule ||
              nextSubscription.starterModule === expectedStarterModule;

            if (planMatches && starterMatches) {
              if (!mounted) return;
              commitSubscription(nextSubscription, { clearCache: true });
              setBillingFlowState("SUCCESS");
              setBillingMessage(
                billingMessageFromUrl ?? "Plan updated successfully"
              );
              cleanupBillingQueryParams();
              return;
            }

            await new Promise((resolve) =>
              window.setTimeout(resolve, BILLING_CONFIRMATION_POLL_MS)
            );
          }

          throw new Error(
            "VedaSuite could not confirm the updated Shopify subscription in time."
          );
        }

        const nextSubscription = await refresh();
        if (!mounted) return;

        if (billingResult === "noop") {
          setBillingFlowState("SUCCESS");
          setBillingMessage(
            billingMessageFromUrl ?? "No plan change was required."
          );
          cleanupBillingQueryParams();
          return;
        }

        if (billingResult === "failed") {
          setBillingFlowState("FAILED");
          setBillingError(
            billingMessageFromUrl ?? "Shopify billing approval was not confirmed."
          );
          cleanupBillingQueryParams();
          return;
        }

        setBillingFlowState((current) =>
          current === "BILLING_REDIRECT" ? current : "IDLE"
        );
        if (!nextSubscription) {
          setBillingMessage(null);
        }
      } catch (error) {
        if (!mounted) return;
        const message =
          error instanceof Error
            ? error.message
            : "Unable to load the current Shopify subscription.";

        if (!cachedSubscription) {
          commitSubscription(fallbackSubscription, { clearCache: true });
        }

        setBillingFlowState(
          billingResult === "confirmed" ? "FAILED" : "IDLE"
        );
        setBillingError(message);
        if (billingResult) {
          cleanupBillingQueryParams();
        }
      } finally {
        if (!mounted) return;
        setLoading(false);
      }
    };

    void hydrate();

    return () => {
      mounted = false;
    };
  }, [
    cachedSubscription,
    commitSubscription,
    fetchSubscription,
    location.search,
    refresh,
  ]);

  const value = useMemo(
    () => ({
      subscription,
      loading,
      refresh,
      billingFlowState,
      billingMessage,
      billingError,
      startBillingRedirect,
      dismissBillingMessage,
      clearBillingError,
    }),
    [
      billingError,
      billingFlowState,
      billingMessage,
      clearBillingError,
      dismissBillingMessage,
      loading,
      refresh,
      startBillingRedirect,
      subscription,
    ]
  );

  return (
    <SubscriptionContext.Provider value={value}>
      {children}
    </SubscriptionContext.Provider>
  );
}

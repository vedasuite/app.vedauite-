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
  | "REDIRECTING_TO_SHOPIFY"
  | "RETURNED_FROM_SHOPIFY"
  | "CONFIRMING_BACKEND_STATE"
  | "CONFIRMED"
  | "FAILED";

type SubscriptionContextValue = {
  subscription: SubscriptionInfo | null;
  loading: boolean;
  refresh: (options?: { clearCache?: boolean }) => Promise<SubscriptionInfo>;
  billingFlowState: BillingFlowState;
  billingMessage: string | null;
  billingError: string | null;
  startBillingRedirect: () => void;
  retryBillingConfirmation: () => Promise<void>;
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
  const initialCachedSubscription = useMemo(() => {
    const rawCachedSubscription =
      readModuleCache<SubscriptionInfo>(SUBSCRIPTION_CACHE_KEY);
    return rawCachedSubscription
      ? normalizeSubscriptionInfo(rawCachedSubscription)
      : null;
  }, []);
  const billingParams = useMemo(() => {
    const params = new URLSearchParams(location.search);
    return {
      billingResult: params.get("billingResult"),
      expectedPlan: params.get("plan"),
      expectedStarterModule: normalizeStarterModule(
        params.get("starterModule")
      ),
      billingMessageFromUrl: params.get("billingMessage"),
      intentId: params.get("intentId"),
    };
  }, [location.search]);

  const [subscription, setSubscription] = useState<SubscriptionInfo | null>(
    initialCachedSubscription ?? fallbackSubscription
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

  const confirmBillingReturn = useCallback(async () => {
    if (billingParams.billingResult !== "confirmed") {
      return;
    }

    setLoading(true);
    setBillingFlowState("RETURNED_FROM_SHOPIFY");
    setBillingMessage(null);
    setBillingError(null);
    clearModuleCache(SUBSCRIPTION_CACHE_KEY);

    try {
      setBillingFlowState("CONFIRMING_BACKEND_STATE");

      if (billingParams.intentId) {
        await embeddedShopRequest("/api/billing/confirm-return", {
          method: "POST",
          body: {
            intentId: billingParams.intentId,
          },
          timeoutMs: 45000,
        }).catch(() => undefined);
      }

      const startedAt = Date.now();
      while (Date.now() - startedAt < BILLING_CONFIRMATION_TIMEOUT_MS) {
        const nextSubscription = await fetchSubscription();
        const planMatches =
          !billingParams.expectedPlan ||
          nextSubscription.planName === billingParams.expectedPlan;
        const starterMatches =
          billingParams.expectedPlan !== "STARTER" ||
          !billingParams.expectedStarterModule ||
          nextSubscription.starterModule === billingParams.expectedStarterModule;

        if (planMatches && starterMatches) {
          commitSubscription(nextSubscription, { clearCache: true });
          setBillingFlowState("CONFIRMED");
          setBillingMessage(
            billingParams.billingMessageFromUrl ?? "Plan updated successfully"
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
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Unable to load the current Shopify subscription.";

      setBillingFlowState("FAILED");
      setBillingError(message);
    } finally {
      setLoading(false);
    }
  }, [
    billingParams.billingMessageFromUrl,
    billingParams.billingResult,
    billingParams.expectedPlan,
    billingParams.expectedStarterModule,
    billingParams.intentId,
    commitSubscription,
    fetchSubscription,
  ]);

  const refresh = useCallback(
    async (options?: { clearCache?: boolean }) => {
      const nextSubscription = await fetchSubscription();
      return commitSubscription(nextSubscription, options);
    },
    [commitSubscription, fetchSubscription]
  );

  const startBillingRedirect = useCallback(() => {
    setBillingFlowState("REDIRECTING_TO_SHOPIFY");
    setBillingError(null);
    setBillingMessage(null);
  }, []);

  const retryBillingConfirmation = useCallback(async () => {
    await confirmBillingReturn();
  }, [confirmBillingReturn]);

  const dismissBillingMessage = useCallback(() => {
    setBillingMessage(null);
    setBillingFlowState((current) => (current === "CONFIRMED" ? "IDLE" : current));
  }, []);

  const clearBillingError = useCallback(() => {
    setBillingError(null);
    setBillingFlowState((current) => (current === "FAILED" ? "IDLE" : current));
  }, []);

  useEffect(() => {
    let mounted = true;

    const hydrate = async () => {
      try {
        if (billingParams.billingResult === "confirmed") {
          await confirmBillingReturn();
          return;
        }

        const nextSubscription = await refresh();
        if (!mounted) return;

        if (billingParams.billingResult === "noop") {
          setBillingFlowState("CONFIRMED");
          setBillingMessage(
            billingParams.billingMessageFromUrl ?? "No plan change was required."
          );
          cleanupBillingQueryParams();
          return;
        }

        if (billingParams.billingResult === "failed") {
          setBillingFlowState("FAILED");
          setBillingError(
            billingParams.billingMessageFromUrl ??
              "Shopify billing approval was not confirmed."
          );
          cleanupBillingQueryParams();
          return;
        }

        setBillingFlowState((current) =>
          current === "REDIRECTING_TO_SHOPIFY" ? current : "IDLE"
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

        if (!initialCachedSubscription) {
          commitSubscription(fallbackSubscription, { clearCache: true });
        }

        setBillingFlowState(
          billingParams.billingResult === "confirmed" ? "FAILED" : "IDLE"
        );
        setBillingError(message);
        if (billingParams.billingResult && billingParams.billingResult !== "confirmed") {
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
    billingParams.billingMessageFromUrl,
    billingParams.billingResult,
    confirmBillingReturn,
    commitSubscription,
    initialCachedSubscription,
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
      retryBillingConfirmation,
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
      retryBillingConfirmation,
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

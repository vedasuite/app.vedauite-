import { useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";

const STORAGE_KEY = "vedasuite:billing-flash";

type BillingFlash = {
  plan?: string | null;
  starterModule?: string | null;
  message?: string | null;
  result?: string | null;
};

export function useBillingFlash() {
  const location = useLocation();
  const [flash, setFlash] = useState<BillingFlash | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const billingResult = params.get("billingResult");
    const plan = params.get("plan");
    const starterModule = params.get("starterModule");
    const billingMessage = params.get("billingMessage");

    if (billingResult && (plan || billingMessage)) {
      const nextFlash = { plan, starterModule, message: billingMessage, result: billingResult };
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(nextFlash));
      setFlash(nextFlash);
      return;
    }

    const stored = sessionStorage.getItem(STORAGE_KEY);
    if (!stored) {
      setFlash(null);
      return;
    }

    try {
      setFlash(JSON.parse(stored) as BillingFlash);
    } catch {
      sessionStorage.removeItem(STORAGE_KEY);
      setFlash(null);
    }
  }, [location.search]);

  const message = useMemo(() => {
    if (!flash) return null;

    if (flash.message) {
      return flash.message;
    }

    const starterLabel =
      flash.starterModule === "trustAbuse"
        ? "Trust & Abuse Intelligence"
        : flash.starterModule === "competitor"
        ? "Competitor Intelligence"
        : flash.starterModule;

    if (flash.result === "failed") {
      return flash.plan
        ? `Billing update failed for ${flash.plan}.`
        : "Billing update failed.";
    }

    if (flash.result === "noop") {
      return flash.plan
        ? `${flash.plan} is already the active plan.`
        : "No billing change was required.";
    }

    return flash.starterModule
      ? `Billing activated: ${flash.plan} plan is live with ${starterLabel} as the Starter module.`
      : `Billing activated: ${flash.plan} plan is now live for your store.`;
  }, [flash]);

  const dismiss = () => {
    sessionStorage.removeItem(STORAGE_KEY);
    setFlash(null);
  };

  return { message, dismiss };
}

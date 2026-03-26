import { useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";

const STORAGE_KEY = "vedasuite:billing-flash";

type BillingFlash = {
  plan: string;
  starterModule?: string | null;
};

export function useBillingFlash() {
  const location = useLocation();
  const [flash, setFlash] = useState<BillingFlash | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const billing = params.get("billing");
    const plan = params.get("plan");
    const starterModule = params.get("starterModule");

    if (billing === "activated" && plan) {
      const nextFlash = { plan, starterModule };
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

    return flash.starterModule
      ? `Billing activated: ${flash.plan} plan is live with ${flash.starterModule} as the Starter module.`
      : `Billing activated: ${flash.plan} plan is now live for your store.`;
  }, [flash]);

  const dismiss = () => {
    sessionStorage.removeItem(STORAGE_KEY);
    setFlash(null);
  };

  return { message, dismiss };
}

import { Frame, Navigation, Toast } from "@shopify/polaris";
import { ReactNode, useCallback, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import { VedaLogo } from "../brand/VedaLogo";
import { useBillingFlash } from "../hooks/useBillingFlash";
import { useEmbeddedNavigation } from "../hooks/useEmbeddedNavigation";
import { useSubscriptionPlan } from "../hooks/useSubscriptionPlan";
import "./app-frame.css";

type Props = {
  children: ReactNode;
};

export function AppFrame({ children }: Props) {
  const location = useLocation();
  const { buildEmbeddedPath, navigateEmbedded } = useEmbeddedNavigation();
  const { subscription } = useSubscriptionPlan();
  const { message: billingMessage, dismiss: dismissBillingMessage } =
    useBillingFlash();
  const [toast, setToast] = useState<string | null>(null);

  const activePlan = subscription?.planName ?? "TRIAL";
  const moduleStatus = {
    fraud: subscription?.enabledModules.fraud ?? true,
    competitor: subscription?.enabledModules.competitor ?? true,
    pricing: subscription?.enabledModules.pricing ?? false,
    profit: subscription?.enabledModules.profitOptimization ?? false,
    creditScore: subscription?.enabledModules.creditScore ?? false,
    reports: activePlan === "GROWTH" || activePlan === "PRO" || activePlan === "TRIAL",
  };

  const dismissToast = useCallback(() => setToast(null), []);

  const createNavItem = useCallback(
    (path: string, label: string, options?: { badge?: string }) => ({
      label,
      selected: location.pathname === path,
      badge: options?.badge,
      onClick: () => {
        if (location.pathname === path) {
          return;
        }
        navigateEmbedded(path);
      },
    }),
    [location.pathname, navigateEmbedded]
  );

  const navigationItems = useMemo(
    () => [
      createNavItem("/", "Dashboard"),
      createNavItem("/fraud", "Fraud Intelligence", {
        badge: moduleStatus.fraud ? undefined : "Upgrade",
      }),
      createNavItem("/competitor", "Competitor Intelligence", {
        badge: moduleStatus.competitor ? undefined : "Upgrade",
      }),
      createNavItem(
        "/pricing",
        moduleStatus.pricing
          ? "AI Pricing Strategy"
          : "AI Pricing Strategy (PRO)",
        {
          badge: moduleStatus.pricing ? undefined : "Locked",
        }
      ),
      createNavItem(
        "/profit",
        moduleStatus.profit
          ? "AI Profit Optimization"
          : "AI Profit Optimization (PRO)",
        {
          badge: moduleStatus.profit ? undefined : "Locked",
        }
      ),
      createNavItem(
        "/credit-score",
        moduleStatus.creditScore
          ? "Shopper Credit Score"
          : "Shopper Credit Score (PRO)",
        {
          badge: moduleStatus.creditScore ? undefined : "Locked",
        }
      ),
      createNavItem(
        "/reports",
        moduleStatus.reports ? "Reports" : "Reports (GROWTH)",
        {
          badge: moduleStatus.reports ? undefined : "Locked",
        }
      ),
      createNavItem("/settings", "Settings"),
      createNavItem("/subscription", "Subscription Plans"),
    ],
    [createNavItem, moduleStatus.competitor, moduleStatus.creditScore, moduleStatus.fraud, moduleStatus.pricing, moduleStatus.profit, moduleStatus.reports]
  );

  const navigation = (
    <Navigation
      location={location.pathname}
      contextControl={
        <div className="vs-brand">
          <div className="vs-brand__row">
            <VedaLogo size={62} />
            <div>
              <p className="vs-brand__title">VedaSuite AI</p>
              <p className="vs-brand__subtitle">
                AI Commerce Solutions For Shopify
              </p>
              <div className="vs-plan-pill">{activePlan} PLAN</div>
              {activePlan === "STARTER" && subscription?.starterModule ? (
                <p className="vs-brand__subtitle">
                  {subscription.starterModule.toUpperCase()} MODULE ACTIVE
                </p>
              ) : null}
            </div>
          </div>
        </div>
      }
    >
      <Navigation.Section items={navigationItems} />
    </Navigation>
  );

  return (
    <Frame navigation={navigation} showMobileNavigation={false}>
      <div className="vs-app-frame">
        <div className="vs-content">{children}</div>
      </div>
      {toast ? <Toast content={toast} onDismiss={dismissToast} /> : null}
      {!toast && billingMessage ? (
        <Toast content={billingMessage} onDismiss={dismissBillingMessage} />
      ) : null}
    </Frame>
  );
}

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

function starterModuleLabel(value: string | null | undefined) {
  if (value === "trustAbuse") {
    return "Trust & Abuse";
  }
  if (value === "competitor") {
    return "Competitor";
  }
  return null;
}

export function AppFrame({ children }: Props) {
  const location = useLocation();
  const { navigateEmbedded } = useEmbeddedNavigation();
  const { subscription } = useSubscriptionPlan();
  const { message: billingMessage, dismiss: dismissBillingMessage } =
    useBillingFlash();
  const [toast, setToast] = useState<string | null>(null);

  const activePlan = subscription?.planName ?? "NONE";
  const moduleStatus = {
    trustAbuse: subscription?.enabledModules?.trustAbuse ?? false,
    competitor: subscription?.enabledModules?.competitor ?? false,
    pricingProfit: subscription?.enabledModules?.pricingProfit ?? false,
    reports: subscription?.enabledModules?.reports ?? false,
    settings: subscription?.enabledModules?.settings ?? false,
  };

  const dismissToast = useCallback(() => setToast(null), []);

  const createNavItem = useCallback(
    (path: string, label: string, options?: { badge?: string }) => ({
      label,
      selected: location.pathname === path,
      badge: options?.badge,
      onClick: () => {
        if (location.pathname !== path) {
          navigateEmbedded(path);
        }
      },
    }),
    [location.pathname, navigateEmbedded]
  );

  const navigationItems = useMemo(
    () => [
      createNavItem("/", "Dashboard"),
      createNavItem("/trust-abuse", "Trust & Abuse", {
        badge: moduleStatus.trustAbuse ? undefined : "Upgrade",
      }),
      createNavItem("/competitor", "Competitor Intelligence", {
        badge: moduleStatus.competitor ? undefined : "Upgrade",
      }),
      createNavItem("/pricing-profit", "Pricing & Profit", {
        badge: moduleStatus.pricingProfit ? undefined : "Upgrade",
      }),
      createNavItem("/reports", "Reports", {
        badge: moduleStatus.reports ? undefined : "Upgrade",
      }),
      createNavItem("/subscription", "Billing"),
      createNavItem("/settings", "Settings"),
    ],
    [
      createNavItem,
      moduleStatus.competitor,
      moduleStatus.pricingProfit,
      moduleStatus.reports,
      moduleStatus.trustAbuse,
    ]
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
                Commerce intelligence operating system for Shopify
              </p>
              <div className="vs-plan-pill">{activePlan} PLAN</div>
              {activePlan === "STARTER" && subscription?.starterModule ? (
                <p className="vs-brand__subtitle">
                  {starterModuleLabel(subscription.starterModule)} ACTIVE
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

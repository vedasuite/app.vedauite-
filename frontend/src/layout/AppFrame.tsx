import { Card, Frame, Navigation, Spinner, Text, Toast } from "@shopify/polaris";
import { ReactNode, useCallback, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import { VedaLogo } from "../brand/VedaLogo";
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
  const {
    subscription,
    billingFlowState,
    billingMessage,
    billingError,
    dismissBillingMessage,
    clearBillingError,
  } = useSubscriptionPlan();
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
      createNavItem("/app/onboarding", "Onboarding"),
      createNavItem("/app/dashboard", "Dashboard"),
      createNavItem("/app/fraud-intelligence", "Fraud Intelligence", {
        badge: moduleStatus.trustAbuse ? undefined : "Upgrade",
      }),
      createNavItem("/app/competitor-intelligence", "Competitor Intelligence", {
        badge: moduleStatus.competitor ? undefined : "Upgrade",
      }),
      createNavItem("/app/ai-pricing-engine", "AI Pricing Engine", {
        badge: moduleStatus.pricingProfit ? undefined : "Upgrade",
      }),
      createNavItem("/app/billing", "Billing"),
      createNavItem("/app/settings", "Settings"),
    ],
    [
      createNavItem,
      moduleStatus.competitor,
      moduleStatus.pricingProfit,
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
        <div className="vs-content">
          {billingFlowState === "RETURNED_FROM_SHOPIFY" ||
          billingFlowState === "CONFIRMING_BACKEND_STATE" ? (
            <Card>
              <div
                style={{
                  minHeight: "55vh",
                  display: "grid",
                  placeItems: "center",
                  textAlign: "center",
                  padding: "2rem",
                }}
              >
                <div>
                  <Spinner accessibilityLabel="Confirming subscription" size="large" />
                  <div style={{ marginTop: "1rem" }}>
                    <Text as="h2" variant="headingLg">
                      Confirming your subscription...
                    </Text>
                  </div>
                  <div style={{ marginTop: "0.5rem" }}>
                    <Text as="p" tone="subdued">
                      VedaSuite is waiting for backend confirmation from Shopify
                      before showing the updated plan.
                    </Text>
                  </div>
                </div>
              </div>
            </Card>
          ) : billingFlowState === "REDIRECTING_TO_SHOPIFY" ? (
            <Card>
              <div
                style={{
                  minHeight: "55vh",
                  display: "grid",
                  placeItems: "center",
                  textAlign: "center",
                  padding: "2rem",
                }}
              >
                <div>
                  <Spinner accessibilityLabel="Redirecting to Shopify billing" size="large" />
                  <div style={{ marginTop: "1rem" }}>
                    <Text as="h2" variant="headingLg">
                      Redirecting to Shopify billing...
                    </Text>
                  </div>
                  <div style={{ marginTop: "0.5rem" }}>
                    <Text as="p" tone="subdued">
                      Approve the selected plan in Shopify to continue.
                    </Text>
                  </div>
                </div>
              </div>
            </Card>
          ) : (
            children
          )}
        </div>
      </div>
      {toast ? <Toast content={toast} onDismiss={dismissToast} /> : null}
      {!toast && billingMessage ? (
        <Toast content={billingMessage} onDismiss={dismissBillingMessage} />
      ) : null}
      {!toast && !billingMessage && billingError ? (
        <Toast content={billingError} onDismiss={clearBillingError} error />
      ) : null}
    </Frame>
  );
}

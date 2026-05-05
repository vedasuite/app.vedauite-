import { Banner, Button, Card, Frame, Navigation, Spinner, Text, Toast } from "@shopify/polaris";
import { ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import { VedaLogo } from "../brand/VedaLogo";
import { useAppState } from "../hooks/useAppState";
import { useEmbeddedNavigation } from "../hooks/useEmbeddedNavigation";
import { useSubscriptionPlan } from "../hooks/useSubscriptionPlan";
import {
  resolveBackendEnabledModules,
  resolveBackendPlan,
  resolveBackendStarterModule,
} from "../lib/backendModuleAccess";
import "./app-frame.css";

type Props = {
  children: ReactNode;
};

function ShellLoadingState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
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
          <Spinner accessibilityLabel={title} size="large" />
          <div style={{ marginTop: "1rem" }}>
            <Text as="h2" variant="headingLg">
              {title}
            </Text>
          </div>
          <div style={{ marginTop: "0.5rem" }}>
            <Text as="p" tone="subdued">
              {description}
            </Text>
          </div>
          {action ? <div style={{ marginTop: "1rem" }}>{action}</div> : null}
        </div>
      </div>
    </Card>
  );
}

function BillingRedirectState({
  state,
  onRetry,
  onOpenBilling,
}: {
  state: "REDIRECTING_TO_SHOPIFY" | "RETURNED_FROM_SHOPIFY" | "CONFIRMING_BACKEND_STATE";
  onRetry: () => void;
  onOpenBilling: () => void;
}) {
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    setTimedOut(false);
    const timer = window.setTimeout(() => setTimedOut(true), 10000);
    return () => window.clearTimeout(timer);
  }, [state]);

  const copy =
    state === "REDIRECTING_TO_SHOPIFY"
      ? {
          title: "Redirecting to Shopify billing...",
          description: "Approve the selected plan in Shopify to continue.",
        }
      : state === "RETURNED_FROM_SHOPIFY"
      ? {
          title: "Returning to VedaSuite...",
          description: "Restoring your embedded app session after Shopify approval.",
        }
      : {
          title: "Waiting for Shopify approval...",
          description: "VedaSuite is reconciling the confirmed plan before showing the updated access.",
        };

  return (
    <ShellLoadingState
      title={copy.title}
      description={
        timedOut
          ? "Still working. You can retry the billing confirmation or reopen the billing page."
          : copy.description
      }
      action={
        timedOut ? (
          <div style={{ display: "inline-flex", gap: "0.75rem", flexWrap: "wrap", justifyContent: "center" }}>
            <Button variant="primary" onClick={onRetry}>
              Retry confirmation
            </Button>
            <Button onClick={onOpenBilling}>Open billing page</Button>
          </div>
        ) : undefined
      }
    />
  );
}

function starterModuleLabel(value: string | null | undefined) {
  if (value === "fraud") {
    return "Fraud";
  }
  if (value === "competitor") {
    return "Competitor";
  }
  return null;
}

export function AppFrame({ children }: Props) {
  const location = useLocation();
  const { navigateEmbedded } = useEmbeddedNavigation();
  const { appState, status: appStateStatus, bootstrap, refresh } = useAppState();
  const {
    subscription,
    billingState,
    entitlements,
    billingFlowState,
    billingMessage,
    billingError,
    retryBillingConfirmation,
    dismissBillingMessage,
    clearBillingError,
  } = useSubscriptionPlan();
  const [toast, setToast] = useState<string | null>(null);

  const installState = appState?.install ?? null;
  const activePlan =
    resolveBackendPlan(appState) ??
    entitlements?.planName ??
    subscription?.planName ??
    "NONE";
  const moduleStatus = resolveBackendEnabledModules(appState);
  const activeStarterModule =
    resolveBackendStarterModule(appState) ??
    entitlements?.starterModule ??
    null;

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
        badge: moduleStatus.fraud ? undefined : "Upgrade",
      }),
      createNavItem("/app/competitor-intelligence", "Competitor Intelligence", {
        badge: moduleStatus.competitor ? undefined : "Upgrade",
      }),
      createNavItem("/app/ai-pricing-engine", "AI Pricing Engine", {
        badge: moduleStatus.pricing ? undefined : "Upgrade",
      }),
      createNavItem("/app/billing", "Billing"),
      createNavItem("/app/settings", "Settings"),
    ],
    [
      createNavItem,
      moduleStatus.competitor,
      moduleStatus.fraud,
      moduleStatus.pricing,
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
              {activePlan === "STARTER" && activeStarterModule ? (
                <p className="vs-brand__subtitle">
                  {starterModuleLabel(activeStarterModule)}{" "}
                  ACTIVE
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

  const bootstrapGate = useMemo(() => {
    switch (bootstrap.status) {
      case "initializing_embedded_context":
        return (
          <ShellLoadingState
            title="Starting VedaSuite..."
            description="Opening the embedded app shell inside Shopify Admin."
          />
        );
      case "validating_shopify_params":
        return (
          <ShellLoadingState
            title="Validating your Shopify launch..."
            description="Checking the store and host details needed to restore your app session."
          />
        );
      case "loading_session":
        return (
          <ShellLoadingState
            title="Restoring your store session..."
            description="Confirming the current Shopify session before loading app data."
          />
        );
      case "loading_installation_record":
        return (
          <ShellLoadingState
            title="Loading VedaSuite..."
            description="Preparing your store connection, installation record, and module readiness."
          />
        );
      case "needs_reconnect":
        return (
          <Card>
            <div style={{ padding: "1.5rem" }}>
              <Banner
                title={installState?.title ?? "VedaSuite needs to reconnect to Shopify"}
                tone="critical"
                action={
                  bootstrap.reconnectUrl
                    ? {
                        content: "Reconnect app",
                        onAction: () => {
                          window.location.assign(bootstrap.reconnectUrl as string);
                        },
                      }
                    : undefined
                }
              >
                <p>
                  {installState?.description ??
                    bootstrap.errorMessage ??
                    "Open VedaSuite again from Shopify Admin so the store session can be restored."}
                </p>
              </Banner>
            </div>
          </Card>
        );
      case "failed":
        return (
          <Card>
            <div style={{ padding: "1.5rem" }}>
              <Banner
                title="VedaSuite could not finish loading"
                tone="critical"
                action={{
                  content: "Retry",
                  onAction: () => {
                    void refresh().catch(() => undefined);
                  },
                }}
              >
                <p>
                  {bootstrap.errorMessage ??
                    "The app shell could not confirm your current installation and store state."}
                </p>
              </Banner>
            </div>
          </Card>
        );
      default:
        return null;
    }
  }, [bootstrap, installState?.description, installState?.title, refresh]);

  const billingFlowGate =
    billingFlowState === "RETURNED_FROM_SHOPIFY" ||
    billingFlowState === "CONFIRMING_BACKEND_STATE" ||
    billingFlowState === "REDIRECTING_TO_SHOPIFY" ? (
      <BillingRedirectState
        state={billingFlowState}
        onRetry={() => {
          void retryBillingConfirmation();
        }}
        onOpenBilling={() => navigateEmbedded("/app/billing")}
      />
    ) : null;

  return (
    <Frame navigation={navigation} showMobileNavigation={false}>
      <div className="vs-app-frame">
        <div className="vs-content">
          {!bootstrapGate && appStateStatus === "error" ? (
            <Banner title="VedaSuite needs a fresh reload" tone="critical">
              <p>
                The app shell could not confirm the latest store state. Refresh once and
                try again.
              </p>
            </Banner>
          ) : null}
          {!bootstrapGate && installState && installState.status !== "installed" ? (
            <Banner title={installState.title} tone="critical">
              <p>{installState.description}</p>
            </Banner>
          ) : null}
          {!bootstrapGate && billingState?.lifecycle === "pending_approval" ? (
            <Banner title={billingState.merchantTitle} tone="warning">
              <p>{billingState.merchantDescription}</p>
            </Banner>
          ) : null}
          {!bootstrapGate && appState?.connection.status === "attention" ? (
            <Banner title={appState.connection.title} tone="warning">
              <p>{appState.connection.description}</p>
            </Banner>
          ) : null}
          {bootstrapGate ?? billingFlowGate ?? children}
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

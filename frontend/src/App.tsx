import { Card, InlineStack, Page, Spinner, Text } from "@shopify/polaris";
import { useEffect } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { RouteErrorBoundary } from "./components/RouteErrorBoundary";
import { useAppState } from "./hooks/useAppState";
import { AppFrame } from "./layout/AppFrame";
import { DashboardPage } from "./modules/Dashboard/DashboardPage";
import { CompetitorPage } from "./modules/CompetitorIntelligence/CompetitorPage";
import { SettingsPage } from "./modules/Settings/SettingsPage";
import { PricingPage } from "./modules/SubscriptionPlans/PricingPage";
import { PricingProfitPage } from "./modules/PricingProfit/PricingProfitPage";
import { TrustAbusePage } from "./modules/TrustAbuse/TrustAbusePage";
import { OnboardingPage } from "./modules/Onboarding/OnboardingPage";
import { useOnboardingState } from "./hooks/useOnboardingState";
import type { OnboardingModuleKey } from "./providers/OnboardingProvider";

function warmModuleChunks() {
  return;
}

function FullPageLoader({ title }: { title: string }) {
  return (
    <Page title={title}>
      <Card>
        <div style={{ minHeight: "45vh", display: "grid", placeItems: "center" }}>
          <InlineStack gap="300" blockAlign="center">
            <Spinner accessibilityLabel={title} size="large" />
            <Text as="p" tone="subdued">
              {title}
            </Text>
          </InlineStack>
        </div>
      </Card>
    </Page>
  );
}

function EntryRoute() {
  const { appState, status, bootstrap } = useAppState();

  if (bootstrap.status !== "ready" || status === "loading" || !appState) {
    return <FullPageLoader title="Loading VedaSuite..." />;
  }

  return (
    <Navigate
      to={appState.onboarding.canAccessDashboard ? "/app/dashboard" : "/app/onboarding"}
      replace
    />
  );
}

function InsightRoute({
  moduleKey,
  children,
}: {
  moduleKey: OnboardingModuleKey;
  children: JSX.Element;
  title?: string;
}) {
  const { onboarding, markInsightViewed } = useOnboardingState();

  useEffect(() => {
    if (
      onboarding &&
      !onboarding.canAccessDashboard &&
      onboarding.selectedModule === moduleKey
    ) {
      void markInsightViewed(moduleKey).catch(() => undefined);
    }
  }, [markInsightViewed, moduleKey, onboarding]);

  return children;
}

function withRouteBoundary(title: string, element: JSX.Element) {
  return <RouteErrorBoundary title={title}>{element}</RouteErrorBoundary>;
}

export default function App() {
  useEffect(() => {
    warmModuleChunks();
  }, []);

  return (
    <AppFrame>
      <Routes>
        <Route path="/" element={<EntryRoute />} />
        <Route path="/app" element={<EntryRoute />} />
        <Route path="/app/onboarding" element={withRouteBoundary("Onboarding", <OnboardingPage />)} />
        <Route path="/app/dashboard" element={withRouteBoundary("Dashboard", <DashboardPage />)} />
        <Route
          path="/app/fraud-intelligence"
          element={
            withRouteBoundary(
              "Fraud Intelligence",
              <InsightRoute moduleKey="trustAbuse">
                <TrustAbusePage />
              </InsightRoute>
            )
          }
        />
        <Route
          path="/app/competitor-intelligence"
          element={
            withRouteBoundary(
              "Competitor Intelligence",
              <InsightRoute moduleKey="competitor">
                <CompetitorPage />
              </InsightRoute>
            )
          }
        />
        <Route
          path="/app/ai-pricing-engine"
          element={
            withRouteBoundary(
              "AI Pricing Engine",
              <InsightRoute moduleKey="pricingProfit">
                <PricingProfitPage />
              </InsightRoute>
            )
          }
        />
        <Route path="/app/billing" element={withRouteBoundary("Billing", <PricingPage />)} />
        <Route path="/app/settings" element={withRouteBoundary("Settings", <SettingsPage />)} />

        <Route path="/onboarding" element={<Navigate to="/app/onboarding" replace />} />
        <Route path="/dashboard" element={<Navigate to="/app/dashboard" replace />} />
        <Route path="/modules/fraud" element={<Navigate to="/app/fraud-intelligence" replace />} />
        <Route path="/modules/competitor" element={<Navigate to="/app/competitor-intelligence" replace />} />
        <Route path="/modules/pricing" element={<Navigate to="/app/ai-pricing-engine" replace />} />
        <Route path="/trust-abuse" element={<Navigate to="/app/fraud-intelligence" replace />} />
        <Route path="/competitor" element={<Navigate to="/app/competitor-intelligence" replace />} />
        <Route path="/pricing-profit" element={<Navigate to="/app/ai-pricing-engine" replace />} />
        <Route path="/subscription" element={<Navigate to="/app/billing" replace />} />
        <Route path="/settings" element={<Navigate to="/app/settings" replace />} />
        <Route path="/fraud" element={<Navigate to="/app/fraud-intelligence" replace />} />
        <Route path="/credit-score" element={<Navigate to="/app/fraud-intelligence" replace />} />
        <Route path="/pricing" element={<Navigate to="/app/ai-pricing-engine" replace />} />
        <Route path="/profit" element={<Navigate to="/app/ai-pricing-engine" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppFrame>
  );
}

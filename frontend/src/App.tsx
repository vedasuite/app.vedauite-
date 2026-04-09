import { Card, InlineStack, Page, Spinner, Text } from "@shopify/polaris";
import { useEffect } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { AppFrame } from "./layout/AppFrame";
import { DashboardPage } from "./modules/Dashboard/DashboardPage";
import { CompetitorPage } from "./modules/CompetitorIntelligence/CompetitorPage";
import { ReportsPage } from "./modules/Reports/ReportsPage";
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
  const { onboarding, loading } = useOnboardingState();

  if (loading || !onboarding) {
    return <FullPageLoader title="Loading VedaSuite..." />;
  }

  return (
    <Navigate
      to={onboarding.canAccessDashboard ? "/dashboard" : "/onboarding"}
      replace
    />
  );
}

function DashboardRoute() {
  const { onboarding, loading } = useOnboardingState();

  if (loading || !onboarding) {
    return <FullPageLoader title="Checking dashboard access..." />;
  }

  if (!onboarding.canAccessDashboard) {
    return <Navigate to="/onboarding" replace />;
  }

  return <DashboardPage />;
}

function InsightRoute({
  moduleKey,
  children,
}: {
  moduleKey: OnboardingModuleKey;
  children: JSX.Element;
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

export default function App() {
  useEffect(() => {
    warmModuleChunks();
  }, []);

  return (
    <AppFrame>
      <Routes>
        <Route path="/" element={<EntryRoute />} />
        <Route path="/dashboard" element={<DashboardRoute />} />
        <Route path="/onboarding" element={<OnboardingPage />} />
        <Route
          path="/modules/fraud"
          element={
            <InsightRoute moduleKey="trustAbuse">
              <TrustAbusePage />
            </InsightRoute>
          }
        />
        <Route
          path="/modules/competitor"
          element={
            <InsightRoute moduleKey="competitor">
              <CompetitorPage />
            </InsightRoute>
          }
        />
        <Route
          path="/modules/pricing"
          element={
            <InsightRoute moduleKey="pricingProfit">
              <PricingProfitPage />
            </InsightRoute>
          }
        />
        <Route path="/trust-abuse" element={<Navigate to="/modules/fraud" replace />} />
        <Route path="/competitor" element={<Navigate to="/modules/competitor" replace />} />
        <Route path="/pricing-profit" element={<Navigate to="/modules/pricing" replace />} />
        <Route path="/reports" element={<ReportsPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/subscription" element={<PricingPage />} />
        <Route path="/fraud" element={<Navigate to="/modules/fraud" replace />} />
        <Route path="/credit-score" element={<Navigate to="/modules/fraud" replace />} />
        <Route path="/pricing" element={<Navigate to="/modules/pricing" replace />} />
        <Route path="/profit" element={<Navigate to="/modules/pricing" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppFrame>
  );
}

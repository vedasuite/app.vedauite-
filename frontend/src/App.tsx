import { useEffect } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { AppFrame } from "./layout/AppFrame";
import { DashboardPage } from "./modules/Dashboard/DashboardPage";
import { FraudPage } from "./modules/FraudIntelligence/FraudPage";
import { CompetitorPage } from "./modules/CompetitorIntelligence/CompetitorPage";
import { PricingPage } from "./modules/PricingStrategy/PricingPage";
import { ProfitPage } from "./modules/ProfitOptimization/ProfitPage";
import { CreditScorePage } from "./modules/CreditScore/CreditScorePage";
import { ReportsPage } from "./modules/Reports/ReportsPage";
import { SettingsPage } from "./modules/Settings/SettingsPage";
import { SubscriptionPage } from "./modules/SubscriptionPlans/SubscriptionPage";

function warmModuleChunks() {
  return;
}

export default function App() {
  useEffect(() => {
    warmModuleChunks();
  }, []);

  return (
    <AppFrame>
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/fraud" element={<FraudPage />} />
        <Route path="/competitor" element={<CompetitorPage />} />
        <Route path="/pricing" element={<PricingPage />} />
        <Route path="/profit" element={<ProfitPage />} />
        <Route path="/credit-score" element={<CreditScorePage />} />
        <Route path="/reports" element={<ReportsPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/subscription" element={<SubscriptionPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppFrame>
  );
}

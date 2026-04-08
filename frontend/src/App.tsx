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
        <Route path="/trust-abuse" element={<TrustAbusePage />} />
        <Route path="/competitor" element={<CompetitorPage />} />
        <Route path="/pricing-profit" element={<PricingProfitPage />} />
        <Route path="/reports" element={<ReportsPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/subscription" element={<PricingPage />} />
        <Route path="/fraud" element={<Navigate to="/trust-abuse" replace />} />
        <Route path="/credit-score" element={<Navigate to="/trust-abuse" replace />} />
        <Route path="/pricing" element={<Navigate to="/pricing-profit" replace />} />
        <Route path="/profit" element={<Navigate to="/pricing-profit" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppFrame>
  );
}

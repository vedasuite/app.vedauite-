import { Router } from "express";
import { ensureOfflineToken } from "../middleware/ensureOfflineToken";
import { verifyShopifySessionToken } from "../middleware/verifyShopifySessionToken";
import { appStateRouter } from "./appStateRoutes";
import { authRouter } from "./authRoutes";
import { billingApiRouter, billingRouter } from "./billingRoutes";
import { dashboardRouter } from "./dashboardRoutes";
import { fraudRouter } from "./fraudRoutes";
import { launchRouter } from "./launchRoutes";
import { competitorRouter } from "./competitorRoutes";
import { pricingRouter } from "./pricingRoutes";
import { pricingProfitRouter } from "./pricingProfitRoutes";
import { publicRouter } from "./publicRoutes";
import { creditScoreRouter } from "./creditScoreRoutes";
import { profitRouter } from "./profitRoutes";
import { reportsRouter } from "./reportsRoutes";
import { settingsRouter } from "./settingsRoutes";
import { shopifyRouter } from "./shopifyRoutes";
import { insightsRouter } from "./insightsRoutes";
import { subscriptionDebugRouter, subscriptionRouter } from "./subscriptionRoutes";
import { supportAdminRouter } from "./supportAdminRoutes";
import { supportRouter } from "./supportRoutes";
import { trustAbuseRouter } from "./trustAbuseRoutes";

export const router = Router();

router.use("/auth", authRouter);
router.use("/billing", billingRouter);
router.use(publicRouter);
router.use(launchRouter);
// Developer support console — gated by SUPPORT_ADMIN_TOKEN inside the router,
// mounted OUTSIDE /api since the developer has no Shopify session token.
router.use("/support-admin", supportAdminRouter);

router.use("/api", verifyShopifySessionToken);
// Mint an offline Admin API token from the verified session token whenever one
// is missing or expired, so no API route can dead-end on a reconnect prompt.
router.use("/api", ensureOfflineToken);

router.use("/api/billing", billingApiRouter);
router.use("/api/app-state", appStateRouter);
router.use("/api/subscription", subscriptionRouter);
router.use("/api/debug", subscriptionDebugRouter);
router.use("/api/dashboard", dashboardRouter);
router.use("/api/trust-abuse", trustAbuseRouter);
router.use("/api/fraud", fraudRouter);
router.use("/api/competitor", competitorRouter);
router.use("/api/pricing", pricingRouter);
router.use("/api/pricing-profit", pricingProfitRouter);
router.use("/api/credit-score", creditScoreRouter);
router.use("/api/profit", profitRouter);
router.use("/api/reports", reportsRouter);
router.use("/api/settings", settingsRouter);
// Phase 1 explainability — additive, read-only aggregate insights.
router.use("/api/insights", insightsRouter);
// Merchant support — session-token authenticated, no plan capability required.
router.use("/api/support", supportRouter);
router.use("/api/shopify", shopifyRouter);
router.use("/api/internal/debug", shopifyRouter);


import { Router } from "express";
import { verifyShopifySessionToken } from "../middleware/verifyShopifySessionToken";
import { authRouter } from "./authRoutes";
import { billingRouter } from "./billingRoutes";
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
import { subscriptionRouter } from "./subscriptionRoutes";
import { trustAbuseRouter } from "./trustAbuseRoutes";

export const router = Router();

router.use("/auth", authRouter);
router.use("/billing", billingRouter);
router.use(publicRouter);
router.use(launchRouter);

router.use("/api", verifyShopifySessionToken);

router.use("/api/subscription", subscriptionRouter);
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
router.use("/api/shopify", shopifyRouter);
router.use("/api/internal/debug", shopifyRouter);


import { Router } from "express";
import { getDashboardInsights } from "../services/explainabilityService";
import { logEvent } from "../services/observabilityService";
import { resolveAuthenticatedShop } from "./routeShop";

// Additive, read-only Phase 1 insights endpoint. Mounted under /api, so it
// reuses the existing session-token verification and offline-token middleware
// unchanged. No writes, no new scopes, no new middleware.
export const insightsRouter = Router();

insightsRouter.get("/dashboard", async (req, res) => {
  const shop = resolveAuthenticatedShop(req);
  if (!shop) {
    return res.status(400).json({ error: { code: "MISSING_SHOP_CONTEXT", message: "Open the app from Shopify Admin and try again." } });
  }
  try {
    const insights = await getDashboardInsights(shop);
    return res.json(insights);
  } catch (error) {
    logEvent("error", "insights.dashboard_failed", { shop, error });
    return res.status(503).json({ error: { code: "INSIGHTS_UNAVAILABLE", message: "Could not load insights. Please refresh and try again." } });
  }
});

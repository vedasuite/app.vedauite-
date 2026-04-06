import { Router } from "express";
import { requireCapability } from "../middleware/requireCapability";
import { getUnifiedDecisionCenter } from "../services/decisionCenterService";
import { getDashboardMetrics } from "../services/dashboardService";
import { resolveAuthenticatedShop } from "./routeShop";

export const dashboardRouter = Router();

dashboardRouter.get("/metrics", requireCapability("reports.view"), async (req, res) => {
  const shop = resolveAuthenticatedShop(req);
  if (!shop) {
    return res.status(400).json({ error: "Missing shop query parameter." });
  }

  const metrics = await getDashboardMetrics(shop);
  if (!metrics) {
    return res.status(404).json({ error: "Store not found." });
  }

  return res.json(metrics);
});

dashboardRouter.get("/decision-center", requireCapability("reports.view"), async (req, res) => {
  const shop = resolveAuthenticatedShop(req);
  if (!shop) {
    return res.status(400).json({ error: "Missing shop query parameter." });
  }

  const decisionCenter = await getUnifiedDecisionCenter(shop);
  return res.json(decisionCenter);
});


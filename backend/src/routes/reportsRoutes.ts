import { Router } from "express";
import { requireFeature } from "../middleware/requireFeature";
import { getWeeklyReport } from "../services/reportsService";
import { resolveAuthenticatedShop } from "./routeShop";

export const reportsRouter = Router();

reportsRouter.get("/weekly", requireFeature("reports"), async (req, res) => {
  const shop = resolveAuthenticatedShop(req);
  if (!shop) {
    return res.status(400).json({ error: "Missing shop." });
  }

  const report = await getWeeklyReport(shop);
  return res.json({ report });
});

reportsRouter.get("/weekly/export", requireFeature("reports"), async (req, res) => {
  const shop = resolveAuthenticatedShop(req);
  if (!shop) {
    return res.status(400).json({ error: "Missing shop." });
  }

  const report = await getWeeklyReport(shop);
  res.setHeader("Content-Type", "application/json");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="vedasuite-weekly-report-${Date.now()}.json"`
  );
  return res.json({
    exportedAt: new Date().toISOString(),
    report,
  });
});


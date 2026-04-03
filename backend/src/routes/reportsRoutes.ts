import { Router } from "express";
import { requireCapability } from "../middleware/requireCapability";
import { getWeeklyReport } from "../services/reportsService";

export const reportsRouter = Router();

reportsRouter.get("/weekly", requireCapability("reports.view"), async (req, res) => {
  const { shop } = req.query;
  if (!shop || typeof shop !== "string") {
    return res.status(400).json({ error: "Missing shop." });
  }

  const report = await getWeeklyReport(shop);
  return res.json({ report });
});

reportsRouter.get("/weekly/export", requireCapability("reports.export"), async (req, res) => {
  const { shop } = req.query;
  if (!shop || typeof shop !== "string") {
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


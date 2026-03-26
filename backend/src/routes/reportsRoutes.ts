import { Router } from "express";
import { getWeeklyReport } from "../services/reportsService";

export const reportsRouter = Router();

reportsRouter.get("/weekly", async (req, res) => {
  const { shop } = req.query;
  if (!shop || typeof shop !== "string") {
    return res.status(400).json({ error: "Missing shop." });
  }

  const report = await getWeeklyReport(shop);
  return res.json({ report });
});

reportsRouter.get("/weekly/export", async (req, res) => {
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


import { Router } from "express";
import {
  getProfitOpportunities,
  getProfitRecommendations,
} from "../services/profitService";

export const profitRouter = Router();

profitRouter.get("/recommendations", async (req, res) => {
  const { shop } = req.query;
  if (!shop || typeof shop !== "string") {
    return res.status(400).json({ error: "Missing shop." });
  }
  const recs = await getProfitRecommendations(shop);
  return res.json({ recommendations: recs });
});

profitRouter.get("/opportunities", async (req, res) => {
  const { shop } = req.query;
  if (!shop || typeof shop !== "string") {
    return res.status(400).json({ error: "Missing shop." });
  }
  const opportunities = await getProfitOpportunities(shop);
  return res.json({ opportunities });
});


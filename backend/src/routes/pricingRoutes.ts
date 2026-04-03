import { Router } from "express";
import { requireCapability } from "../middleware/requireCapability";
import {
  approvePricingRecommendation,
  getPricingRecommendations,
  simulatePricingChange,
} from "../services/pricingService";

export const pricingRouter = Router();

pricingRouter.get(
  "/recommendations",
  requireCapability("pricing.basicRecommendations"),
  async (req, res) => {
  const { shop } = req.query;
  if (!shop || typeof shop !== "string") {
    return res.status(400).json({ error: "Missing shop." });
  }

  const recs = await getPricingRecommendations(shop);
  return res.json({ recommendations: recs });
});

pricingRouter.post(
  "/simulate",
  requireCapability("pricing.scenarioSimulator"),
  async (req, res) => {
  const { currentPrice, recommendedPrice, salesVelocity, margin } = req.body;
  const result = await simulatePricingChange({
    currentPrice,
    recommendedPrice,
    salesVelocity,
    margin,
  });
  return res.json(result);
});

pricingRouter.post(
  "/recommendations/:id/approve",
  requireCapability("pricing.basicRecommendations"),
  async (req, res) => {
  const { id } = req.params;
  const body = req.body as { shop?: string };
  const shop =
    body.shop ??
    (typeof req.query.shop === "string" ? req.query.shop : undefined);

  if (!shop || !id) {
    return res.status(400).json({ error: "Missing shop or recommendation id." });
  }

  const recommendation = await approvePricingRecommendation(shop, id);
  return res.json({ recommendation });
});


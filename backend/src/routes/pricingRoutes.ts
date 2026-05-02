import { Router } from "express";
import { requireFeature } from "../middleware/requireFeature";
import {
  approvePricingRecommendation,
  getPricingRecommendations,
  simulatePricingChange,
} from "../services/pricingService";
import { resolveAuthenticatedShop } from "./routeShop";

export const pricingRouter = Router();

pricingRouter.get(
  "/recommendations",
  requireFeature("pricing"),
  async (req, res) => {
  const shop = resolveAuthenticatedShop(req);
  if (!shop) {
    return res.status(400).json({ error: "Missing shop." });
  }

  const recs = await getPricingRecommendations(shop);
  return res.json({ recommendations: recs });
});

pricingRouter.post(
  "/simulate",
  requireFeature("pricing"),
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
  requireFeature("pricing"),
  async (req, res) => {
  const { id } = req.params;
  const shop = resolveAuthenticatedShop(req);

  if (!shop || !id) {
    return res.status(400).json({ error: "Missing shop or recommendation id." });
  }

  const recommendation = await approvePricingRecommendation(shop, id);
  return res.json({ recommendation });
});


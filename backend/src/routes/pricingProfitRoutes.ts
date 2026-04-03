import { Router } from "express";
import { getPricingProfitOverview } from "../services/pricingProfitService";

export const pricingProfitRouter = Router();

pricingProfitRouter.get("/overview", async (req, res) => {
  const shop = typeof req.query.shop === "string" ? req.query.shop : undefined;
  if (!shop) {
    return res.status(400).json({ error: "Missing shop." });
  }

  const overview = await getPricingProfitOverview(shop);
  return res.json({ overview });
});

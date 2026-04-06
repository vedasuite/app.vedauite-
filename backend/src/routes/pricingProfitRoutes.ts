import { Router } from "express";
import { requireCapability } from "../middleware/requireCapability";
import { getPricingProfitOverview } from "../services/pricingProfitService";
import { resolveAuthenticatedShop } from "./routeShop";

export const pricingProfitRouter = Router();
pricingProfitRouter.use(requireCapability("module.pricingProfit"));

pricingProfitRouter.get("/overview", async (req, res) => {
  const shop = resolveAuthenticatedShop(req);
  if (!shop) {
    return res.status(400).json({ error: "Missing shop." });
  }

  const overview = await getPricingProfitOverview(shop);
  return res.json({ overview });
});

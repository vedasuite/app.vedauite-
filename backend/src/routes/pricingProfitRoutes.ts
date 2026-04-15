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

  try {
    const overview = await Promise.race([
      getPricingProfitOverview(shop),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("Pricing overview timed out.")), 12000);
      }),
    ]);

    return res.json({ overview });
  } catch (error) {
    return res.status(503).json({
      error:
        error instanceof Error
          ? error.message
          : "Pricing overview could not be loaded.",
    });
  }
});

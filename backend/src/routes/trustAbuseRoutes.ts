import { Router } from "express";
import { requireFeature } from "../middleware/requireFeature";
import { getTrustAbuseOverview } from "../services/trustAbuseService";
import { resolveAuthenticatedShop } from "./routeShop";

export const trustAbuseRouter = Router();
trustAbuseRouter.use(requireFeature("fraud"));

trustAbuseRouter.get("/overview", async (req, res) => {
  const shop = resolveAuthenticatedShop(req);
  if (!shop) {
    return res.status(400).json({ error: "Missing shop." });
  }

  const overview = await getTrustAbuseOverview(shop);
  return res.json({ overview });
});

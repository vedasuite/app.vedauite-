import { Router } from "express";
import { requireCapability } from "../middleware/requireCapability";
import { getTrustAbuseOverview } from "../services/trustAbuseService";
import { resolveAuthenticatedShop } from "./routeShop";

export const trustAbuseRouter = Router();
trustAbuseRouter.use(requireCapability("module.trustAbuse"));

trustAbuseRouter.get("/overview", async (req, res) => {
  const shop = resolveAuthenticatedShop(req);
  if (!shop) {
    return res.status(400).json({ error: "Missing shop." });
  }

  const overview = await getTrustAbuseOverview(shop);
  return res.json({ overview });
});

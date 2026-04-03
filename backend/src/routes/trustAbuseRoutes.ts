import { Router } from "express";
import { getTrustAbuseOverview } from "../services/trustAbuseService";

export const trustAbuseRouter = Router();

trustAbuseRouter.get("/overview", async (req, res) => {
  const shop = typeof req.query.shop === "string" ? req.query.shop : undefined;
  if (!shop) {
    return res.status(400).json({ error: "Missing shop." });
  }

  const overview = await getTrustAbuseOverview(shop);
  return res.json({ overview });
});

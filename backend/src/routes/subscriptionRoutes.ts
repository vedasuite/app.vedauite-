import { Router } from "express";
import { verifyShopifySessionToken } from "../middleware/verifyShopifySessionToken";
import {
  cancelSubscription,
  downgradeToTrial,
  getCurrentSubscription,
  updateStarterModuleSelection,
} from "../services/subscriptionService";

export const subscriptionRouter = Router();

subscriptionRouter.get("/plan", async (req, res) => {
  const { shop } = req.query;
  if (!shop || typeof shop !== "string") {
    return res.status(400).json({ error: "Missing shop." });
  }
  const plan = await getCurrentSubscription(shop);
  return res.json({ subscription: plan });
});

subscriptionRouter.post("/cancel", verifyShopifySessionToken, async (req, res) => {
  const body = req.body as { shop?: string };
  const shop =
    body.shop ??
    (typeof req.query.shop === "string" ? req.query.shop : undefined);
  if (!shop) {
    return res.status(400).json({ error: "Missing shop." });
  }

  const subscription = await cancelSubscription(shop);
  return res.json({ subscription });
});

subscriptionRouter.post("/downgrade-to-trial", verifyShopifySessionToken, async (req, res) => {
  const body = req.body as { shop?: string };
  const shop =
    body.shop ??
    (typeof req.query.shop === "string" ? req.query.shop : undefined);
  if (!shop) {
    return res.status(400).json({ error: "Missing shop." });
  }

  const result = await downgradeToTrial(shop);
  return res.json({ result });
});

subscriptionRouter.post("/starter-module", verifyShopifySessionToken, async (req, res) => {
  const body = req.body as {
    shop?: string;
    starterModule?: "trustAbuse" | "competitor";
  };
  const shop =
    body.shop ??
    (typeof req.query.shop === "string" ? req.query.shop : undefined);
  const starterModule = body.starterModule;

  if (!shop || !starterModule) {
    return res.status(400).json({ error: "Missing shop or starter module." });
  }

  const subscription = await updateStarterModuleSelection(shop, starterModule);
  return res.json({ subscription });
});


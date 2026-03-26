import { Router } from "express";
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

subscriptionRouter.post("/cancel", async (req, res) => {
  const { shop } = req.body as { shop?: string };
  if (!shop) {
    return res.status(400).json({ error: "Missing shop." });
  }

  const subscription = await cancelSubscription(shop);
  return res.json({ subscription });
});

subscriptionRouter.post("/downgrade-to-trial", async (req, res) => {
  const { shop } = req.body as { shop?: string };
  if (!shop) {
    return res.status(400).json({ error: "Missing shop." });
  }

  const result = await downgradeToTrial(shop);
  return res.json({ result });
});

subscriptionRouter.post("/starter-module", async (req, res) => {
  const { shop, starterModule } = req.body as {
    shop?: string;
    starterModule?: "fraud" | "competitor";
  };

  if (!shop || !starterModule) {
    return res.status(400).json({ error: "Missing shop or starter module." });
  }

  const subscription = await updateStarterModuleSelection(shop, starterModule);
  return res.json({ subscription });
});


import { Router } from "express";
import { env } from "../config/env";
import {
  getSyncWebhookStatus,
  registerSyncWebhooks,
  syncShopifyStoreData,
} from "../services/shopifyAdminService";

export const shopifyRouter = Router();

shopifyRouter.post("/sync", async (req, res) => {
  const { shop } = req.body as { shop?: string };

  if (!shop) {
    return res.status(400).json({ error: "Missing shop." });
  }

  const result = await syncShopifyStoreData(shop);
  return res.json({ result });
});

shopifyRouter.post("/register-webhooks", async (req, res) => {
  const { shop } = req.body as { shop?: string };

  if (!shop) {
    return res.status(400).json({ error: "Missing shop." });
  }

  const result = await registerSyncWebhooks(shop, env.shopifyAppUrl);
  return res.json({ result });
});

shopifyRouter.get("/webhook-status", async (req, res) => {
  const { shop } = req.query;

  if (!shop || typeof shop !== "string") {
    return res.status(400).json({ error: "Missing shop." });
  }

  const result = await getSyncWebhookStatus(shop, env.shopifyAppUrl);
  return res.json({ result });
});

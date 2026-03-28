import { Router } from "express";
import { env } from "../config/env";
import {
  getSyncWebhookStatus,
  registerSyncWebhooks,
  syncShopifyStoreData,
} from "../services/shopifyAdminService";

export const shopifyRouter = Router();

function buildReauthorizeUrl(shop?: string) {
  if (!shop) {
    return undefined;
  }

  return new URL(
    `/auth/install?shop=${encodeURIComponent(shop)}`,
    env.shopifyAppUrl
  ).toString();
}

shopifyRouter.post("/sync", async (req, res) => {
  const body = req.body as { shop?: string };
  const shop =
    body.shop ??
    (typeof req.query.shop === "string" ? req.query.shop : undefined);

  if (!shop) {
    return res.status(400).json({ error: "Missing shop." });
  }

  try {
    const result = await syncShopifyStoreData(shop);
    return res.json({ result });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to sync Shopify data.";

    if (/invalid for .*reauthorize the app/i.test(message)) {
      return res.status(401).json({
        error: {
          message,
          reauthorizeUrl: buildReauthorizeUrl(shop),
        },
      });
    }

    throw error;
  }
});

shopifyRouter.post("/register-webhooks", async (req, res) => {
  const body = req.body as { shop?: string };
  const shop =
    body.shop ??
    (typeof req.query.shop === "string" ? req.query.shop : undefined);

  if (!shop) {
    return res.status(400).json({ error: "Missing shop." });
  }

  try {
    const result = await registerSyncWebhooks(shop, env.shopifyAppUrl);
    return res.json({ result });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Unable to register Shopify sync webhooks.";

    if (/invalid for .*reauthorize the app/i.test(message)) {
      return res.status(401).json({
        error: {
          message,
          reauthorizeUrl: buildReauthorizeUrl(shop),
        },
      });
    }

    throw error;
  }
});

shopifyRouter.get("/webhook-status", async (req, res) => {
  const { shop } = req.query;

  if (!shop || typeof shop !== "string") {
    return res.status(400).json({ error: "Missing shop." });
  }

  const result = await getSyncWebhookStatus(shop, env.shopifyAppUrl);
  return res.json({ result });
});

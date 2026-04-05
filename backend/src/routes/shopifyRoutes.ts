import { type Response, Router } from "express";
import { env } from "../config/env";
import {
  assertHealthyOfflineAccess,
  getConnectionHealth,
  normalizeShopDomain,
  ShopifyConnectionError,
  type ShopifyConnectionCode,
} from "../services/shopifyConnectionService";
import {
  getSyncWebhookStatus,
  registerSyncWebhooks,
} from "../services/shopifyAdminService";
import {
  getLatestSyncJob,
  startStoreSyncJob,
} from "../services/syncJobService";

export const shopifyRouter = Router();

function buildReauthorizeUrl(shop?: string) {
  const normalizedShop = normalizeShopDomain(shop);
  if (!normalizedShop) {
    return undefined;
  }

  return new URL(
    `/auth/install?shop=${encodeURIComponent(normalizedShop)}`,
    env.shopifyAppUrl
  ).toString();
}

function sendStructuredConnectionError(
  res: Response,
  shop: string | undefined,
  error: unknown,
  fallbackMessage: string
) {
  const message =
    error instanceof Error ? error.message : fallbackMessage;
  const code =
    error instanceof ShopifyConnectionError
      ? error.code
      : (/invalid access token|reauthorize/i.test(message)
          ? "SHOPIFY_AUTH_REQUIRED"
          : "STALE_CONNECTION") satisfies ShopifyConnectionCode;

  const reauthorizeUrl =
    error instanceof ShopifyConnectionError && error.reauthorizeUrl
      ? error.reauthorizeUrl
      : buildReauthorizeUrl(shop);

  return res.status(401).json({
    error: {
      code,
      message,
      reauthorizeUrl,
    },
  });
}

shopifyRouter.get("/connection-health", async (req, res) => {
  const { shop } = req.query;
  const result = await getConnectionHealth(
    typeof shop === "string" ? shop : undefined,
    { probeApi: true }
  );
  return res.json({ result });
});

shopifyRouter.post("/sync", async (req, res) => {
  const body = req.body as { shop?: string };
  const shop =
    body.shop ??
    (typeof req.query.shop === "string" ? req.query.shop : undefined);

  if (!shop) {
    return res.status(400).json({ error: "Missing shop." });
  }

  try {
    await assertHealthyOfflineAccess(shop);
    const result = await startStoreSyncJob(shop, "manual");
    return res.json({ result });
  } catch (error) {
    if (error instanceof ShopifyConnectionError) {
      return sendStructuredConnectionError(
        res,
        shop,
        error,
        "Unable to sync Shopify data."
      );
    }

    return res.status(500).json({
      error: {
        code: "SYNC_FAILED",
        message:
          error instanceof Error
            ? error.message
            : "Unable to sync Shopify data.",
      },
    });
  }
});

shopifyRouter.get("/sync-jobs/latest", async (req, res) => {
  const { shop } = req.query;

  if (!shop || typeof shop !== "string") {
    return res.status(400).json({ error: "Missing shop." });
  }

  const result = await getLatestSyncJob(shop);
  return res.json({ result });
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
    await assertHealthyOfflineAccess(shop);
    const result = await registerSyncWebhooks(shop, env.shopifyAppUrl);
    return res.json({ result });
  } catch (error) {
    if (error instanceof ShopifyConnectionError) {
      return sendStructuredConnectionError(
        res,
        shop,
        error,
        "Unable to register Shopify sync webhooks."
      );
    }

    return res.status(500).json({
      error: {
        code: "WEBHOOK_REGISTRATION_FAILED",
        message:
          error instanceof Error
            ? error.message
            : "Unable to register Shopify sync webhooks.",
      },
    });
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

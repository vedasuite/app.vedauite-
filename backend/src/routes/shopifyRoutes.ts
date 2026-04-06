import { type Request, type Response, Router } from "express";
import { prisma } from "../db/prismaClient";
import { env } from "../config/env";
import {
  buildReauthorizeUrl,
  getConnectionHealth,
  ShopifyConnectionError,
  type ShopifyConnectionCode,
} from "../services/shopifyConnectionService";
import { getCurrentSubscription } from "../services/subscriptionService";
import {
  getSyncWebhookStatus,
  registerSyncWebhooks,
} from "../services/shopifyAdminService";
import {
  getLatestSyncJob,
  startStoreSyncJob,
} from "../services/syncJobService";

export const shopifyRouter = Router();

type ShopifyRequest = Request & { shopifySession?: { shop?: string } };

function resolveShopFromRequest(req: ShopifyRequest) {
  return (
    req.shopifySession?.shop ??
    (typeof req.query.shop === "string" ? req.query.shop : undefined) ??
    (typeof req.body?.shop === "string" ? req.body.shop : undefined)
  );
}

function resolveEmbeddedContext(req: ShopifyRequest) {
  const queryHost = typeof req.query.host === "string" ? req.query.host : undefined;
  const bodyHost = typeof req.body?.host === "string" ? req.body.host : undefined;
  const queryReturnTo =
    typeof req.query.returnTo === "string" ? req.query.returnTo : undefined;
  const bodyReturnTo =
    typeof req.body?.returnTo === "string" ? req.body.returnTo : undefined;

  return {
    host: queryHost ?? bodyHost ?? null,
    returnTo: queryReturnTo ?? bodyReturnTo ?? req.path ?? "/",
  };
}

function sendStructuredConnectionError(
  res: Response,
  shop: string | undefined,
  context: { host?: string | null; returnTo?: string | null },
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
      : buildReauthorizeUrl(shop, context.returnTo, context.host);

  return res.status(401).json({
    error: {
      code,
      message,
      reauthorizeUrl,
    },
  });
}

shopifyRouter.get("/diagnostics", async (req, res) => {
  const request = req as ShopifyRequest;
  const shop = resolveShopFromRequest(request);
  const context = resolveEmbeddedContext(request);

  if (!shop) {
    return res.status(400).json({
      error: {
        code: "MISSING_SHOP",
        message: "Missing shop.",
      },
    });
  }

  const [health, store, latestSyncJob, subscription] = await Promise.all([
    getConnectionHealth(shop, {
      probeApi: true,
      host: context.host,
      returnTo: context.returnTo,
    }),
    prisma.store.findUnique({
      where: { shop },
      select: {
        shop: true,
        installedAt: true,
        reauthorizedAt: true,
        uninstalledAt: true,
        grantedScopes: true,
        tokenAcquisitionMode: true,
        isOffline: true,
        accessToken: true,
        accessTokenExpiresAt: true,
        refreshToken: true,
        refreshTokenExpiresAt: true,
        webhooksRegisteredAt: true,
        lastWebhookRegistrationStatus: true,
        lastSyncAt: true,
        lastSyncStatus: true,
        lastConnectionCheckAt: true,
        lastConnectionStatus: true,
        authErrorCode: true,
        authErrorMessage: true,
      },
    }),
    getLatestSyncJob(shop),
    getCurrentSubscription(shop).catch(() => null),
  ]);

  let webhookStatus: Awaited<ReturnType<typeof getSyncWebhookStatus>> | null = null;
  if (health.hasOfflineToken && !health.reauthRequired && !health.shop?.includes(" ")) {
    try {
      webhookStatus = await getSyncWebhookStatus(shop, env.shopifyAppUrl);
    } catch {
      webhookStatus = null;
    }
  }

  return res.json({
    generatedAt: new Date().toISOString(),
    shop,
    installation: {
      found: !!store,
      installedAt: store?.installedAt?.toISOString() ?? null,
      reauthorizedAt: store?.reauthorizedAt?.toISOString() ?? null,
      uninstalledAt: store?.uninstalledAt?.toISOString() ?? null,
      grantedScopes: store?.grantedScopes ?? null,
      tokenAcquisitionMode: store?.tokenAcquisitionMode ?? null,
      offlineTokenPresent: !!store?.accessToken,
      refreshTokenPresent: !!store?.refreshToken,
      isOffline: store?.isOffline ?? false,
      accessTokenExpiresAt: store?.accessTokenExpiresAt?.toISOString() ?? null,
      refreshTokenExpiresAt: store?.refreshTokenExpiresAt?.toISOString() ?? null,
      authErrorCode: store?.authErrorCode ?? null,
      authErrorMessage: store?.authErrorMessage ?? null,
    },
    connection: health,
    reviewerSummary: {
      installExists: !!store,
      tokenPresent: !!store?.accessToken,
      tokenRefreshHealthy:
        !store?.refreshTokenExpiresAt ||
        store.refreshTokenExpiresAt.getTime() > Date.now(),
      webhookCoverageReady: health.webhookCoverageReady,
      reconnectRequired: health.reauthRequired,
      uninstallState: !!store?.uninstalledAt,
      billingStatus: subscription?.billingStatus ?? null,
    },
    webhooks: {
      registeredAt: store?.webhooksRegisteredAt?.toISOString() ?? null,
      lastStatus: store?.lastWebhookRegistrationStatus ?? null,
      liveStatus: webhookStatus,
    },
    sync: {
      lastSyncAt: store?.lastSyncAt?.toISOString() ?? null,
      lastSyncStatus: store?.lastSyncStatus ?? null,
      latestJob: latestSyncJob,
    },
    billing: subscription
      ? {
          planName: subscription.planName,
          status: subscription.status,
          billingStatus: subscription.billingStatus ?? null,
          active: subscription.active,
          starterModule: subscription.starterModule ?? null,
          endsAt: subscription.endsAt,
          trialEndsAt: subscription.trialEndsAt,
        }
      : null,
  });
});

shopifyRouter.get("/connection-health", async (req, res) => {
  const request = req as ShopifyRequest;
  const shop = resolveShopFromRequest(request);
  const context = resolveEmbeddedContext(request);
  const result = await getConnectionHealth(
    shop,
    {
      probeApi: true,
      host: context.host,
      returnTo: context.returnTo,
    }
  );
  return res.json({ result });
});

shopifyRouter.post("/sync", async (req, res) => {
  const request = req as ShopifyRequest;
  const shop = resolveShopFromRequest(request);
  const context = resolveEmbeddedContext(request);

  if (!shop) {
    return res.status(400).json({
      error: {
        code: "MISSING_SHOP",
        message: "Missing shop.",
      },
    });
  }

  try {
    await getConnectionHealth(shop, {
      probeApi: true,
      host: context.host,
      returnTo: context.returnTo,
    }).then((health) => {
      if (!health.healthy) {
        throw new ShopifyConnectionError(health.code, health.message, {
          reauthorizeUrl: health.reauthorizeUrl,
        });
      }
    });
    const result = await startStoreSyncJob(shop, "manual");
    return res.json({ result });
  } catch (error) {
    if (error instanceof ShopifyConnectionError) {
      return sendStructuredConnectionError(
        res,
        shop,
        context,
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
  const shop = resolveShopFromRequest(req as ShopifyRequest);

  if (!shop) {
    return res.status(400).json({
      error: {
        code: "MISSING_SHOP",
        message: "Missing shop.",
      },
    });
  }

  const result = await getLatestSyncJob(shop);
  return res.json({ result });
});

shopifyRouter.post("/register-webhooks", async (req, res) => {
  const request = req as ShopifyRequest;
  const shop = resolveShopFromRequest(request);
  const context = resolveEmbeddedContext(request);

  if (!shop) {
    return res.status(400).json({
      error: {
        code: "MISSING_SHOP",
        message: "Missing shop.",
      },
    });
  }

  try {
    await getConnectionHealth(shop, {
      probeApi: true,
      host: context.host,
      returnTo: context.returnTo,
    }).then((health) => {
      if (!health.healthy) {
        throw new ShopifyConnectionError(health.code, health.message, {
          reauthorizeUrl: health.reauthorizeUrl,
        });
      }
    });
    const result = await registerSyncWebhooks(shop, env.shopifyAppUrl);
    return res.json({ result });
  } catch (error) {
    if (error instanceof ShopifyConnectionError) {
      return sendStructuredConnectionError(
        res,
        shop,
        context,
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
  const shop = resolveShopFromRequest(req as ShopifyRequest);

  if (!shop) {
    return res.status(400).json({
      error: {
        code: "MISSING_SHOP",
        message: "Missing shop.",
      },
    });
  }

  const result = await getSyncWebhookStatus(shop, env.shopifyAppUrl);
  return res.json({ result });
});

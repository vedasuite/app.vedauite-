import { type Request, type Response, Router } from "express";
import { prisma } from "../db/prismaClient";
import { env } from "../config/env";
import {
  buildReauthorizeUrl,
  ensureInstallationMetadata,
  getConnectionHealth,
  ShopifyConnectionError,
  type ShopifyConnectionCode,
} from "../services/shopifyConnectionService";
import { getBillingManagementState } from "../services/billingManagementService";
import {
  getCurrentSubscription,
  resolveBillingState,
} from "../services/subscriptionService";
import {
  getSyncWebhookStatus,
  registerSyncWebhooks,
} from "../services/shopifyAdminService";
import {
  getLatestSyncJob,
  startStoreSyncJob,
} from "../services/syncJobService";
import {
  deriveModuleReadiness,
  deriveSyncStatus,
  getStoreOperationalSnapshot,
} from "../services/storeOperationalStateService";
import { resolveAuthenticatedShop } from "./routeShop";

export const shopifyRouter = Router();

type ShopifyRequest = Request & { shopifySession?: { shop?: string } };

function resolveShopFromRequest(req: ShopifyRequest) {
  return resolveAuthenticatedShop(req);
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

  await ensureInstallationMetadata(shop);

  const [health, store, latestSyncJob, subscription, operational, billingState, billingManagement] = await Promise.all([
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
    getStoreOperationalSnapshot(shop).catch(() => null),
    resolveBillingState(shop).catch(() => null),
    getBillingManagementState(shop).catch(() => null),
  ]);

  let webhookStatus: Awaited<ReturnType<typeof getSyncWebhookStatus>> | null = null;
  if (health.hasOfflineToken && !health.reauthRequired && !health.shop?.includes(" ")) {
    try {
      webhookStatus = await getSyncWebhookStatus(shop, env.shopifyAppUrl);
    } catch {
      webhookStatus = null;
    }
  }

  const syncHealth = operational
    ? deriveSyncStatus({
        connectionStatus: operational.store.lastConnectionStatus,
        latestSyncJobStatus: operational.latestSyncJob?.status ?? null,
        lastSyncStatus: operational.store.lastSyncStatus,
        products: operational.counts.products,
        orders: operational.counts.orders,
        customers: operational.counts.customers,
        priceRows: operational.counts.pricingRows,
        profitRows: operational.counts.profitRows,
        timelineEvents: operational.counts.timelineEvents,
      })
    : null;

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
      billingStatus: billingState?.lifecycle ?? null,
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
      syncHealth,
      operationalCounts: operational?.counts ?? null,
    },
    billing: subscription
      ? {
          planName: billingState?.planName ?? subscription.planName,
          lifecycle: billingState?.lifecycle ?? "unknown_error",
          status: billingState?.status ?? subscription.status,
          billingStatus:
            billingState?.normalizedBillingStatus ?? subscription.billingStatus ?? null,
          active: billingState?.active ?? subscription.active,
          accessActive: billingState?.accessActive ?? subscription.active,
          verified: billingState?.verified ?? false,
          starterModule:
            billingState?.starterModule ?? subscription.starterModule ?? null,
          endsAt:
            billingState?.showRenewalDate
              ? billingState.renewalAt
              : billingState?.endsAt ?? subscription.endsAt,
          trialEndsAt: billingState?.showTrialDate ? subscription.trialEndsAt : null,
          planSource: billingState?.planSource ?? null,
          merchantTitle: billingState?.merchantTitle ?? null,
          merchantDescription: billingState?.merchantDescription ?? null,
          pendingIntentStatus: billingState?.pendingIntentStatus ?? null,
          pendingRequestedPlanName: billingState?.pendingRequestedPlanName ?? null,
          mismatchWarnings: billingState?.mismatchWarnings ?? [],
          pendingIntent: billingManagement?.pendingIntent ?? null,
        }
      : null,
  });
});

async function handleSyncHealth(req: Request, res: Response) {
  const request = req as ShopifyRequest;
  const shop = resolveShopFromRequest(request);

  if (!shop) {
    return res.status(400).json({
      error: {
        code: "MISSING_SHOP",
        message: "Missing shop.",
      },
    });
  }

  const [health, operational] = await Promise.all([
    getConnectionHealth(shop, { probeApi: true }),
    getStoreOperationalSnapshot(shop),
  ]);
  const syncHealth = deriveSyncStatus({
    connectionStatus: operational.store.lastConnectionStatus,
    latestSyncJobStatus: operational.latestSyncJob?.status ?? null,
    lastSyncStatus: operational.store.lastSyncStatus,
    products: operational.counts.products,
    orders: operational.counts.orders,
    customers: operational.counts.customers,
    priceRows: operational.counts.pricingRows,
    profitRows: operational.counts.profitRows,
    timelineEvents: operational.counts.timelineEvents,
  });

  return res.json({
    shop,
    authState: health.code,
    connectionHealthy: health.healthy,
    lastSyncStatus: syncHealth.status,
    lastSyncReason: syncHealth.reason,
    countsExplanation: {
      rawCounts:
        "Persisted raw Shopify records currently stored in VedaSuite.",
      processedCounts:
        "Derived engine output rows currently stored for dashboard and module readiness.",
    },
    rawCounts: {
      products: operational.counts.products,
      orders: operational.counts.orders,
      customers: operational.counts.customers,
    },
    rawStoredCounts: {
      products: operational.counts.products,
      orders: operational.counts.orders,
      customers: operational.counts.customers,
    },
    processedCounts: {
      pricingRows: operational.counts.pricingRows,
      profitRows: operational.counts.profitRows,
      timelineEvents: operational.counts.timelineEvents,
      competitorRows: operational.counts.competitorRows,
    },
    processedOutputCounts: {
      pricingRows: operational.counts.pricingRows,
      profitRows: operational.counts.profitRows,
      timelineEvents: operational.counts.timelineEvents,
      competitorRows: operational.counts.competitorRows,
    },
    lastSuccessfulPullTimestamps: {
      sync: operational.store.lastSyncAt?.toISOString() ?? null,
      competitor: operational.latestCompetitorAt?.toISOString() ?? null,
    },
    lastProcessingTimestamp: operational.latestProcessingAt?.toISOString() ?? null,
    blockingErrors: {
      connection: operational.store.lastConnectionError ?? null,
      latestSyncJob: operational.latestSyncJob?.errorMessage ?? null,
      latestCompetitorJob: operational.latestCompetitorIngestJob?.errorMessage ?? null,
    },
  });
}

shopifyRouter.get("/internal/debug/sync-health", handleSyncHealth);
shopifyRouter.get("/sync-health", handleSyncHealth);

async function handleBillingHealth(req: Request, res: Response) {
  const request = req as ShopifyRequest;
  const shop = resolveShopFromRequest(request);

  if (!shop) {
    return res.status(400).json({
      error: {
        code: "MISSING_SHOP",
        message: "Missing shop.",
      },
    });
  }

  const [subscription, billingState, billingManagement] = await Promise.all([
    getCurrentSubscription(shop),
    resolveBillingState(shop),
    getBillingManagementState(shop),
  ]);

  return res.json({
    shop,
    lifecycle: billingState.lifecycle,
    dbPlan: billingState.dbPlanName,
    dbBillingStatus: billingState.dbBillingStatus,
    activeSubscriptionId: billingState.shopifyChargeId,
    activeSubscriptionEndsAt: billingState.endsAt,
    lastBillingWebhookProcessedAt: billingState.lastBillingWebhookProcessedAt,
    lastBillingSyncAt: billingState.lastBillingSyncAt,
    billingResolutionSource: billingState.lastBillingResolutionSource,
    planSource: billingState.planSource,
    effectivePlanUsedByFeatureGating: subscription.planName,
    effectiveBillingStatus: billingState.lifecycle,
    accessActive: billingState.accessActive,
    verified: billingState.verified,
    merchantTitle: billingState.merchantTitle,
    merchantDescription: billingState.merchantDescription,
    renewalAt: billingState.renewalAt,
    trialEndsAt: billingState.showTrialDate ? subscription.trialEndsAt : null,
    pendingIntent: billingManagement.pendingIntent,
    mismatchWarnings: billingState.mismatchWarnings,
  });
}

shopifyRouter.get("/internal/debug/billing-health", handleBillingHealth);
shopifyRouter.get("/billing-health", handleBillingHealth);

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
  const summary =
    result?.summaryJson
      ? (() => {
          try {
            return JSON.parse(result.summaryJson);
          } catch {
            return null;
          }
        })()
      : null;
  return res.json({
    result: result
      ? {
          ...result,
          summary,
        }
      : null,
  });
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

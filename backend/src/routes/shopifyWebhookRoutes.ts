import crypto from "crypto";
import { Router } from "express";
import { env } from "../config/env";
import { prisma } from "../db/prismaClient";
import { logEvent, withRetry } from "../services/observabilityService";
import {
  exportCustomerDataRequest,
  redactCustomerData,
  redactShopData,
} from "../services/privacyService";
import { reconcileStoreSubscriptionFromWebhook } from "../services/subscriptionService";
import { runStoreSyncJob, type SyncTriggerSource } from "../services/syncJobService";

export const shopifyWebhookRouter = Router();

function verifyWebhookSignature(rawBody: Buffer, hmacHeader?: string | string[]) {
  if (!hmacHeader || typeof hmacHeader !== "string") {
    return false;
  }

  const digest = crypto
    .createHmac("sha256", env.shopifyApiSecret)
    .update(rawBody)
    .digest("base64");

  const provided = Buffer.from(hmacHeader);
  const generated = Buffer.from(digest);

  if (provided.length !== generated.length) {
    return false;
  }

  return crypto.timingSafeEqual(provided, generated);
}

async function handleSyncWebhook(req: any, res: any) {
  const rawBody = req.body as Buffer;
  const shopDomain = req.headers["x-shopify-shop-domain"];
  const hmacHeader = req.headers["x-shopify-hmac-sha256"];

  if (!Buffer.isBuffer(rawBody) || !verifyWebhookSignature(rawBody, hmacHeader)) {
    return res.status(401).send("Invalid webhook signature");
  }

  if (!shopDomain || typeof shopDomain !== "string") {
    return res.status(400).send("Missing shop domain");
  }

  // Acknowledge immediately — Shopify counts any non-200 as a failure and retries.
  // Process the sync job asynchronously so errors don't surface as 5xx to Shopify.
  res.status(200).send("ok");

  logEvent("info", "webhook.sync_received", {
    topic: req.path,
    shop: shopDomain,
  });

  const triggerSource = req.path.replace("/", "") as SyncTriggerSource;

  void withRetry(() => runStoreSyncJob(shopDomain, triggerSource), {
    attempts: 3,
    delayMs: 300,
    operationName: "webhook.shopify_sync",
    context: {
      topic: req.path,
      shop: shopDomain,
    },
  }).catch((error) => {
    logEvent("error", "webhook.sync_job_failed", {
      topic: req.path,
      shop: shopDomain,
      error,
    });
  });
}

async function handleWebhookEnvelope(req: any, res: any) {
  const rawBody = req.body as Buffer;
  const shopDomain = req.headers["x-shopify-shop-domain"];
  const hmacHeader = req.headers["x-shopify-hmac-sha256"];

  if (!Buffer.isBuffer(rawBody) || !verifyWebhookSignature(rawBody, hmacHeader)) {
    return res.status(401).send("Invalid webhook signature");
  }

  if (!shopDomain || typeof shopDomain !== "string") {
    return res.status(400).send("Missing shop domain");
  }

  return {
    rawBody,
    shopDomain,
    payload: JSON.parse(rawBody.toString("utf8")),
  };
}

async function handleAppUninstalled(req: any, res: any) {
  const envelope = await handleWebhookEnvelope(req, res);
  if (!envelope || "status" in envelope) {
    return envelope;
  }

  const store = await prisma.store.findUnique({
    where: { shop: envelope.shopDomain },
    include: { subscription: true },
  });

  if (!store) {
    return res.status(200).send("ok");
  }

  // Shopify sends an X-Shopify-Triggered-At header with the ISO timestamp of
  // when the event actually occurred. If the store was reauthorized (reinstalled)
  // AFTER the webhook event was created, this is a delayed webhook from a
  // previous uninstall arriving after the fresh reinstall completed — skip it
  // to prevent overwriting the fresh installation record.
  const triggeredAtRaw = req.headers["x-shopify-triggered-at"];
  const webhookTriggeredAt =
    typeof triggeredAtRaw === "string" && triggeredAtRaw
      ? new Date(triggeredAtRaw)
      : null;

  const reinstallAfterThisEvent =
    webhookTriggeredAt &&
    store.reauthorizedAt &&
    store.reauthorizedAt > webhookTriggeredAt;

  if (reinstallAfterThisEvent) {
    logEvent("info", "webhook.app_uninstalled.skipped_reinstalled", {
      shop: envelope.shopDomain,
      reauthorizedAt: store.reauthorizedAt?.toISOString() ?? null,
      webhookTriggeredAt: webhookTriggeredAt.toISOString(),
    });
    return res.status(200).send("ok");
  }

  await prisma.$transaction(async (tx) => {
    if (store.subscription) {
      await tx.storeSubscription.update({
        where: { id: store.subscription.id },
        data: {
          active: false,
          billingStatus: "UNINSTALLED",
          cancelledAt: new Date(),
          lastBillingWebhookProcessedAt: new Date(),
          lastBillingResolutionSource: "webhook_app_uninstalled",
          lastBillingSubscriptionName: null,
        } as any,
      });
    }

    // Cancel any pending billing intents so they don't surface as stale
    // "awaiting approval" state on reinstall.
    await tx.billingPlanIntent.updateMany({
      where: {
        storeId: store.id,
        status: { in: ["CREATING", "PENDING_APPROVAL"] },
      },
      data: {
        status: "CANCELLED",
        cancelledAt: new Date(),
        errorCode: "APP_UNINSTALLED",
        errorMessage: "Cancelled because the app was uninstalled.",
      },
    });

    await tx.store.update({
      where: { id: store.id },
      data: {
        accessToken: null,
        refreshToken: null,
        accessTokenExpiresAt: null,
        refreshTokenExpiresAt: null,
        uninstalledAt: new Date(),
        webhooksRegisteredAt: null,
        lastWebhookRegistrationStatus: "UNINSTALLED",
        lastSyncStatus: "UNINSTALLED",
        lastConnectionCheckAt: new Date(),
        lastConnectionStatus: "UNINSTALLED",
        lastConnectionError: "Shopify app uninstall webhook received.",
        authErrorCode: "UNINSTALLED",
        authErrorMessage: "Shopify app uninstall webhook received.",
        onboardingCompletedAt: null,
        onboardingDismissedAt: null,
        onboardingPlanConfirmedAt: null,
        onboardingFirstInsightViewedAt: null,
        onboardingSelectedModule: null,
      },
    });
  });

  logEvent("info", "webhook.app_uninstalled", {
    shop: envelope.shopDomain,
  });

  return res.status(200).send("ok");
}

async function handleCustomersDataRequest(req: any, res: any) {
  const envelope = await handleWebhookEnvelope(req, res);
  if (!envelope || "status" in envelope) {
    return envelope;
  }

  try {
    const result = await exportCustomerDataRequest(
      envelope.shopDomain,
      envelope.payload
    );

    return res.status(200).json({
      ok: true,
      shop: envelope.shopDomain,
      ...result,
    });
  } catch (error) {
    // Always return 200 to Shopify — retrying a data export is harmless but a
    // 5xx causes Shopify to flag the compliance endpoint as unhealthy.
    logEvent("error", "webhook.customers_data_request_failed", {
      shop: envelope.shopDomain,
      error,
    });
    return res.status(200).json({ ok: false, shop: envelope.shopDomain });
  }
}

async function handleCustomersRedact(req: any, res: any) {
  const envelope = await handleWebhookEnvelope(req, res);
  if (!envelope || "status" in envelope) {
    return envelope;
  }

  try {
    const result = await redactCustomerData(envelope.shopDomain, envelope.payload);

    return res.status(200).json({
      ok: true,
      shop: envelope.shopDomain,
      ...result,
    });
  } catch (error) {
    logEvent("error", "webhook.customers_redact_failed", {
      shop: envelope.shopDomain,
      error,
    });
    return res.status(200).json({ ok: false, shop: envelope.shopDomain });
  }
}

async function handleShopRedact(req: any, res: any) {
  const envelope = await handleWebhookEnvelope(req, res);
  if (!envelope || "status" in envelope) {
    return envelope;
  }

  try {
    const result = await redactShopData(envelope.shopDomain);

    return res.status(200).json({
      ok: true,
      ...result,
    });
  } catch (error) {
    logEvent("error", "webhook.shop_redact_failed", {
      shop: envelope.shopDomain,
      error,
    });
    return res.status(200).json({ ok: false, shop: envelope.shopDomain });
  }
}

async function handleAppSubscriptionUpdate(req: any, res: any) {
  const envelope = await handleWebhookEnvelope(req, res);
  if (!envelope || "status" in envelope) {
    return envelope;
  }

  const payload = envelope.payload as {
    admin_graphql_api_id?: string;
    name?: string;
    status?: string;
    current_period_end?: string;
    currentPeriodEnd?: string;
  };

  await reconcileStoreSubscriptionFromWebhook({
    shopDomain: envelope.shopDomain,
    shopifyChargeId: payload.admin_graphql_api_id ?? null,
    planName: payload.name ?? null,
    status: payload.status ?? null,
    currentPeriodEnd: payload.current_period_end ?? payload.currentPeriodEnd ?? null,
  });

  logEvent("info", "webhook.app_subscription_updated", {
    shop: envelope.shopDomain,
    route: req.path,
    processedAt: new Date().toISOString(),
    subscriptionId: payload.admin_graphql_api_id ?? null,
    status: payload.status ?? null,
    planName: payload.name ?? null,
  });

  return res.status(200).send("ok");
}

shopifyWebhookRouter.post("/orders_create", handleSyncWebhook);
shopifyWebhookRouter.post("/orders_updated", handleSyncWebhook);
shopifyWebhookRouter.post("/customers_create", handleSyncWebhook);
shopifyWebhookRouter.post("/customers_update", handleSyncWebhook);
shopifyWebhookRouter.post("/app_subscriptions_update", handleAppSubscriptionUpdate);
shopifyWebhookRouter.post("/app_uninstalled", handleAppUninstalled);
shopifyWebhookRouter.post("/customers_data_request", handleCustomersDataRequest);
shopifyWebhookRouter.post("/customers_redact", handleCustomersRedact);
shopifyWebhookRouter.post("/shop_redact", handleShopRedact);

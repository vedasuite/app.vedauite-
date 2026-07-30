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

  // A malformed body should not become a 5xx. The HMAC already passed, so this
  // is not an attack path, but retrying unparseable JSON can never succeed —
  // acknowledge it and log instead of failing the delivery.
  try {
    return {
      rawBody,
      shopDomain,
      payload: JSON.parse(rawBody.toString("utf8")),
    };
  } catch (error) {
    logEvent("error", "webhook.payload_parse_failed", {
      shop: shopDomain,
      topic: req.path,
      error,
    });
    return res.status(200).send("ok");
  }
}

async function handleAppUninstalled(req: any, res: any) {
  const envelope = await handleWebhookEnvelope(req, res);
  if (!envelope || "status" in envelope) {
    return envelope;
  }

  // Acknowledge before doing any database work. Shopify counts every non-200 as
  // a delivery failure, and a transient DB error here would otherwise surface as
  // a 5xx and inflate the app's webhook failure rate. The processing below is
  // retried internally instead.
  const triggeredAtRaw = req.headers["x-shopify-triggered-at"];
  res.status(200).send("ok");

  void withRetry(
    () => processAppUninstalled(envelope.shopDomain, triggeredAtRaw),
    {
      attempts: 3,
      delayMs: 500,
      operationName: "webhook.app_uninstalled",
      context: { shop: envelope.shopDomain },
    }
  ).catch((error) => {
    logEvent("error", "webhook.app_uninstalled_failed", {
      shop: envelope.shopDomain,
      error,
    });
  });
}

async function processAppUninstalled(
  shopDomain: string,
  triggeredAtRaw: unknown
) {
  const store = await prisma.store.findUnique({
    where: { shop: shopDomain },
    include: { subscription: true },
  });

  if (!store) {
    return;
  }

  // Delayed-webhook guard: skip this uninstall if we can confirm a reinstall
  // completed AFTER the event that triggered this webhook.
  //
  // Primary: Shopify sends X-Shopify-Triggered-At (ISO timestamp of when the
  // event occurred). Compare against reauthorizedAt (set on every OAuth callback).
  // Fallback: if the header is absent, check whether the store already has a
  // fresh access token — that only happens after a successful reinstall OAuth.
  // If the token is present AND reauthorizedAt is very recent (< 5 min) we treat
  // this as a race where the reinstall beat the webhook delivery.
  const webhookTriggeredAt =
    typeof triggeredAtRaw === "string" && triggeredAtRaw
      ? new Date(triggeredAtRaw)
      : null;

  logEvent("info", "webhook.app_uninstalled.guard_check", {
    shop: shopDomain,
    hasTriggeredAtHeader: !!webhookTriggeredAt,
    webhookTriggeredAt: webhookTriggeredAt?.toISOString() ?? null,
    storeReauthorizedAt: store.reauthorizedAt?.toISOString() ?? null,
    hasAccessToken: !!store.accessToken,
  });

  // Primary guard: event timestamp vs last reinstall time
  const reinstallAfterEventTimestamp =
    webhookTriggeredAt !== null &&
    store.reauthorizedAt !== null &&
    store.reauthorizedAt > webhookTriggeredAt;

  // Fallback guard (no event timestamp): if the store has a token AND was
  // reauthorized within the last 5 minutes, a reinstall just completed and
  // this webhook is from the previous uninstall cycle.
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
  const reinstallJustCompletedFallback =
    webhookTriggeredAt === null &&
    !!store.accessToken &&
    store.reauthorizedAt !== null &&
    store.reauthorizedAt > fiveMinutesAgo;

  if (reinstallAfterEventTimestamp || reinstallJustCompletedFallback) {
    logEvent("info", "webhook.app_uninstalled.skipped_reinstalled", {
      shop: shopDomain,
      reason: reinstallAfterEventTimestamp ? "event_timestamp" : "fallback_recent_reauth",
      reauthorizedAt: store.reauthorizedAt?.toISOString() ?? null,
      webhookTriggeredAt: webhookTriggeredAt?.toISOString() ?? null,
    });
    return;
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
    shop: shopDomain,
  });
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

    // Success, including "unknown shop" and "customer not found" — those are
    // normal returns, not thrown errors, so they land here as 200.
    return res.status(200).json({
      ok: true,
      shop: envelope.shopDomain,
      ...result,
    });
  } catch (error) {
    // A thrown error is now a genuine failure (DB error, filesystem error).
    // Report it honestly with 500 so a real, persistent problem surfaces rather
    // than hiding behind an unconditional 200. Shopify retries on 5xx.
    logEvent("error", "webhook.customers_data_request_failed", {
      shop: envelope.shopDomain,
      error,
    });
    return res.status(500).json({ ok: false, shop: envelope.shopDomain });
  }
}

async function handleCustomersRedact(req: any, res: any) {
  const envelope = await handleWebhookEnvelope(req, res);
  if (!envelope || "status" in envelope) {
    return envelope;
  }

  try {
    const result = await redactCustomerData(envelope.shopDomain, envelope.payload);

    // Success, including unknown-shop / customer-not-found / missing-id — all
    // normal returns. There is nothing to erase in those cases, which is not a
    // failure.
    return res.status(200).json({
      ok: true,
      shop: envelope.shopDomain,
      ...result,
    });
  } catch (error) {
    // Genuine failure (DB error mid-transaction). Honest 500 so it is not
    // silently retried-into-nowhere; Shopify redelivers on 5xx.
    logEvent("error", "webhook.customers_redact_failed", {
      shop: envelope.shopDomain,
      error,
    });
    return res.status(500).json({ ok: false, shop: envelope.shopDomain });
  }
}

async function handleShopRedact(req: any, res: any) {
  const envelope = await handleWebhookEnvelope(req, res);
  if (!envelope || "status" in envelope) {
    return envelope;
  }

  try {
    const result = await redactShopData(envelope.shopDomain);

    // All three non-throwing outcomes are success:
    //   deleted                -> data erased
    //   not_found              -> unknown shop, or already erased on a retry
    //   skipped_active_install -> shop reinstalled; must not erase a live store
    // None is an error, so all return 200.
    return res.status(200).json({
      ok: true,
      shop: envelope.shopDomain,
      ...result,
    });
  } catch (error) {
    // A throw is a genuine failure — a DB error during the delete. This is the
    // case that was silently returning 200 and hiding the fact that redaction
    // never happened. Report it honestly with 500; Shopify retries on 5xx.
    logEvent("error", "webhook.shop_redact_failed", {
      shop: envelope.shopDomain,
      error,
    });
    return res.status(500).json({ ok: false, shop: envelope.shopDomain });
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

  // Acknowledge before reconciling. A transient DB failure while reconciling a
  // plan change would otherwise return 5xx and count against the app's webhook
  // failure rate; the retry below handles it instead.
  res.status(200).send("ok");

  void withRetry(
    () =>
      reconcileStoreSubscriptionFromWebhook({
        shopDomain: envelope.shopDomain,
        shopifyChargeId: payload.admin_graphql_api_id ?? null,
        planName: payload.name ?? null,
        status: payload.status ?? null,
        currentPeriodEnd:
          payload.current_period_end ?? payload.currentPeriodEnd ?? null,
      }),
    {
      attempts: 3,
      delayMs: 500,
      operationName: "webhook.app_subscription_updated",
      context: { shop: envelope.shopDomain },
    }
  )
    .then(() => {
      logEvent("info", "webhook.app_subscription_updated", {
        shop: envelope.shopDomain,
        route: req.path,
        processedAt: new Date().toISOString(),
        subscriptionId: payload.admin_graphql_api_id ?? null,
        status: payload.status ?? null,
        planName: payload.name ?? null,
      });
    })
    .catch((error) => {
      logEvent("error", "webhook.app_subscription_updated_failed", {
        shop: envelope.shopDomain,
        subscriptionId: payload.admin_graphql_api_id ?? null,
        error,
      });
    });
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

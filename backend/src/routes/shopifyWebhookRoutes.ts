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

  logEvent("info", "webhook.sync_received", {
    topic: req.path,
    shop: shopDomain,
  });

  const triggerSource = req.path.replace("/", "") as SyncTriggerSource;

  await withRetry(() => runStoreSyncJob(shopDomain, triggerSource), {
    attempts: 3,
    delayMs: 300,
    operationName: "webhook.shopify_sync",
    context: {
      topic: req.path,
      shop: shopDomain,
    },
  });
  return res.status(200).send("ok");
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

  await prisma.$transaction(async (tx) => {
    if (store.subscription) {
      await tx.storeSubscription.delete({
        where: { id: store.subscription.id },
      });
    }

    await tx.fraudSignal.deleteMany({ where: { storeId: store.id } });
    await tx.order.deleteMany({ where: { storeId: store.id } });
    await tx.customer.deleteMany({ where: { storeId: store.id } });
    await tx.competitorData.deleteMany({ where: { storeId: store.id } });
    await tx.competitorDomain.deleteMany({ where: { storeId: store.id } });
    await tx.priceHistory.deleteMany({ where: { storeId: store.id } });
    await tx.profitOptimizationData.deleteMany({ where: { storeId: store.id } });
    await tx.store.delete({ where: { id: store.id } });
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

  const result = await exportCustomerDataRequest(
    envelope.shopDomain,
    envelope.payload
  );

  return res.status(200).json({
    ok: true,
    shop: envelope.shopDomain,
    ...result,
  });
}

async function handleCustomersRedact(req: any, res: any) {
  const envelope = await handleWebhookEnvelope(req, res);
  if (!envelope || "status" in envelope) {
    return envelope;
  }

  const result = await redactCustomerData(envelope.shopDomain, envelope.payload);

  return res.status(200).json({
    ok: true,
    shop: envelope.shopDomain,
    ...result,
  });
}

async function handleShopRedact(req: any, res: any) {
  const envelope = await handleWebhookEnvelope(req, res);
  if (!envelope || "status" in envelope) {
    return envelope;
  }

  const result = await redactShopData(envelope.shopDomain);

  return res.status(200).json({
    ok: true,
    ...result,
  });
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

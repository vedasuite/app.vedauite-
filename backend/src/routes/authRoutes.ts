import { Response, Router } from "express";
import qs from "qs";
import crypto from "crypto";
import axios from "axios";
import { env } from "../config/env";
import { prisma } from "../db/prismaClient";
import {
  clearShopifyOAuthStateCookie,
  createShopifyOAuthState,
  readShopifyOAuthStateCookie,
  setShopifyOAuthStateCookie,
} from "../lib/shopifyOAuthState";
import { setShopifySessionCookie } from "../lib/shopifySessionCookie";
import { ensureStoreBootstrapped } from "../services/bootstrapService";
import { normalizeShopDomain } from "../services/shopifyConnectionService";
import { registerSyncWebhooks } from "../services/shopifyAdminService";
import { runStoreSyncJob } from "../services/syncJobService";

export const authRouter = Router();

function redirectTopLevel(res: Response, url: string) {
  return res
    .status(200)
    .type("html")
    .send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Redirecting…</title>
  </head>
  <body>
    <script>
      (function () {
        var target = ${JSON.stringify(url)};
        if (window.top && window.top !== window) {
          window.top.location.href = target;
          return;
        }
        window.location.href = target;
      })();
    </script>
    <p>Redirecting… <a href="${url}">Continue</a></p>
  </body>
</html>`);
}

function buildInstallUrl(shop: string, state: string) {
  const params = qs.stringify({
    client_id: env.shopifyApiKey,
    scope: env.shopifyScopes,
    redirect_uri: `${env.shopifyAppUrl}/auth/callback`,
    state,
  });
  return `https://${shop}/admin/oauth/authorize?${params}`;
}

authRouter.get("/install", (req, res) => {
  const normalizedShop = normalizeShopDomain(
    typeof req.query.shop === "string" ? req.query.shop : undefined
  );

  if (!normalizedShop) {
    return res.status(400).send("Missing shop parameter.");
  }
  const state = createShopifyOAuthState();
  setShopifyOAuthStateCookie(res, normalizedShop, state);
  const redirectUrl = buildInstallUrl(normalizedShop, state);
  return redirectTopLevel(res, redirectUrl);
});

authRouter.get("/callback", async (req, res) => {
  const { code, hmac, state } = req.query;
  const shop = normalizeShopDomain(
    typeof req.query.shop === "string" ? req.query.shop : undefined
  );

  if (!shop || typeof code !== "string" || typeof hmac !== "string") {
    return res.status(400).send("Missing OAuth parameters.");
  }

  const message = qs.stringify(
    Object.fromEntries(
      Object.entries(req.query).filter(
        ([key]) => key !== "hmac" && key !== "signature"
      )
    )
  );

  const generatedHmac = crypto
    .createHmac("sha256", env.shopifyApiSecret)
    .update(message)
    .digest("hex");

  if (generatedHmac !== hmac) {
    return res.status(400).send("HMAC validation failed.");
  }

  const expectedState = readShopifyOAuthStateCookie(req);
  if (
    !state ||
    typeof state !== "string" ||
    !expectedState ||
    expectedState.shop !== shop ||
    expectedState.state !== state
  ) {
    return res.status(400).send("OAuth state validation failed.");
  }

  clearShopifyOAuthStateCookie(res);

  const tokenUrl = `https://${shop}/admin/oauth/access_token`;

  const tokenResponse = await axios.post(tokenUrl, {
    client_id: env.shopifyApiKey,
    client_secret: env.shopifyApiSecret,
    code,
  });

  const accessToken = tokenResponse.data.access_token as string;
  const grantedScope = tokenResponse.data.scope as string | undefined;

  const shopDomain = shop;
  const trialStartedAt = new Date();
  const trialEndsAt = new Date(trialStartedAt);
  trialEndsAt.setDate(trialEndsAt.getDate() + env.billing.trialDays);
  const existingStore = await prisma.store.findUnique({
    where: { shop: shopDomain },
    select: {
      installedAt: true,
      trialStartedAt: true,
      trialEndsAt: true,
    },
  });

  await prisma.store.upsert({
    where: { shop: shopDomain },
    create: {
      shop: shopDomain,
      accessToken,
      scope: grantedScope ?? env.shopifyScopes,
      isOffline: true,
      installedAt: trialStartedAt,
      lastConnectionCheckAt: trialStartedAt,
      lastConnectionStatus: "OK",
      lastConnectionError: null,
      syncStatus: "PENDING",
      trialStartedAt,
      trialEndsAt,
    },
    update: {
      accessToken,
      scope: grantedScope ?? env.shopifyScopes,
      isOffline: true,
      installedAt: existingStore?.installedAt ?? trialStartedAt,
      trialStartedAt: existingStore?.trialStartedAt ?? trialStartedAt,
      trialEndsAt: existingStore?.trialEndsAt ?? trialEndsAt,
      uninstalledAt: null,
      lastConnectionCheckAt: new Date(),
      lastConnectionStatus: "OK",
      lastConnectionError: null,
    },
  });

  setShopifySessionCookie(res, shopDomain);

  await ensureStoreBootstrapped(shopDomain);

  try {
    await registerSyncWebhooks(shopDomain, env.shopifyAppUrl);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn("[auth] Unable to auto-register Shopify sync webhooks.", error);
  }

  void runStoreSyncJob(shopDomain, "auth_install").catch((error) => {
    console.warn("[auth] Unable to perform initial Shopify sync.", error);
  });

  // After installation, redirect into the embedded app in Shopify Admin.
  const storeHandle = shopDomain.replace(".myshopify.com", "");
  const adminAppUrl = `https://admin.shopify.com/store/${encodeURIComponent(
    storeHandle
  )}/apps/${encodeURIComponent(env.shopifyApiKey)}`;

  return redirectTopLevel(res, adminAppUrl);
});


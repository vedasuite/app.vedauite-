import { type Request, type Response, Router } from "express";
import axios from "axios";
import crypto from "crypto";
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
import { logEvent } from "../services/observabilityService";
import { registerSyncWebhooks } from "../services/shopifyAdminService";
import {
  normalizeShopDomain,
  updateConnectionDiagnostics,
} from "../services/shopifyConnectionService";
import { runStoreSyncJob } from "../services/syncJobService";

export const authRouter = Router();

type OAuthAccessTokenResponse = {
  access_token: string;
  scope?: string;
  expires_in?: number;
  associated_user_scope?: string;
  refresh_token?: string;
  refresh_token_expires_in?: number;
};

type TokenAcquisitionMode = "offline_expiring" | "offline_legacy";

function redirectTopLevel(res: Response, url: string) {
  return res
    .status(200)
    .type("html")
    .send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Redirecting...</title>
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
    <p>Redirecting... <a href="${url}">Continue</a></p>
  </body>
</html>`);
}

function normalizeReturnPath(returnTo?: string | null) {
  if (!returnTo || typeof returnTo !== "string") {
    return "/";
  }

  if (!returnTo.startsWith("/")) {
    return "/";
  }

  if (returnTo.startsWith("//")) {
    return "/";
  }

  return returnTo;
}

function buildInstallUrl(shop: string, state: string) {
  const params = new URLSearchParams({
    client_id: env.shopifyApiKey,
    scope: env.shopifyScopes,
    redirect_uri: `${env.shopifyAppUrl}/auth/callback`,
    state,
  });

  return `https://${shop}/admin/oauth/authorize?${params.toString()}`;
}

function buildEmbeddedReturnUrl(options: {
  shop: string;
  host?: string | null;
  returnTo?: string | null;
}) {
  const returnTo = normalizeReturnPath(options.returnTo);
  const url = new URL(returnTo, env.shopifyAppUrl);
  url.searchParams.set("shop", options.shop);
  if (options.host) {
    url.searchParams.set("host", options.host);
  }
  url.searchParams.set("embedded", "1");
  return url.toString();
}

function safeEquals(left: string, right: string) {
  const provided = Buffer.from(left);
  const expected = Buffer.from(right);
  if (provided.length !== expected.length) {
    return false;
  }

  return crypto.timingSafeEqual(provided, expected);
}

function validateOAuthHmac(query: Record<string, unknown>, hmac: string) {
  const message = Object.entries(query)
    .filter(([key, value]) => key !== "hmac" && key !== "signature" && value != null)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join(",") : value}`)
    .join("&");

  const digest = crypto
    .createHmac("sha256", env.shopifyApiSecret)
    .update(message)
    .digest("hex");

  return safeEquals(digest, hmac);
}

async function exchangeOfflineAccessToken(shop: string, code: string) {
  const tokenUrl = `https://${shop}/admin/oauth/access_token`;
  const response = await axios.post<OAuthAccessTokenResponse>(tokenUrl, {
    client_id: env.shopifyApiKey,
    client_secret: env.shopifyApiSecret,
    code,
  });

  return response.data;
}

async function persistInstallationRecord(params: {
  shop: string;
  accessToken: string;
  grantedScopes: string;
  installedAt: Date;
  reauthorizedAt: Date;
  accessTokenExpiresAt: Date | null;
  refreshToken: string | null;
  refreshTokenExpiresAt: Date | null;
  tokenAcquisitionMode: TokenAcquisitionMode;
}) {
  const existingStore = await prisma.store.findUnique({
    where: { shop: params.shop },
    select: {
      installedAt: true,
      trialStartedAt: true,
      trialEndsAt: true,
      createdAt: true,
    },
  });

  const trialStartedAt = existingStore?.trialStartedAt ?? params.installedAt;
  const trialEndsAt =
    existingStore?.trialEndsAt ??
    new Date(params.installedAt.getTime() + env.billing.trialDays * 24 * 60 * 60 * 1000);

  return prisma.store.upsert({
    where: { shop: params.shop },
    create: {
      shop: params.shop,
      accessToken: params.accessToken,
      grantedScopes: params.grantedScopes,
      isOffline: true,
      installedAt: params.installedAt,
      reauthorizedAt: params.reauthorizedAt,
      accessTokenExpiresAt: params.accessTokenExpiresAt,
      refreshToken: params.refreshToken,
      refreshTokenExpiresAt: params.refreshTokenExpiresAt,
      tokenAcquisitionMode: params.tokenAcquisitionMode,
      lastConnectionCheckAt: params.reauthorizedAt,
      lastConnectionStatus: "OK",
      lastConnectionError: null,
      authErrorCode: null,
      authErrorMessage: null,
      lastWebhookRegistrationStatus: "PENDING",
      lastSyncStatus: "PENDING",
      uninstalledAt: null,
      trialStartedAt,
      trialEndsAt,
    },
    update: {
      accessToken: params.accessToken,
      grantedScopes: params.grantedScopes,
      isOffline: true,
      installedAt: existingStore?.installedAt ?? params.installedAt,
      reauthorizedAt: params.reauthorizedAt,
      accessTokenExpiresAt: params.accessTokenExpiresAt,
      refreshToken: params.refreshToken,
      refreshTokenExpiresAt: params.refreshTokenExpiresAt,
      tokenAcquisitionMode: params.tokenAcquisitionMode,
      uninstalledAt: null,
      lastConnectionCheckAt: params.reauthorizedAt,
      lastConnectionStatus: "OK",
      lastConnectionError: null,
      authErrorCode: null,
      authErrorMessage: null,
      lastWebhookRegistrationStatus: "PENDING",
      trialStartedAt,
      trialEndsAt,
    },
  });
}

async function finalizeInstallationHealth(shop: string, returnUrl: string) {
  try {
    await registerSyncWebhooks(shop, env.shopifyAppUrl);
  } catch (error) {
    logEvent("warn", "shopify.auth.webhook_registration_failed", {
      shop,
      route: "auth.callback",
      returnUrl,
      error,
    });
  }

  void runStoreSyncJob(shop, "auth_install").catch((error) => {
    logEvent("warn", "shopify.auth.initial_sync_failed", {
      shop,
      route: "auth.callback",
      returnUrl,
      error,
    });
  });
}

function startOAuth(req: Request, res: Response) {
  const normalizedShop = normalizeShopDomain(
    typeof req.query.shop === "string" ? req.query.shop : undefined
  );

  if (!normalizedShop) {
    return res.status(400).send("Missing or invalid shop parameter.");
  }

  const state = createShopifyOAuthState();
  const host =
    typeof req.query.host === "string" && req.query.host.trim()
      ? req.query.host
      : null;
  const returnTo = normalizeReturnPath(
    typeof req.query.returnTo === "string" ? req.query.returnTo : "/"
  );

  setShopifyOAuthStateCookie(res, {
    shop: normalizedShop,
    state,
    host,
    returnTo,
  });

  logEvent("info", "shopify.auth.start", {
    shop: normalizedShop,
    route: "auth.install",
    host,
    returnTo,
  });

  return redirectTopLevel(res, buildInstallUrl(normalizedShop, state));
}

authRouter.get("/install", (req, res) => startOAuth(req, res));
authRouter.get("/reconnect", (req, res) => startOAuth(req, res));

authRouter.get("/callback", async (req, res) => {
  const shop = normalizeShopDomain(
    typeof req.query.shop === "string" ? req.query.shop : undefined
  );
  const code = typeof req.query.code === "string" ? req.query.code : undefined;
  const hmac = typeof req.query.hmac === "string" ? req.query.hmac : undefined;
  const state = typeof req.query.state === "string" ? req.query.state : undefined;

  if (!shop || !code || !hmac || !state) {
    return res.status(400).send("Missing OAuth parameters.");
  }

  if (!validateOAuthHmac(req.query, hmac)) {
    logEvent("warn", "shopify.auth.callback_invalid_hmac", {
      shop,
      route: "auth.callback",
    });
    return res.status(400).send("HMAC validation failed.");
  }

  const statePayload = readShopifyOAuthStateCookie(req);
  if (
    !statePayload ||
    statePayload.shop !== shop ||
    statePayload.state !== state
  ) {
    logEvent("warn", "shopify.auth.callback_invalid_state", {
      shop,
      route: "auth.callback",
      cookieShop: statePayload?.shop ?? null,
    });
    return res.status(400).send("OAuth state validation failed.");
  }

  clearShopifyOAuthStateCookie(res);

  try {
    const tokenData = await exchangeOfflineAccessToken(shop, code);
    const now = new Date();
    const accessTokenExpiresAt =
      typeof tokenData.expires_in === "number"
        ? new Date(now.getTime() + tokenData.expires_in * 1000)
        : null;
    const refreshTokenExpiresAt =
      typeof tokenData.refresh_token_expires_in === "number"
        ? new Date(now.getTime() + tokenData.refresh_token_expires_in * 1000)
        : null;
    const tokenAcquisitionMode: TokenAcquisitionMode = tokenData.refresh_token
      ? "offline_expiring"
      : "offline_legacy";

    await persistInstallationRecord({
      shop,
      accessToken: tokenData.access_token,
      grantedScopes: tokenData.scope ?? env.shopifyScopes,
      installedAt: now,
      reauthorizedAt: now,
      accessTokenExpiresAt,
      refreshToken: tokenData.refresh_token ?? null,
      refreshTokenExpiresAt,
      tokenAcquisitionMode,
    });

    setShopifySessionCookie(res, shop);

    if (env.enableDemoBootstrap) {
      await ensureStoreBootstrapped(shop);
    }

    const returnUrl = buildEmbeddedReturnUrl({
      shop,
      host: statePayload.host,
      returnTo: statePayload.returnTo,
    });

    await updateConnectionDiagnostics(shop, {
      lastConnectionStatus: "OK",
      authErrorCode: null,
      authErrorMessage: null,
    });

    await finalizeInstallationHealth(shop, returnUrl);

    logEvent("info", "shopify.auth.callback_completed", {
      shop,
      route: "auth.callback",
      host: statePayload.host ?? null,
      returnTo: statePayload.returnTo ?? "/",
      grantedScopes: tokenData.scope ?? env.shopifyScopes,
      hasRefreshToken: !!tokenData.refresh_token,
      tokenAcquisitionMode,
      accessTokenExpiresAt: accessTokenExpiresAt?.toISOString() ?? null,
    });

    return redirectTopLevel(res, returnUrl);
  } catch (error) {
    await prisma.store.upsert({
      where: { shop },
      create: {
        shop,
        isOffline: true,
        installedAt: new Date(),
        authErrorCode: "SHOPIFY_AUTH_REQUIRED",
        authErrorMessage:
          error instanceof Error ? error.message : "Shopify OAuth exchange failed.",
        lastConnectionStatus: "SHOPIFY_AUTH_REQUIRED",
        lastConnectionError:
          error instanceof Error ? error.message : "Shopify OAuth exchange failed.",
      },
      update: {
        authErrorCode: "SHOPIFY_AUTH_REQUIRED",
        authErrorMessage:
          error instanceof Error ? error.message : "Shopify OAuth exchange failed.",
        lastConnectionStatus: "SHOPIFY_AUTH_REQUIRED",
        lastConnectionError:
          error instanceof Error ? error.message : "Shopify OAuth exchange failed.",
      },
    });

    logEvent("error", "shopify.auth.callback_failed", {
      shop,
      route: "auth.callback",
      error,
    });

    return res.status(500).send("Unable to complete Shopify authorization.");
  }
});

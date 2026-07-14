import { type Request, type Response, Router } from "express";
import axios from "axios";
import crypto from "crypto";
import { env } from "../config/env";
import { prisma } from "../db/prismaClient";
import {
  createShopifyOAuthState,
  verifyShopifyOAuthState,
} from "../lib/shopifyOAuthState";
import type { OAuthStateResult } from "../lib/shopifyOAuthState";
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

// Escaping an iframe with script (window.top.location = url) is blocked by
// Chrome's (and other browsers') popup/redirect protections when it isn't
// tied to a direct user click — this is stricter in Incognito and can leave
// the merchant on a blank page with no way forward. A real <a target="_top">
// click is never blocked by any browser, so it's the primary mechanism here,
// not a hidden fallback. We still attempt an automatic redirect for the
// common case where it isn't blocked, but the visible button is what
// guarantees this page never dead-ends.
function redirectTopLevel(res: Response, url: string, shop?: string) {
  const safeUrl = JSON.stringify(url);
  const escapeUrl = shop ? `https://${shop}/admin` : null;
  return res
    .status(200)
    .type("html")
    .send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Continue to VedaSuite</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #f6f6f7; }
      .card { text-align: center; }
      .btn { display: inline-block; margin-top: 16px; padding: 10px 24px; background: #000; color: #fff; text-decoration: none; border-radius: 6px; font-weight: 600; }
      .escape { display: block; margin-top: 14px; color: #6d7175; font-size: 13px; text-decoration: underline; }
    </style>
  </head>
  <body>
    <div class="card">
      <p>Continuing to VedaSuite...</p>
      <a class="btn" id="continue-link" href="${url}" target="_top" rel="noopener">Continue</a>
      ${escapeUrl ? `<a class="escape" href="${escapeUrl}" target="_top" rel="noopener">Return to Shopify admin instead</a>` : ""}
    </div>
    <script>
      (function () {
        var target = ${safeUrl};
        try {
          var destination = window.top && window.top !== window ? window.top : window;
          destination.location.replace(target);
        } catch (e) {
          // Cross-origin top navigation was blocked — the visible button
          // above (a real user click) always works as the fallback.
        }
      })();
    </script>
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
  const response = await axios.post<OAuthAccessTokenResponse>(
    tokenUrl,
    {
      client_id: env.shopifyApiKey,
      client_secret: env.shopifyApiSecret,
      code,
    },
    { timeout: 15000 }
  );

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

// Fire-and-forget: webhook registration and the initial sync both call out
// to Shopify's API and can be slow or flaky. Neither should block the
// redirect back to the app UI — a merchant (or reviewer) should never sit
// on a blank page waiting for these to finish. Errors are logged, not
// surfaced, since the app functions correctly even if this hasn't
// completed yet (it self-heals on the next scheduled/triggered sync).
function finalizeInstallationHealth(shop: string, returnUrl: string) {
  void registerSyncWebhooks(shop, env.shopifyAppUrl).catch((error) => {
    logEvent("warn", "shopify.auth.webhook_registration_failed", {
      shop,
      route: "auth.callback",
      returnUrl,
      error,
    });
  });

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

  const host =
    typeof req.query.host === "string" && req.query.host.trim()
      ? req.query.host
      : null;
  const returnTo = normalizeReturnPath(
    typeof req.query.returnTo === "string" ? req.query.returnTo : "/"
  );

  const state = createShopifyOAuthState({
    shop: normalizedShop,
    host,
    returnTo,
  });

  logEvent("info", "shopify.auth.state_issued", {
    shop: normalizedShop,
    route: "auth.install",
    host,
    returnTo,
    stateIssuedAt: new Date().toISOString(),
  });

  return redirectTopLevel(res, buildInstallUrl(normalizedShop, state), normalizedShop);
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

  logEvent("info", "shopify.auth.callback_received", {
    shop: shop ?? "(missing)",
    route: "auth.callback",
    hasCode: !!code,
    hasHmac: !!hmac,
    hasState: !!state,
  });

  if (!shop || !code || !hmac || !state) {
    logEvent("warn", "shopify.auth.callback_missing_params", {
      shop: shop ?? "(missing)",
      route: "auth.callback",
      hasCode: !!code,
      hasHmac: !!hmac,
      hasState: !!state,
    });
    return res.status(400).send("Missing OAuth parameters.");
  }

  const hmacValid = validateOAuthHmac(req.query, hmac);
  logEvent(hmacValid ? "info" : "warn", "shopify.auth.callback_hmac_check", {
    shop,
    route: "auth.callback",
    hmacValid,
  });

  if (!hmacValid) {
    return res.status(400).send("HMAC validation failed.");
  }

  const stateResult: OAuthStateResult = verifyShopifyOAuthState(state, shop);
  logEvent(stateResult.ok ? "info" : "warn", "shopify.auth.callback_state_check", {
    shop,
    route: "auth.callback",
    stateOk: stateResult.ok,
    stateReason: stateResult.ok ? "valid" : stateResult.reason,
  });

  if (!stateResult.ok) {
    if (stateResult.reason === "expired") {
      // State token expired (TTL exceeded). This is not a security issue — the
      // HMAC on the callback was already verified above, so we know the request
      // is genuine. Restart OAuth from the top with a fresh state token so the
      // merchant/reviewer never hits a dead-end. A human reviewer who takes
      // longer than the TTL window between clicking install and approving on
      // Shopify's consent screen would otherwise see a raw 400.
      logEvent("info", "shopify.auth.callback_state_expired_restarting", {
        shop,
        route: "auth.callback",
      });
      const host =
        typeof req.query.host === "string" && req.query.host.trim()
          ? req.query.host
          : null;
      const freshState = createShopifyOAuthState({ shop, host, returnTo: "/" });
      return redirectTopLevel(res, buildInstallUrl(shop, freshState), shop);
    }
    return res.status(400).send("OAuth state validation failed.");
  }

  const statePayload = stateResult.payload;

  try {
    logEvent("info", "shopify.auth.token_exchange_start", { shop, route: "auth.callback" });
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

    if (env.enableGuidedBootstrap) {
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

    finalizeInstallationHealth(shop, returnUrl);

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

    return redirectTopLevel(res, returnUrl, shop);
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

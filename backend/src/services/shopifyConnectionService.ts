import axios from "axios";
import { prisma } from "../db/prismaClient";
import { env } from "../config/env";
import { logEvent } from "./observabilityService";

export type ShopifyConnectionCode =
  | "OK"
  | "MISSING_SHOP"
  | "MISSING_INSTALLATION"
  | "MISSING_OFFLINE_TOKEN"
  | "OFFLINE_TOKEN_EXPIRED"
  | "REFRESH_TOKEN_EXPIRED"
  | "TOKEN_REFRESH_FAILED"
  | "SHOPIFY_RECONNECT_REQUIRED"
  | "UNINSTALLED"
  | "SHOPIFY_AUTH_REQUIRED"
  | "SHOPIFY_API_UNREACHABLE"
  | "WEBHOOK_REGISTRATION_FAILED"
  | "WEBHOOKS_MISSING"
  | "SYNC_FAILED"
  | "INVALID_SHOP"
  | "STALE_CONNECTION";

export type ShopifyConnectionHealth = {
  shop: string | null;
  code: ShopifyConnectionCode;
  healthy: boolean;
  installationFound: boolean;
  hasOfflineToken: boolean;
  webhooksRegistered: boolean;
  webhookCoverageReady: boolean;
  lastWebhookRegistrationStatus: string | null;
  lastSyncStatus: string | null;
  lastSyncAt: string | null;
  lastConnectionCheckAt: string | null;
  lastConnectionStatus: string | null;
  tokenAcquisitionMode: string | null;
  accessTokenExpiresAt: string | null;
  refreshTokenExpiresAt: string | null;
  authErrorCode: string | null;
  authErrorMessage: string | null;
  reauthRequired: boolean;
  message: string;
  reauthorizeUrl?: string;
};

type ReauthorizeContext = {
  host?: string | null;
  returnTo?: string | null;
};

type InstallationRecord = Awaited<ReturnType<typeof getOfflineInstallation>>;

type ConnectionDiagnosticUpdate = {
  lastConnectionStatus?: string | null;
  lastConnectionError?: string | null;
  authErrorCode?: string | null;
  authErrorMessage?: string | null;
  webhooksRegisteredAt?: Date | null;
  lastWebhookRegistrationStatus?: string | null;
  lastSyncAt?: Date | null;
  lastSyncStatus?: string | null;
};

type RefreshAccessTokenResponse = {
  access_token: string;
  scope?: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
};

const SHOP_REGEX = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i;
const ACCESS_TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;

/**
 * Recognizes every response shape Shopify uses to reject a stored Admin API
 * token as invalid or unusable — including the newer enforcement where a
 * non-expiring ("legacy") offline token is rejected outright with 403,
 * distinct from the older 401 "invalid access token" case. Centralized here
 * so every Admin API call site (GraphQL, REST probe) classifies this the
 * same way instead of each guessing its own status/text check.
 *
 * Docs: https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/offline-access-tokens#expiring-vs-non-expiring-offline-tokens
 */
export function isShopifyAuthRejection(status: number, bodyText: string): boolean {
  if (status === 401) {
    return true;
  }
  if (status === 403 && /non-expiring access tokens? (is|are) no longer accepted/i.test(bodyText)) {
    return true;
  }
  return /invalid api key|invalid access token|unrecognized login|wrong password/i.test(
    bodyText
  );
}

function deriveTokenAcquisitionMode(installation: {
  refreshToken?: string | null;
  accessTokenExpiresAt?: Date | null;
  tokenAcquisitionMode?: string | null;
}) {
  // Only treat the token as refreshable when a refresh token is actually present.
  // A token with accessTokenExpiresAt but no refreshToken cannot be refreshed —
  // treating it as "offline_expiring" triggers TOKEN_REFRESH_FAILED (null refresh
  // token sent to Shopify), which propagates to the reconnect banner.
  if (installation.refreshToken) {
    return "offline_expiring";
  }

  // If the stored mode explicitly says expiring but there is no refresh token now
  // (e.g. it was cleared), fall back to legacy so refresh is not attempted.
  return installation.tokenAcquisitionMode === "offline_expiring"
    ? "offline_legacy"
    : installation.tokenAcquisitionMode ?? "offline_legacy";
}

export class ShopifyConnectionError extends Error {
  code: ShopifyConnectionCode;
  reauthorizeUrl?: string;

  constructor(
    code: ShopifyConnectionCode,
    message: string,
    options: { reauthorizeUrl?: string } = {}
  ) {
    super(message);
    this.code = code;
    this.reauthorizeUrl = options.reauthorizeUrl;
  }
}

export function normalizeShopDomain(shop?: string | null) {
  if (!shop || typeof shop !== "string") {
    return null;
  }

  const trimmed = shop.trim().toLowerCase();
  if (!trimmed) {
    return null;
  }

  if (trimmed.includes("://") || trimmed.includes("/") || trimmed.includes("?")) {
    return null;
  }

  const normalized = trimmed.endsWith(".myshopify.com")
    ? trimmed
    : `${trimmed}.myshopify.com`;

  if (!SHOP_REGEX.test(normalized)) {
    return null;
  }

  return normalized;
}

function normalizeReturnTo(returnTo?: string | null) {
  if (!returnTo || typeof returnTo !== "string") {
    return null;
  }

  if (!returnTo.startsWith("/") || returnTo.startsWith("//")) {
    return null;
  }

  return returnTo;
}

export function buildReauthorizeUrl(
  shop?: string | null,
  returnTo?: string | null,
  host?: string | null
) {
  const normalizedShop = normalizeShopDomain(shop);
  if (!normalizedShop) {
    return undefined;
  }

  const url = new URL("/auth/reconnect", env.shopifyAppUrl);
  url.searchParams.set("shop", normalizedShop);
  const normalizedReturnTo = normalizeReturnTo(returnTo);
  if (normalizedReturnTo) {
    url.searchParams.set("returnTo", normalizedReturnTo);
  }
  if (host && typeof host === "string" && host.trim()) {
    url.searchParams.set("host", host.trim());
  }
  return url.toString();
}

export async function ensureInstallationMetadata(shop?: string | null) {
  const normalizedShop = normalizeShopDomain(shop);
  if (!normalizedShop) {
    return null;
  }

  const installation = await prisma.store.findUnique({
    where: { shop: normalizedShop },
  });

  if (!installation) {
    return null;
  }

  const installedAt = installation.installedAt ?? installation.createdAt ?? new Date();
  const reauthorizedAt = installation.reauthorizedAt ?? installedAt;
  const grantedScopes = installation.grantedScopes ?? env.shopifyScopes;
  const tokenAcquisitionMode = deriveTokenAcquisitionMode(installation);

  const needsUpdate =
    !installation.installedAt ||
    !installation.reauthorizedAt ||
    !installation.grantedScopes ||
    installation.tokenAcquisitionMode !== tokenAcquisitionMode;

  if (!needsUpdate) {
    return installation;
  }

  const updated = await prisma.store.update({
    where: { id: installation.id },
    data: {
      installedAt,
      reauthorizedAt,
      grantedScopes,
      tokenAcquisitionMode,
    },
  });

  logEvent("info", "shopify.installation.metadata_backfilled", {
    shop: normalizedShop,
    installedAt: updated.installedAt?.toISOString() ?? null,
    reauthorizedAt: updated.reauthorizedAt?.toISOString() ?? null,
    tokenAcquisitionMode: updated.tokenAcquisitionMode ?? null,
    grantedScopes: updated.grantedScopes ?? null,
  });

  return updated;
}

export async function getOfflineInstallation(shop?: string | null) {
  const normalizedShop = normalizeShopDomain(shop);
  if (!normalizedShop) {
    return null;
  }

  await ensureInstallationMetadata(normalizedShop);

  return prisma.store.findUnique({
    where: { shop: normalizedShop },
  });
}

function isAccessTokenExpiring(installation: NonNullable<InstallationRecord>) {
  if (!installation.accessTokenExpiresAt) {
    return false;
  }

  return installation.accessTokenExpiresAt.getTime() <= Date.now() + ACCESS_TOKEN_EXPIRY_BUFFER_MS;
}

function isRefreshTokenExpired(installation: NonNullable<InstallationRecord>) {
  if (!installation.refreshTokenExpiresAt) {
    return false;
  }

  return (
    installation.refreshTokenExpiresAt.getTime() <=
    Date.now() + ACCESS_TOKEN_EXPIRY_BUFFER_MS
  );
}

async function markReconnectRequired(
  installation: NonNullable<InstallationRecord>,
  code:
    | "OFFLINE_TOKEN_EXPIRED"
    | "REFRESH_TOKEN_EXPIRED"
    | "TOKEN_REFRESH_FAILED"
    | "SHOPIFY_RECONNECT_REQUIRED",
  message: string
) {
  await prisma.store.update({
    where: { id: installation.id },
    data: {
      lastConnectionCheckAt: new Date(),
      lastConnectionStatus: "SHOPIFY_RECONNECT_REQUIRED",
      lastConnectionError: message,
      authErrorCode: code,
      authErrorMessage: message,
    },
  });
}

/**
 * Exchange a Shopify session token (the JWT App Bridge issues in the browser)
 * for an offline Admin API access token.
 *
 * This is the modern replacement for relying solely on the OAuth redirect to
 * obtain the offline token. A valid session token proves the merchant is inside
 * the installed app, so Shopify will mint a fresh offline token on demand —
 * no redirect, no "Reconnect" banner.
 *
 * Docs: https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/token-exchange
 */
export async function exchangeSessionTokenForOfflineToken(
  shop: string,
  sessionToken: string
) {
  const normalizedShop = normalizeShopDomain(shop);
  if (!normalizedShop) {
    throw new ShopifyConnectionError(
      "MISSING_SHOP",
      "Cannot exchange session token: invalid shop domain."
    );
  }

  const tokenUrl = `https://${normalizedShop}/admin/oauth/access_token`;
  const response = await axios.post<RefreshAccessTokenResponse>(
    tokenUrl,
    {
      client_id: env.shopifyApiKey,
      client_secret: env.shopifyApiSecret,
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: sessionToken,
      subject_token_type: "urn:ietf:params:oauth:token-type:id_token",
      requested_token_type:
        "urn:shopify:params:oauth:token-type:offline-access-token",
      // Required to actually receive expires_in/refresh_token back — Token
      // Exchange defaults to non-expiring, same as the classic grant. See the
      // note on the classic exchange in authRoutes.ts for the full rationale.
      expiring: "1",
    },
    { timeout: 15000 }
  );

  const now = new Date();
  const accessTokenExpiresAt =
    typeof response.data.expires_in === "number"
      ? new Date(now.getTime() + response.data.expires_in * 1000)
      : null;
  const refreshTokenExpiresAt =
    typeof response.data.refresh_token_expires_in === "number"
      ? new Date(now.getTime() + response.data.refresh_token_expires_in * 1000)
      : null;

  // Plan-selected trial model: token exchange (like OAuth install) never
  // starts a trial — it only proves the app is installed/reachable. The
  // trial begins only at Shopify plan approval (see
  // billingManagementService.confirmBillingApprovalReturn). A brand-new
  // Store row created here simply has no trial dates yet, which is the
  // normal state for any shop that hasn't chosen a plan.
  const trialStartedAt = null;
  const trialEndsAt = null;

  const store = await prisma.store.upsert({
    where: { shop: normalizedShop },
    create: {
      shop: normalizedShop,
      accessToken: response.data.access_token,
      grantedScopes: response.data.scope ?? env.shopifyScopes,
      isOffline: true,
      installedAt: now,
      reauthorizedAt: now,
      accessTokenExpiresAt,
      refreshToken: response.data.refresh_token ?? null,
      refreshTokenExpiresAt,
      tokenAcquisitionMode: response.data.refresh_token
        ? "offline_expiring"
        : "offline_legacy",
      uninstalledAt: null,
      lastConnectionCheckAt: now,
      lastConnectionStatus: "OK",
      lastConnectionError: null,
      authErrorCode: null,
      authErrorMessage: null,
      lastWebhookRegistrationStatus: "PENDING",
      lastSyncStatus: "PENDING",
      trialStartedAt,
      trialEndsAt,
    },
    update: {
      accessToken: response.data.access_token,
      grantedScopes: response.data.scope ?? env.shopifyScopes,
      isOffline: true,
      accessTokenExpiresAt,
      refreshToken: response.data.refresh_token ?? null,
      refreshTokenExpiresAt,
      tokenAcquisitionMode: response.data.refresh_token
        ? "offline_expiring"
        : "offline_legacy",
      reauthorizedAt: now,
      // A successful exchange proves the app is installed right now.
      uninstalledAt: null,
      lastConnectionCheckAt: now,
      lastConnectionStatus: "OK",
      lastConnectionError: null,
      authErrorCode: null,
      authErrorMessage: null,
    },
  });

  logEvent("info", "shopify.connection.session_token_exchanged", {
    shop: normalizedShop,
    accessTokenExpiresAt: accessTokenExpiresAt?.toISOString() ?? null,
    hasRefreshToken: !!response.data.refresh_token,
    grantedScopes: response.data.scope ?? env.shopifyScopes,
  });

  return store;
}

/**
 * Serializes every token-mutating Shopify call (session-token exchange OR
 * refresh_token grant) per shop, so concurrent requests never send two
 * competing token requests for the same shop at once. Shopify rotates the
 * refresh token on each successful refresh, so a second concurrent call
 * still holding the old refresh token would otherwise fail or, worse, race
 * the DB write. Concurrent callers share the exact same in-flight promise
 * (and therefore the same resolved Store row / thrown error) rather than
 * each issuing their own request — this also naturally dedupes the common
 * "a page load fires several API calls at once" case.
 */
const inflightTokenOperations = new Map<
  string,
  Promise<NonNullable<InstallationRecord>>
>();

function runExclusiveTokenOperation(
  shop: string,
  factory: () => Promise<NonNullable<InstallationRecord>>
): Promise<NonNullable<InstallationRecord>> {
  const existing = inflightTokenOperations.get(shop);
  if (existing) {
    return existing;
  }

  const operation = factory().finally(() => {
    inflightTokenOperations.delete(shop);
  });

  inflightTokenOperations.set(shop, operation);
  return operation;
}

// Bounds how often a legacy (non-expiring, no refresh token) installation is
// opportunistically re-exchanged for an expiring token. This is intentionally
// NOT persisted and NOT unconditional: it fires at most once per shop per
// server process lifetime, only when a live session token is already being
// presented (i.e. only for real, already-authenticated embedded requests).
// This deliberately avoids turning every request for every existing
// (including production) installation into an extra Shopify call — see the
// Phase 1 verification report for the full rationale and the separate,
// deliberate production-migration path.
const legacyUpgradeAttempted = new Set<string>();

/**
 * Guarantee the store has a usable offline access token, minting or
 * upgrading one via token exchange when it is missing, expiring, or was
 * issued as a legacy (non-expiring) token that Shopify may reject outright.
 * Safe to call on every authenticated request — it is a no-op when a fresh,
 * already-expiring-capable token is already stored.
 *
 * Returns true when a token is available afterwards.
 */
export async function ensureOfflineAccessToken(
  shop: string,
  sessionToken?: string | null
): Promise<boolean> {
  const normalizedShop = normalizeShopDomain(shop);
  if (!normalizedShop) {
    return false;
  }

  const installation = await prisma.store.findUnique({
    where: { shop: normalizedShop },
    select: {
      accessToken: true,
      accessTokenExpiresAt: true,
      refreshToken: true,
      uninstalledAt: true,
    },
  });

  const expiringSoon =
    !!installation?.accessTokenExpiresAt &&
    installation.accessTokenExpiresAt.getTime() - Date.now() <=
      ACCESS_TOKEN_EXPIRY_BUFFER_MS;

  // A token with no refresh token was issued in legacy (non-expiring) mode.
  // Shopify may reject it outright for apps required to use expiring tokens.
  // Attempt exactly one opportunistic upgrade per shop per process lifetime
  // when we actually have a session token in hand to exchange with — never
  // proactively for every request, and never without a live session token.
  const isLegacyMode = !!installation?.accessToken && !installation.refreshToken;
  const needsUpgradeAttempt =
    isLegacyMode && !!sessionToken && !legacyUpgradeAttempted.has(normalizedShop);

  const tokenUsable =
    !!installation?.accessToken &&
    !installation.uninstalledAt &&
    !expiringSoon &&
    !needsUpgradeAttempt;

  if (tokenUsable) {
    return true;
  }

  if (!sessionToken) {
    return !!installation?.accessToken;
  }

  try {
    const store = await runExclusiveTokenOperation(normalizedShop, () =>
      exchangeSessionTokenForOfflineToken(normalizedShop, sessionToken)
    );
    logEvent("info", "shopify.connection.offline_token_self_healed", {
      shop: normalizedShop,
      hadToken: !!installation?.accessToken,
      wasUninstalled: !!installation?.uninstalledAt,
      wasLegacyMode: isLegacyMode,
    });
    return !!store.accessToken;
  } catch (error) {
    logEvent("warn", "shopify.connection.token_exchange_failed", {
      shop: normalizedShop,
      error,
    });
    return !!installation?.accessToken;
  } finally {
    if (isLegacyMode) {
      legacyUpgradeAttempted.add(normalizedShop);
    }
  }
}

async function exchangeLegacyOfflineToken(
  installation: NonNullable<InstallationRecord>
) {
  if (!installation.accessToken) {
    throw new ShopifyConnectionError(
      "MISSING_OFFLINE_TOKEN",
      `Cannot exchange legacy token for ${installation.shop}: no access token stored.`,
      { reauthorizeUrl: buildReauthorizeUrl(installation.shop) }
    );
  }

  try {
    const tokenUrl = `https://${installation.shop}/admin/oauth/access_token`;
    const response = await axios.post<RefreshAccessTokenResponse>(
      tokenUrl,
      {
        client_id: env.shopifyApiKey,
        client_secret: env.shopifyApiSecret,
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token: installation.accessToken,
        subject_token_type:
          "urn:shopify:params:oauth:token-type:offline-access-token",
        requested_token_type:
          "urn:shopify:params:oauth:token-type:offline-access-token",
        // Migrates the existing non-expiring token to an expiring one in a
        // single call — Shopify revokes the old token on success. Required;
        // see the note in authRoutes.ts's exchangeOfflineAccessToken.
        expiring: "1",
      },
      { timeout: 15000 }
    );

    const now = new Date();
    const accessTokenExpiresAt =
      typeof response.data.expires_in === "number"
        ? new Date(now.getTime() + response.data.expires_in * 1000)
        : null;
    const refreshTokenExpiresAt =
      typeof response.data.refresh_token_expires_in === "number"
        ? new Date(now.getTime() + response.data.refresh_token_expires_in * 1000)
        : null;

    const updated = await prisma.store.update({
      where: { id: installation.id },
      data: {
        accessToken: response.data.access_token,
        grantedScopes: response.data.scope ?? installation.grantedScopes,
        accessTokenExpiresAt,
        refreshToken: response.data.refresh_token ?? null,
        refreshTokenExpiresAt,
        tokenAcquisitionMode: response.data.refresh_token
          ? "offline_expiring"
          : "offline_legacy",
        reauthorizedAt: now,
        authErrorCode: null,
        authErrorMessage: null,
        lastConnectionCheckAt: now,
        lastConnectionStatus: "OK",
        lastConnectionError: null,
      },
    });

    logEvent("info", "shopify.connection.legacy_token_exchanged", {
      shop: installation.shop,
      accessTokenExpiresAt: accessTokenExpiresAt?.toISOString() ?? null,
      hasRefreshToken: !!response.data.refresh_token,
    });

    return updated;
  } catch (error) {
    // Exchange failed — token may already be deprecated/revoked, force reconnect
    const code = "SHOPIFY_RECONNECT_REQUIRED";
    const message = `Failed to exchange legacy offline token for ${installation.shop}. Reconnect the app to continue.`;
    await markReconnectRequired(installation, code, message);

    logEvent("warn", "shopify.connection.legacy_token_exchange_failed", {
      shop: installation.shop,
      error,
    });

    throw new ShopifyConnectionError(code, message, {
      reauthorizeUrl: buildReauthorizeUrl(installation.shop),
    });
  }
}

async function refreshOfflineAccessToken(
  installation: NonNullable<InstallationRecord>
) {
  if (!installation.refreshToken) {
    // No refresh token means this installation is still in legacy
    // (non-expiring) mode. Before giving up, attempt a one-time migration
    // exchange using the existing legacy access token itself as proof of
    // identity — this needs no live session token, so it also lets
    // session-less contexts (background jobs, the connection-health probe)
    // self-heal, not just live embedded requests.
    if (installation.accessToken) {
      return exchangeLegacyOfflineToken(installation);
    }

    const code = installation.accessTokenExpiresAt
      ? "OFFLINE_TOKEN_EXPIRED"
      : "SHOPIFY_RECONNECT_REQUIRED";
    const message = installation.accessTokenExpiresAt
      ? `Stored offline access token expired for ${installation.shop} and no refresh token is available. Reconnect the app and retry.`
      : `Stored Shopify offline installation for ${installation.shop} does not include a refresh token. Reconnect the app and retry.`;

    await markReconnectRequired(installation, code, message);

    throw new ShopifyConnectionError(
      code,
      message,
      { reauthorizeUrl: buildReauthorizeUrl(installation.shop) }
    );
  }

  if (isRefreshTokenExpired(installation)) {
    const message = `Stored Shopify refresh token expired for ${installation.shop}. Reconnect the app and retry.`;
    await markReconnectRequired(installation, "REFRESH_TOKEN_EXPIRED", message);
    throw new ShopifyConnectionError("REFRESH_TOKEN_EXPIRED", message, {
      reauthorizeUrl: buildReauthorizeUrl(installation.shop),
    });
  }

  try {
    const tokenUrl = `https://${installation.shop}/admin/oauth/access_token`;
    const response = await axios.post<RefreshAccessTokenResponse>(
      tokenUrl,
      {
        client_id: env.shopifyApiKey,
        client_secret: env.shopifyApiSecret,
        grant_type: "refresh_token",
        refresh_token: installation.refreshToken,
      },
      { timeout: 15000 }
    );

    const now = new Date();
    const nextAccessTokenExpiresAt =
      typeof response.data.expires_in === "number"
        ? new Date(now.getTime() + response.data.expires_in * 1000)
        : null;
    const nextRefreshTokenExpiresAt =
      typeof response.data.refresh_token_expires_in === "number"
        ? new Date(now.getTime() + response.data.refresh_token_expires_in * 1000)
        : installation.refreshTokenExpiresAt;

    const updated = await prisma.store.update({
      where: { id: installation.id },
      data: {
        accessToken: response.data.access_token,
        grantedScopes: response.data.scope ?? installation.grantedScopes,
        accessTokenExpiresAt: nextAccessTokenExpiresAt,
        refreshToken: response.data.refresh_token ?? installation.refreshToken,
        refreshTokenExpiresAt: nextRefreshTokenExpiresAt,
        tokenAcquisitionMode: response.data.refresh_token
          ? "offline_expiring"
          : deriveTokenAcquisitionMode(installation),
        reauthorizedAt: now,
        authErrorCode: null,
        authErrorMessage: null,
        lastConnectionCheckAt: now,
        lastConnectionStatus: "OK",
        lastConnectionError: null,
        uninstalledAt: null,
      },
    });

    logEvent("info", "shopify.connection.refresh_token_succeeded", {
      shop: installation.shop,
      route: "connection.refresh",
      accessTokenExpiresAt: nextAccessTokenExpiresAt?.toISOString() ?? null,
    });

    return updated;
  } catch (error) {
    const authRelatedFailure =
      axios.isAxiosError(error) &&
      (error.response?.status === 400 ||
        error.response?.status === 401 ||
        /invalid_grant|invalid refresh token|invalid access token|unauthorized/i.test(
          String(error.response?.data ?? error.message)
        ));
    const code = authRelatedFailure
      ? "SHOPIFY_RECONNECT_REQUIRED"
      : "TOKEN_REFRESH_FAILED";
    const message = authRelatedFailure
      ? `Shopify rejected the stored refresh token for ${installation.shop}. Reconnect the app and retry.`
      : error instanceof Error
      ? error.message
      : "Shopify access token refresh failed.";

    await markReconnectRequired(installation, code, message);

    logEvent("error", "shopify.connection.refresh_token_failed", {
      shop: installation.shop,
      route: "connection.refresh",
      code,
      error,
    });

    throw new ShopifyConnectionError(code, message, {
      reauthorizeUrl: buildReauthorizeUrl(installation.shop),
    });
  }
}

export async function forceRefreshOfflineAccessToken(shop?: string | null) {
  const normalizedShop = normalizeShopDomain(shop);
  if (!normalizedShop) {
    throw new ShopifyConnectionError("INVALID_SHOP", "Invalid Shopify shop domain.");
  }

  const installation = await getOfflineInstallation(normalizedShop);
  if (!installation) {
    throw new ShopifyConnectionError(
      "MISSING_INSTALLATION",
      `No Shopify installation record was found for ${normalizedShop}.`,
      { reauthorizeUrl: buildReauthorizeUrl(normalizedShop) }
    );
  }

  return runExclusiveTokenOperation(normalizedShop, () =>
    refreshOfflineAccessToken(installation)
  );
}

export async function resolveOfflineInstallation(
  shop?: string | null,
  options: { allowRefresh?: boolean } = {}
) {
  const normalizedShop = normalizeShopDomain(shop);
  if (!normalizedShop) {
    throw new ShopifyConnectionError("INVALID_SHOP", "Invalid Shopify shop domain.");
  }

  const installation = await getOfflineInstallation(normalizedShop);
  if (!installation) {
    throw new ShopifyConnectionError(
      "MISSING_INSTALLATION",
      `No Shopify installation record was found for ${normalizedShop}.`,
      { reauthorizeUrl: buildReauthorizeUrl(normalizedShop) }
    );
  }

  if (installation.uninstalledAt) {
    throw new ShopifyConnectionError(
      "UNINSTALLED",
      `The app was previously uninstalled from ${normalizedShop}. Reconnect the app to continue.`,
      { reauthorizeUrl: buildReauthorizeUrl(normalizedShop) }
    );
  }

  if (!installation.accessToken) {
    throw new ShopifyConnectionError(
      "MISSING_OFFLINE_TOKEN",
      `The stored Shopify offline access token is missing for ${normalizedShop}. Reauthorize the app and retry.`,
      { reauthorizeUrl: buildReauthorizeUrl(normalizedShop) }
    );
  }

  if (options.allowRefresh === false && isAccessTokenExpiring(installation)) {
    throw new ShopifyConnectionError(
      "OFFLINE_TOKEN_EXPIRED",
      `Stored offline access token expired for ${normalizedShop}. Reconnect the app or allow token refresh before retrying.`,
      { reauthorizeUrl: buildReauthorizeUrl(normalizedShop) }
    );
  }

  if (options.allowRefresh !== false && isAccessTokenExpiring(installation)) {
    return runExclusiveTokenOperation(normalizedShop, () =>
      refreshOfflineAccessToken(installation)
    );
  }

  // Legacy offline tokens (offline_legacy) still work for API calls — Shopify deprecated
  // permanent tokens but they remain valid. Migration to expiring tokens requires the
  // merchant to re-authorize via OAuth; it cannot be done by exchanging tokens server-side.

  // Clear any stale auth error written by a prior failed token exchange attempt.
  // Fire-and-forget: heals DB state on the first successful API call without blocking the caller.
  if (installation.authErrorCode) {
    void prisma.store.update({
      where: { id: installation.id },
      data: {
        authErrorCode: null,
        authErrorMessage: null,
        lastConnectionStatus: "OK",
        lastConnectionError: null,
        lastConnectionCheckAt: new Date(),
      },
    }).catch((err) => {
      logEvent("warn", "shopify.connection.clear_stale_auth_error_failed", {
        shop: installation.shop,
        authErrorCode: installation.authErrorCode,
        error: err,
      });
    });
  }

  return installation;
}

export async function getOfflineShopSession(shop?: string | null) {
  return resolveOfflineInstallation(shop);
}

export async function getShopAccessToken(shop?: string | null) {
  const installation = await resolveOfflineInstallation(shop);
  return installation.accessToken!;
}

export async function updateConnectionDiagnostics(
  shop: string,
  update: ConnectionDiagnosticUpdate
) {
  const normalizedShop = normalizeShopDomain(shop);
  if (!normalizedShop) {
    return;
  }

  await prisma.store.update({
    where: { shop: normalizedShop },
    data: {
      ...(update.lastConnectionStatus !== undefined
        ? { lastConnectionStatus: update.lastConnectionStatus }
        : {}),
      ...(update.lastConnectionError !== undefined
        ? { lastConnectionError: update.lastConnectionError }
        : {}),
      ...(update.authErrorCode !== undefined
        ? { authErrorCode: update.authErrorCode }
        : {}),
      ...(update.authErrorMessage !== undefined
        ? { authErrorMessage: update.authErrorMessage }
        : {}),
      ...(update.webhooksRegisteredAt !== undefined
        ? { webhooksRegisteredAt: update.webhooksRegisteredAt }
        : {}),
      ...(update.lastWebhookRegistrationStatus !== undefined
        ? { lastWebhookRegistrationStatus: update.lastWebhookRegistrationStatus }
        : {}),
      ...(update.lastSyncAt !== undefined ? { lastSyncAt: update.lastSyncAt } : {}),
      ...(update.lastSyncStatus !== undefined
        ? { lastSyncStatus: update.lastSyncStatus }
        : {}),
      lastConnectionCheckAt: new Date(),
    },
  });
}

async function probeShopApi(shop: string, accessToken: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(
      `https://${shop}/admin/api/${env.shopifyAdminApiVersion}/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({
          query: `
            query ConnectionHealth {
              shop {
                name
              }
            }
          `,
        }),
        signal: controller.signal,
      }
    );

    if (!response.ok) {
      const body = await response.text();
      const authRejected = isShopifyAuthRejection(response.status, body);
      throw new ShopifyConnectionError(
        authRejected ? "SHOPIFY_AUTH_REQUIRED" : "SHOPIFY_API_UNREACHABLE",
        authRejected
          ? `Stored Shopify access token is invalid for ${shop}. Reauthorize the app and retry.`
          : `Shopify Admin API probe failed for ${shop}: ${response.status}.`,
        { reauthorizeUrl: buildReauthorizeUrl(shop) }
      );
    }

    const payload = (await response.json()) as {
      errors?: Array<{ message: string }>;
      data?: { shop?: { name?: string } };
    };

    if (payload.errors?.length) {
      const message = payload.errors.map((entry) => entry.message).join(", ");
      throw new ShopifyConnectionError(
        "SHOPIFY_API_UNREACHABLE",
        message || `Shopify Admin API probe failed for ${shop}.`
      );
    }

    return payload.data?.shop?.name ?? shop;
  } catch (error) {
    if (error instanceof ShopifyConnectionError) {
      throw error;
    }

    if (
      error instanceof Error &&
      (error.name === "AbortError" ||
        /timed out|fetch failed|network request failed|aborted/i.test(error.message))
    ) {
      throw new ShopifyConnectionError(
        "SHOPIFY_API_UNREACHABLE",
        `Shopify Admin API request timed out for ${shop}. Retry in a few seconds.`
      );
    }

    throw new ShopifyConnectionError(
      "STALE_CONNECTION",
      error instanceof Error ? error.message : `Unable to verify Shopify connection for ${shop}.`,
      { reauthorizeUrl: buildReauthorizeUrl(shop) }
    );
  } finally {
    clearTimeout(timeout);
  }
}

export async function getConnectionHealth(
  shop?: string | null,
  options: { probeApi?: boolean } & ReauthorizeContext = {}
): Promise<ShopifyConnectionHealth> {
  const normalizedShop = normalizeShopDomain(shop);

  if (!normalizedShop) {
    return {
      shop: null,
      code: "MISSING_SHOP",
      healthy: false,
      installationFound: false,
      hasOfflineToken: false,
      webhooksRegistered: false,
      webhookCoverageReady: false,
      lastWebhookRegistrationStatus: null,
      lastSyncStatus: null,
      lastSyncAt: null,
      lastConnectionCheckAt: null,
      lastConnectionStatus: null,
      authErrorCode: "MISSING_SHOP",
      authErrorMessage: "Missing Shopify shop domain.",
      tokenAcquisitionMode: null,
      accessTokenExpiresAt: null,
      refreshTokenExpiresAt: null,
      reauthRequired: true,
      message: "Missing Shopify shop domain.",
    };
  }

  const installation = await prisma.store.findUnique({
    where: { shop: normalizedShop },
  });

  if (!installation) {
    return {
      shop: normalizedShop,
      code: "MISSING_INSTALLATION",
      healthy: false,
      installationFound: false,
      hasOfflineToken: false,
      webhooksRegistered: false,
      webhookCoverageReady: false,
      lastWebhookRegistrationStatus: null,
      lastSyncStatus: null,
      lastSyncAt: null,
      lastConnectionCheckAt: null,
      lastConnectionStatus: null,
      authErrorCode: "MISSING_INSTALLATION",
      authErrorMessage: `No Shopify installation record was found for ${normalizedShop}.`,
      tokenAcquisitionMode: null,
      accessTokenExpiresAt: null,
      refreshTokenExpiresAt: null,
      reauthRequired: true,
      message: `No Shopify installation record was found for ${normalizedShop}.`,
      reauthorizeUrl: buildReauthorizeUrl(
        normalizedShop,
        options.returnTo,
        options.host
      ),
    };
  }

  const baseHealth: ShopifyConnectionHealth = {
    shop: normalizedShop,
    code: "OK",
    healthy: true,
    installationFound: true,
    hasOfflineToken: !!installation.accessToken,
    webhooksRegistered: !!installation.webhooksRegisteredAt,
    webhookCoverageReady:
      !!installation.webhooksRegisteredAt &&
      installation.lastWebhookRegistrationStatus !== "FAILED" &&
      installation.lastWebhookRegistrationStatus !== "UNINSTALLED",
    lastWebhookRegistrationStatus: installation.lastWebhookRegistrationStatus ?? null,
    lastSyncStatus: installation.lastSyncStatus ?? null,
    lastSyncAt: installation.lastSyncAt?.toISOString() ?? null,
    lastConnectionCheckAt: installation.lastConnectionCheckAt?.toISOString() ?? null,
    lastConnectionStatus: installation.lastConnectionStatus ?? null,
    tokenAcquisitionMode: installation.tokenAcquisitionMode ?? null,
    accessTokenExpiresAt: installation.accessTokenExpiresAt?.toISOString() ?? null,
    refreshTokenExpiresAt: installation.refreshTokenExpiresAt?.toISOString() ?? null,
    authErrorCode: installation.authErrorCode ?? null,
    authErrorMessage: installation.authErrorMessage ?? installation.lastConnectionError ?? null,
    reauthRequired: false,
    message: "Shopify connection is healthy.",
  };

  const buildFailure = (
    code: ShopifyConnectionCode,
    message: string,
    options: { reauthRequired?: boolean; reauthorizeUrl?: string } = {}
  ): ShopifyConnectionHealth => ({
    ...baseHealth,
    code,
    healthy: false,
    reauthRequired: options.reauthRequired ?? false,
    message,
    authErrorCode: code,
    authErrorMessage: message,
      reauthorizeUrl: options.reauthorizeUrl,
    });

  if (installation.uninstalledAt) {
    return buildFailure(
      "UNINSTALLED",
      `This Shopify installation was previously uninstalled and must be reconnected.`,
      {
        reauthRequired: true,
        reauthorizeUrl: buildReauthorizeUrl(
          normalizedShop,
          options.returnTo,
          options.host
        ),
      }
    );
  }

  if (!installation.accessToken) {
    return buildFailure(
      "MISSING_OFFLINE_TOKEN",
      `The stored Shopify offline access token is missing for ${normalizedShop}.`,
      {
        reauthRequired: true,
        reauthorizeUrl: buildReauthorizeUrl(
          normalizedShop,
          options.returnTo,
          options.host
        ),
      }
    );
  }

  if (
    installation.authErrorCode &&
    [
      "OFFLINE_TOKEN_EXPIRED",
      "REFRESH_TOKEN_EXPIRED",
      "TOKEN_REFRESH_FAILED",
      "SHOPIFY_RECONNECT_REQUIRED",
    ].includes(installation.authErrorCode)
  ) {
    return buildFailure(
      installation.authErrorCode as ShopifyConnectionCode,
      installation.authErrorMessage ??
        "Shopify installation needs reconnect before server-side operations can continue.",
      {
        reauthRequired: true,
        reauthorizeUrl: buildReauthorizeUrl(
          normalizedShop,
          options.returnTo,
          options.host
        ),
      }
    );
  }

  // Missing webhooks does NOT make the connection unhealthy — the OAuth
  // token can be perfectly valid while webhook registration just hasn't
  // completed yet (e.g. it's fire-and-forget after install and may still
  // be in flight, or failed once transiently). `healthy` must only reflect
  // whether we can actually authenticate with Shopify, because `/sync` and
  // `/register-webhooks` both refuse to run when `!healthy` — conflating
  // the two meant a store stuck without webhooks couldn't self-heal by
  // clicking "Register webhooks", since that endpoint's own health check
  // would reject it first. `webhookCoverageReady` (already computed above)
  // is the correct, dedicated signal for this instead.
  if (!installation.webhooksRegisteredAt) {
    baseHealth.code = "WEBHOOKS_MISSING";
    baseHealth.message = "Mandatory Shopify webhooks are not registered yet.";
  }

  if (!options.probeApi) {
    return baseHealth;
  }

  try {
    const resolved = await resolveOfflineInstallation(normalizedShop, { allowRefresh: true });
    await probeShopApi(normalizedShop, resolved.accessToken!);
    await updateConnectionDiagnostics(normalizedShop, {
      lastConnectionStatus: baseHealth.code === "WEBHOOKS_MISSING" ? "WEBHOOKS_MISSING" : "OK",
      authErrorCode: null,
      authErrorMessage: null,
    });
    return baseHealth;
  } catch (error) {
    const connectionError =
      error instanceof ShopifyConnectionError
        ? error
        : new ShopifyConnectionError(
            "STALE_CONNECTION",
          error instanceof Error ? error.message : "Unable to verify Shopify connection.",
            {
              reauthorizeUrl: buildReauthorizeUrl(
                normalizedShop,
                options.returnTo,
                options.host
              ),
            }
          );

    await updateConnectionDiagnostics(normalizedShop, {
      lastConnectionStatus: connectionError.code,
      lastConnectionError: connectionError.message,
      authErrorCode: connectionError.code,
      authErrorMessage: connectionError.message,
    });

    logEvent("warn", "shopify.connection.health_failed", {
      shop: normalizedShop,
      route: "shopify.connection_health",
      code: connectionError.code,
      message: connectionError.message,
    });

    return {
      ...baseHealth,
      code: connectionError.code,
      healthy: false,
      reauthRequired:
        connectionError.code === "SHOPIFY_AUTH_REQUIRED" ||
        connectionError.code === "MISSING_OFFLINE_TOKEN" ||
        connectionError.code === "UNINSTALLED" ||
        connectionError.code === "MISSING_INSTALLATION" ||
        connectionError.code === "OFFLINE_TOKEN_EXPIRED" ||
        connectionError.code === "REFRESH_TOKEN_EXPIRED" ||
        connectionError.code === "TOKEN_REFRESH_FAILED" ||
        connectionError.code === "SHOPIFY_RECONNECT_REQUIRED",
      message: connectionError.message,
      authErrorCode: connectionError.code,
      authErrorMessage: connectionError.message,
      reauthorizeUrl: connectionError.reauthorizeUrl,
    };
  }
}

export async function assertHealthyOfflineAccess(shop?: string | null) {
  const health = await getConnectionHealth(shop, { probeApi: true });
  if (!health.healthy) {
    throw new ShopifyConnectionError(health.code, health.message, {
      reauthorizeUrl: health.reauthorizeUrl ?? buildReauthorizeUrl(health.shop),
    });
  }

  return health;
}

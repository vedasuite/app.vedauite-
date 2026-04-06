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

export async function getOfflineInstallation(shop?: string | null) {
  const normalizedShop = normalizeShopDomain(shop);
  if (!normalizedShop) {
    return null;
  }

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

async function refreshOfflineAccessToken(
  installation: NonNullable<InstallationRecord>
) {
  if (!installation.refreshToken) {
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
    const response = await axios.post<RefreshAccessTokenResponse>(tokenUrl, {
      client_id: env.shopifyApiKey,
      client_secret: env.shopifyApiSecret,
      grant_type: "refresh_token",
      refresh_token: installation.refreshToken,
    });

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
          : installation.tokenAcquisitionMode ?? "offline_expiring",
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

  return refreshOfflineAccessToken(installation);
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
    return refreshOfflineAccessToken(installation);
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
      throw new ShopifyConnectionError(
        response.status === 401 ? "SHOPIFY_AUTH_REQUIRED" : "SHOPIFY_API_UNREACHABLE",
        response.status === 401
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

  if (!installation.webhooksRegisteredAt) {
    baseHealth.code = "WEBHOOKS_MISSING";
    baseHealth.healthy = false;
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

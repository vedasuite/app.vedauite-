import { prisma } from "../db/prismaClient";
import { env } from "../config/env";
import { logEvent } from "./observabilityService";

export type ShopifyConnectionCode =
  | "OK"
  | "MISSING_SHOP"
  | "MISSING_INSTALLATION"
  | "MISSING_ACCESS_TOKEN"
  | "UNINSTALLED"
  | "STALE_CONNECTION"
  | "SHOPIFY_AUTH_REQUIRED"
  | "SHOPIFY_API_UNREACHABLE"
  | "WEBHOOKS_MISSING"
  | "SYNC_REQUIRED";

export type ShopifyConnectionHealth = {
  shop: string | null;
  code: ShopifyConnectionCode;
  healthy: boolean;
  installationFound: boolean;
  hasOfflineToken: boolean;
  webhooksRegistered: boolean;
  webhookCoverageReady: boolean;
  lastSyncStatus: string | null;
  lastSyncAt: string | null;
  lastConnectionStatus: string | null;
  lastConnectionError: string | null;
  reauthRequired: boolean;
  message: string;
};

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
  if (!shop) {
    return null;
  }

  const normalized = shop.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  if (normalized.endsWith(".myshopify.com")) {
    return normalized;
  }

  return `${normalized}.myshopify.com`;
}

function buildReauthorizeUrl(shop?: string | null) {
  const normalizedShop = normalizeShopDomain(shop);
  if (!normalizedShop) {
    return undefined;
  }

  return new URL(
    `/auth/install?shop=${encodeURIComponent(normalizedShop)}`,
    env.shopifyAppUrl
  ).toString();
}

export async function getOfflineShopSession(shop?: string | null) {
  const normalizedShop = normalizeShopDomain(shop);
  if (!normalizedShop) {
    return null;
  }

  return prisma.store.findUnique({
    where: { shop: normalizedShop },
  });
}

export async function getShopAccessToken(shop?: string | null) {
  const installation = await getOfflineShopSession(shop);
  if (!installation?.accessToken || installation.uninstalledAt) {
    return null;
  }

  return installation.accessToken;
}

async function recordConnectionStatus(
  shop: string,
  status: ShopifyConnectionCode | "OK",
  errorMessage?: string | null
) {
  await prisma.store.update({
    where: { shop },
    data: {
      lastConnectionCheckAt: new Date(),
      lastConnectionStatus: status,
      lastConnectionError: errorMessage ?? null,
    },
  });
}

async function probeShopApi(shop: string, accessToken: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(
      `https://${shop}/admin/api/2024-01/graphql.json`,
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
      const text = await response.text();
      if (
        response.status === 401 ||
        /invalid api key|invalid access token|unrecognized login|wrong password/i.test(
          text
        )
      ) {
        throw new ShopifyConnectionError(
          "SHOPIFY_AUTH_REQUIRED",
          `Stored Shopify access token is invalid for ${shop}. Reauthorize the app and retry.`,
          { reauthorizeUrl: buildReauthorizeUrl(shop) }
        );
      }

      throw new ShopifyConnectionError(
        "SHOPIFY_API_UNREACHABLE",
        `Shopify Admin API probe failed for ${shop}: ${response.status}`
      );
    }

    const payload = (await response.json()) as {
      data?: { shop?: { name?: string } };
      errors?: Array<{ message: string }>;
    };

    if (payload.errors?.length) {
      const message = payload.errors.map((error) => error.message).join(", ");
      throw new ShopifyConnectionError("STALE_CONNECTION", message, {
        reauthorizeUrl: buildReauthorizeUrl(shop),
      });
    }

    return payload.data?.shop?.name ?? shop;
  } catch (error) {
    if (error instanceof ShopifyConnectionError) {
      throw error;
    }

    if (
      error instanceof Error &&
      (error.name === "AbortError" ||
        /aborted|timed out|network request failed|fetch failed/i.test(error.message))
    ) {
      throw new ShopifyConnectionError(
        "SHOPIFY_API_UNREACHABLE",
        `Shopify API request timed out for ${shop}. Retry in a few seconds.`
      );
    }

    throw new ShopifyConnectionError(
      "STALE_CONNECTION",
      error instanceof Error ? error.message : "Shopify connection probe failed.",
      { reauthorizeUrl: buildReauthorizeUrl(shop) }
    );
  } finally {
    clearTimeout(timeout);
  }
}

export async function getConnectionHealth(
  shop?: string | null,
  options: { probeApi?: boolean } = {}
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
      lastSyncStatus: null,
      lastSyncAt: null,
      lastConnectionStatus: null,
      lastConnectionError: null,
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
      lastSyncStatus: null,
      lastSyncAt: null,
      lastConnectionStatus: null,
      lastConnectionError: null,
      reauthRequired: true,
      message: "No Shopify installation record was found for this shop.",
    };
  }

  if (installation.uninstalledAt) {
    await recordConnectionStatus(normalizedShop, "UNINSTALLED");
    return {
      shop: normalizedShop,
      code: "UNINSTALLED",
      healthy: false,
      installationFound: true,
      hasOfflineToken: !!installation.accessToken,
      webhooksRegistered: !!installation.webhooksRegisteredAt,
      webhookCoverageReady: false,
      lastSyncStatus: installation.syncStatus ?? null,
      lastSyncAt: installation.lastSyncAt?.toISOString() ?? null,
      lastConnectionStatus: "UNINSTALLED",
      lastConnectionError: installation.lastConnectionError ?? null,
      reauthRequired: true,
      message: "This Shopify installation was previously uninstalled and must be reconnected.",
    };
  }

  if (!installation.accessToken) {
    await recordConnectionStatus(
      normalizedShop,
      "MISSING_ACCESS_TOKEN",
      "Missing offline access token."
    );
    return {
      shop: normalizedShop,
      code: "MISSING_ACCESS_TOKEN",
      healthy: false,
      installationFound: true,
      hasOfflineToken: false,
      webhooksRegistered: !!installation.webhooksRegisteredAt,
      webhookCoverageReady: false,
      lastSyncStatus: installation.syncStatus ?? null,
      lastSyncAt: installation.lastSyncAt?.toISOString() ?? null,
      lastConnectionStatus: "MISSING_ACCESS_TOKEN",
      lastConnectionError: "Missing offline access token.",
      reauthRequired: true,
      message: "The Shopify offline access token is missing for this installation.",
    };
  }

  const baseHealth: ShopifyConnectionHealth = {
    shop: normalizedShop,
    code: "OK",
    healthy: true,
    installationFound: true,
    hasOfflineToken: true,
    webhooksRegistered: !!installation.webhooksRegisteredAt,
    webhookCoverageReady: !!installation.webhooksRegisteredAt,
    lastSyncStatus: installation.syncStatus ?? null,
    lastSyncAt: installation.lastSyncAt?.toISOString() ?? null,
    lastConnectionStatus: installation.lastConnectionStatus ?? "OK",
    lastConnectionError: installation.lastConnectionError ?? null,
    reauthRequired: false,
    message: "Shopify connection is healthy.",
  };

  if (!options.probeApi) {
    if (!installation.webhooksRegisteredAt) {
      return {
        ...baseHealth,
        code: "WEBHOOKS_MISSING",
        healthy: false,
        webhookCoverageReady: false,
        message: "Mandatory Shopify webhooks are not registered yet.",
      };
    }

    return baseHealth;
  }

  try {
    await probeShopApi(normalizedShop, installation.accessToken);
    await recordConnectionStatus(normalizedShop, "OK", null);

    const webhookCoverageReady = !!installation.webhooksRegisteredAt;
    return {
      ...baseHealth,
      code: webhookCoverageReady ? "OK" : "WEBHOOKS_MISSING",
      healthy: webhookCoverageReady,
      webhookCoverageReady,
      message: webhookCoverageReady
        ? "Shopify connection is healthy."
        : "Shopify connection is healthy, but required webhooks are missing.",
    };
  } catch (error) {
    const connectionError =
      error instanceof ShopifyConnectionError
        ? error
        : new ShopifyConnectionError(
            "STALE_CONNECTION",
            error instanceof Error ? error.message : "Unable to verify Shopify connection.",
            { reauthorizeUrl: buildReauthorizeUrl(normalizedShop) }
          );

    await recordConnectionStatus(
      normalizedShop,
      connectionError.code,
      connectionError.message
    );

    logEvent("warn", "shopify.connection_health.failed", {
      shop: normalizedShop,
      code: connectionError.code,
      message: connectionError.message,
    });

    return {
      ...baseHealth,
      code: connectionError.code,
      healthy: false,
      lastConnectionStatus: connectionError.code,
      lastConnectionError: connectionError.message,
      reauthRequired:
        connectionError.code === "SHOPIFY_AUTH_REQUIRED" ||
        connectionError.code === "STALE_CONNECTION" ||
        connectionError.code === "MISSING_ACCESS_TOKEN" ||
        connectionError.code === "UNINSTALLED",
      message: connectionError.message,
    };
  }
}

export async function assertHealthyOfflineAccess(shop?: string | null) {
  const health = await getConnectionHealth(shop, { probeApi: true });
  if (!health.healthy && health.code !== "WEBHOOKS_MISSING") {
    throw new ShopifyConnectionError(health.code, health.message, {
      reauthorizeUrl: buildReauthorizeUrl(health.shop),
    });
  }

  return health;
}

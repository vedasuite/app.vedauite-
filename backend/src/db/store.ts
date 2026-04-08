import { prisma } from "./prismaClient";
import { env } from "../config/env";
import {
  normalizeShopDomain,
  resolveOfflineInstallation,
} from "../services/shopifyConnectionService";

export async function saveStore(shop: string, accessToken: string) {
  const normalizedShop = normalizeShopDomain(shop);
  if (!normalizedShop) {
    throw new Error("Invalid Shopify shop domain.");
  }

  return prisma.store.upsert({
    where: { shop: normalizedShop },
    create: {
      shop: normalizedShop,
      accessToken,
      grantedScopes: env.shopifyScopes,
      tokenAcquisitionMode: "offline_legacy",
      isOffline: true,
      installedAt: new Date(),
      reauthorizedAt: new Date(),
      lastConnectionStatus: "OK",
      authErrorCode: null,
      authErrorMessage: null,
    },
    update: {
      accessToken,
      grantedScopes: env.shopifyScopes,
      tokenAcquisitionMode: "offline_legacy",
      reauthorizedAt: new Date(),
      uninstalledAt: null,
      lastConnectionStatus: "OK",
      lastConnectionError: null,
      authErrorCode: null,
      authErrorMessage: null,
    },
  });
}

export async function getToken(shop: string) {
  try {
    const installation = await resolveOfflineInstallation(shop);
    return installation.accessToken ?? null;
  } catch {
    return null;
  }
}

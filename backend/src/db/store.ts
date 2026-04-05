import { prisma } from "./prismaClient";
import { normalizeShopDomain } from "../services/shopifyConnectionService";

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
    },
    update: {
      accessToken,
      uninstalledAt: null,
      lastConnectionStatus: "OK",
      lastConnectionError: null,
    },
  });
}

export async function getToken(shop: string) {
  const normalizedShop = normalizeShopDomain(shop);
  if (!normalizedShop) {
    return null;
  }

  const store = await prisma.store.findUnique({
    where: { shop: normalizedShop },
    select: { accessToken: true, uninstalledAt: true },
  });

  if (!store || store.uninstalledAt) {
    return null;
  }

  return store.accessToken ?? null;
}

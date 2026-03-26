import { prisma } from "./prismaClient";

export async function saveStore(shop: string, accessToken: string) {
  return prisma.store.upsert({
    where: { shop },
    create: {
      shop,
      accessToken,
    },
    update: {
      accessToken,
    },
  });
}

export async function getToken(shop: string) {
  const store = await prisma.store.findUnique({
    where: { shop },
    select: { accessToken: true },
  });

  return store?.accessToken ?? null;
}

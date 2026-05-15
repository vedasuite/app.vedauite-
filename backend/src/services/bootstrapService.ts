import { env } from "../config/env";
import { prisma } from "../db/prismaClient";
import { logEvent } from "./observabilityService";

export async function ensureStoreBootstrapped(shop: string) {
  const store = await prisma.store.findUnique({
    where: { shop },
    select: {
      id: true,
      shop: true,
      installedAt: true,
    },
  });

  if (!store) {
    throw new Error("Store not found");
  }

  if (env.enableGuidedBootstrap) {
    logEvent("warn", "bootstrap.guided_bootstrap_ignored", {
      shop: store.shop,
      message:
        "Guided bootstrap is enabled in configuration, but VedaSuite only uses Shopify store activity for merchant intelligence.",
    });
  }

  logEvent("info", "bootstrap.checked", {
    shop: store.shop,
    installedAt: store.installedAt?.toISOString() ?? null,
    generatedGuidedData: false,
  });
}

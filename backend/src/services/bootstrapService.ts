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

  if (env.enableDemoBootstrap) {
    logEvent("warn", "bootstrap.demo_mode_ignored", {
      shop: store.shop,
      message:
        "Demo bootstrap is enabled in configuration, but VedaSuite no longer seeds fake merchant intelligence data.",
    });
  }

  logEvent("info", "bootstrap.checked", {
    shop: store.shop,
    installedAt: store.installedAt?.toISOString() ?? null,
    seeded: false,
  });
}

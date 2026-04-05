import { prisma } from "../db/prismaClient";
import { recomputeStoreDerivedData } from "./coreEngineService";
import { logEvent } from "./observabilityService";
import { syncShopifyStoreData } from "./shopifyAdminService";

export type SyncTriggerSource =
  | "manual"
  | "auth_install"
  | "orders_create"
  | "orders_updated"
  | "customers_create"
  | "customers_update"
  | "system";

async function resolveStore(shopDomain: string) {
  const store = await prisma.store.findUnique({
    where: { shop: shopDomain },
    select: {
      id: true,
      shop: true,
    },
  });

  if (!store) {
    throw new Error("Store not found");
  }

  return store;
}

export async function runStoreSyncJob(
  shopDomain: string,
  triggerSource: SyncTriggerSource
) {
  const store = await resolveStore(shopDomain);

  const job = await prisma.syncJob.create({
    data: {
      storeId: store.id,
      jobType: "shopify_sync",
      triggerSource,
      status: "RUNNING",
      startedAt: new Date(),
    },
  });

  try {
    const syncResult = await syncShopifyStoreData(shopDomain);
    const recomputeResult = await recomputeStoreDerivedData(shopDomain);

    const completed = await prisma.syncJob.update({
      where: { id: job.id },
      data: {
        status: "SUCCEEDED",
        finishedAt: new Date(),
        summaryJson: JSON.stringify({
          syncResult,
          recomputeResult,
        }),
      },
    });

    logEvent("info", "sync_job.completed", {
      shop: shopDomain,
      triggerSource,
      jobId: completed.id,
    });

    return {
      jobId: completed.id,
      status: completed.status,
      syncResult,
      recomputeResult,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Shopify sync job failed.";

    await prisma.syncJob.update({
      where: { id: job.id },
      data: {
        status: "FAILED",
        finishedAt: new Date(),
        errorMessage: message,
      },
    });

    logEvent("error", "sync_job.failed", {
      shop: shopDomain,
      triggerSource,
      jobId: job.id,
      message,
    });

    throw error;
  }
}

export async function getLatestSyncJob(shopDomain: string) {
  const store = await resolveStore(shopDomain);

  return prisma.syncJob.findFirst({
    where: { storeId: store.id },
    orderBy: { createdAt: "desc" },
  });
}

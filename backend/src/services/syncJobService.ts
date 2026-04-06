import { prisma } from "../db/prismaClient";
import { recomputeStoreDerivedData } from "./coreEngineService";
import { logEvent } from "./observabilityService";
import { syncShopifyStoreData } from "./shopifyAdminService";
import { ShopifyConnectionError } from "./shopifyConnectionService";

export type SyncTriggerSource =
  | "manual"
  | "auth_install"
  | "orders_create"
  | "orders_updated"
  | "customers_create"
  | "customers_update"
  | "system";

const ACTIVE_SYNC_STATUSES = ["PENDING", "RUNNING"] as const;

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

function mapSyncFailure(error: unknown) {
  if (error instanceof ShopifyConnectionError) {
    const reconnectRequired =
      error.code === "OFFLINE_TOKEN_EXPIRED" ||
      error.code === "REFRESH_TOKEN_EXPIRED" ||
      error.code === "TOKEN_REFRESH_FAILED" ||
      error.code === "SHOPIFY_RECONNECT_REQUIRED" ||
      error.code === "SHOPIFY_AUTH_REQUIRED";

    return {
      code: error.code,
      status: reconnectRequired ? "SHOPIFY_RECONNECT_REQUIRED" : "SYNC_REQUIRED",
      message: error.message,
    };
  }

  const message =
    error instanceof Error ? error.message : "Shopify sync job failed.";

  const reconnectRequired = /reauthorize|invalid access token|refresh token|offline token expired|reconnect/i.test(
    message
  );

  return {
    code: reconnectRequired ? "SHOPIFY_RECONNECT_REQUIRED" : "SYNC_FAILED",
    status: reconnectRequired ? "SHOPIFY_RECONNECT_REQUIRED" : "SYNC_REQUIRED",
    message,
  };
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
    await prisma.store.update({
      where: { id: store.id },
      data: {
        lastSyncStatus: "RUNNING",
      },
    });

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

    await prisma.store.update({
      where: { id: store.id },
      data: {
        lastSyncAt: new Date(),
        lastSyncStatus: "SUCCEEDED",
        lastConnectionCheckAt: new Date(),
        lastConnectionStatus: "OK",
        lastConnectionError: null,
        authErrorCode: null,
        authErrorMessage: null,
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
    const failure = mapSyncFailure(error);

    await prisma.syncJob.update({
      where: { id: job.id },
      data: {
        status: "FAILED",
        finishedAt: new Date(),
        errorMessage: failure.message,
      },
    });

    await prisma.store.update({
      where: { id: store.id },
      data: {
        lastSyncStatus: "FAILED",
        lastConnectionCheckAt: new Date(),
        lastConnectionStatus: failure.status,
        lastConnectionError: failure.message,
        authErrorCode: failure.code,
        authErrorMessage: failure.message,
      },
    });

    logEvent("error", "sync_job.failed", {
      shop: shopDomain,
      triggerSource,
      jobId: job.id,
      code: failure.code,
      message: failure.message,
    });

    throw error;
  }
}

export async function startStoreSyncJob(
  shopDomain: string,
  triggerSource: SyncTriggerSource
) {
  const store = await resolveStore(shopDomain);

  const activeJob = await prisma.syncJob.findFirst({
    where: {
      storeId: store.id,
      jobType: "shopify_sync",
      status: {
        in: [...ACTIVE_SYNC_STATUSES],
      },
    },
    orderBy: { createdAt: "desc" },
  });

  if (activeJob) {
    return {
      jobId: activeJob.id,
      status: activeJob.status,
      reusedExisting: true,
    };
  }

  const createdJob = await prisma.syncJob.create({
    data: {
      storeId: store.id,
      jobType: "shopify_sync",
      triggerSource,
      status: "PENDING",
    },
  });

  void (async () => {
    try {
      await prisma.store.update({
        where: { id: store.id },
        data: {
          lastSyncStatus: "RUNNING",
        },
      });

      await prisma.syncJob.update({
        where: { id: createdJob.id },
        data: {
          status: "RUNNING",
          startedAt: new Date(),
        },
      });

      const syncResult = await syncShopifyStoreData(shopDomain);
      const recomputeResult = await recomputeStoreDerivedData(shopDomain);

      await prisma.syncJob.update({
        where: { id: createdJob.id },
        data: {
          status: "SUCCEEDED",
          finishedAt: new Date(),
          summaryJson: JSON.stringify({
            syncResult,
            recomputeResult,
          }),
        },
      });

      await prisma.store.update({
        where: { id: store.id },
        data: {
          lastSyncAt: new Date(),
          lastSyncStatus: "SUCCEEDED",
          lastConnectionCheckAt: new Date(),
          lastConnectionStatus: "OK",
          lastConnectionError: null,
          authErrorCode: null,
          authErrorMessage: null,
        },
      });

      logEvent("info", "sync_job.completed", {
        shop: shopDomain,
        triggerSource,
        jobId: createdJob.id,
        mode: "background",
      });
    } catch (error) {
      const failure = mapSyncFailure(error);

      await prisma.syncJob.update({
        where: { id: createdJob.id },
        data: {
          status: "FAILED",
          finishedAt: new Date(),
          errorMessage: failure.message,
        },
      });

      await prisma.store.update({
        where: { id: store.id },
        data: {
          lastSyncStatus: "FAILED",
          lastConnectionCheckAt: new Date(),
          lastConnectionStatus: failure.status,
          lastConnectionError: failure.message,
          authErrorCode: failure.code,
          authErrorMessage: failure.message,
        },
      });

      logEvent("error", "sync_job.failed", {
        shop: shopDomain,
        triggerSource,
        jobId: createdJob.id,
        mode: "background",
        code: failure.code,
        message: failure.message,
      });
    }
  })();

  return {
    jobId: createdJob.id,
    status: "PENDING",
    reusedExisting: false,
  };
}

export async function getLatestSyncJob(shopDomain: string) {
  const store = await resolveStore(shopDomain);

  return prisma.syncJob.findFirst({
    where: { storeId: store.id },
    orderBy: { createdAt: "desc" },
  });
}

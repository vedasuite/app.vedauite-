import { prisma } from "../db/prismaClient";
import { recomputeStoreDerivedData } from "./coreEngineService";
import { logEvent } from "./observabilityService";
import { syncShopifyStoreData } from "./shopifyAdminService";
import { ShopifyConnectionError } from "./shopifyConnectionService";
import {
  deriveSyncStatus,
  getStoreOperationalSnapshot,
  type StoreSyncStatus,
} from "./storeOperationalStateService";

export type SyncTriggerSource =
  | "manual"
  | "auth_install"
  | "orders_create"
  | "orders_updated"
  | "customers_create"
  | "customers_update"
  | "system";

const ACTIVE_SYNC_STATUSES = ["PENDING", "RUNNING", "SYNC_IN_PROGRESS"] as const;

function buildSyncActivitySummary(params: {
  syncResult: Awaited<ReturnType<typeof syncShopifyStoreData>>;
  recomputeResult: Awaited<ReturnType<typeof recomputeStoreDerivedData>>;
  operational: Awaited<ReturnType<typeof getStoreOperationalSnapshot>>;
}) {
  const competitorRows = params.operational.counts.competitorRows;
  const competitorReason =
    competitorRows > 0
      ? "Competitor module was not refreshed in this sync."
      : "Competitor module was not refreshed in this sync. Run competitor monitoring separately to check domains and matches.";

  return {
    ordersProcessed: params.syncResult.ordersSynced,
    customersEvaluated: params.recomputeResult.customersRecomputed,
    competitorPagesChecked: 0,
    pricingRecordsAnalyzed: params.recomputeResult.productOutputsUpdated,
    fraudSignalsGenerated: params.recomputeResult.fraudSignalsGenerated ?? 0,
    newInsightsCount: params.recomputeResult.timelineEventsCreated,
    updatedInsightsCount: 0,
    errorsCount: 0,
    noChangeReasons: [
      "no new fraud signals were triggered",
      competitorRows > 0
        ? "competitor module was not refreshed in this sync"
        : "no competitor checks ran during this sync",
      "pricing signals remained stable",
    ],
    moduleProcessing: {
      fraud: {
        processed: true,
        status:
          (params.recomputeResult.fraudSignalsGenerated ?? 0) > 0
            ? "updated"
            : "processed_no_changes",
        reason:
          (params.recomputeResult.fraudSignalsGenerated ?? 0) > 0
            ? "Fraud checks ran and generated updated fraud signals."
            : "Fraud checks ran, but no new fraud signals were triggered.",
      },
      competitor: {
        processed: false,
        status: "not_refreshed",
        reason: competitorReason,
      },
      pricing: {
        processed: true,
        status:
          params.recomputeResult.productOutputsUpdated > 0
            ? "updated"
            : "processed_no_changes",
        reason:
          params.recomputeResult.productOutputsUpdated > 0
            ? "Pricing records were analyzed during this sync."
            : "Pricing checks ran, but no pricing records changed.",
      },
    },
  };
}

function mapDerivedSyncStatusToJobStatus(status: StoreSyncStatus) {
  switch (status) {
    case "READY_WITH_DATA":
      return "READY_WITH_DATA";
    case "EMPTY_STORE_DATA":
      return "SUCCEEDED_NO_DATA";
    case "SYNC_COMPLETED_PROCESSING_PENDING":
      return "SUCCEEDED_PROCESSING_PENDING";
    case "FAILED":
      return "FAILED";
    case "SYNC_IN_PROGRESS":
      return "SYNC_IN_PROGRESS";
    case "NOT_CONNECTED":
      return "FAILED";
    case "SYNC_REQUIRED":
    default:
      return "SUCCEEDED_NO_DATA";
  }
}

async function finalizeSyncSuccess(params: {
  storeId: string;
  jobId: string;
  shopDomain: string;
  triggerSource: SyncTriggerSource;
  syncResult: Awaited<ReturnType<typeof syncShopifyStoreData>>;
  recomputeResult: Awaited<ReturnType<typeof recomputeStoreDerivedData>>;
}) {
  const operational = await getStoreOperationalSnapshot(params.shopDomain);
  const derivedSync = deriveSyncStatus({
    connectionStatus: operational.store.lastConnectionStatus,
    latestSyncJobStatus: params.syncResult.status,
    lastSyncStatus: operational.store.lastSyncStatus,
    products: operational.counts.products,
    orders: operational.counts.orders,
    customers: operational.counts.customers,
    priceRows: operational.counts.pricingRows,
    profitRows: operational.counts.profitRows,
    timelineEvents: operational.counts.timelineEvents,
  });
  const finalJobStatus = mapDerivedSyncStatusToJobStatus(derivedSync.status);
  const finishedAt = new Date();
  const activitySummary = buildSyncActivitySummary({
    syncResult: params.syncResult,
    recomputeResult: params.recomputeResult,
    operational,
  });

  const completed = await prisma.syncJob.update({
    where: { id: params.jobId },
    data: {
      status: finalJobStatus,
      finishedAt,
      summaryJson: JSON.stringify({
        syncResult: {
          ...params.syncResult,
          status: finalJobStatus,
        },
        recomputeResult: {
          ...params.recomputeResult,
          status:
            derivedSync.status === "READY_WITH_DATA"
              ? "SUCCEEDED"
              : derivedSync.status === "FAILED"
              ? "FAILED"
              : "SUCCEEDED_NO_DATA",
        },
        operationalCounts: operational.counts,
        derivedSync,
        activitySummary,
      }),
      errorMessage:
        derivedSync.status === "FAILED" ? derivedSync.reason : null,
    },
  });

  await prisma.store.update({
    where: { id: params.storeId },
    data: {
      lastSyncAt: finishedAt,
      lastSyncStatus: derivedSync.status,
      lastConnectionCheckAt: finishedAt,
      lastConnectionStatus: "OK",
      lastConnectionError: null,
      authErrorCode: null,
      authErrorMessage: null,
    },
  });

  logEvent("info", "sync_job.completed", {
    shop: params.shopDomain,
    triggerSource: params.triggerSource,
    jobId: completed.id,
    syncStatus: params.syncResult.status,
    finalJobStatus,
    derivedStatus: derivedSync.status,
    counts: operational.counts,
  });

  return {
    completed,
    derivedSync,
    operational,
  };
}

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
      status: "SYNC_IN_PROGRESS",
      startedAt: new Date(),
    },
  });

  try {
    await prisma.store.update({
      where: { id: store.id },
      data: {
        lastSyncStatus: "SYNC_IN_PROGRESS",
      },
    });

    const syncResult = await syncShopifyStoreData(shopDomain);
    const recomputeResult = await recomputeStoreDerivedData(shopDomain);
    const { completed } = await finalizeSyncSuccess({
      storeId: store.id,
      jobId: job.id,
      shopDomain,
      triggerSource,
      syncResult,
      recomputeResult,
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
          lastSyncStatus: "SYNC_IN_PROGRESS",
        },
      });

      await prisma.syncJob.update({
        where: { id: createdJob.id },
        data: {
          status: "SYNC_IN_PROGRESS",
          startedAt: new Date(),
        },
      });

      const syncResult = await syncShopifyStoreData(shopDomain);
      const recomputeResult = await recomputeStoreDerivedData(shopDomain);
      const { completed, derivedSync, operational } =
        await finalizeSyncSuccess({
          storeId: store.id,
          jobId: createdJob.id,
          shopDomain,
          triggerSource,
          syncResult,
          recomputeResult,
        });

      logEvent("info", "sync_job.completed.background", {
        shop: shopDomain,
        triggerSource,
        jobId: completed.id,
        mode: "background",
        syncStatus: syncResult.status,
        finalJobStatus: completed.status,
        derivedStatus: derivedSync.status,
        counts: operational.counts,
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

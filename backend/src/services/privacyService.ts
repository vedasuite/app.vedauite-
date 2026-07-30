import fs from "fs/promises";
import path from "path";
import { env } from "../config/env";
import { prisma } from "../db/prismaClient";
import { logEvent } from "./observabilityService";

function runtimeExportPath(filename: string) {
  return path.resolve(process.cwd(), env.complianceExportDir, filename);
}

function normalizeCustomerId(value: unknown) {
  if (typeof value === "number") {
    return String(value);
  }

  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }

  return null;
}

function redactEmail(email?: string | null) {
  if (!email) {
    return null;
  }

  return `redacted+${Date.now()}@vedasuite.local`;
}

// Returns null for an unknown shop rather than throwing. A compliance webhook
// for a shop we never stored is a SUCCESS — there is nothing to export or
// erase — not an error. The previous throw was swallowed by the handlers'
// try/catch and reported as 200 {ok:false}, hiding the (benign) case inside the
// same channel as genuine failures. Callers now branch on null explicitly.
async function findStore(shopDomain: string) {
  return prisma.store.findUnique({
    where: { shop: shopDomain },
  });
}

export type StoreDeletionOutcome =
  | { outcome: "deleted"; storeId: string; shop: string }
  | { outcome: "skipped_active_install"; storeId: string; shop: string }
  | { outcome: "not_found" };

/**
 * The SOLE permitted caller of prisma.store.delete(). Do not call store.delete()
 * or store.deleteMany() anywhere else — route every store deletion through here.
 *
 * Every FK to Store is ON DELETE CASCADE, so deleting the row erases all related
 * data atomically. Because that is now irreversible in a single statement, this
 * function refuses to delete an ACTIVE install — accessToken present AND
 * uninstalledAt null — and reports "skipped_active_install" instead. That guard
 * is the safety catch the RESTRICT constraints used to provide implicitly.
 *
 * The guard is enforced inside deleteMany's WHERE, so it is atomic: a store that
 * becomes active between the read and the delete matches zero rows and is
 * skipped, with no time-of-check/time-of-use race.
 */
export async function deleteStoreCompletely(
  storeId: string,
  reason: "shop_redact" | "retention_sweep"
): Promise<StoreDeletionOutcome> {
  const store = await prisma.store.findUnique({
    where: { id: storeId },
    select: { id: true, shop: true, accessToken: true, uninstalledAt: true },
  });

  if (!store) {
    return { outcome: "not_found" };
  }

  const isActiveInstall =
    store.accessToken !== null && store.uninstalledAt === null;

  if (isActiveInstall) {
    logEvent("warn", "privacy.store_delete_skipped_active", {
      storeId: store.id,
      shop: store.shop,
      reason,
    });
    return { outcome: "skipped_active_install", storeId: store.id, shop: store.shop };
  }

  // Re-check the guard atomically in the WHERE: delete only if NOT an active
  // install (accessToken null OR uninstalledAt set).
  const res = await prisma.store.deleteMany({
    where: {
      id: storeId,
      OR: [{ accessToken: null }, { uninstalledAt: { not: null } }],
    },
  });

  if (res.count === 0) {
    // Zero rows matched after we read it: either it was deleted concurrently,
    // or it turned into an active install in the gap. Distinguish for honesty.
    const still = await prisma.store.findUnique({
      where: { id: storeId },
      select: { id: true },
    });
    if (!still) {
      return { outcome: "not_found" };
    }
    logEvent("warn", "privacy.store_delete_skipped_active", {
      storeId: store.id,
      shop: store.shop,
      reason,
      note: "became active between read and delete",
    });
    return { outcome: "skipped_active_install", storeId: store.id, shop: store.shop };
  }

  logEvent("info", "privacy.store_deleted", {
    storeId: store.id,
    shop: store.shop,
    reason,
  });
  return { outcome: "deleted", storeId: store.id, shop: store.shop };
}

export async function exportCustomerDataRequest(
  shopDomain: string,
  payload: Record<string, any>
) {
  const store = await findStore(shopDomain);

  if (!store) {
    // Unknown shop — no data held here to export. Success, nothing written.
    logEvent("info", "privacy.customer_data_request_no_store", {
      shop: shopDomain,
    });
    return { outputPath: null, customerFound: false, orderCount: 0, fraudSignalCount: 0 };
  }

  const customerId = normalizeCustomerId(
    payload.customer?.id ?? payload.customer_id ?? payload.customerId
  );
  const customerEmail =
    typeof payload.customer?.email === "string" ? payload.customer.email : null;

  const customer = customerId
    ? await prisma.customer.findFirst({
        where: {
          storeId: store.id,
          OR: [
            { shopifyCustomerId: customerId },
            ...(customerEmail ? [{ email: customerEmail }] : []),
          ],
        },
        include: {
          orders: true,
          fraudSignals: true,
        },
      })
    : customerEmail
    ? await prisma.customer.findFirst({
        where: {
          storeId: store.id,
          email: customerEmail,
        },
        include: {
          orders: true,
          fraudSignals: true,
        },
      })
    : null;

  const exportPayload = {
    requestedAt: new Date().toISOString(),
    shop: shopDomain,
    shopifyRequest: payload,
    customer: customer
      ? {
          shopifyCustomerId: customer.shopifyCustomerId,
          email: customer.email,
          creditScore: customer.creditScore,
          creditCategory: customer.creditCategory,
          totalOrders: customer.totalOrders,
          totalRefunds: customer.totalRefunds,
        }
      : null,
    orders:
      customer?.orders.map((order) => ({
        shopifyOrderId: order.shopifyOrderId,
        totalAmount: order.totalAmount,
        currency: order.currency,
        status: order.status,
        refunded: order.refunded,
        refundRequested: order.refundRequested,
        createdAt: order.createdAt,
      })) ?? [],
    fraudSignals:
      customer?.fraudSignals.map((signal) => ({
        riskScore: signal.riskScore,
        riskLevel: signal.riskLevel,
        createdAt: signal.createdAt,
      })) ?? [],
  };

  const filename = `customer-data-request-${shopDomain.replace(
    /\.myshopify\.com$/i,
    ""
  )}-${Date.now()}.json`;
  const outputPath = runtimeExportPath(filename);

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify(exportPayload, null, 2), "utf8");

  logEvent("info", "privacy.customer_data_request_exported", {
    shop: shopDomain,
    outputPath,
    customerFound: !!customer,
  });

  return {
    outputPath,
    customerFound: !!customer,
    orderCount: exportPayload.orders.length,
    fraudSignalCount: exportPayload.fraudSignals.length,
  };
}

export async function redactCustomerData(
  shopDomain: string,
  payload: Record<string, any>
) {
  const store = await findStore(shopDomain);
  const customerId = normalizeCustomerId(
    payload.customer?.id ?? payload.customer_id ?? payload.customerId
  );

  if (!store) {
    // Unknown shop — nothing of this customer's is stored here. Success.
    return { redacted: false, reason: "store_not_found" };
  }

  if (!customerId) {
    // Do not log the raw payload: it can contain the customer's email/PII.
    logEvent("warn", "privacy.customer_redact_missing_customer_id", {
      shop: shopDomain,
    });

    return {
      redacted: false,
      reason: "missing_customer_id",
    };
  }

  const customer = await prisma.customer.findFirst({
    where: {
      storeId: store.id,
      shopifyCustomerId: customerId,
    },
  });

  if (!customer) {
    return {
      redacted: false,
      reason: "customer_not_found",
    };
  }

  await prisma.$transaction(async (tx) => {
    // TimelineEvent carries customerId plus free-text title/detail/metadataJson,
    // and metadataJson embeds the raw customer email (see coreEngineService
    // trust_profile_scored events). These rows are derived analytics,
    // reconstructible from source data, so they are DELETED rather than
    // field-stripped — surgically editing opaque JSON is fragile and would
    // silently miss any field added later. Deleting by customerId is provably
    // complete for this customer's timeline PII.
    await tx.timelineEvent.deleteMany({
      where: { customerId: customer.id },
    });

    await tx.fraudSignal.updateMany({
      where: {
        customerId: customer.id,
      },
      data: {
        customerId: null,
        email: null,
        shippingAddress: null,
        ipAddress: null,
        deviceFingerprint: null,
        paymentFingerprint: null,
        // sharedNetworkHash is sha256(email|deviceFP|paymentFP|shippingAddress).
        // A hash of personal data is still personal data, so nulling the source
        // fields while keeping the hash would be an incomplete anonymisation.
        sharedNetworkHash: null,
      },
    });

    await tx.order.updateMany({
      where: {
        customerId: customer.id,
      },
      data: {
        customerId: null,
      },
    });

    await tx.customer.update({
      where: { id: customer.id },
      data: {
        email: redactEmail(customer.email),
        totalOrders: 0,
        totalRefunds: 0,
        refundRate: 0,
        fraudSignalsCount: 0,
        paymentReliability: 0,
        creditScore: 0,
        creditCategory: "Redacted",
      },
    });
  });

  logEvent("info", "privacy.customer_redacted", {
    shop: shopDomain,
    customerId,
  });

  return {
    redacted: true,
    customerId,
  };
}

export type ShopRedactResult =
  | { redacted: true; shop: string }
  | { redacted: false; reason: "not_found" | "skipped_active_install" };

export async function redactShopData(
  shopDomain: string
): Promise<ShopRedactResult> {
  const store = await findStore(shopDomain);

  if (!store) {
    // Unknown shop, or already erased by a prior delivery (Shopify retries).
    // Nothing to do — this is success, not failure.
    return { redacted: false, reason: "not_found" };
  }

  // All deletion goes through the single guarded path. A throw here is a real
  // DB failure and must propagate so the webhook handler returns 500.
  const result = await deleteStoreCompletely(store.id, "shop_redact");

  switch (result.outcome) {
    case "deleted":
      logEvent("info", "privacy.shop_redacted", { shop: shopDomain });
      return { redacted: true, shop: shopDomain };
    case "not_found":
      return { redacted: false, reason: "not_found" };
    case "skipped_active_install":
      // The shop reinstalled since the uninstall that triggered this webhook.
      // We must not erase a live store; acknowledging without deleting is
      // correct and the handler returns 200.
      return { redacted: false, reason: "skipped_active_install" };
  }
}

import { env } from "../config/env";
import { prisma } from "../db/prismaClient";
import { logEvent } from "./observabilityService";
import { redactShopData } from "./privacyService";

let sweepTimer: NodeJS.Timeout | null = null;

/**
 * Delete personal data for stores that uninstalled longer ago than the
 * configured retention period.
 *
 * Shopify normally sends shop/redact about 48 hours after an uninstall, and
 * that handler already deletes everything. This sweep is the backstop for the
 * case where the webhook never arrives or fails permanently — without it, a
 * missed redact would leave customer and order records in the database
 * indefinitely, and no bounded retention period could honestly be claimed.
 *
 * Only stores with `uninstalledAt` set are considered. A reinstall clears that
 * field in `persistInstallationRecord`, so an active installation is never
 * touched no matter how long ago it was first installed.
 */
export async function purgeExpiredUninstalledStores() {
  const retentionDays = env.dataRetention.uninstalledStoreDays;

  if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
    return { scanned: 0, purged: 0, failed: 0, skipped: true as const };
  }

  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

  const expired = await prisma.store.findMany({
    where: {
      uninstalledAt: { not: null, lt: cutoff },
    },
    select: { shop: true, uninstalledAt: true },
  });

  if (expired.length === 0) {
    return { scanned: 0, purged: 0, failed: 0, skipped: false as const };
  }

  let purged = 0;
  let failed = 0;

  for (const store of expired) {
    try {
      // Reuse the compliance deletion path so retention and shop/redact can
      // never drift apart on what counts as "all of a store's data".
      await redactShopData(store.shop);
      purged += 1;

      logEvent("info", "data_retention.store_purged", {
        shop: store.shop,
        uninstalledAt: store.uninstalledAt?.toISOString() ?? null,
        retentionDays,
      });
    } catch (error) {
      failed += 1;
      logEvent("error", "data_retention.store_purge_failed", {
        shop: store.shop,
        error,
      });
    }
  }

  logEvent("info", "data_retention.sweep_completed", {
    scanned: expired.length,
    purged,
    failed,
    retentionDays,
    cutoff: cutoff.toISOString(),
  });

  return { scanned: expired.length, purged, failed, skipped: false as const };
}

/**
 * Run the retention sweep on an interval for the lifetime of the process.
 *
 * The timer is unref'd so it never holds the process open during shutdown, and
 * failures are logged rather than thrown — a failed sweep must not take down
 * the web service, and the next interval will retry.
 */
export function startDataRetentionSweep() {
  const retentionDays = env.dataRetention.uninstalledStoreDays;
  const intervalHours = env.dataRetention.sweepIntervalHours;

  if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
    logEvent("info", "data_retention.disabled", { retentionDays });
    return;
  }

  if (sweepTimer) {
    return;
  }

  const run = () => {
    void purgeExpiredUninstalledStores().catch((error) => {
      logEvent("error", "data_retention.sweep_failed", { error });
    });
  };

  // Delay the first run so it never competes with startup work (migrations,
  // first requests) on a cold boot.
  const startupDelayMs = 5 * 60 * 1000;
  const intervalMs = Math.max(1, intervalHours) * 60 * 60 * 1000;

  const startupTimer = setTimeout(run, startupDelayMs);
  startupTimer.unref?.();

  sweepTimer = setInterval(run, intervalMs);
  sweepTimer.unref?.();

  logEvent("info", "data_retention.sweep_scheduled", {
    retentionDays,
    intervalHours,
  });
}

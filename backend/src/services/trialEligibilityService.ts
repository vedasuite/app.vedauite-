import { prisma } from "../db/prismaClient";
import { env } from "../config/env";
import { addDaysUtc } from "../billing/trialState";
import { logEvent } from "./observabilityService";

export type TrialWindow = { trialStartedAt: Date; trialEndsAt: Date };

/**
 * The single durable gate on trial grants — enforces one trial per shop for
 * the lifetime of the shop's relationship with the app, independent of
 * whether the Store row itself has ever been deleted and recreated.
 *
 * `ShopTrialHistory` has no relation to Store and is never deleted by
 * shop/redact or the retention sweep (see schema.prisma doc comment), so it
 * is the durable source of truth this function reads first.
 *
 * `candidateStoreWindow` is whatever trial dates (if any) already exist on
 * the current Store row. It is used only to backfill history for a shop
 * that predates this table — it never seeds a *new* window when durable
 * history already exists, and it never overrides history.
 *
 * Fails closed: any DB error returns null (no trial dates), logs a
 * manual-review event, and never falls back to guessing "now + N days".
 */
export async function resolveTrialWindowForInstall(
  shop: string,
  installMoment: Date,
  candidateStoreWindow: TrialWindow | null
): Promise<TrialWindow | null> {
  try {
    const existingHistory = await prisma.shopTrialHistory.findUnique({
      where: { shop },
    });

    if (existingHistory) {
      return {
        trialStartedAt: existingHistory.trialStartedAt,
        trialEndsAt: existingHistory.trialEndsAt,
      };
    }

    if (candidateStoreWindow) {
      // No durable history yet, but the Store row already carries a trial
      // window — this shop predates ShopTrialHistory. Backfill from it
      // rather than granting a new one.
      const backfilled = await createHistoryRowSafely(shop, {
        firstInstalledAt: installMoment,
        trialStartedAt: candidateStoreWindow.trialStartedAt,
        trialEndsAt: candidateStoreWindow.trialEndsAt,
      });
      if (backfilled) {
        logEvent("info", "billing.trial_history_backfilled", {
          shop,
          trialStartedAt: backfilled.trialStartedAt.toISOString(),
          trialEndsAt: backfilled.trialEndsAt.toISOString(),
        });
      }
      return backfilled;
    }

    // No durable history and no existing Store trial dates — this is a
    // genuine first installation. Grant exactly once, recorded durably.
    const trialStartedAt = installMoment;
    const trialEndsAt = addDaysUtc(installMoment, env.billing.trialDays);
    const granted = await createHistoryRowSafely(shop, {
      firstInstalledAt: installMoment,
      trialStartedAt,
      trialEndsAt,
    });

    if (granted) {
      logEvent("info", "billing.trial_history_recorded", {
        shop,
        trialStartedAt: granted.trialStartedAt.toISOString(),
        trialEndsAt: granted.trialEndsAt.toISOString(),
      });
    }

    return granted;
  } catch (error) {
    logEvent("error", "billing.trial_eligibility_check_failed", {
      shop,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function createHistoryRowSafely(
  shop: string,
  data: { firstInstalledAt: Date; trialStartedAt: Date; trialEndsAt: Date }
): Promise<TrialWindow | null> {
  try {
    const created = await prisma.shopTrialHistory.create({
      data: { shop, ...data },
    });
    return {
      trialStartedAt: created.trialStartedAt,
      trialEndsAt: created.trialEndsAt,
    };
  } catch (error) {
    // Unique-constraint race: a concurrent request created it first. Re-read
    // and use whichever row actually won — never invent a second window.
    if ((error as { code?: string } | null)?.code === "P2002") {
      const existing = await prisma.shopTrialHistory.findUnique({
        where: { shop },
      });
      if (existing) {
        return {
          trialStartedAt: existing.trialStartedAt,
          trialEndsAt: existing.trialEndsAt,
        };
      }
    }
    throw error;
  }
}

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
 * Plan-selected trial model: the trial begins at the moment Shopify
 * approves a plan (STARTER/GROWTH/PRO) — never at install, and never before
 * the merchant has chosen anything. Call this only from
 * billingManagementService.confirmBillingApprovalReturn, immediately after
 * Shopify's approval is confirmed. `approvalMoment` is that confirmation
 * instant, not the original install time.
 *
 * `ShopTrialHistory` has no relation to Store and is never deleted by
 * shop/redact or the retention sweep (see schema.prisma doc comment), so it
 * is the durable source of truth this function reads first — a shop that
 * already has a history record (even from a prior approval, a prior
 * install-time grant under the old model, or after a full data purge and
 * reinstall) NEVER gets a second window, regardless of when this is called.
 *
 * `candidateStoreWindow` is whatever trial dates (if any) already exist on
 * the current Store row. It is used only to backfill history for a shop
 * that predates this table — it never seeds a *new* window when durable
 * history already exists, and it never overrides history.
 *
 * Never fabricates dates. A DB failure is logged and then RE-THROWN rather
 * than returning null: the merchant already has a Shopify-approved
 * subscription at this point, so silently losing their promised trial is not
 * an acceptable outcome. Propagating lets the caller fail visibly — the
 * webhook handler returns non-2xx so Shopify redelivers on its own durable
 * retry schedule, and the browser-redirect path shows a recoverable error.
 * Retries converge safely because this function grants at most one window
 * per shop, ever.
 */
export async function resolveTrialWindowOnApproval(
  shop: string,
  approvalMoment: Date,
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
      // window — this shop predates ShopTrialHistory (e.g. granted under the
      // old install-time model). Backfill from it rather than granting a
      // new one.
      const backfilled = await createHistoryRowSafely(shop, {
        firstInstalledAt: approvalMoment,
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

    // No durable history and no existing Store trial dates — this shop has
    // genuinely never had a trial before. Grant exactly once, starting now
    // (plan-approval time), recorded durably.
    const trialStartedAt = approvalMoment;
    const trialEndsAt = addDaysUtc(approvalMoment, env.billing.trialDays);
    const granted = await createHistoryRowSafely(shop, {
      firstInstalledAt: approvalMoment,
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
      retryable: true,
      error: error instanceof Error ? error.message : String(error),
    });
    // Re-thrown deliberately — see the doc comment above. Never return null
    // here: that would hand the caller a "no trial" result indistinguishable
    // from a legitimate no-trial outcome, permanently losing the trial of a
    // merchant whose subscription was already approved.
    throw error;
  }
}

/**
 * Read-only: returns the shop's durable trial window from ShopTrialHistory,
 * or null if none exists yet.
 *
 * Used before creating a Shopify subscription — including a plan-switch
 * replacement — to determine Shopify's own `trialDays` for that call:
 *   - null (no history)       -> genuinely first-ever approval
 *   - history, still open     -> a plan switch mid-trial — the caller must
 *                                use the WHOLE remaining days, never a flat 0
 *                                (early charge) or a flat full trialDays
 *                                (second trial)
 *   - history, already closed -> normal immediate billing
 *
 * Deliberately does NOT create a history row (nothing has been approved by
 * Shopify yet at the point this is called) and deliberately does NOT catch
 * errors — a DB failure here should fail the whole billing-change request
 * (the caller's existing error handling does this safely) rather than
 * silently guessing a trialDays value that could charge a merchant early or
 * hand them a bonus window.
 */
export async function getExistingTrialWindow(shop: string): Promise<TrialWindow | null> {
  const existing = await prisma.shopTrialHistory.findUnique({ where: { shop } });
  if (!existing) {
    return null;
  }
  return { trialStartedAt: existing.trialStartedAt, trialEndsAt: existing.trialEndsAt };
}

/**
 * Read-only check: has this shop already used its one durable trial? Fails
 * closed: a DB error here is treated as "already used" (returns true), so
 * a transient failure can only ever be too conservative — never
 * accidentally grant an extra free window.
 */
export async function hasExistingTrialHistory(shop: string): Promise<boolean> {
  try {
    return (await getExistingTrialWindow(shop)) !== null;
  } catch (error) {
    logEvent("error", "billing.trial_eligibility_check_failed", {
      shop,
      context: "pre_approval_shopify_trial_days_check",
      error: error instanceof Error ? error.message : String(error),
    });
    return true;
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

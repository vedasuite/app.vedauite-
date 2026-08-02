/**
 * The single canonical trial predicate. Every backend surface (Billing,
 * Dashboard, Onboarding, app-state, entitlement resolution) must derive
 * "is the trial active" from this module and nothing else — no
 * `planName === "TRIAL"` inference, no independent `isDateInFuture` checks,
 * no frontend fallback duration.
 *
 * The rule is intentionally the simplest possible one, and it is additive
 * with paid-subscription state: a merchant can simultaneously have an active
 * Shopify subscription for STARTER/GROWTH/PRO *and* an open local trial
 * window. Whether a paid subscription exists must never suppress this
 * predicate — see subscriptionService.ts `resolveBillingState`.
 */

export const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Deterministic UTC-safe "add N days" — a fixed millisecond offset, immune to
 * local timezone/DST boundary shifts. Never use `Date#setDate`/`getDate` for
 * trial arithmetic; those operate in the host's local calendar.
 */
export function addDaysUtc(start: Date, days: number): Date {
  return new Date(start.getTime() + days * MS_PER_DAY);
}

export type PersistedTrialDates = {
  trialStartedAt: Date | null;
  trialEndsAt: Date | null;
};

export type CanonicalTrialState = {
  /** True iff trialEndsAt is persisted and strictly later than now. */
  trialActive: boolean;
  trialStartedAt: string | null;
  trialEndsAt: string | null;
  /** Whole days remaining, 0 when not active. Ceil of the remaining ms. */
  trialDaysRemaining: number;
  /**
   * True when trialStartedAt/trialEndsAt are not both persisted. Read paths
   * must surface this as a safe "incomplete" signal — never invent dates to
   * fill the gap.
   */
  trialDatesIncomplete: boolean;
};

/**
 * Pure, read-only, UTC-safe. Never writes anything — callers on a read path
 * (GET /api/app-state, GET /api/subscription/plan, resolveBillingState,
 * resolveEntitlements) must call this instead of initializing/backfilling
 * dates. Trial dates are written exactly once, only on genuine first
 * installation (see authRoutes.ts persistInstallationRecord and
 * shopifyConnectionService.ts exchangeSessionTokenForOfflineToken's create
 * branch).
 */
export function computeTrialState(
  input: PersistedTrialDates,
  now: number = Date.now()
): CanonicalTrialState {
  const { trialStartedAt, trialEndsAt } = input;

  if (!trialStartedAt || !trialEndsAt) {
    return {
      trialActive: false,
      trialStartedAt: trialStartedAt?.toISOString() ?? null,
      trialEndsAt: trialEndsAt?.toISOString() ?? null,
      trialDaysRemaining: 0,
      trialDatesIncomplete: true,
    };
  }

  const active = trialEndsAt.getTime() > now;
  const trialDaysRemaining = active
    ? Math.max(0, Math.ceil((trialEndsAt.getTime() - now) / MS_PER_DAY))
    : 0;

  return {
    trialActive: active,
    trialStartedAt: trialStartedAt.toISOString(),
    trialEndsAt: trialEndsAt.toISOString(),
    trialDaysRemaining,
    trialDatesIncomplete: false,
  };
}

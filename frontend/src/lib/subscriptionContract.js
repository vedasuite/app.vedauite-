/**
 * Decides when a missing field in a subscription payload is genuine
 * backend/frontend contract drift worth warning about.
 *
 * THE BUG THIS FIXES: normalizeBillingState() reuses normalizeSubscriptionInfo()
 * as a defaulting helper by casting a BillingState to Partial<SubscriptionInfo>.
 * BillingState legitimately has no trialDays - it was never part of that
 * contract - so every billing-state normalisation logged
 *
 *   "[billing] subscription payload missing trialDays while trialActive is true"
 *
 * That is a false positive. It was not backend drift: /api/subscription/plan
 * does return trialDays (CurrentSubscription in backend/src/billing/capabilities.ts,
 * populated in subscriptionService.ts).
 *
 * The warning still has real value on genuine subscription payloads, so it is
 * gated rather than removed: callers state which contract they are normalising.
 *
 * Plain ESM JavaScript so the regression tests import and execute this exact
 * module rather than a copy of the rule.
 */

/** Payload kinds that flow through normalizeSubscriptionInfo. */
export const SUBSCRIPTION_CONTRACT = "subscription";
export const BILLING_STATE_CONTRACT = "billing-state";

/**
 * True only when the payload is a real subscription payload AND the field is
 * genuinely absent.
 *
 * @param {{contract?: string, value?: unknown, present: boolean}} input
 * @returns {boolean}
 */
export function shouldWarnMissingField(input) {
  const { contract = SUBSCRIPTION_CONTRACT, present } = input ?? {};

  // Only the subscription contract promises these fields. Normalising any
  // other shape through the same helper must stay silent.
  if (contract !== SUBSCRIPTION_CONTRACT) {
    return false;
  }

  return !present;
}

/**
 * True when `value` is a usable trialDays number.
 * @param {unknown} value
 */
export function hasTrialDays(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * True when `value` is a usable trialActive boolean.
 * @param {unknown} value
 */
export function hasTrialActive(value) {
  return typeof value === "boolean";
}

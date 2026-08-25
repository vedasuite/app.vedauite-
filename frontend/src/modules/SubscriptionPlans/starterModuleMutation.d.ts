/**
 * Types for starterModuleMutation.js.
 *
 * Plain ESM JavaScript so the backend test runner can execute the exact shipped
 * rule. Without a declaration file every import was `any` (TS7016) — on a
 * function that decides whether changing a Starter plan's selected module needs
 * a fresh BILLING APPROVAL. An untyped argument there means a caller could pass
 * the wrong field, get `false`, and silently skip Shopify's approval step.
 */

export type StarterModuleMutationInput = {
  /**
   * The plan the merchant is currently on.
   *
   * Optional because the caller reads it from a subscription payload that may
   * not have loaded yet. The implementation compares with `===`, so an absent
   * value simply fails the STARTER check and returns false — and the only
   * consequence is which toast is shown, since the redirect to Shopify happens
   * either way and the backend owns the actual approval.
   */
  currentPlanName?: string;
  /** Whether that subscription is currently active. Optional for the same reason. */
  currentActive?: boolean;
  /** The plan being requested. */
  requestedPlanName: string;
  /** The Starter module being requested, if any. */
  requestedStarterModule?: string | null;
  /** The Starter module currently selected, if any. */
  currentStarterModule?: string | null;
};

/**
 * True when the merchant is switching which single module their ACTIVE Starter
 * plan covers — the one case where the plan name does not change but the
 * entitlement does, so Shopify still has to approve it.
 */
export function shouldRequireStarterModuleBillingApproval(
  input: StarterModuleMutationInput
): boolean;

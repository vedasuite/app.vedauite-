/** Types for subscriptionContract.js. */

export const SUBSCRIPTION_CONTRACT: "subscription";
export const BILLING_STATE_CONTRACT: "billing-state";

export function shouldWarnMissingField(input: {
  contract?: string;
  value?: unknown;
  present: boolean;
}): boolean;

export function hasTrialDays(value: unknown): boolean;
export function hasTrialActive(value: unknown): boolean;

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

/**
 * SUBSCRIPTION CONTRACT WARNINGS.
 *
 * REPRODUCES the console warning seen throughout the staging lifecycle:
 *
 *   "[billing] subscription payload missing trialDays while trialActive is
 *    true - reporting 0 instead of guessing a duration."
 *
 * It was NOT backend drift. /api/subscription/plan does return trialDays -
 * CurrentSubscription declares it (backend/src/billing/capabilities.ts) and
 * subscriptionService.ts populates it.
 *
 * The real cause: normalizeBillingState() reuses normalizeSubscriptionInfo()
 * as a defaulting helper by casting a BillingState to Partial<SubscriptionInfo>.
 * BillingState never carried trialDays, so every billing-state normalisation
 * logged a false positive.
 *
 * The warning still matters for genuine subscription payloads, so it is gated
 * by contract rather than deleted. These tests execute the real rule.
 */

const FRONTEND = path.resolve(__dirname, "../../frontend/src");
const CONTRACT_URL = pathToFileURL(
  path.join(FRONTEND, "lib/subscriptionContract.js")
).href;
const CAPABILITIES_SRC = path.join(FRONTEND, "lib/billingCapabilities.ts");
const BACKEND_CAPABILITIES = path.resolve(
  __dirname,
  "../src/billing/capabilities.ts"
);

let SUBSCRIPTION_CONTRACT;
let BILLING_STATE_CONTRACT;
let shouldWarnMissingField;
let hasTrialDays;
let hasTrialActive;

test.before(async () => {
  const mod = await import(CONTRACT_URL);
  ({
    SUBSCRIPTION_CONTRACT,
    BILLING_STATE_CONTRACT,
    shouldWarnMissingField,
    hasTrialDays,
    hasTrialActive,
  } = mod);
});

// ===========================================================================
// The false positive must be gone
// ===========================================================================

test("REPRO: a billing-state payload missing trialDays must NOT warn", () => {
  assert.equal(
    shouldWarnMissingField({
      contract: BILLING_STATE_CONTRACT,
      present: hasTrialDays(undefined),
    }),
    false,
    "BillingState never promised trialDays — warning about it is a false positive"
  );
});

test("REPRO: a billing-state payload missing trialActive must NOT warn", () => {
  assert.equal(
    shouldWarnMissingField({
      contract: BILLING_STATE_CONTRACT,
      present: hasTrialActive(undefined),
    }),
    false
  );
});

test("REPRO: no billing-state shape produces a warning", () => {
  // Every field combination a BillingState can present.
  for (const value of [undefined, null, 0, 7, "7", NaN, {}]) {
    assert.equal(
      shouldWarnMissingField({
        contract: BILLING_STATE_CONTRACT,
        present: hasTrialDays(value),
      }),
      false,
      `billing-state must stay silent for trialDays=${String(value)}`
    );
  }
});

// ===========================================================================
// Genuine drift must still be caught
// ===========================================================================

test("GENUINE: a subscription payload missing trialDays still warns", () => {
  assert.equal(
    shouldWarnMissingField({
      contract: SUBSCRIPTION_CONTRACT,
      present: hasTrialDays(undefined),
    }),
    true,
    "real backend/frontend drift must remain visible"
  );
});

test("GENUINE: the default contract is the subscription contract", () => {
  // A caller that forgets to declare a contract must get the strict behaviour,
  // so silence is never the accidental default.
  assert.equal(shouldWarnMissingField({ present: false }), true);
  assert.equal(shouldWarnMissingField({ present: true }), false);
});

test("GENUINE: a present trialDays does not warn", () => {
  for (const value of [0, 3, 7, 14]) {
    assert.equal(hasTrialDays(value), true, `${value} is a usable trialDays`);
    assert.equal(
      shouldWarnMissingField({
        contract: SUBSCRIPTION_CONTRACT,
        present: hasTrialDays(value),
      }),
      false
    );
  }
});

test("GENUINE: a non-numeric trialDays counts as missing", () => {
  // The frontend reports 0 rather than guessing, so this must still be flagged.
  for (const value of [undefined, null, "7", NaN, Infinity, {}, []]) {
    assert.equal(hasTrialDays(value), false, `${String(value)} is not a usable trialDays`);
  }
});

test("GENUINE: trialActive must be a real boolean", () => {
  assert.equal(hasTrialActive(true), true);
  assert.equal(hasTrialActive(false), true);
  for (const value of [undefined, null, "true", 1, 0, {}]) {
    assert.equal(hasTrialActive(value), false);
  }
});

// ===========================================================================
// Wiring
// ===========================================================================

test("WIRING: normalizeBillingState declares the billing-state contract", () => {
  const src = fs.readFileSync(CAPABILITIES_SRC, "utf8");
  const fn = src.match(/export function normalizeBillingState[\s\S]*?\n\}/);
  assert.ok(fn, "normalizeBillingState must exist");
  assert.match(
    fn[0],
    /BILLING_STATE_CONTRACT/,
    "it must declare that it is not normalising a subscription payload"
  );
});

test("WIRING: both warnings are gated by the shared rule", () => {
  const src = fs.readFileSync(CAPABILITIES_SRC, "utf8");
  const warnCount = (src.match(/shouldWarnMissingField\(/g) ?? []).length;
  assert.equal(warnCount, 2, "both trialActive and trialDays warnings must be gated");

  // The raw unguarded checks must not come back.
  assert.doesNotMatch(
    src,
    /if \(typeof value\.trialDays !== "number" && typeof console/,
    "the ungated trialDays warning must not return"
  );
});

test("WIRING: the backend genuinely does supply trialDays", () => {
  // The premise of the fix: this was never backend drift. If trialDays ever
  // leaves CurrentSubscription, the warning becomes real and this must fail.
  const backend = fs.readFileSync(BACKEND_CAPABILITIES, "utf8");
  const type = backend.match(/export type CurrentSubscription = \{[\s\S]*?\n\};/);
  assert.ok(type, "CurrentSubscription must exist");
  assert.match(
    type[0],
    /\btrialDays: number;/,
    "CurrentSubscription must still declare trialDays"
  );

  const service = fs.readFileSync(
    path.resolve(__dirname, "../src/services/subscriptionService.ts"),
    "utf8"
  );
  assert.match(
    service,
    /trialDays: env\.billing\.trialDays/,
    "the subscription payload must still populate trialDays"
  );
});

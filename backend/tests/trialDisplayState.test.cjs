const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

process.env.SHOPIFY_API_KEY ||= "test-key";
process.env.SHOPIFY_API_SECRET ||= "test-secret";
process.env.SHOPIFY_APP_URL ||= "https://app.vedasuite.in";
process.env.DATABASE_URL ||= "postgresql://example:example@localhost:5432/example";

function mockModule(relPath, exports) {
  const abs = require.resolve(path.resolve(__dirname, relPath));
  require.cache[abs] = { id: abs, filename: abs, loaded: true, exports };
}

mockModule("../dist/db/prismaClient.js", { prisma: {} });
mockModule("../dist/services/observabilityService.js", { logEvent: () => {} });

const { buildCanonicalEntitlements } = require(
  path.resolve(__dirname, "../dist/services/subscriptionService.js")
);

/**
 * The trial UI on Onboarding and the Dashboard renders from the canonical
 * entitlement state — `tier === "trial"` — and shows `planName` as the plan
 * that begins afterwards. These tests pin that contract so the three surfaces
 * cannot drift, and so nothing starts inferring a trial from a date.
 */
function entitlements({ planName, starterModule = null, accessActive, trialActive }) {
  return buildCanonicalEntitlements({
    planName,
    starterModule,
    accessActive,
    verified: true,
    trialActive,
  });
}

test("active trial reports tier=trial and retains the selected paid plan for display", () => {
  for (const selectedPlan of ["STARTER", "GROWTH", "PRO"]) {
    const state = entitlements({
      planName: selectedPlan,
      starterModule: selectedPlan === "STARTER" ? "fraud" : null,
      accessActive: false, // not yet charged — the trial is what grants access
      trialActive: true,
    });

    assert.equal(state.tier, "trial", `${selectedPlan} trial must report tier=trial`);
    assert.equal(
      state.planName,
      selectedPlan,
      "the selected post-trial plan must be preserved for display"
    );
    assert.equal(state.accessActive, true, "an active trial grants access");
    assert.match(state.title, /trial/i);
  }
});

test("active trial title and description avoid the confusing 'TRIAL plan' wording", () => {
  const state = entitlements({ planName: "GROWTH", accessActive: false, trialActive: true });
  assert.equal(state.title, "7-day full-access trial");
  assert.doesNotMatch(
    state.description,
    /your TRIAL plan/i,
    "must never describe TRIAL as the future paid plan"
  );
  assert.match(state.description, /GROWTH/);
});

test("a legacy TRIAL plan inside an open window never names TRIAL as the future paid plan", () => {
  const state = entitlements({ planName: "TRIAL", accessActive: false, trialActive: true });

  assert.equal(state.tier, "trial");
  assert.doesNotMatch(
    state.description,
    /\bTRIAL starts\b/i,
    "TRIAL is not a chargeable plan and must not be named as the next one"
  );
  assert.match(state.description, /selected subscription/i, "safe neutral fallback copy");
});

test("expired trial without a subscription is not reported as a trial", () => {
  const state = entitlements({ planName: "NONE", accessActive: false, trialActive: false });

  assert.notEqual(state.tier, "trial", "an expired trial must not report tier=trial");
  assert.equal(state.accessActive, false);
  assert.match(state.description, /choose a plan/i);
});

test("a legacy standalone TRIAL plan with a closed window is not reported as a trial", () => {
  const state = entitlements({ planName: "TRIAL", accessActive: false, trialActive: false });

  assert.notEqual(state.tier, "trial");
  assert.equal(state.planName, "NONE", "legacy TRIAL collapses rather than granting access");
  assert.equal(state.accessActive, false);
});

test("active paid subscription is not reported as a trial", () => {
  const state = entitlements({ planName: "GROWTH", accessActive: true, trialActive: false });

  assert.notEqual(state.tier, "trial", "a paid plan must not show trial messaging");
  assert.equal(state.tier, "growth");
  assert.equal(state.accessActive, true);
});

test("no plan and no trial reports no access and no trial", () => {
  const state = entitlements({ planName: "NONE", accessActive: false, trialActive: false });

  assert.equal(state.tier, "none");
  assert.notEqual(state.tier, "trial");
});

test("a trial cannot be inferred without a selected plan", () => {
  // trialActive alone must not manufacture access when no plan was chosen —
  // this is what stops a stale trialEndsAt from unlocking modules.
  const state = entitlements({ planName: "NONE", accessActive: false, trialActive: true });

  assert.notEqual(state.tier, "trial");
  assert.equal(state.accessActive, false);
});

test("Starter selection survives the trial so it is already set when billing starts", () => {
  const state = entitlements({
    planName: "STARTER",
    starterModule: "competitor",
    accessActive: false,
    trialActive: true,
  });

  assert.equal(state.tier, "trial");
  assert.equal(state.planName, "STARTER");
  assert.equal(state.starterModule, "competitor");
});

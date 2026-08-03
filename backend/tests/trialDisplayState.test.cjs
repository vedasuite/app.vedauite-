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
 * Plan-selected trial model (2026-08-03): the trial only starts once a plan
 * is approved in Shopify, and `tier` reports that SELECTED plan's tier
 * throughout — trial or paid, it's the same tier, because the trial does
 * not widen entitlements to every module. `trialActive`-driven copy
 * ("Starter trial active") is what distinguishes "not yet billed" from
 * "paid", not a separate "trial" tier. These tests pin that contract so
 * Onboarding, Dashboard and Billing cannot drift apart.
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

test("active trial reports the SELECTED plan's own tier and retains the plan for display", () => {
  const expectedTier = { STARTER: "starter", GROWTH: "growth", PRO: "pro" };
  for (const selectedPlan of ["STARTER", "GROWTH", "PRO"]) {
    const state = entitlements({
      planName: selectedPlan,
      starterModule: selectedPlan === "STARTER" ? "fraud" : null,
      accessActive: false, // not yet charged — the trial is what grants access
      trialActive: true,
    });

    assert.equal(
      state.tier,
      expectedTier[selectedPlan],
      `${selectedPlan} trial must report its own tier, not a generic "trial" tier`
    );
    assert.equal(
      state.planName,
      selectedPlan,
      "the selected plan must be preserved for display"
    );
    assert.equal(state.accessActive, true, "an active trial grants access");
    assert.match(state.title, /trial/i);
    assert.match(state.title, new RegExp(selectedPlan, "i"), "title must name the selected plan, not a generic trial");
  }
});

test("active trial title and description name the selected plan, never generic 'full-access'", () => {
  const state = entitlements({ planName: "GROWTH", accessActive: false, trialActive: true });
  assert.equal(state.title, "Growth trial active");
  assert.doesNotMatch(
    state.description,
    /your TRIAL plan/i,
    "must never describe TRIAL as the plan"
  );
  assert.match(state.description, /Growth/);
  assert.match(state.description, /not.*charged/i, "must state Shopify has not billed yet");
});

test("a legacy TRIAL plan name never grants access, open window or not", () => {
  // "TRIAL" as a stored plan name predates the plan-selected model — it
  // always collapses to NONE, since there's no way to know which real plan
  // (STARTER/GROWTH/PRO) it should represent.
  const state = entitlements({ planName: "TRIAL", accessActive: false, trialActive: true });

  assert.notEqual(state.tier, "trial");
  assert.equal(state.tier, "none");
  assert.equal(state.planName, "NONE");
  assert.equal(state.accessActive, false);
  assert.match(state.description, /choose a plan/i, "prompts choosing a real plan instead");
});

test("no subscription and no trial prompts choosing a plan to start the trial", () => {
  const state = entitlements({ planName: "NONE", accessActive: false, trialActive: false });

  assert.notEqual(state.tier, "trial");
  assert.equal(state.tier, "none");
  assert.equal(state.accessActive, false);
  assert.match(state.description, /choose a plan.*trial/i);
});

test("a legacy standalone TRIAL plan with a closed window is not reported as a trial", () => {
  const state = entitlements({ planName: "TRIAL", accessActive: false, trialActive: false });

  assert.notEqual(state.tier, "trial");
  assert.equal(state.planName, "NONE", "legacy TRIAL collapses rather than granting access");
  assert.equal(state.accessActive, false);
});

test("active paid subscription (trial closed) reports its own tier, unaffected by trial wording", () => {
  const state = entitlements({ planName: "GROWTH", accessActive: true, trialActive: false });

  assert.equal(state.tier, "growth");
  assert.equal(state.accessActive, true);
  assert.doesNotMatch(state.title, /trial/i, "no trial copy once billed and the trial is closed");
});

test("no plan and no trial reports no access", () => {
  const state = entitlements({ planName: "NONE", accessActive: false, trialActive: false });

  assert.equal(state.tier, "none");
});

test("a trial cannot be inferred without a selected plan", () => {
  // trialActive alone must not manufacture access when no plan was chosen —
  // this is what stops a stale trialEndsAt from unlocking modules. Under the
  // plan-selected model this combination shouldn't arise in practice (trial
  // dates aren't set until a plan is approved), but the resolver itself must
  // still refuse to grant access from trialActive alone.
  const state = entitlements({ planName: "NONE", accessActive: false, trialActive: true });

  assert.equal(state.tier, "none");
  assert.equal(state.accessActive, false);
});

test("Starter module selection survives the trial and is reflected in the title", () => {
  const state = entitlements({
    planName: "STARTER",
    starterModule: "competitor",
    accessActive: false,
    trialActive: true,
  });

  assert.equal(state.tier, "starter");
  assert.equal(state.planName, "STARTER");
  assert.equal(state.starterModule, "competitor");
  assert.equal(state.title, "Starter trial active");
});

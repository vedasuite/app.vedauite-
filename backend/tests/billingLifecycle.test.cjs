const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildCanonicalEntitlements,
  deriveCanonicalBillingLifecycle,
} = require("../dist/services/subscriptionService.js");

test("install with no plan resolves to no_subscription", () => {
  const lifecycle = deriveCanonicalBillingLifecycle({
    uninstalled: false,
    pendingApproval: false,
    planName: "NONE",
    accessActive: false,
    billingStatus: "INACTIVE",
    isTestCharge: false,
  });

  assert.equal(lifecycle, "no_subscription");
});

test("starter active resolves to active lifecycle and starter entitlements", () => {
  const lifecycle = deriveCanonicalBillingLifecycle({
    uninstalled: false,
    pendingApproval: false,
    planName: "STARTER",
    accessActive: true,
    billingStatus: "ACTIVE",
    isTestCharge: false,
  });
  const entitlements = buildCanonicalEntitlements({
    planName: "STARTER",
    starterModule: "trustAbuse",
    accessActive: true,
    verified: true,
    trialActive: false,
  });

  assert.equal(lifecycle, "active");
  assert.equal(entitlements.tier, "starter");
  assert.equal(entitlements.modules.trustAbuse, true);
  assert.equal(entitlements.modules.competitor, false);
  assert.equal(entitlements.modules.pricingProfit, false);
});

test("growth active resolves to growth entitlements", () => {
  const entitlements = buildCanonicalEntitlements({
    planName: "GROWTH",
    starterModule: null,
    accessActive: true,
    verified: true,
    trialActive: false,
  });

  assert.equal(entitlements.tier, "growth");
  assert.equal(entitlements.modules.trustAbuse, true);
  assert.equal(entitlements.modules.competitor, true);
  assert.equal(entitlements.modules.pricingProfit, true);
});

test("pro active resolves to pro entitlements", () => {
  const entitlements = buildCanonicalEntitlements({
    planName: "PRO",
    starterModule: null,
    accessActive: true,
    verified: true,
    trialActive: false,
  });

  assert.equal(entitlements.tier, "pro");
  assert.equal(entitlements.featureAccess.fullProfitEngine, true);
});

test("cancelled plan remains cancelled even if access is still active until the end date", () => {
  const lifecycle = deriveCanonicalBillingLifecycle({
    uninstalled: false,
    pendingApproval: false,
    planName: "PRO",
    accessActive: true,
    billingStatus: "CANCELLED",
    isTestCharge: false,
  });

  assert.equal(lifecycle, "cancelled");
});

test("billing approval pending wins over stale plan assumptions", () => {
  const lifecycle = deriveCanonicalBillingLifecycle({
    uninstalled: false,
    pendingApproval: true,
    planName: "NONE",
    accessActive: false,
    billingStatus: "INACTIVE",
    isTestCharge: false,
  });

  assert.equal(lifecycle, "pending_approval");
});

test("uninstalled stores resolve to uninstalled lifecycle", () => {
  const lifecycle = deriveCanonicalBillingLifecycle({
    uninstalled: true,
    pendingApproval: false,
    planName: "PRO",
    accessActive: false,
    billingStatus: "UNINSTALLED",
    isTestCharge: false,
  });

  assert.equal(lifecycle, "uninstalled");
});

test("frozen billing statuses resolve to frozen", () => {
  const lifecycle = deriveCanonicalBillingLifecycle({
    uninstalled: false,
    pendingApproval: false,
    planName: "GROWTH",
    accessActive: false,
    billingStatus: "PAST_DUE",
    isTestCharge: false,
  });

  assert.equal(lifecycle, "frozen");
});

test("test charge lifecycle is explicit", () => {
  const lifecycle = deriveCanonicalBillingLifecycle({
    uninstalled: false,
    pendingApproval: false,
    planName: "PRO",
    accessActive: true,
    billingStatus: "ACTIVE",
    isTestCharge: true,
  });

  assert.equal(lifecycle, "test_charge");
});

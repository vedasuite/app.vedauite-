const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const helperPath = pathToFileURL(
  path.resolve(__dirname, "../src/modules/SubscriptionPlans/starterModuleMutation.js")
).href;

test("active starter competitor selection requires Shopify billing approval", async () => {
  const { shouldRequireStarterModuleBillingApproval } = await import(helperPath);

  assert.equal(
    shouldRequireStarterModuleBillingApproval({
      currentPlanName: "STARTER",
      currentActive: true,
      requestedPlanName: "STARTER",
      currentStarterModule: "fraud",
      requestedStarterModule: "competitor",
    }),
    true
  );
});

test("non-starter plan changes do not trigger starter-specific reapproval helper", async () => {
  const { shouldRequireStarterModuleBillingApproval } = await import(helperPath);

  assert.equal(
    shouldRequireStarterModuleBillingApproval({
      currentPlanName: "GROWTH",
      currentActive: true,
      requestedPlanName: "STARTER",
      currentStarterModule: null,
      requestedStarterModule: "competitor",
    }),
    false
  );
});

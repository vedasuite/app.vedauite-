const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const helperPath = pathToFileURL(
  path.resolve(__dirname, "../src/modules/SubscriptionPlans/starterModuleMutation.js")
).href;

test("active starter competitor selection uses local starter-module mutation path", async () => {
  const { shouldUseStarterModuleMutation } = await import(helperPath);

  assert.equal(
    shouldUseStarterModuleMutation({
      currentPlanName: "STARTER",
      currentActive: true,
      requestedPlanName: "STARTER",
      currentStarterModule: "fraud",
      requestedStarterModule: "competitor",
    }),
    true
  );
});

test("non-starter plan changes continue to use billing change-plan path", async () => {
  const { shouldUseStarterModuleMutation } = await import(helperPath);

  assert.equal(
    shouldUseStarterModuleMutation({
      currentPlanName: "GROWTH",
      currentActive: true,
      requestedPlanName: "STARTER",
      currentStarterModule: null,
      requestedStarterModule: "competitor",
    }),
    false
  );
});

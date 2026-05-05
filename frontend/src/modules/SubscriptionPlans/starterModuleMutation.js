export function shouldRequireStarterModuleBillingApproval(input) {
  return (
    input.currentPlanName === "STARTER" &&
    input.currentActive === true &&
    input.requestedPlanName === "STARTER" &&
    !!input.requestedStarterModule &&
    input.currentStarterModule !== input.requestedStarterModule
  );
}

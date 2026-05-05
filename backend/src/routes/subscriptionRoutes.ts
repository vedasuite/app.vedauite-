import { Router } from "express";
import { requireCapability } from "../middleware/requireCapability";
import {
  buildCanonicalEntitlements,
  cancelSubscription,
  downgradeToTrial,
  getCurrentSubscription,
  resolveEntitlements,
  resolveBillingState,
} from "../services/subscriptionService";
import { getBillingManagementState } from "../services/billingManagementService";
import { resolveAuthenticatedShop } from "./routeShop";

export const subscriptionRouter = Router();
export const subscriptionDebugRouter = Router();

subscriptionRouter.get("/plan", requireCapability("billing.planManagement"), async (req, res) => {
  const shop = resolveAuthenticatedShop(req);
  if (!shop) {
    return res.status(400).json({ error: "Missing shop." });
  }
  const plan = await getCurrentSubscription(shop);
  const billingState = await resolveBillingState(shop);
  const entitlements = buildCanonicalEntitlements({
    planName: billingState.planName,
    starterModule: billingState.starterModule,
    accessActive: billingState.accessActive,
    verified: billingState.verified,
    trialActive: billingState.planName === "TRIAL" && billingState.accessActive,
  });
  const billing = await getBillingManagementState(shop).catch(() => null);
  return res.json({ subscription: plan, billingState, entitlements, billing });
});

subscriptionRouter.post("/cancel", requireCapability("billing.downgrade"), async (req, res) => {
  const shop = resolveAuthenticatedShop(req);
  if (!shop) {
    return res.status(400).json({ error: "Missing shop." });
  }

  const subscription = await cancelSubscription(shop);
  return res.json({ subscription });
});

subscriptionRouter.post("/downgrade-to-trial", requireCapability("billing.downgrade"), async (req, res) => {
  const shop = resolveAuthenticatedShop(req);
  if (!shop) {
    return res.status(400).json({ error: "Missing shop." });
  }

  const result = await downgradeToTrial(shop);
  return res.json({ result });
});

subscriptionRouter.post("/starter-module", requireCapability("billing.moduleSelectionStarter"), async (req, res) => {
  const shop = resolveAuthenticatedShop(req);
  if (!shop) {
    return res.status(400).json({ error: "Missing shop." });
  }
  return res.status(409).json({
    error: {
      code: "STARTER_MODULE_REQUIRES_BILLING_APPROVAL",
      message:
        "Changing the Starter module now requires Shopify billing approval. Refresh the billing page and confirm the Starter module change there.",
    },
  });
});

subscriptionDebugRouter.get("/entitlements", requireCapability("billing.planManagement"), async (req, res) => {
  const shop = resolveAuthenticatedShop(req);
  if (!shop) {
    return res.status(400).json({ error: "Missing shop." });
  }

  const billingState = await resolveBillingState(shop);
  const entitlements = await resolveEntitlements(shop);

  return res.json({
    shop,
    dbPlan: billingState.dbPlanName,
    dbStarterModule: billingState.starterModule,
    normalizedStarterModule: entitlements.starterModule,
    enabledModules: entitlements.enabledModules,
    lockedModules: entitlements.lockedModules,
  });
});


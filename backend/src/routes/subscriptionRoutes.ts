import { Router } from "express";
import { requireCapability } from "../middleware/requireCapability";
import {
  buildCanonicalEntitlements,
  cancelSubscription,
  downgradeToTrial,
  getCurrentSubscription,
  resolveEntitlements,
  resolveBillingState,
  updateStarterModuleSelection,
} from "../services/subscriptionService";
import { logEvent } from "../services/observabilityService";
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
  const body = req.body as {
    starterModule?: "fraud" | "competitor";
  };
  const shop = resolveAuthenticatedShop(req);
  const starterModule = body.starterModule;

  if (!shop || !starterModule) {
    return res.status(400).json({ error: "Missing shop or starter module." });
  }

  const subscription = await updateStarterModuleSelection(shop, starterModule);
  const entitlements = await resolveEntitlements(shop);

  logEvent("info", "starter_module.entitlements_returned", {
    shop,
    plan: entitlements.plan,
    starterModule: entitlements.starterModule,
    enabledModules: entitlements.enabledModules,
    lockedModules: entitlements.lockedModules,
  });

  return res.json({
    plan: entitlements.plan,
    starterModule: entitlements.starterModule,
    enabledModules: entitlements.enabledModules,
    lockedModules: entitlements.lockedModules,
    subscription,
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


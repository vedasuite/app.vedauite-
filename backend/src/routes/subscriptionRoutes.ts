import { Router } from "express";
import { requireCapability } from "../middleware/requireCapability";
import {
  buildCanonicalEntitlements,
  cancelSubscription,
  downgradeToTrial,
  getCurrentSubscription,
  resolveBillingState,
  updateStarterModuleSelection,
} from "../services/subscriptionService";
import { getBillingManagementState } from "../services/billingManagementService";
import { resolveAuthenticatedShop } from "./routeShop";

export const subscriptionRouter = Router();

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
    starterModule?: "trustAbuse" | "competitor";
  };
  const shop = resolveAuthenticatedShop(req);
  const starterModule = body.starterModule;

  if (!shop || !starterModule) {
    return res.status(400).json({ error: "Missing shop or starter module." });
  }

  const subscription = await updateStarterModuleSelection(shop, starterModule);
  return res.json({ subscription });
});


import { Router } from "express";
import { requireCapability } from "../middleware/requireCapability";
import { getUnifiedDecisionCenter } from "../services/decisionCenterService";
import { getDashboardMetrics } from "../services/dashboardService";
import {
  confirmOnboardingPlan,
  dismissOnboarding,
  getOnboardingState,
  markOnboardingInsightViewed,
  markOnboardingComplete,
  selectOnboardingModule,
} from "../services/onboardingService";
import { resolveAuthenticatedShop } from "./routeShop";

export const dashboardRouter = Router();

dashboardRouter.get("/metrics", requireCapability("reports.view"), async (req, res) => {
  const shop = resolveAuthenticatedShop(req);
  if (!shop) {
    return res.status(400).json({ error: "Missing shop query parameter." });
  }

  const metrics = await getDashboardMetrics(shop);
  if (!metrics) {
    return res.status(404).json({ error: "Store not found." });
  }

  return res.json(metrics);
});

dashboardRouter.get("/decision-center", requireCapability("reports.view"), async (req, res) => {
  const shop = resolveAuthenticatedShop(req);
  if (!shop) {
    return res.status(400).json({ error: "Missing shop query parameter." });
  }

  const decisionCenter = await getUnifiedDecisionCenter(shop);
  return res.json(decisionCenter);
});

dashboardRouter.get("/onboarding", async (req, res) => {
  const shop = resolveAuthenticatedShop(req);
  if (!shop) {
    return res.status(400).json({ error: "Missing shop query parameter." });
  }

  const onboarding = await getOnboardingState(shop);
  return res.json({ onboarding });
});

dashboardRouter.post("/onboarding/select-module", async (req, res) => {
  const shop = resolveAuthenticatedShop(req);
  if (!shop) {
    return res.status(400).json({ error: "Missing shop query parameter." });
  }

  const body = req.body as { moduleKey?: string };
  const onboarding = await selectOnboardingModule({
    shopDomain: shop,
    moduleKey: body.moduleKey ?? "",
  });
  return res.json({ onboarding });
});

dashboardRouter.post("/onboarding/view-insight", async (req, res) => {
  const shop = resolveAuthenticatedShop(req);
  if (!shop) {
    return res.status(400).json({ error: "Missing shop query parameter." });
  }

  const body = req.body as { moduleKey?: string | null };
  const onboarding = await markOnboardingInsightViewed({
    shopDomain: shop,
    moduleKey: body.moduleKey ?? null,
  });
  return res.json({ onboarding });
});

dashboardRouter.post("/onboarding/confirm-plan", async (req, res) => {
  const shop = resolveAuthenticatedShop(req);
  if (!shop) {
    return res.status(400).json({ error: "Missing shop query parameter." });
  }

  const onboarding = await confirmOnboardingPlan(shop);
  return res.json({ onboarding });
});

dashboardRouter.post("/onboarding/complete", async (req, res) => {
  const shop = resolveAuthenticatedShop(req);
  if (!shop) {
    return res.status(400).json({ error: "Missing shop query parameter." });
  }

  const onboarding = await markOnboardingComplete(shop);
  return res.json({ onboarding });
});

dashboardRouter.post("/onboarding/dismiss", async (req, res) => {
  const shop = resolveAuthenticatedShop(req);
  if (!shop) {
    return res.status(400).json({ error: "Missing shop query parameter." });
  }

  const onboarding = await dismissOnboarding(shop);
  return res.json({ onboarding });
});


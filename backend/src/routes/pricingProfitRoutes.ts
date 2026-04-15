import { Router } from "express";
import { requireCapability } from "../middleware/requireCapability";
import { getPricingProfitOverview } from "../services/pricingProfitService";
import { logEvent } from "../services/observabilityService";
import { resolveAuthenticatedShop } from "./routeShop";

export const pricingProfitRouter = Router();
pricingProfitRouter.use(requireCapability("module.pricingProfit"));

pricingProfitRouter.get("/overview", async (req, res) => {
  const shop = resolveAuthenticatedShop(req);
  if (!shop) {
    return res.status(400).json({ error: "Missing shop." });
  }

  try {
    logEvent("info", "pricing_profit.route_request_started", {
      shop,
      route: req.originalUrl,
    });
    const overview = await Promise.race([
      getPricingProfitOverview(shop),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("Pricing overview timed out.")), 12000);
      }),
    ]);

    logEvent("info", "pricing_profit.route_request_succeeded", {
      shop,
      route: req.originalUrl,
      viewStatus: overview.viewState?.status ?? null,
    });
    return res.json({ overview });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Pricing overview could not be loaded.";
    const timedOut = /timed out/i.test(message);

    logEvent("error", "pricing_profit.route_request_failed", {
      shop,
      route: req.originalUrl,
      timedOut,
      error,
    });

    return res.status(timedOut ? 504 : 503).json({
      error: {
        code: timedOut ? "PRICING_TIMEOUT" : "PRICING_OVERVIEW_FAILED",
        message,
      },
    });
  }
});

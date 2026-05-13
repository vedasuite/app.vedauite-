import { Router } from "express";
import { requireFeature } from "../middleware/requireFeature";
import {
  applyFraudAction,
  getFraudIntelligenceOverview,
  listRecentFraudOrders,
  scoreOrderFraud,
} from "../services/fraudService";
import { getMerchantOrderLabelOrNull } from "../lib/merchantLabels";
import { resolveAuthenticatedShop } from "./routeShop";

export const fraudRouter = Router();
fraudRouter.use(requireFeature("fraud"));

fraudRouter.get("/orders", async (req, res) => {
  const shop = resolveAuthenticatedShop(req);
  if (!shop) {
    return res.status(400).json({ error: "Missing shop query parameter." });
  }

  const orders = (await listRecentFraudOrders(shop))
    .map((order) => ({
      ...order,
      shopifyOrderId: getMerchantOrderLabelOrNull(order),
    }))
    .filter((order) => !!order.shopifyOrderId);
  return res.json({ orders });
});

fraudRouter.get("/overview", async (req, res) => {
  const shop = resolveAuthenticatedShop(req);
  if (!shop) {
    return res.status(400).json({ error: "Missing shop query parameter." });
  }

  const overview = await getFraudIntelligenceOverview(shop);
  return res.json({ overview });
});

fraudRouter.post("/score", async (req, res) => {
  const { orderId, signals } = req.body as {
    orderId: string;
    signals: unknown;
  };
  const shop = resolveAuthenticatedShop(req);
  if (!shop || !orderId) {
    return res.status(400).json({ error: "Missing shop or orderId." });
  }

  const result = await scoreOrderFraud(shop, orderId, signals as any);
  return res.json(result);
});

fraudRouter.post("/action", async (req, res) => {
  const { orderId, action } = req.body as {
    orderId: string;
    action: "allow" | "flag" | "block" | "manual_review";
  };
  const shop = resolveAuthenticatedShop(req);

  if (!shop || !orderId || !action) {
    return res.status(400).json({ error: "Missing parameters." });
  }

  const order = await applyFraudAction(shop, orderId, action);
  return res.json({ order });
});


import { Router } from "express";
import {
  createSupportTicket,
  listTicketsForShop,
} from "../services/supportService";
import { resolveAuthenticatedShop } from "./routeShop";

// Merchant-facing support endpoints. Mounted under /api, so every request is
// already authenticated by verifyShopifySessionToken. Deliberately NOT gated by
// any plan capability — raising a support ticket must work on every plan,
// including no plan at all.
export const supportRouter = Router();

supportRouter.get("/tickets", async (req, res) => {
  const shop = resolveAuthenticatedShop(req);
  if (!shop) {
    return res.status(400).json({ error: "Missing shop context." });
  }
  const tickets = await listTicketsForShop(shop);
  return res.json({ tickets });
});

supportRouter.post("/tickets", async (req, res) => {
  const shop = resolveAuthenticatedShop(req);
  if (!shop) {
    return res.status(400).json({ error: "Missing shop context." });
  }

  const result = await createSupportTicket(shop, req.body ?? {});
  if (!result.ok) {
    return res.status(400).json({ error: result.error });
  }
  return res.status(201).json({ ticket: result.ticket });
});

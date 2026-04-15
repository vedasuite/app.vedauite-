import { Router } from "express";
import { getMerchantAppState } from "../services/appStateService";
import { resolveAuthenticatedShop } from "./routeShop";

export const appStateRouter = Router();

appStateRouter.get("/", async (req, res) => {
  const shop = resolveAuthenticatedShop(req);
  if (!shop) {
    return res.status(400).json({ error: "Missing shop query parameter." });
  }

  const appState = await getMerchantAppState(shop);
  return res.json({ appState });
});

import { Router } from "express";
import { requireCapability } from "../middleware/requireCapability";
import { getSettings, updateSettings } from "../services/settingsService";
import { resolveAuthenticatedShop } from "./routeShop";

export const settingsRouter = Router();

settingsRouter.get("/", requireCapability("settings.view"), async (req, res) => {
  const shop = resolveAuthenticatedShop(req);
  if (!shop) {
    return res.status(400).json({ error: "Missing shop." });
  }
  const settings = await getSettings(shop);
  return res.json({ settings });
});

settingsRouter.post("/", requireCapability("settings.manage"), async (req, res) => {
  const { settings } = req.body as {
    shop: string;
    settings: Parameters<typeof updateSettings>[1];
  };
  const shop = resolveAuthenticatedShop(req);
  if (!shop || !settings) {
    return res.status(400).json({ error: "Missing shop or settings." });
  }
  const updated = await updateSettings(shop, settings);
  return res.json({ settings: updated });
});


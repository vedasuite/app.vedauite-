import { Router } from "express";
import { getSettings, updateSettings } from "../services/settingsService";

export const settingsRouter = Router();

settingsRouter.get("/", async (req, res) => {
  const { shop } = req.query;
  if (!shop || typeof shop !== "string") {
    return res.status(400).json({ error: "Missing shop." });
  }
  const settings = await getSettings(shop);
  return res.json({ settings });
});

settingsRouter.post("/", async (req, res) => {
  const { shop, settings } = req.body as {
    shop: string;
    settings: Parameters<typeof updateSettings>[1];
  };
  if (!shop || !settings) {
    return res.status(400).json({ error: "Missing shop or settings." });
  }
  const updated = await updateSettings(shop, settings);
  return res.json({ settings: updated });
});


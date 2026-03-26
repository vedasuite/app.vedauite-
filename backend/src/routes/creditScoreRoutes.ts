import { Router } from "express";
import {
  getCustomerScore,
  getTrustOperatingLayer,
  listCustomerScores,
  recomputeCustomerScore,
} from "../services/creditScoreService";

export const creditScoreRouter = Router();

creditScoreRouter.get("/customers", async (req, res) => {
  const { shop } = req.query;
  if (!shop || typeof shop !== "string") {
    return res.status(400).json({ error: "Missing shop." });
  }
  const customers = await listCustomerScores(shop);
  return res.json({ customers });
});

creditScoreRouter.get("/operating-layer", async (req, res) => {
  const { shop } = req.query;
  if (!shop || typeof shop !== "string") {
    return res.status(400).json({ error: "Missing shop." });
  }

  const operatingLayer = await getTrustOperatingLayer(shop);
  return res.json({ operatingLayer });
});

creditScoreRouter.get("/customer/:id", async (req, res) => {
  const { shop } = req.query;
  const { id } = req.params;
  if (!shop || typeof shop !== "string") {
    return res.status(400).json({ error: "Missing shop." });
  }
  const customer = await getCustomerScore(shop, id);
  return res.json({ customer });
});

creditScoreRouter.post("/customer/:id/recompute", async (req, res) => {
  const { id } = req.params;
  const updated = await recomputeCustomerScore(id);
  return res.json({ customer: updated });
});


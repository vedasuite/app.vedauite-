import { Router } from "express";
import {
  getCompetitorResponseEngine,
  getCompetitorOverview,
  ingestCompetitorSnapshots,
  listCompetitorConnectors,
  listTrackedCompetitorProducts,
  updateCompetitorDomains,
} from "../services/competitorService";

export const competitorRouter = Router();

competitorRouter.get("/overview", async (req, res) => {
  const { shop } = req.query;
  if (!shop || typeof shop !== "string") {
    return res.status(400).json({ error: "Missing shop." });
  }

  const overview = await getCompetitorOverview(shop);
  return res.json(overview);
});

competitorRouter.get("/products", async (req, res) => {
  const { shop } = req.query;
  if (!shop || typeof shop !== "string") {
    return res.status(400).json({ error: "Missing shop." });
  }

  const products = await listTrackedCompetitorProducts(shop);
  return res.json({ products });
});

competitorRouter.get("/connectors", async (req, res) => {
  const { shop } = req.query;
  if (!shop || typeof shop !== "string") {
    return res.status(400).json({ error: "Missing shop." });
  }

  const connectors = await listCompetitorConnectors(shop);
  return res.json({ connectors });
});

competitorRouter.get("/response-engine", async (req, res) => {
  const { shop } = req.query;
  if (!shop || typeof shop !== "string") {
    return res.status(400).json({ error: "Missing shop." });
  }

  const responseEngine = await getCompetitorResponseEngine(shop);
  return res.json({ responseEngine });
});

competitorRouter.post("/domains", async (req, res) => {
  const body = req.body as {
    shop: string;
    domains: { domain: string; label?: string }[];
  };
  const shop =
    body.shop ??
    (typeof req.query.shop === "string" ? req.query.shop : undefined);
  const domains = body.domains;

  if (!shop || !domains) {
    return res.status(400).json({ error: "Missing shop or domains." });
  }

  const updated = await updateCompetitorDomains(shop, domains);
  return res.json({ domains: updated });
});

competitorRouter.post("/ingest", async (req, res) => {
  const body = req.body as { shop?: string };
  const shop =
    body.shop ??
    (typeof req.query.shop === "string" ? req.query.shop : undefined);

  if (!shop) {
    return res.status(400).json({ error: "Missing shop." });
  }

  const result = await ingestCompetitorSnapshots(shop);
  return res.json({ result });
});


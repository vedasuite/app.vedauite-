import { Router } from "express";
import { requireFeature } from "../middleware/requireFeature";
import {
  getCompetitorResponseEngine,
  getCompetitorOverview,
  ingestCompetitorSnapshots,
  listCompetitorConnectors,
  listTrackedCompetitorProducts,
  updateCompetitorDomains,
} from "../services/competitorService";
import { resolveAuthenticatedShop } from "./routeShop";
import { prisma } from "../db/prismaClient";

export const competitorRouter = Router();
competitorRouter.use(requireFeature("competitor"));

competitorRouter.get("/overview", async (req, res) => {
  const shop = resolveAuthenticatedShop(req);
  if (!shop) {
    return res.status(400).json({ error: "Missing shop." });
  }

  const overview = await getCompetitorOverview(shop);
  return res.json(overview);
});

competitorRouter.get("/products", async (req, res) => {
  const shop = resolveAuthenticatedShop(req);
  if (!shop) {
    return res.status(400).json({ error: "Missing shop." });
  }

  const products = await listTrackedCompetitorProducts(shop);
  return res.json({ products });
});

competitorRouter.get("/connectors", async (req, res) => {
  const shop = resolveAuthenticatedShop(req);
  if (!shop) {
    return res.status(400).json({ error: "Missing shop." });
  }

  const connectors = await listCompetitorConnectors(shop);
  return res.json({ connectors });
});

competitorRouter.get("/response-engine", async (req, res) => {
  const shop = resolveAuthenticatedShop(req);
  if (!shop) {
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
  const shop = resolveAuthenticatedShop(req) ?? body.shop;
  const domains = body.domains;

  if (!shop || !domains) {
    return res.status(400).json({ error: "Missing shop or domains." });
  }

  const updated = await updateCompetitorDomains(shop, domains);
  return res.json({ domains: updated });
});

competitorRouter.post("/ingest", async (req, res) => {
  const body = req.body as { shop?: string };
  const shop = resolveAuthenticatedShop(req) ?? body.shop;

  if (!shop) {
    return res.status(400).json({ error: "Missing shop." });
  }

  const runningJob = await prisma.syncJob.findFirst({
    where: { store: { shop }, jobType: "competitor_ingest", status: "RUNNING" },
  });
  if (runningJob) {
    return res.json({ result: { merchantMessage: "Analysis is already running. Please wait for it to finish." } });
  }

  const result = await ingestCompetitorSnapshots(shop);
  return res.json({ result });
});


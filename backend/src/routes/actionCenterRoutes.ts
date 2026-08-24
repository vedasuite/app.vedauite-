// PART 4 — Action Center API.
//
// Mounted under /api, so it inherits the existing verifyShopifySessionToken and
// ensureOfflineToken middleware. Store scoping comes from the verified session
// token's shop claim — never from a client-supplied parameter.
//
// Read endpoints plus merchant-driven lifecycle changes and feedback. No
// Shopify write, no store mutation, no automatic action of any kind.

import { Router, type Request, type Response } from "express";
import { prisma } from "../db/prismaClient";
import { HttpError } from "../lib/httpError";
import { logEvent } from "./../services/observabilityService";
import { resolveAuthenticatedShop } from "./routeShop";
import { resolveEntitlements } from "../services/subscriptionService";
import {
  getActionCenter,
  updateActionStatus,
} from "../services/actionCenterService";
import {
  getIntelligenceBrief,
  isAiExplanationEnabled,
} from "../services/intelligenceBriefService";
import { env } from "../config/env";
import { AI_PROVIDER_NAME } from "../services/ai/aiBriefProvider";
import { FINDING_STATUSES } from "../services/intelligenceFindingService";

export const actionCenterRouter = Router();

/** Resolves the authenticated shop to a store id, or 404s. */
async function resolveStore(req: Request) {
  const shop = resolveAuthenticatedShop(req);
  if (!shop) {
    throw new HttpError(400, "Missing shop.");
  }
  const store = await prisma.store.findUnique({
    where: { shop },
    select: { id: true, shop: true, lastSyncAt: true },
  });
  if (!store) {
    throw new HttpError(404, "Store not found.");
  }
  return store;
}

/**
 * Which capability modules this plan enables. Read from the EXISTING entitlement
 * system so the Action Center can never show a merchant something their plan
 * does not include — and, equally, so store-health findings (null capability)
 * are never withheld.
 */
async function enabledModulesFor(shop: string): Promise<string[]> {
  const entitlements = await resolveEntitlements(shop);
  return entitlements.enabledModules ?? [];
}

/**
 * GET /api/action-center
 * The prioritized feed, summary and brief. Filters: status, severity, module, since.
 */
actionCenterRouter.get("/", async (req: Request, res: Response) => {
  const store = await resolveStore(req);
  const enabledModules = await enabledModulesFor(store.shop);

  const { cards, summary } = await getActionCenter({
    storeId: store.id,
    enabledModules,
    status: typeof req.query.status === "string" ? req.query.status : undefined,
    severity: typeof req.query.severity === "string" ? req.query.severity : undefined,
    module: typeof req.query.module === "string" ? req.query.module : undefined,
    since: typeof req.query.since === "string" ? req.query.since : undefined,
  });

  // Never throws: any AI failure degrades to the deterministic brief.
  const brief = await getIntelligenceBrief(cards, summary, { storeId: store.id });

  // Pilot instrumentation: aggregate counts only, never finding contents.
  // Wrapped so an analytics failure can never break the response.
  try {
    logEvent("info", "action_center.viewed", {
      shop: store.shop,
      storeId: store.id,
      cardCount: cards.length,
      openCount: summary.totalOpen,
      staleCount: summary.staleCount,
      briefGeneratedBy: brief.generatedBy,
      filters: {
        status: req.query.status ?? null,
        severity: req.query.severity ?? null,
        module: req.query.module ?? null,
      },
    });
  } catch {
    /* instrumentation must never affect the response */
  }

  return res.json({
    cards,
    summary,
    brief,
    meta: {
      lastSyncAt: store.lastSyncAt ? store.lastSyncAt.toISOString() : null,
      availableStatuses: FINDING_STATUSES,
      // Honest capability reporting so the UI can explain an empty feed.
      enabledModules,
      aiEnabled: brief.generatedBy === "ai_assisted",
      // Observability for the AI layer, so "why is this not AI-assisted?" is
      // answerable from the response itself rather than only from server logs.
      // Contains NO credential — the model name is not a secret, and the key is
      // never included in any form, not even a length or prefix.
      ai: {
        /** Flag on AND a server-side key present. */
        configured: isAiExplanationEnabled(),
        provider: isAiExplanationEnabled() ? AI_PROVIDER_NAME : null,
        model: isAiExplanationEnabled() ? env.ai.model : null,
        /** True only when a model produced the prose shown above. */
        used: brief.generatedBy === "ai_assisted",
        /** Set only when AI was attempted and did not succeed. */
        fallbackReason: brief.aiFallbackReason ?? null,
      },
    },
  });
});

/**
 * POST /api/action-center/:id/status
 * Merchant-driven lifecycle: seen / in_review / resolved / dismissed.
 */
actionCenterRouter.post("/:id/status", async (req: Request, res: Response) => {
  const store = await resolveStore(req);
  const status = typeof req.body?.status === "string" ? req.body.status : "";
  const note = typeof req.body?.note === "string" ? req.body.note : null;

  const updated = await updateActionStatus({
    storeId: store.id,
    shopDomain: store.shop,
    findingId: req.params.id,
    status,
    note,
  });

  return res.json({
    ok: true,
    finding: {
      id: updated.id,
      status: updated.status,
      statusChangedAt: updated.statusChangedAt,
      resolvedAt: updated.resolvedAt,
      dismissedAt: updated.dismissedAt,
    },
  });
});

/**
 * POST /api/action-center/:id/feedback
 * Pilot usefulness signal. Records an aggregate only — no free-text is stored,
 * so no merchant or customer content can leak into logs.
 */
actionCenterRouter.post("/:id/feedback", async (req: Request, res: Response) => {
  const store = await resolveStore(req);
  const useful = req.body?.useful;

  if (typeof useful !== "boolean") {
    throw new HttpError(400, "`useful` must be a boolean.");
  }

  // Confirm the finding belongs to this store before recording anything.
  const finding = await prisma.intelligenceFinding.findFirst({
    where: { id: req.params.id, storeId: store.id },
    select: { id: true, findingType: true, module: true },
  });
  if (!finding) {
    throw new HttpError(404, "Finding not found.");
  }

  try {
    logEvent("info", "action_center.feedback", {
      shop: store.shop,
      storeId: store.id,
      findingId: finding.id,
      findingType: finding.findingType,
      module: finding.module,
      useful,
    });
  } catch {
    /* never block on instrumentation */
  }

  return res.json({ ok: true });
});

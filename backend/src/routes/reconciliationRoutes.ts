import { Router } from "express";
import { HttpError } from "../lib/httpError";
import { logEvent } from "../services/observabilityService";
import { getCurrentSubscription } from "../services/subscriptionService";
import {
  confirmMapping,
  deleteReconciliationSource,
  getReconciliationWorkspace,
  runReconciliation,
  uploadReconciliationFile,
} from "../services/reconciliationService";
import {
  MAX_UPLOAD_BYTES,
  parseSpreadsheet,
  SpreadsheetParseError,
} from "../services/spreadsheetParsing";
import {
  listRateCards,
  saveRateCard,
  suggestRateCardMapping,
} from "../services/rateCardService";

export const reconciliationRouter = Router();

/**
 * Resolves the shop from the SESSION ONLY.
 *
 * Deliberately NOT resolveAuthenticatedShop, which falls back to a shop named
 * in the query string or the request body. That fallback is fine for read-only
 * module routes, but these endpoints accept and return uploaded operational
 * files, and a caller-supplied shop parameter has no business anywhere near
 * that decision. If the session does not name a shop, the request fails.
 */
function sessionShop(req: unknown): string | null {
  const shop = (req as { shopifySession?: { shop?: string } }).shopifySession?.shop;
  return typeof shop === "string" && shop.length > 0 ? shop : null;
}

/**
 * Gates on the reconciliation capability.
 *
 * Kept out of requireFeature deliberately: that middleware's FEATURE_RULES map
 * pairs each feature with a REQUIRED PLAN, and choosing one for reconciliation
 * would be making the commercial decision. This checks the capability, and the
 * capability's plan assignment lives in one line of billing/capabilities.ts.
 */
reconciliationRouter.use(async (req, res, next) => {
  const shop = sessionShop(req);
  if (!shop) {
    return res.status(401).json({
      error: {
        code: "REAUTHORIZE_REQUIRED",
        message:
          "Your Shopify session expired. Reload VedaSuite from Shopify Admin and try again.",
      },
    });
  }
  try {
    const subscription = await getCurrentSubscription(shop);
    if (!subscription.capabilities["reconciliation.run"]) {
      return res.status(403).json({
        error: {
          code: "FEATURE_NOT_INCLUDED",
          message: "Reconciliation is not included in your current plan.",
        },
      });
    }
    return next();
  } catch (error) {
    return next(error);
  }
});

/** Translates a thrown error into a response without leaking internals. */
function fail(res: Parameters<typeof reconciliationRouter.get>[1] extends never ? never : any, error: unknown, event: string, context: Record<string, unknown>) {
  if (error instanceof HttpError) {
    return res.status(error.status).json({ error: { message: error.message } });
  }
  logEvent("error", event, {
    ...context,
    error: error instanceof Error ? error.message : String(error),
  });
  return res.status(500).json({
    error: {
      message:
        "VedaSuite could not complete that request. Your uploaded data is unchanged and nothing in Shopify was modified.",
    },
  });
}

reconciliationRouter.get("/workspace", async (req, res) => {
  const shop = sessionShop(req) as string;
  try {
    return res.json({ workspace: await getReconciliationWorkspace(shop) });
  } catch (error) {
    return fail(res, error, "reconciliation.workspace_failed", { shop });
  }
});

/**
 * Accepts a file as base64 on the normal authenticated JSON route.
 *
 * WHY NOT MULTIPART. A multipart body parser is another dependency handling
 * untrusted input, and it typically wants a temp directory — which would mean
 * merchant operational files landing on disk. Base64 on the existing JSON route
 * reuses the session-token auth and store scoping already proven here, and the
 * bytes never leave memory.
 */
reconciliationRouter.post("/upload", async (req, res) => {
  const shop = sessionShop(req) as string;
  const { checkType, fileName, contentBase64, sheetName } = req.body ?? {};

  if (typeof contentBase64 !== "string" || contentBase64.length === 0) {
    return res.status(400).json({ error: { message: "No file content was received." } });
  }
  // Base64 inflates by 4/3; reject before decoding rather than after.
  if (contentBase64.length > Math.ceil((MAX_UPLOAD_BYTES * 4) / 3) + 1024) {
    return res.status(413).json({
      error: {
        message: `That file is larger than ${Math.floor(
          MAX_UPLOAD_BYTES / (1024 * 1024)
        )}MB. Export a narrower range and try again.`,
      },
    });
  }
  if (typeof fileName !== "string" || fileName.length === 0) {
    return res.status(400).json({ error: { message: "No file name was received." } });
  }

  try {
    const buffer = Buffer.from(contentBase64, "base64");
    const result = await uploadReconciliationFile({
      shopDomain: shop,
      checkType,
      fileName,
      buffer,
      sheetName: typeof sheetName === "string" ? sheetName : null,
    });
    return res.json({ result });
  } catch (error) {
    return fail(res, error, "reconciliation.upload_failed", { shop, checkType });
  }
});

reconciliationRouter.post("/mapping", async (req, res) => {
  const shop = sessionShop(req) as string;
  const { sourceId, mapping, fileName, contentBase64, sheetName } = req.body ?? {};

  if (typeof sourceId !== "string" || !sourceId) {
    return res.status(400).json({ error: { message: "No upload was identified." } });
  }
  if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) {
    return res.status(400).json({ error: { message: "No column mapping was received." } });
  }
  if (typeof contentBase64 !== "string" || typeof fileName !== "string") {
    return res
      .status(400)
      .json({ error: { message: "Re-select the file so VedaSuite can apply the mapping." } });
  }

  try {
    const result = await confirmMapping({
      shopDomain: shop,
      sourceId,
      // Only known string values survive; anything else is dropped rather than
      // trusted, and validateMapping then checks each against the real headers.
      mapping: Object.fromEntries(
        Object.entries(mapping).filter(
          ([, value]) => typeof value === "string" && value.length > 0
        )
      ) as Record<string, string>,
      fileName,
      buffer: Buffer.from(contentBase64, "base64"),
      sheetName: typeof sheetName === "string" ? sheetName : null,
    });
    return res.json({ result });
  } catch (error) {
    return fail(res, error, "reconciliation.mapping_failed", { shop, sourceId });
  }
});

reconciliationRouter.post("/run", async (req, res) => {
  const shop = sessionShop(req) as string;
  const { sourceId, rateCardId } = req.body ?? {};
  if (typeof sourceId !== "string" || !sourceId) {
    return res.status(400).json({ error: { message: "No upload was identified." } });
  }
  try {
    const result = await runReconciliation({
      shopDomain: shop,
      sourceId,
      rateCardId: typeof rateCardId === "string" ? rateCardId : null,
    });
    return res.json({ result });
  } catch (error) {
    return fail(res, error, "reconciliation.run_failed", { shop, sourceId });
  }
});

reconciliationRouter.delete("/source/:sourceId", async (req, res) => {
  const shop = sessionShop(req) as string;
  try {
    const result = await deleteReconciliationSource({
      shopDomain: shop,
      sourceId: req.params.sourceId,
    });
    return res.json({ result });
  } catch (error) {
    return fail(res, error, "reconciliation.delete_failed", {
      shop,
      sourceId: req.params.sourceId,
    });
  }
});

// ---------------------------------------------------------------------------
// Rate cards
//
// Same session-only shop resolution and same capability gate as everything
// above — a rate card is a merchant's commercial contract terms, which is at
// least as sensitive as an operational export.
// ---------------------------------------------------------------------------

reconciliationRouter.get("/rate-cards", async (req, res) => {
  const shop = sessionShop(req) as string;
  try {
    return res.json({ rateCards: await listRateCards(shop) });
  } catch (error) {
    return fail(res, error, "reconciliation.rate_cards_failed", { shop });
  }
});

/** Inspects a rate-card file and proposes a mapping. Saves nothing. */
reconciliationRouter.post("/rate-card/inspect", async (req, res) => {
  const shop = sessionShop(req) as string;
  const { fileName, contentBase64, sheetName } = req.body ?? {};
  if (typeof contentBase64 !== "string" || typeof fileName !== "string") {
    return res.status(400).json({ error: { message: "No file was received." } });
  }
  if (contentBase64.length > Math.ceil((MAX_UPLOAD_BYTES * 4) / 3) + 1024) {
    return res.status(413).json({ error: { message: "That file is too large." } });
  }
  try {
    const parsed = parseSpreadsheet({
      fileName,
      buffer: Buffer.from(contentBase64, "base64"),
      sheetName: typeof sheetName === "string" ? sheetName : null,
    });
    return res.json({
      result: {
        fileName: parsed.fileName,
        headers: parsed.headers,
        sampleRows: parsed.rows.slice(0, 5),
        availableSheets: parsed.availableSheets,
        sheetName: parsed.sheetName,
        totalRows: parsed.rows.length,
        ...suggestRateCardMapping({
          headers: parsed.headers,
          sampleRows: parsed.rows.slice(0, 25),
        }),
      },
    });
  } catch (error) {
    if (error instanceof SpreadsheetParseError) {
      return res.status(400).json({ error: { message: error.message } });
    }
    return fail(res, error, "reconciliation.rate_card_inspect_failed", { shop });
  }
});

/** Saves a rate card as a NEW VERSION. Never edits an existing one. */
reconciliationRouter.post("/rate-card", async (req, res) => {
  const shop = sessionShop(req) as string;
  const { name, fileName, contentBase64, mapping, sheetName, note } = req.body ?? {};

  if (typeof contentBase64 !== "string" || typeof fileName !== "string") {
    return res.status(400).json({ error: { message: "No file was received." } });
  }
  if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) {
    return res.status(400).json({ error: { message: "No column mapping was received." } });
  }
  if (contentBase64.length > Math.ceil((MAX_UPLOAD_BYTES * 4) / 3) + 1024) {
    return res.status(413).json({ error: { message: "That file is too large." } });
  }

  try {
    const result = await saveRateCard({
      shopDomain: shop,
      name: typeof name === "string" ? name : "Rate card",
      fileName,
      buffer: Buffer.from(contentBase64, "base64"),
      // Only string values survive; validateMapping-equivalent checks happen
      // inside saveRateCard against the file's real headers.
      mapping: Object.fromEntries(
        Object.entries(mapping).filter(
          ([, value]) => typeof value === "string" && value.length > 0
        )
      ) as Record<string, string>,
      sheetName: typeof sheetName === "string" ? sheetName : null,
      note: typeof note === "string" ? note : null,
    });
    return res.json({ result });
  } catch (error) {
    return fail(res, error, "reconciliation.rate_card_save_failed", { shop });
  }
});

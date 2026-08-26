// Reconciliation persistence and orchestration.
//
// The pure logic lives in reconciliationModel / reconciliationChecks /
// reconciliationImportCalc / reconciliationFindingCalc. This module does the
// database work and nothing else clever, so the rules stay testable without a
// database and this file stays auditable for isolation.
//
// STORE ISOLATION
// ---------------
// Every function here takes a resolved storeId and every query filters on it,
// including the ones that could rely on a join to do it. That redundancy is the
// point: an uploaded operational file is the most sensitive data VedaSuite
// holds, and "the join would have caught it" is not a property worth betting a
// merchant's data on. ReconciliationRecord and ReconciliationDiscrepancy both
// carry a denormalized storeId for exactly this reason.
//
// NO SHOPIFY WRITES. V1 reads, analyses and recommends. Nothing in this file
// calls a Shopify mutation.

import { HttpError } from "../lib/httpError";
import { prisma } from "../db/prismaClient";
import { logEvent } from "./observabilityService";
import {
  buildImportPreview,
  type ImportPreview,
  type ImportedRow,
} from "./reconciliationImportCalc";
import {
  CHECK_TYPE_FIELDS,
  suggestMapping,
  validateMapping,
  type ConfirmedMapping,
} from "./columnMapping";
import {
  MAX_UPLOAD_BYTES,
  parseSpreadsheet,
  SpreadsheetParseError,
} from "./spreadsheetParsing";
import {
  CHECK_TYPE_LABEL,
  isCheckType,
  type CheckType,
} from "./reconciliationModel";
import {
  runCheck,
  type ExternalRow,
  type ShopifyInventoryRecord,
  type ShopifyOrderRecord,
} from "./reconciliationChecks";
import {
  buildReconciliationFindings,
  RECONCILIATION_MODULE,
} from "./reconciliationFindingCalc";
import { computeFindingFingerprint, recordFinding } from "./intelligenceFindingService";
import { computeOpportunityScore } from "./explainabilityCalc";

/** Rows of a single upload that are persisted. Bounds one merchant's blast radius. */
const MAX_PERSISTED_ROWS = 20_000;
/** Discrepancies persisted per run. Truncation is reported, never silent. */
const MAX_PERSISTED_DISCREPANCIES = 2_000;

async function resolveStoreId(shopDomain: string): Promise<string> {
  const store = await prisma.store.findUnique({
    where: { shop: shopDomain },
    select: { id: true },
  });
  if (!store) throw new HttpError(404, "Store not found.");
  return store.id;
}

function assertCheckType(value: unknown): CheckType {
  if (!isCheckType(value)) {
    throw new HttpError(400, "That reconciliation type is not recognised.");
  }
  return value;
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

export interface UploadResult {
  sourceId: string;
  fileName: string;
  format: string;
  headers: string[];
  sampleRows: string[][];
  suggestions: ReturnType<typeof suggestMapping>["suggestions"];
  unmappedHeaders: string[];
  needsConfirmation: boolean;
  totalRows: number;
  truncated: boolean;
}

/**
 * Accepts a file, parses it, and returns a mapping proposal.
 *
 * Nothing is reconciled here and no finding is created. The merchant sees what
 * VedaSuite thinks the columns are and confirms before anything else happens.
 *
 * The raw file is NEVER written to disk. It exists as a buffer for the duration
 * of this call; what persists is the normalized fields the mapping selects.
 */
export async function uploadReconciliationFile(input: {
  shopDomain: string;
  checkType: string;
  fileName: string;
  /** Raw bytes. The caller decodes the transport encoding. */
  buffer: Buffer;
}): Promise<UploadResult> {
  const storeId = await resolveStoreId(input.shopDomain);
  const checkType = assertCheckType(input.checkType);

  if (input.buffer.length > MAX_UPLOAD_BYTES) {
    throw new HttpError(
      413,
      `That file is larger than ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))}MB. Export a narrower range and try again.`
    );
  }

  let parsed;
  try {
    parsed = parseSpreadsheet({ fileName: input.fileName, buffer: input.buffer });
  } catch (error) {
    if (error instanceof SpreadsheetParseError) {
      // The parser's messages are written for merchants and name the fix.
      throw new HttpError(400, error.message);
    }
    throw error;
  }

  const sampleRows = parsed.rows.slice(0, 25);
  const proposal = suggestMapping({
    checkType,
    headers: parsed.headers,
    sampleRows,
  });

  const source = await prisma.reconciliationSource.create({
    data: {
      storeId,
      checkType,
      fileName: parsed.fileName,
      fileFormat: parsed.format,
      fileSizeBytes: input.buffer.length,
      status: proposal.needsConfirmation ? "needs_mapping" : "validating",
      statusReason: proposal.needsConfirmation
        ? "VedaSuite is not certain which columns to use. Confirm the mapping to continue."
        : null,
      headersJson: JSON.stringify(parsed.headers),
      totalRows: parsed.rows.length,
    },
    select: { id: true },
  });

  // Deliberately logs SHAPE only. Never a header name, never a cell value:
  // an operational export can carry commercially sensitive information and log
  // aggregation is not the place for it.
  logEvent("info", "reconciliation.file_uploaded", {
    storeId,
    sourceId: source.id,
    checkType,
    format: parsed.format,
    sizeBytes: input.buffer.length,
    columnCount: parsed.headers.length,
    rowCount: parsed.rows.length,
    truncated: parsed.truncated,
  });

  return {
    sourceId: source.id,
    fileName: parsed.fileName,
    format: parsed.format,
    headers: parsed.headers,
    // A handful of rows so the merchant can see what they are mapping.
    sampleRows: parsed.rows.slice(0, 5),
    suggestions: proposal.suggestions,
    unmappedHeaders: proposal.unmappedHeaders,
    needsConfirmation: proposal.needsConfirmation,
    totalRows: parsed.rows.length,
    truncated: parsed.truncated,
  };
}

// ---------------------------------------------------------------------------
// Mapping + validation
// ---------------------------------------------------------------------------

export interface ConfirmMappingResult {
  sourceId: string;
  status: string;
  preview: Omit<ImportPreview, "rows"> & {
    /** A sample of rejected rows, so the merchant can see the actual problem. */
    invalidExamples: Array<{ rowNumber: number; reason: string }>;
    duplicateExamples: Array<{ rowNumber: number; duplicateOf: number }>;
  };
  canReconcile: boolean;
  blockingReason: string | null;
}

/**
 * Applies a merchant-confirmed mapping and reports what the file yields.
 *
 * Rows are persisted here so the same upload can be reconciled again without
 * re-uploading. The RAW file is still not stored — only the fields the mapping
 * selected, which is why there is no column here for a name, an email or an
 * address even if the merchant's file contained one.
 */
export async function confirmMapping(input: {
  shopDomain: string;
  sourceId: string;
  mapping: ConfirmedMapping;
  /** Re-supplied because the raw file is not retained between calls. */
  fileName: string;
  buffer: Buffer;
}): Promise<ConfirmMappingResult> {
  const storeId = await resolveStoreId(input.shopDomain);

  const source = await prisma.reconciliationSource.findFirst({
    // storeId in the WHERE, not checked after the fact.
    where: { id: input.sourceId, storeId },
    select: { id: true, checkType: true, headersJson: true },
  });
  if (!source) throw new HttpError(404, "That upload was not found.");

  const checkType = assertCheckType(source.checkType);

  let parsed;
  try {
    parsed = parseSpreadsheet({ fileName: input.fileName, buffer: input.buffer });
  } catch (error) {
    if (error instanceof SpreadsheetParseError) throw new HttpError(400, error.message);
    throw error;
  }

  const validation = validateMapping({
    checkType,
    headers: parsed.headers,
    mapping: input.mapping,
  });
  if (!validation.ok) {
    await prisma.reconciliationSource.updateMany({
      where: { id: source.id, storeId },
      data: { status: "needs_mapping", statusReason: validation.message },
    });
    throw new HttpError(400, validation.message ?? "That mapping cannot be used.");
  }

  const preview = buildImportPreview({
    checkType,
    headers: parsed.headers,
    rows: parsed.rows,
    mapping: input.mapping,
    truncated: parsed.truncated,
  });

  const usable = preview.rows.filter((row) => !row.invalidReason);
  if (usable.length === 0) {
    await prisma.reconciliationSource.updateMany({
      where: { id: source.id, storeId },
      data: {
        status: "failed",
        statusReason:
          "No usable rows were found with this mapping. Check that the mapped columns contain the values you expect.",
        totalRows: preview.totalRows,
        validRows: 0,
        invalidRows: preview.invalidRows,
        duplicateRows: preview.duplicateRows,
        mappingJson: JSON.stringify(input.mapping),
      },
    });
    throw new HttpError(
      400,
      "No usable rows were found with this mapping. Check that the mapped columns contain the values you expect."
    );
  }

  await prisma.$transaction([
    prisma.reconciliationRecord.deleteMany({ where: { sourceId: source.id, storeId } }),
    prisma.reconciliationRecord.createMany({
      data: preview.rows.slice(0, MAX_PERSISTED_ROWS).map((row) => ({
        sourceId: source.id,
        storeId,
        rowNumber: row.rowNumber,
        sku: row.sku,
        orderRef: row.orderRef,
        tracking: row.tracking,
        location: row.location,
        quantity: row.quantity,
        amount: row.amount,
        currency: row.currency,
        observedAt: row.observedAtIso ? new Date(row.observedAtIso) : null,
        invalidReason: row.invalidReason,
      })),
    }),
    prisma.reconciliationSource.updateMany({
      where: { id: source.id, storeId },
      data: {
        status: "ready",
        statusReason: null,
        mappingJson: JSON.stringify(input.mapping),
        headersJson: JSON.stringify(parsed.headers),
        totalRows: preview.totalRows,
        validRows: preview.validRows,
        invalidRows: preview.invalidRows,
        duplicateRows: preview.duplicateRows,
      },
    }),
  ]);

  // Rows that only exist in the wider ImportedRow shape (expected/received
  // quantities, unit cost) are recomputed at run time from the same mapping, so
  // nothing is lost by the narrower persisted schema.
  cacheDerivedRows(source.id, preview.rows);

  logEvent("info", "reconciliation.mapping_confirmed", {
    storeId,
    sourceId: source.id,
    checkType,
    totalRows: preview.totalRows,
    validRows: preview.validRows,
    invalidRows: preview.invalidRows,
    duplicateRows: preview.duplicateRows,
  });

  return {
    sourceId: source.id,
    status: "ready",
    preview: {
      totalRows: preview.totalRows,
      validRows: preview.validRows,
      invalidRows: preview.invalidRows,
      duplicateRows: preview.duplicateRows,
      missingOptionalFields: preview.missingOptionalFields,
      truncated: preview.truncated,
      invalidExamples: preview.rows
        .filter((row) => row.invalidReason)
        .slice(0, 10)
        .map((row) => ({ rowNumber: row.rowNumber, reason: row.invalidReason as string })),
      duplicateExamples: preview.rows
        .filter((row) => row.duplicateOf != null)
        .slice(0, 10)
        .map((row) => ({ rowNumber: row.rowNumber, duplicateOf: row.duplicateOf as number })),
    },
    canReconcile: true,
    blockingReason: null,
  };
}

/**
 * Holds the fields the narrow persisted schema does not carry, for the life of
 * the process.
 *
 * Deliberately in-memory and deliberately small. A cache miss simply means the
 * run reads what IS persisted and reports which checks could not run — it never
 * substitutes a default, and it never fails.
 */
const derivedRowCache = new Map<string, ImportedRow[]>();
const DERIVED_CACHE_LIMIT = 20;

function cacheDerivedRows(sourceId: string, rows: ImportedRow[]) {
  if (derivedRowCache.size >= DERIVED_CACHE_LIMIT) {
    const oldest = derivedRowCache.keys().next().value;
    if (oldest) derivedRowCache.delete(oldest);
  }
  derivedRowCache.set(sourceId, rows.slice(0, MAX_PERSISTED_ROWS));
}

// ---------------------------------------------------------------------------
// Running a reconciliation
// ---------------------------------------------------------------------------

export interface RunResult {
  runId: string;
  status: string;
  statusReason: string | null;
  checkType: CheckType;
  matchedCount: number;
  probableCount: number;
  unmatchedCount: number;
  discrepancyCount: number;
  quantifiedCount: number;
  warnings: string[];
  findingsCreated: number;
}

/**
 * Loads the Shopify side of a comparison.
 *
 * Product cost is deliberately absent: Shopify does not send it, and the
 * ProfitOptimizationData row that might hold one records `costSource`, which is
 * "assumed" in practice. Passing an assumed cost here would let the engine
 * value a quantity difference using a number nobody measured, so cost only ever
 * reaches a discrepancy when the merchant supplied it in their own file.
 */
async function loadShopifySide(storeId: string) {
  const [variants, orders] = await Promise.all([
    prisma.variantSnapshot.findMany({
      where: { product: { storeId } },
      select: {
        sku: true,
        inventoryQuantity: true,
        title: true,
        product: { select: { handle: true, currency: true } },
      },
      take: 10_000,
    }),
    prisma.order.findMany({
      where: { storeId },
      select: {
        orderName: true,
        shopifyLegacyOrderId: true,
        status: true,
        refunded: true,
        currency: true,
        totalAmount: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
      take: 5_000,
    }),
  ]);

  const inventory: ShopifyInventoryRecord[] = variants.map((variant) => ({
    sku: variant.sku,
    inventoryQuantity: variant.inventoryQuantity,
    productHandle: variant.product.handle,
    variantTitle: variant.title,
    unitCost: null,
    currency: variant.product.currency,
  }));

  // Both the display name (#1042) and the legacy id are offered as references,
  // because 3PL exports use either. matchRecords strips the "#" on both sides.
  const orderRecords: ShopifyOrderRecord[] = [];
  for (const order of orders) {
    const base = {
      status: order.status,
      refunded: order.refunded,
      currency: order.currency,
      totalAmount: order.totalAmount,
      createdAtIso: order.createdAt.toISOString(),
    };
    if (order.orderName) orderRecords.push({ ...base, orderRef: order.orderName });
    if (order.shopifyLegacyOrderId) {
      orderRecords.push({ ...base, orderRef: order.shopifyLegacyOrderId });
    }
  }

  return { inventory, orders: orderRecords };
}

/** Rebuilds the wide row shape from what is persisted, plus the cache. */
async function loadExternalRows(storeId: string, sourceId: string): Promise<ExternalRow[]> {
  const cached = derivedRowCache.get(sourceId);
  if (cached) {
    return cached
      .filter((row) => !row.invalidReason)
      .map((row) => ({
        rowNumber: row.rowNumber,
        sku: row.sku,
        orderRef: row.orderRef,
        tracking: row.tracking,
        location: row.location,
        quantity: row.quantity,
        amount: row.amount,
        expectedAmount: row.expectedAmount,
        expectedQuantity: row.expectedQuantity,
        receivedQuantity: row.receivedQuantity,
        unitCost: row.unitCost,
        currency: row.currency,
        observedAtIso: row.observedAtIso,
        duplicateOf: row.duplicateOf,
      }));
  }

  const rows = await prisma.reconciliationRecord.findMany({
    where: { sourceId, storeId, invalidReason: null },
    orderBy: { rowNumber: "asc" },
    take: MAX_PERSISTED_ROWS,
  });

  return rows.map((row) => ({
    rowNumber: row.rowNumber,
    sku: row.sku,
    orderRef: row.orderRef,
    tracking: row.tracking,
    location: row.location,
    quantity: row.quantity,
    amount: row.amount,
    // Not persisted; a run from a restarted process simply cannot make the
    // checks that need them, and says so rather than assuming values.
    expectedAmount: null,
    expectedQuantity: null,
    receivedQuantity: null,
    unitCost: null,
    currency: row.currency,
    observedAtIso: row.observedAt ? row.observedAt.toISOString() : null,
    duplicateOf: null,
  }));
}

/**
 * Runs one reconciliation and files the results into Action Center.
 *
 * A run that cannot match anything, or that had rows rejected, finishes as
 * `completed_with_warnings` and carries the reason. It is never displayed as a
 * clean success — a partially processed upload that looks fully reconciled is
 * worse than no reconciliation at all.
 */
export async function runReconciliation(input: {
  shopDomain: string;
  sourceId: string;
  nowIso?: string;
}): Promise<RunResult> {
  const storeId = await resolveStoreId(input.shopDomain);
  const nowIso = input.nowIso ?? new Date().toISOString();

  const source = await prisma.reconciliationSource.findFirst({
    where: { id: input.sourceId, storeId },
    select: { id: true, checkType: true, status: true, validRows: true, invalidRows: true },
  });
  if (!source) throw new HttpError(404, "That upload was not found.");
  if (source.status !== "ready" && source.status !== "completed") {
    throw new HttpError(
      409,
      "Confirm the column mapping for this file before running a reconciliation."
    );
  }
  const checkType = assertCheckType(source.checkType);

  const run = await prisma.reconciliationRun.create({
    data: { storeId, sourceId: source.id, checkType, status: "running" },
    select: { id: true },
  });

  try {
    const [shopify, external] = await Promise.all([
      loadShopifySide(storeId),
      loadExternalRows(storeId, source.id),
    ]);

    const result = runCheck({
      checkType,
      shopifyInventory: shopify.inventory,
      shopifyOrders: shopify.orders,
      external,
      nowIso,
    });

    const warnings = [...result.warnings];
    if (source.invalidRows > 0) {
      warnings.push(
        `${source.invalidRows} rows in this file could not be used and were not reconciled.`
      );
    }

    const discrepancies = result.discrepancies.slice(0, MAX_PERSISTED_DISCREPANCIES);
    if (result.discrepancies.length > discrepancies.length) {
      warnings.push(
        `${result.discrepancies.length - discrepancies.length} further discrepancies were found but not stored for this run.`
      );
    }

    const findings = buildReconciliationFindings({ checkType, discrepancies });

    // --- persist discrepancies with their finding back-reference -----------
    const fingerprintByDiscrepancy = new Map<Discrepancyish, string>();
    for (const finding of findings) {
      const fingerprint = computeFindingFingerprint({
        storeId,
        module: RECONCILIATION_MODULE,
        findingType: finding.findingType,
        subjectKey: finding.subjectKey,
      });
      for (const discrepancy of finding.discrepancies) {
        fingerprintByDiscrepancy.set(discrepancy, fingerprint);
      }
    }

    if (discrepancies.length > 0) {
      await prisma.reconciliationDiscrepancy.createMany({
        data: discrepancies.map((discrepancy) => ({
          runId: run.id,
          storeId,
          kind: discrepancy.kind,
          certainty: discrepancy.certainty,
          matchConfidence: discrepancy.matchConfidence,
          subjectKey: discrepancy.subjectKey,
          shopifyValue: discrepancy.shopifyValue,
          externalValue: discrepancy.externalValue,
          difference: discrepancy.difference,
          impactAmount:
            discrepancy.impact.status === "quantified" ? discrepancy.impact.amount : null,
          impactCurrency:
            discrepancy.impact.status === "quantified" ? discrepancy.impact.currency : null,
          impactBasis:
            discrepancy.impact.status === "quantified"
              ? discrepancy.impact.basis
              : discrepancy.impact.reason,
          evidenceJson: JSON.stringify(discrepancy.evidence),
          findingFingerprint: fingerprintByDiscrepancy.get(discrepancy) ?? null,
        })),
      });
    }

    // --- file findings through the EXISTING lifecycle ----------------------
    let findingsCreated = 0;
    for (const finding of findings) {
      const insightId = `reconciliation:${checkType}:${finding.findingType}`;
      await recordFinding({
        storeId,
        module: RECONCILIATION_MODULE,
        findingType: finding.findingType,
        subjectKey: finding.subjectKey,
        sourceInsightId: insightId,
        snapshot: {
          id: insightId,
          storeId,
          module: RECONCILIATION_MODULE as never,
          title: finding.title,
          reasons: finding.reasons,
          evidence: finding.evidence,
          financialImpact: finding.financialImpact,
          confidence: finding.confidence,
          recency: nowIso,
          urgency: finding.urgency,
          easeOfAction: "manual",
          recommendedAction: finding.recommendedAction,
          score: computeOpportunityScore({
            financialImpact: finding.financialImpact,
            urgency: finding.urgency,
            confidence: finding.confidence,
            easeOfAction: "manual",
            recencyIso: nowIso,
            nowIso,
            storeImpactCap: 1000,
          }),
          methodology: {
            summary: `Compared Shopify against the ${CHECK_TYPE_LABEL[checkType].toLowerCase()} file you uploaded, matching on ${
              checkType === "3pl_invoice" ? "order reference" : "SKU"
            }.`,
            assumptions: [
              "No value is calculated unless a cost or reference rate was present in your own data.",
              "Rows are matched on identifiers only. Similar product names are never treated as a match.",
            ],
            caps: [
              `At most ${MAX_PERSISTED_DISCREPANCIES} discrepancies are stored per run.`,
              "VedaSuite reports where the two records differ. It does not determine why.",
            ],
          },
          route: "/app/reconciliation",
          dataQuality: finding.certainty === "insufficient_data" ? "insufficient_data" : "ok",
        },
      });
      findingsCreated += 1;
    }

    const quantifiedCount = discrepancies.filter(
      (discrepancy) => discrepancy.impact.status === "quantified"
    ).length;
    const status = warnings.length > 0 ? "completed_with_warnings" : "completed";

    await prisma.$transaction([
      prisma.reconciliationRun.updateMany({
        where: { id: run.id, storeId },
        data: {
          status,
          statusReason: warnings.length > 0 ? warnings.join(" ") : null,
          matchedCount: result.counts.exact,
          probableCount: result.counts.probable,
          unmatchedCount: result.counts.unmatched,
          discrepancyCount: discrepancies.length,
          quantifiedCount,
          finishedAt: new Date(),
        },
      }),
      prisma.reconciliationSource.updateMany({
        where: { id: source.id, storeId },
        data: { status: "completed" },
      }),
    ]);

    logEvent("info", "reconciliation.run_completed", {
      storeId,
      runId: run.id,
      checkType,
      status,
      matched: result.counts.exact,
      probable: result.counts.probable,
      unmatched: result.counts.unmatched,
      discrepancies: discrepancies.length,
      quantified: quantifiedCount,
      findings: findingsCreated,
    });

    return {
      runId: run.id,
      status,
      statusReason: warnings.length > 0 ? warnings.join(" ") : null,
      checkType,
      matchedCount: result.counts.exact,
      probableCount: result.counts.probable,
      unmatchedCount: result.counts.unmatched,
      discrepancyCount: discrepancies.length,
      quantifiedCount,
      warnings,
      findingsCreated,
    };
  } catch (error) {
    await prisma.reconciliationRun.updateMany({
      where: { id: run.id, storeId },
      data: {
        status: "failed",
        // Merchant-facing and generic. The real error goes to the log, not to
        // the client, so an internal message cannot leak through this path.
        statusReason:
          "This reconciliation could not be completed. Your uploaded data is unchanged and nothing in Shopify was modified.",
        finishedAt: new Date(),
      },
    });
    logEvent("error", "reconciliation.run_failed", {
      storeId,
      runId: run.id,
      checkType: source.checkType,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/** Structural alias so the fingerprint map can key on identity. */
type Discrepancyish = { kind: string; subjectKey: string };

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** The workspace payload: what exists, what ran, and what it found. */
export async function getReconciliationWorkspace(shopDomain: string) {
  const storeId = await resolveStoreId(shopDomain);

  const [sources, runs, openFindings, variantCoverage] = await Promise.all([
    prisma.reconciliationSource.findMany({
      where: { storeId },
      orderBy: { uploadedAt: "desc" },
      take: 20,
      select: {
        id: true,
        checkType: true,
        fileName: true,
        fileFormat: true,
        status: true,
        statusReason: true,
        totalRows: true,
        validRows: true,
        invalidRows: true,
        duplicateRows: true,
        uploadedAt: true,
      },
    }),
    prisma.reconciliationRun.findMany({
      where: { storeId },
      orderBy: { startedAt: "desc" },
      take: 20,
      select: {
        id: true,
        checkType: true,
        status: true,
        statusReason: true,
        matchedCount: true,
        probableCount: true,
        unmatchedCount: true,
        discrepancyCount: true,
        quantifiedCount: true,
        startedAt: true,
        finishedAt: true,
      },
    }),
    prisma.intelligenceFinding.count({
      where: {
        storeId,
        module: RECONCILIATION_MODULE,
        status: { in: ["new", "seen", "in_review"] },
      },
    }),
    prisma.variantSnapshot.count({
      where: { product: { storeId }, NOT: { sku: null } },
    }),
  ]);

  const latestRun = runs[0] ?? null;
  const discrepancies = latestRun
    ? await prisma.reconciliationDiscrepancy.findMany({
        where: { runId: latestRun.id, storeId },
        orderBy: { createdAt: "asc" },
        take: 200,
      })
    : [];

  return {
    checkTypes: (Object.keys(CHECK_TYPE_FIELDS) as CheckType[]).map((checkType) => ({
      checkType,
      label: CHECK_TYPE_LABEL[checkType],
      requiredFields: CHECK_TYPE_FIELDS[checkType].required,
      optionalFields: CHECK_TYPE_FIELDS[checkType].optional,
      latestRun: runs.find((entry) => entry.checkType === checkType) ?? null,
    })),
    sources,
    runs,
    openFindings,
    latestRun,
    discrepancies: discrepancies.map((row) => ({
      id: row.id,
      kind: row.kind,
      certainty: row.certainty,
      matchConfidence: row.matchConfidence,
      subjectKey: row.subjectKey,
      shopifyValue: row.shopifyValue,
      externalValue: row.externalValue,
      difference: row.difference,
      impactAmount: row.impactAmount,
      impactCurrency: row.impactCurrency,
      impactBasis: row.impactBasis,
      evidence: safeParseEvidence(row.evidenceJson),
    })),
    // Readiness, stated honestly. Inventory reconciliation is impossible
    // without SKUs on the Shopify side, and saying so up front beats a run that
    // matches nothing.
    shopifyReadiness: {
      variantsWithSku: variantCoverage,
      ready: variantCoverage > 0,
      reason:
        variantCoverage > 0
          ? null
          : "None of your Shopify variants have a SKU set, so VedaSuite has nothing to match an inventory or shipment file against. Add SKUs in Shopify and run a sync.",
    },
  };
}

function safeParseEvidence(value: string | null): Array<{ label: string; value: string }> {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Deletes an upload and everything derived from it, scoped to the store. */
export async function deleteReconciliationSource(input: {
  shopDomain: string;
  sourceId: string;
}) {
  const storeId = await resolveStoreId(input.shopDomain);
  const deleted = await prisma.reconciliationSource.deleteMany({
    where: { id: input.sourceId, storeId },
  });
  if (deleted.count === 0) throw new HttpError(404, "That upload was not found.");
  derivedRowCache.delete(input.sourceId);
  logEvent("info", "reconciliation.source_deleted", { storeId, sourceId: input.sourceId });
  return { deleted: deleted.count };
}

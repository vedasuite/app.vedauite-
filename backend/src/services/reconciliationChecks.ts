// The three check types, all running on the one matching engine.
//
// PURE. No database. Each check takes already-normalized records from both
// sides and returns Discrepancy values; persistence and finding creation happen
// elsewhere.
//
// WHAT EACH CHECK IS ALLOWED TO SAY
// ---------------------------------
// The engine reports where two documents disagree. It does not diagnose why,
// and it does not assign blame. Every summary sentence in this file names the
// two values and their difference, and stops there — see
// containsCausalClaim in reconciliationModel.ts, which the tests apply to every
// sentence produced here.

import type {
  Certainty,
  Discrepancy,
  DiscrepancyEvidence,
  MatchConfidence,
  NormalizedRecord,
} from "./reconciliationModel";
import {
  certaintyFor,
  describeQuantityDifference,
  matchRecords,
  quantifyByAmountDifference,
  quantifyByUnitCost,
  round2,
} from "./reconciliationModel";

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

/** A Shopify variant, as reconciliation sees it. */
export interface ShopifyInventoryRecord {
  sku: string | null;
  /** NULL means Shopify did not report a tracked quantity. NOT zero. */
  inventoryQuantity: number | null;
  productHandle: string;
  variantTitle: string | null;
  /** Present only when a cost was OBSERVED, never an assumption. */
  unitCost?: number | null;
  currency?: string | null;
}

/** A Shopify order, as reconciliation sees it. */
export interface ShopifyOrderRecord {
  orderRef: string | null;
  status: string;
  refunded: boolean;
  currency: string | null;
  totalAmount: number;
  createdAtIso: string;
}

/** One row from the merchant's uploaded file, already validated. */
export interface ExternalRow {
  rowNumber: number;
  sku: string | null;
  orderRef: string | null;
  tracking: string | null;
  location: string | null;
  quantity: number | null;
  amount: number | null;
  expectedAmount: number | null;
  expectedQuantity: number | null;
  receivedQuantity: number | null;
  unitCost: number | null;
  currency: string | null;
  observedAtIso: string | null;
  duplicateOf: number | null;
}

export interface CheckResult {
  discrepancies: Discrepancy[];
  counts: {
    exact: number;
    probable: number;
    unmatched: number;
  };
  /** Reasons the run is only partially conclusive. Surfaced, never hidden. */
  warnings: string[];
}

const fileRow = (rowNumber: number): DiscrepancyEvidence => ({
  label: "Row in your file",
  value: String(rowNumber),
});

/** Evidence naming which identifier the pairing was made on. */
const matchedOn = (kind: string, key: string): DiscrepancyEvidence => ({
  label: "Matched on",
  value: `${kind} ${key}`,
});

/** How old a file's snapshot is, when it says. */
export const STALE_SNAPSHOT_HOURS = 72;

function snapshotWarnings(rows: ExternalRow[], nowIso: string): string[] {
  const dated = rows.filter((row) => row.observedAtIso);
  // A file that does not carry a date gets NO staleness comment at all.
  if (dated.length === 0) return [];
  const newest = dated.reduce((latest, row) =>
    (row.observedAtIso as string) > (latest.observedAtIso as string) ? row : latest
  );
  const ageHours =
    (new Date(nowIso).getTime() - new Date(newest.observedAtIso as string).getTime()) /
    3_600_000;
  if (ageHours <= STALE_SNAPSHOT_HOURS) return [];
  return [
    `The newest date in this file is ${Math.round(
      ageHours / 24
    )} days old, so these figures describe an older snapshot than your current Shopify data.`,
  ];
}

// ---------------------------------------------------------------------------
// 1. INVENTORY
// ---------------------------------------------------------------------------

export const INVENTORY_KINDS = {
  quantityMismatch: "inventory_quantity_mismatch",
  missingExternally: "inventory_missing_externally",
  externalOnly: "inventory_external_only",
  duplicateRow: "inventory_duplicate_row",
  locationMismatch: "inventory_location_mismatch",
  negativeQuantity: "inventory_negative_quantity",
  untrackedInShopify: "inventory_untracked_in_shopify",
} as const;

/**
 * Compares Shopify inventory against a warehouse or 3PL stock file.
 *
 * NULL IS NOT ZERO. A Shopify variant with no tracked quantity is reported as
 * untracked, not as a variant holding nothing — telling a merchant their
 * warehouse has 11 units "more" than a Shopify variant that simply is not
 * inventory-tracked would be a fabricated discrepancy.
 */
export function runInventoryCheck(input: {
  shopify: ShopifyInventoryRecord[];
  external: ExternalRow[];
  nowIso: string;
}): CheckResult {
  const discrepancies: Discrepancy[] = [];
  const warnings = snapshotWarnings(input.external, input.nowIso);

  const shopifyRecords: NormalizedRecord[] = input.shopify.map((variant) => ({
    side: "shopify",
    rowNumber: 0,
    sku: variant.sku,
    quantity: variant.inventoryQuantity,
    label: variant.variantTitle ?? variant.productHandle,
  }));
  const externalRecords: NormalizedRecord[] = input.external.map((row) => ({
    side: "external",
    rowNumber: row.rowNumber,
    sku: row.sku,
    quantity: row.quantity,
    location: row.location,
    observedAtIso: row.observedAtIso,
  }));

  const skuless = input.shopify.filter((variant) => !variant.sku).length;
  if (skuless > 0) {
    warnings.push(
      `${skuless} of your Shopify variants have no SKU set, so they cannot be matched to any file row. Set a SKU in Shopify to include them.`
    );
  }

  const result = matchRecords({
    shopify: shopifyRecords,
    external: externalRecords,
    keyKind: "sku",
  });
  const externalByRow = new Map(input.external.map((row) => [row.rowNumber, row]));
  const shopifyBySku = new Map(
    input.shopify
      .filter((variant) => variant.sku)
      .map((variant) => [(variant.sku as string).toLowerCase(), variant])
  );

  // --- matched pairs -------------------------------------------------------
  for (const pair of result.matched) {
    const variant = shopifyBySku.get(pair.key);
    const shopifyQuantity = pair.shopify[0]?.quantity ?? null;
    // Sum the external side: a multi-location export legitimately splits one
    // SKU across rows, and comparing only the first would invent a shortfall.
    const externalRows = pair.external
      .map((record) => externalByRow.get(record.rowNumber))
      .filter((row): row is ExternalRow => !!row);
    const externalQuantity = externalRows.reduce(
      (total, row) => total + (row.quantity ?? 0),
      0
    );

    if (pair.external.length > 1) {
      const rowNumbers = externalRows.map((row) => row.rowNumber);
      discrepancies.push({
        kind: INVENTORY_KINDS.duplicateRow,
        certainty: "confirmed",
        matchConfidence: pair.confidence,
        subjectKey: pair.key,
        summary: `SKU ${pair.key} appears on ${pair.external.length} rows of your file (rows ${rowNumbers.join(
          ", "
        )}). VedaSuite added them together; if they are not separate locations, the file may contain duplicates.`,
        shopifyValue: shopifyQuantity == null ? null : String(shopifyQuantity),
        externalValue: String(externalQuantity),
        difference: null,
        impact: {
          status: "not_quantified",
          reason: "A repeated row is a data question, not a monetary one.",
        },
        evidence: [
          matchedOn("SKU", pair.key),
          { label: "Rows in your file", value: rowNumbers.join(", ") },
          { label: "Combined quantity", value: String(externalQuantity) },
        ],
      });
    }

    if (shopifyQuantity == null) {
      discrepancies.push({
        kind: INVENTORY_KINDS.untrackedInShopify,
        certainty: "insufficient_data",
        matchConfidence: pair.confidence,
        subjectKey: pair.key,
        summary: `SKU ${pair.key} is in your file with ${externalQuantity} units, but Shopify does not report a tracked inventory quantity for it, so the two cannot be compared.`,
        shopifyValue: null,
        externalValue: String(externalQuantity),
        difference: null,
        impact: {
          status: "not_quantified",
          reason: "There is no Shopify quantity to compare against, so there is no difference to value.",
        },
        evidence: [
          matchedOn("SKU", pair.key),
          { label: "File quantity", value: String(externalQuantity) },
          { label: "Shopify inventory tracking", value: "Not tracked for this variant" },
          fileRow(externalRows[0]?.rowNumber ?? 0),
        ],
      });
      continue;
    }

    const negativeRow = externalRows.find((row) => (row.quantity ?? 0) < 0);
    if (negativeRow) {
      discrepancies.push({
        kind: INVENTORY_KINDS.negativeQuantity,
        certainty: certaintyFor(pair.confidence),
        matchConfidence: pair.confidence,
        subjectKey: pair.key,
        summary: `Your file reports a negative quantity (${negativeRow.quantity}) for SKU ${pair.key}.`,
        shopifyValue: String(shopifyQuantity),
        externalValue: String(negativeRow.quantity),
        difference: null,
        impact: {
          status: "not_quantified",
          reason: "A negative count is a data question rather than a valued difference.",
        },
        evidence: [matchedOn("SKU", pair.key), fileRow(negativeRow.rowNumber)],
      });
    }

    const difference = round2(externalQuantity - shopifyQuantity);
    if (difference !== 0) {
      const costRow = externalRows.find((row) => row.unitCost != null);
      const unitCost = costRow?.unitCost ?? variant?.unitCost ?? null;
      const currency = costRow?.currency ?? variant?.currency ?? null;
      const costIsObserved = unitCost != null;

      discrepancies.push({
        kind: INVENTORY_KINDS.quantityMismatch,
        certainty: certaintyFor(pair.confidence),
        matchConfidence: pair.confidence,
        subjectKey: pair.key,
        summary: describeQuantityDifference({
          subject: `SKU ${pair.key}`,
          shopifyQuantity,
          externalQuantity,
          externalLabel: "Your uploaded file",
        }),
        shopifyValue: String(shopifyQuantity),
        externalValue: String(externalQuantity),
        difference,
        impact: quantifyByUnitCost({
          units: difference,
          unitCost,
          currency,
          costIsObserved,
          costSourceLabel: costRow?.unitCost != null ? "the cost column in your file" : "the recorded product cost",
        }),
        evidence: [
          matchedOn("SKU", pair.key),
          { label: "Shopify quantity", value: String(shopifyQuantity) },
          { label: "File quantity", value: String(externalQuantity) },
          { label: "Difference", value: `${difference > 0 ? "+" : ""}${difference} units` },
          fileRow(externalRows[0]?.rowNumber ?? 0),
          ...(pair.ambiguityReason
            ? [{ label: "Why this is not confirmed", value: pair.ambiguityReason }]
            : []),
        ],
      });
    }

    // Location is only comparable when the file supplies one AND Shopify has
    // something to compare it with. VedaSuite has no per-location Shopify
    // inventory today, so this reports MULTIPLE locations in the file rather
    // than claiming a mismatch against Shopify it cannot see.
    const locations = Array.from(
      new Set(externalRows.map((row) => row.location).filter((value): value is string => !!value))
    );
    if (locations.length > 1) {
      discrepancies.push({
        kind: INVENTORY_KINDS.locationMismatch,
        certainty: "insufficient_data",
        matchConfidence: pair.confidence,
        subjectKey: pair.key,
        summary: `SKU ${pair.key} is reported at ${locations.length} locations in your file (${locations.join(
          ", "
        )}). Shopify does not tell VedaSuite which location holds which units, so the split cannot be verified.`,
        shopifyValue: String(shopifyQuantity),
        externalValue: String(externalQuantity),
        difference: null,
        impact: {
          status: "not_quantified",
          reason: "No per-location Shopify inventory is available to compare against.",
        },
        evidence: [
          matchedOn("SKU", pair.key),
          { label: "Locations in your file", value: locations.join(", ") },
        ],
      });
    }
  }

  // --- present in Shopify only --------------------------------------------
  for (const record of result.shopifyOnly) {
    const key = (record.sku as string).toLowerCase();
    discrepancies.push({
      kind: INVENTORY_KINDS.missingExternally,
      certainty: certaintyFor("unmatched"),
      matchConfidence: "unmatched",
      subjectKey: key,
      summary: `SKU ${key} exists in Shopify${
        record.quantity == null ? "" : ` with ${record.quantity} units`
      } but does not appear anywhere in the uploaded file.`,
      shopifyValue: record.quantity == null ? null : String(record.quantity),
      externalValue: null,
      difference: null,
      impact: {
        status: "not_quantified",
        reason:
          "A SKU absent from the file may simply be stored elsewhere or excluded from the export, so no value is placed on it.",
      },
      evidence: [
        { label: "SKU", value: key },
        { label: "In Shopify", value: record.quantity == null ? "Not inventory-tracked" : `${record.quantity} units` },
        { label: "In uploaded file", value: "Not present" },
      ],
    });
  }

  // --- present in the file only -------------------------------------------
  for (const record of result.externalOnly) {
    const row = externalByRow.get(record.rowNumber);
    const key = (record.sku as string).toLowerCase();
    discrepancies.push({
      kind: INVENTORY_KINDS.externalOnly,
      certainty: certaintyFor("unmatched"),
      matchConfidence: "unmatched",
      subjectKey: key,
      summary: `SKU ${key} appears in your file with ${
        row?.quantity ?? 0
      } units but no Shopify variant carries that SKU.`,
      shopifyValue: null,
      externalValue: String(row?.quantity ?? 0),
      difference: null,
      impact: {
        status: "not_quantified",
        reason: "There is no Shopify product to compare against, so no value is placed on this row.",
      },
      evidence: [
        { label: "SKU", value: key },
        { label: "In uploaded file", value: `${row?.quantity ?? 0} units` },
        { label: "In Shopify", value: "No variant with this SKU" },
        fileRow(record.rowNumber),
      ],
    });
  }

  if (result.unkeyed.length > 0) {
    warnings.push(
      `${result.unkeyed.length} rows in your file have no SKU, so they could not be matched to anything.`
    );
  }

  return { discrepancies, counts: result.counts, warnings };
}

// ---------------------------------------------------------------------------
// 2. 3PL INVOICE
// ---------------------------------------------------------------------------

export const INVOICE_KINDS = {
  unmatchedCharge: "invoice_unmatched_charge",
  duplicateCharge: "invoice_duplicate_charge",
  cancelledOrderCharge: "invoice_cancelled_order_charge",
  refundedOrderCharge: "invoice_refunded_order_charge",
  amountDifference: "invoice_amount_difference",
  unverifiedCharge: "invoice_unverified_charge",
} as const;

const CANCELLED_STATUSES = new Set(["cancelled", "canceled", "voided", "expired"]);

/**
 * Compares an uploaded 3PL invoice against Shopify order records.
 *
 * THE RULE THAT DEFINES THIS CHECK. A charge is not wrong merely because it
 * exists. Without a contracted or expected rate, VedaSuite can say a charge is
 * UNVERIFIED — it has nothing to check it against — but it may not call it an
 * overcharge. With an expected rate supplied in the file, the difference is
 * arithmetic on two figures the merchant provided, and may be stated.
 */
export function runInvoiceCheck(input: {
  shopifyOrders: ShopifyOrderRecord[];
  external: ExternalRow[];
  nowIso: string;
}): CheckResult {
  const discrepancies: Discrepancy[] = [];
  const warnings = snapshotWarnings(input.external, input.nowIso);

  const hasAnyExpectedRate = input.external.some((row) => row.expectedAmount != null);
  if (!hasAnyExpectedRate) {
    warnings.push(
      "This file contains no expected or contracted rate, so VedaSuite can report charges it cannot match to an order, but not whether any amount is too high."
    );
  }

  const result = matchRecords({
    shopify: input.shopifyOrders.map((order) => ({
      side: "shopify" as const,
      rowNumber: 0,
      orderRef: order.orderRef,
    })),
    external: input.external.map((row) => ({
      side: "external" as const,
      rowNumber: row.rowNumber,
      orderRef: row.orderRef,
      amount: row.amount,
    })),
    keyKind: "order_ref",
  });

  const orderByRef = new Map(
    input.shopifyOrders
      .filter((order) => order.orderRef)
      .map((order) => [(order.orderRef as string).replace(/^#+/, "").toLowerCase(), order])
  );
  const externalByRow = new Map(input.external.map((row) => [row.rowNumber, row]));

  for (const pair of result.matched) {
    const order = orderByRef.get(pair.key);
    const rows = pair.external
      .map((record) => externalByRow.get(record.rowNumber))
      .filter((row): row is ExternalRow => !!row);

    // --- more than one charge for one order ------------------------------
    if (rows.length > 1) {
      const identical = rows.filter(
        (row) => row.amount != null && row.amount === rows[0].amount
      );
      const isLikelyDuplicate = identical.length > 1;
      discrepancies.push({
        kind: INVOICE_KINDS.duplicateCharge,
        // Several lines for one order is normal in some contracts (pick, pack
        // and ship billed separately). Identical amounts is a stronger signal,
        // but neither is proof, so neither is ever "confirmed".
        certainty: "possible",
        matchConfidence: pair.confidence,
        subjectKey: pair.key,
        summary: isLikelyDuplicate
          ? `Order ${pair.key} carries ${identical.length} charges of the same amount (${rows[0].amount}) on rows ${identical
              .map((row) => row.rowNumber)
              .join(", ")}.`
          : `Order ${pair.key} carries ${rows.length} separate charges in this invoice (rows ${rows
              .map((row) => row.rowNumber)
              .join(", ")}).`,
        shopifyValue: order ? `1 order` : null,
        externalValue: `${rows.length} charges`,
        difference: null,
        impact: {
          status: "not_quantified",
          reason:
            "VedaSuite does not know whether your contract bills this order as one line or several, so it does not treat the extra lines as recoverable.",
        },
        evidence: [
          matchedOn("order", pair.key),
          {
            label: "Charges on this order",
            value: rows
              .map((row) => `row ${row.rowNumber}: ${row.amount ?? "unreadable"}`)
              .join("; "),
          },
        ],
      });
    }

    for (const row of rows) {
      // --- charged against a cancelled or refunded order -------------------
      if (order && CANCELLED_STATUSES.has(order.status.toLowerCase())) {
        discrepancies.push({
          kind: INVOICE_KINDS.cancelledOrderCharge,
          certainty: certaintyFor(pair.confidence),
          matchConfidence: pair.confidence,
          subjectKey: pair.key,
          summary: `Order ${pair.key} is ${order.status.toLowerCase()} in Shopify, but this invoice charges ${
            row.amount ?? "an unreadable amount"
          } for it.`,
          shopifyValue: order.status,
          externalValue: row.amount == null ? null : String(row.amount),
          difference: null,
          impact: chargeImpactWithoutRate(row),
          evidence: [
            matchedOn("order", pair.key),
            { label: "Shopify order status", value: order.status },
            { label: "Charged", value: String(row.amount ?? "unreadable") },
            fileRow(row.rowNumber),
          ],
        });
      } else if (order?.refunded) {
        discrepancies.push({
          kind: INVOICE_KINDS.refundedOrderCharge,
          // A refunded order was usually still shipped, so the charge may be
          // entirely correct. This is a prompt to check, not an accusation.
          certainty: "possible",
          matchConfidence: pair.confidence,
          subjectKey: pair.key,
          summary: `Order ${pair.key} was refunded in Shopify, and this invoice charges ${
            row.amount ?? "an unreadable amount"
          } for it. A refunded order may still have shipped, so this is worth checking rather than assuming.`,
          shopifyValue: "Refunded",
          externalValue: row.amount == null ? null : String(row.amount),
          difference: null,
          impact: chargeImpactWithoutRate(row),
          evidence: [
            matchedOn("order", pair.key),
            { label: "Shopify order", value: "Refunded" },
            { label: "Charged", value: String(row.amount ?? "unreadable") },
            fileRow(row.rowNumber),
          ],
        });
      }

      // --- billed vs expected ---------------------------------------------
      if (row.expectedAmount != null && row.amount != null) {
        const difference = round2(row.amount - row.expectedAmount);
        if (difference !== 0) {
          discrepancies.push({
            kind: INVOICE_KINDS.amountDifference,
            certainty: certaintyFor(pair.confidence),
            matchConfidence: pair.confidence,
            subjectKey: pair.key,
            summary: `Order ${pair.key} was billed ${row.amount} against a supplied expected rate of ${row.expectedAmount}, a difference of ${
              difference > 0 ? "+" : ""
            }${difference}.`,
            shopifyValue: null,
            externalValue: String(row.amount),
            difference,
            impact: quantifyByAmountDifference({
              billed: row.amount,
              expected: row.expectedAmount,
              currency: row.currency ?? order?.currency ?? null,
              expectedSourceLabel: "the expected rate column in your file",
            }),
            evidence: [
              matchedOn("order", pair.key),
              { label: "Billed", value: String(row.amount) },
              { label: "Expected rate you supplied", value: String(row.expectedAmount) },
              {
                label: "Difference",
                value: `${difference > 0 ? "+" : ""}${difference}`,
              },
              fileRow(row.rowNumber),
            ],
          });
        }
      }
    }
  }

  // --- charged for something not in Shopify -------------------------------
  for (const record of result.externalOnly) {
    const row = externalByRow.get(record.rowNumber);
    discrepancies.push({
      kind: INVOICE_KINDS.unmatchedCharge,
      certainty: certaintyFor("unmatched"),
      matchConfidence: "unmatched",
      subjectKey: (record.orderRef as string) ?? String(record.rowNumber),
      summary: `This invoice charges ${
        row?.amount ?? "an unreadable amount"
      } against order reference ${record.orderRef}, which does not match any order VedaSuite has synced from Shopify.`,
      shopifyValue: null,
      externalValue: row?.amount == null ? null : String(row.amount),
      difference: null,
      impact: {
        status: "not_quantified",
        reason:
          "The order may predate what VedaSuite has synced, or use a different reference format, so no amount is claimed as recoverable.",
      },
      evidence: [
        { label: "Order reference on the invoice", value: String(record.orderRef) },
        { label: "In Shopify", value: "No matching order found" },
        { label: "Charged", value: String(row?.amount ?? "unreadable") },
        fileRow(record.rowNumber),
      ],
    });
  }

  if (result.unkeyed.length > 0) {
    warnings.push(
      `${result.unkeyed.length} invoice rows carry no order reference, so they could not be matched to an order.`
    );
  }

  return { discrepancies, counts: result.counts, warnings };
}

/**
 * The impact of a questionable charge when no reference rate exists.
 *
 * Always unquantified. This is the difference between "$742 of charges are
 * unverified" and "the 3PL overcharged you $742" — the first is true, the
 * second requires an authoritative rate VedaSuite does not have.
 */
function chargeImpactWithoutRate(row: ExternalRow): Discrepancy["impact"] {
  if (row.expectedAmount != null && row.amount != null && row.currency) {
    return quantifyByAmountDifference({
      billed: row.amount,
      expected: row.expectedAmount,
      currency: row.currency,
      expectedSourceLabel: "the expected rate column in your file",
    });
  }
  return {
    status: "not_quantified",
    reason:
      "VedaSuite has no contracted rate for this charge, so it can flag the charge as unverified but not state that any amount is recoverable.",
  };
}

// ---------------------------------------------------------------------------
// 3. SUPPLIER SHIPMENT
// ---------------------------------------------------------------------------

export const SUPPLIER_KINDS = {
  quantityShortfall: "supplier_quantity_shortfall",
  quantityOverage: "supplier_quantity_overage",
  partialShipment: "supplier_partial_shipment",
  missingSku: "supplier_missing_sku",
  unexpectedSku: "supplier_unexpected_sku",
  duplicateLine: "supplier_duplicate_line",
  missingTracking: "supplier_missing_tracking",
} as const;

/**
 * Compares a supplier shipment or receipt file against Shopify products, and —
 * where the file supplies both — against itself.
 *
 * NO INVENTED EXPECTATIONS. There is no assumed lead time and no default
 * delivery date anywhere in this check. A shipment is only ever described as
 * short when the file states both what was expected and what arrived; nothing
 * is ever called late, because no expected date is derivable from Shopify.
 */
export function runSupplierCheck(input: {
  shopify: ShopifyInventoryRecord[];
  external: ExternalRow[];
  nowIso: string;
}): CheckResult {
  const discrepancies: Discrepancy[] = [];
  const warnings = snapshotWarnings(input.external, input.nowIso);

  const comparableRows = input.external.filter(
    (row) => row.expectedQuantity != null || row.receivedQuantity != null
  );
  if (comparableRows.length === 0) {
    warnings.push(
      "This file does not contain both an expected and a received quantity, so VedaSuite can list what arrived but cannot say whether anything is short."
    );
  }

  const result = matchRecords({
    shopify: input.shopify.map((variant) => ({
      side: "shopify" as const,
      rowNumber: 0,
      sku: variant.sku,
      label: variant.productHandle,
    })),
    external: input.external.map((row) => ({
      side: "external" as const,
      rowNumber: row.rowNumber,
      sku: row.sku,
    })),
    keyKind: "sku",
  });

  const externalByRow = new Map(input.external.map((row) => [row.rowNumber, row]));
  const seenLines = new Map<string, number>();

  for (const row of input.external) {
    const key = row.sku ?? String(row.rowNumber);

    // --- duplicate shipment line ----------------------------------------
    const identity = [row.sku, row.tracking ?? "", row.receivedQuantity ?? row.quantity ?? ""].join("|");
    const previousRow = seenLines.get(identity);
    if (previousRow != null) {
      discrepancies.push({
        kind: SUPPLIER_KINDS.duplicateLine,
        certainty: "possible",
        matchConfidence: "exact",
        subjectKey: key,
        summary: `Rows ${previousRow} and ${row.rowNumber} describe the same SKU, tracking reference and quantity, so one may be a repeated line.`,
        shopifyValue: null,
        externalValue: String(row.receivedQuantity ?? row.quantity ?? ""),
        difference: null,
        impact: {
          status: "not_quantified",
          reason: "A repeated line is a data question until you confirm which of the two is real.",
        },
        evidence: [
          { label: "SKU", value: String(row.sku ?? "not supplied") },
          { label: "Rows in your file", value: `${previousRow}, ${row.rowNumber}` },
        ],
      });
    } else {
      seenLines.set(identity, row.rowNumber);
    }

    // --- expected vs received -------------------------------------------
    const expected = row.expectedQuantity;
    const received = row.receivedQuantity ?? row.quantity ?? null;
    if (expected != null && received != null) {
      const difference = round2(received - expected);
      if (difference < 0) {
        const kind =
          received > 0 ? SUPPLIER_KINDS.partialShipment : SUPPLIER_KINDS.quantityShortfall;
        discrepancies.push({
          kind,
          certainty: "confirmed",
          matchConfidence: "exact",
          subjectKey: key,
          // States the two documented figures. Says nothing about where the
          // difference went or who is responsible for it.
          summary: `Your file records ${expected} units expected and ${received} received for ${
            row.sku ? `SKU ${row.sku}` : `row ${row.rowNumber}`
          }, a shortfall of ${Math.abs(difference)} units.`,
          shopifyValue: null,
          externalValue: String(received),
          difference,
          impact: quantifyByUnitCost({
            units: difference,
            unitCost: row.unitCost,
            currency: row.currency,
            costIsObserved: row.unitCost != null,
            costSourceLabel: "the unit cost column in your file",
          }),
          evidence: [
            { label: "SKU", value: String(row.sku ?? "not supplied") },
            { label: "Expected", value: String(expected) },
            { label: "Received", value: String(received) },
            { label: "Shortfall", value: `${Math.abs(difference)} units` },
            ...(row.tracking ? [{ label: "Tracking", value: row.tracking }] : []),
            fileRow(row.rowNumber),
          ],
        });
      } else if (difference > 0) {
        discrepancies.push({
          kind: SUPPLIER_KINDS.quantityOverage,
          certainty: "confirmed",
          matchConfidence: "exact",
          subjectKey: key,
          summary: `Your file records ${expected} units expected and ${received} received for ${
            row.sku ? `SKU ${row.sku}` : `row ${row.rowNumber}`
          }, which is ${difference} more than expected.`,
          shopifyValue: null,
          externalValue: String(received),
          difference,
          impact: {
            status: "not_quantified",
            reason: "Receiving more than expected is not a loss, so no value is placed on it.",
          },
          evidence: [
            { label: "SKU", value: String(row.sku ?? "not supplied") },
            { label: "Expected", value: String(expected) },
            { label: "Received", value: String(received) },
            fileRow(row.rowNumber),
          ],
        });
      }
    }

    // --- missing tracking, only where other rows have it ------------------
    if (!row.tracking && input.external.some((other) => other.tracking)) {
      discrepancies.push({
        kind: SUPPLIER_KINDS.missingTracking,
        certainty: "confirmed",
        matchConfidence: "exact",
        subjectKey: key,
        summary: `Row ${row.rowNumber} has no tracking reference, while other rows in the same file do.`,
        shopifyValue: null,
        externalValue: null,
        difference: null,
        impact: {
          status: "not_quantified",
          reason: "A missing reference is a completeness issue, not a monetary one.",
        },
        evidence: [
          { label: "SKU", value: String(row.sku ?? "not supplied") },
          fileRow(row.rowNumber),
        ],
      });
    }
  }

  // --- SKUs in the shipment that Shopify does not carry -------------------
  for (const record of result.externalOnly) {
    const row = externalByRow.get(record.rowNumber);
    discrepancies.push({
      kind: SUPPLIER_KINDS.unexpectedSku,
      certainty: certaintyFor("unmatched"),
      matchConfidence: "unmatched",
      subjectKey: (record.sku as string) ?? String(record.rowNumber),
      summary: `SKU ${record.sku} appears in this shipment file but no Shopify variant carries that SKU.`,
      shopifyValue: null,
      externalValue: String(row?.receivedQuantity ?? row?.quantity ?? ""),
      difference: null,
      impact: {
        status: "not_quantified",
        reason: "There is no Shopify product to compare against.",
      },
      evidence: [
        { label: "SKU", value: String(record.sku) },
        { label: "In Shopify", value: "No variant with this SKU" },
        fileRow(record.rowNumber),
      ],
    });
  }

  if (result.unkeyed.length > 0) {
    discrepancies.push({
      kind: SUPPLIER_KINDS.missingSku,
      certainty: "confirmed",
      matchConfidence: "unmatched",
      subjectKey: "rows_without_sku",
      summary: `${result.unkeyed.length} rows in this shipment file have no SKU, so they cannot be matched to a product.`,
      shopifyValue: null,
      externalValue: String(result.unkeyed.length),
      difference: null,
      impact: {
        status: "not_quantified",
        reason: "Rows without an identifier cannot be compared to anything.",
      },
      evidence: [
        {
          label: "Rows in your file",
          value: result.unkeyed.map((record) => record.rowNumber).join(", "),
        },
      ],
    });
  }

  return { discrepancies, counts: result.counts, warnings };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export interface CheckInput {
  checkType: string;
  shopifyInventory: ShopifyInventoryRecord[];
  shopifyOrders: ShopifyOrderRecord[];
  external: ExternalRow[];
  nowIso: string;
}

/** Routes to the right check. One entry point, so callers stay uniform. */
export function runCheck(input: CheckInput): CheckResult {
  switch (input.checkType) {
    case "inventory":
      return runInventoryCheck({
        shopify: input.shopifyInventory,
        external: input.external,
        nowIso: input.nowIso,
      });
    case "3pl_invoice":
      return runInvoiceCheck({
        shopifyOrders: input.shopifyOrders,
        external: input.external,
        nowIso: input.nowIso,
      });
    case "supplier_shipment":
      return runSupplierCheck({
        shopify: input.shopifyInventory,
        external: input.external,
        nowIso: input.nowIso,
      });
    default:
      throw new Error(`Unknown check type: ${input.checkType}`);
  }
}

/** Certainty ranking, used for ordering and for the run's headline. */
export const CERTAINTY_RANK: Record<Certainty, number> = {
  confirmed: 3,
  possible: 2,
  insufficient_data: 1,
};

export function matchConfidenceRank(confidence: MatchConfidence): number {
  return confidence === "exact" ? 3 : confidence === "probable" ? 2 : 1;
}

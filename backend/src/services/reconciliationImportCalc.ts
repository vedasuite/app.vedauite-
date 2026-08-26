// Turning confirmed mappings and raw rows into validated, normalized records.
//
// PURE. No database.
//
// Everything a merchant is shown BEFORE they commit a run is computed here:
// how many rows are usable, how many were rejected and why, and which rows
// duplicate each other. A merchant should never press "reconcile" and discover
// afterwards that half the file was silently dropped.

import type { ConfirmedMapping, FieldKey } from "./columnMapping";
import { CHECK_TYPE_FIELDS, fieldDefinition } from "./columnMapping";
import { normalizeKey, normalizeOrderRef, parseNumeric } from "./reconciliationModel";

export interface ImportedRow {
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
  /** Charge type as the merchant wrote it, for rate-card matching. */
  chargeType: string | null;
  observedAtIso: string | null;
  /** Set when the row cannot be used. Shown to the merchant verbatim. */
  invalidReason: string | null;
  /** True when an earlier row carried the same identity. */
  duplicateOf: number | null;
}

export interface ImportPreview {
  rows: ImportedRow[];
  totalRows: number;
  validRows: number;
  invalidRows: number;
  duplicateRows: number;
  /** Fields the mapping did not supply, with what each would have unlocked. */
  missingOptionalFields: Array<{ field: FieldKey; label: string; consequence: string }>;
  /** True when MAX_ROWS cut the file short during parsing. */
  truncated: boolean;
}

/**
 * Parses a date from a spreadsheet cell.
 *
 * Handles ISO strings and the Excel serial-day numbers a workbook stores for
 * date-formatted cells. Returns null rather than a guess for anything else:
 * "03/04/2026" is genuinely ambiguous between March and April, and a wrong date
 * would be used to tell a merchant their snapshot is stale when it is not.
 */
export function parseObservedAt(raw: string | null | undefined): string | null {
  const value = (raw ?? "").trim();
  if (!value) return null;

  // Excel serial day: days since 1899-12-30 (Excel's leap-year quirk included).
  if (/^\d{5}(\.\d+)?$/.test(value)) {
    const serial = Number(value);
    if (serial > 20_000 && serial < 80_000) {
      const millis = Math.round((serial - 25_569) * 86_400_000);
      const date = new Date(millis);
      return Number.isNaN(date.getTime()) ? null : date.toISOString();
    }
  }

  // Unambiguous ISO-ish forms only.
  if (/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?/.test(value)) {
    const date = new Date(value.replace(" ", "T"));
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  return null;
}

/**
 * Normalizes a currency code without inventing one.
 *
 * A missing currency stays missing: defaulting to USD would let VedaSuite state
 * a dollar figure for a merchant billing in euros.
 */
export function normalizeCurrency(raw: string | null | undefined): string | null {
  const value = (raw ?? "").trim().toUpperCase();
  if (/^[A-Z]{3}$/.test(value)) return value;
  const symbols: Record<string, string> = { $: "USD", "£": "GBP", "€": "EUR" };
  return symbols[value] ?? null;
}

/**
 * Builds normalized rows and explains every rejection.
 *
 * DUPLICATES ARE FLAGGED, NOT DISCARDED. A repeated SKU in an inventory file
 * and a repeated order reference in a 3PL invoice mean different things — the
 * first is usually a multi-location export, the second is a candidate double
 * charge — so this layer records the repetition and lets each check decide.
 */
export function buildImportPreview(input: {
  checkType: string;
  headers: string[];
  rows: string[][];
  mapping: ConfirmedMapping;
  truncated?: boolean;
}): ImportPreview {
  const spec = CHECK_TYPE_FIELDS[input.checkType];
  if (!spec) throw new Error(`Unknown check type: ${input.checkType}`);

  const indexOf = (field: FieldKey): number => {
    const header = input.mapping[field];
    if (!header) return -1;
    return input.headers.indexOf(header);
  };

  const columns: Record<string, number> = {};
  for (const field of [...spec.required, ...spec.optional]) {
    columns[field] = indexOf(field);
  }

  const cell = (row: string[], field: FieldKey): string | null => {
    const index = columns[field];
    if (index == null || index < 0) return null;
    const value = (row[index] ?? "").trim();
    return value.length > 0 ? value : null;
  };

  const seen = new Map<string, number>();
  const rows: ImportedRow[] = [];

  input.rows.forEach((raw, offset) => {
    // +2: one for the header row, one because merchants count from 1.
    const rowNumber = offset + 2;

    const isBlank = raw.every((value) => !String(value ?? "").trim());
    if (isBlank) return;

    const sku = normalizeKey(cell(raw, "sku"));
    const orderRef = normalizeOrderRef(cell(raw, "orderRef"));
    const quantityRaw = cell(raw, "quantity");
    const quantity = parseNumeric(quantityRaw);
    const amountRaw = cell(raw, "amount");
    const amount = parseNumeric(amountRaw);

    const row: ImportedRow = {
      rowNumber,
      sku,
      orderRef,
      tracking: normalizeKey(cell(raw, "tracking")),
      location: cell(raw, "location"),
      quantity,
      amount,
      expectedAmount: parseNumeric(cell(raw, "expectedAmount")),
      expectedQuantity: parseNumeric(cell(raw, "expectedQuantity")),
      receivedQuantity: parseNumeric(cell(raw, "receivedQuantity")),
      unitCost: parseNumeric(cell(raw, "unitCost")),
      chargeType: cell(raw, "chargeType"),
      currency: normalizeCurrency(cell(raw, "currency")),
      observedAtIso: parseObservedAt(cell(raw, "observedAt")),
      invalidReason: null,
      duplicateOf: null,
    };

    // --- validation, in the order a merchant would ask about it -------------
    const missingRequired = spec.required.filter((field) => {
      switch (field) {
        case "sku":
          return !row.sku;
        case "orderRef":
          return !row.orderRef;
        case "quantity":
          return row.quantity == null;
        case "amount":
          return row.amount == null;
        default:
          return !cell(raw, field);
      }
    });

    if (missingRequired.length > 0) {
      // Distinguish "the cell was empty" from "the cell had something
      // unreadable in it" — they need different fixes.
      const unreadable = missingRequired.filter((field) => {
        if (field === "quantity") return quantityRaw != null && row.quantity == null;
        if (field === "amount") return amountRaw != null && row.amount == null;
        return false;
      });
      row.invalidReason =
        unreadable.length > 0
          ? `${unreadable
              .map((field) => fieldDefinition(field).label)
              .join(" and ")} could not be read as a number on this row.`
          : `${missingRequired
              .map((field) => fieldDefinition(field).label)
              .join(" and ")} is empty on this row.`;
    } else if (row.quantity != null && !Number.isFinite(row.quantity)) {
      row.invalidReason = "Quantity on this row is not a usable number.";
    } else if (row.quantity != null && row.quantity < 0) {
      // Negative stock is real in some systems (oversold), so this is reported
      // as a discrepancy later rather than rejected here — but a negative in a
      // 3PL amount column is almost always a credit note, which is a different
      // thing from a charge and must not be netted silently.
      row.invalidReason = null;
    }

    if (!row.invalidReason) {
      const identity =
        input.checkType === "3pl_invoice"
          ? [row.orderRef, row.tracking, row.amount].join("|")
          : [row.sku, row.location ?? "", row.quantity].join("|");
      const previous = seen.get(identity);
      if (previous != null) row.duplicateOf = previous;
      else seen.set(identity, rowNumber);
    }

    rows.push(row);
  });

  const missingOptionalFields = spec.optional
    .filter((field) => columns[field] == null || columns[field] < 0)
    .map((field) => ({
      field,
      label: fieldDefinition(field).label,
      consequence: consequenceOfMissing(field),
    }));

  return {
    rows,
    totalRows: rows.length,
    validRows: rows.filter((row) => !row.invalidReason).length,
    invalidRows: rows.filter((row) => row.invalidReason).length,
    duplicateRows: rows.filter((row) => row.duplicateOf != null).length,
    missingOptionalFields,
    truncated: input.truncated ?? false,
  };
}

/**
 * What VedaSuite will not be able to say because a column was not supplied.
 *
 * Stated up front rather than discovered later as a page full of "impact not
 * quantified" with no explanation.
 */
export function consequenceOfMissing(field: FieldKey): string {
  switch (field) {
    case "unitCost":
      return "Quantity differences will be reported in units only. VedaSuite will not put a value on them, because Shopify does not send product cost.";
    case "currency":
      return "Amounts will be compared but not stated as money, because VedaSuite will not assume a currency.";
    case "observedAt":
      return "VedaSuite will not comment on whether this snapshot is old, because the file does not say when it was taken.";
    case "expectedAmount":
      return "VedaSuite will report charges it cannot match, but never that an amount is wrong — that needs your agreed rate.";
    case "chargeType":
      return "VedaSuite cannot tell which fee each line is for, so it cannot check any amount against your saved rate card.";
    case "expectedQuantity":
      return "Shipment shortfalls will only be detectable where another quantity column allows a comparison.";
    case "receivedQuantity":
      return "VedaSuite cannot compare what shipped against what arrived.";
    case "location":
      return "Location mismatches will not be reported.";
    case "tracking":
      return "Tracking references will not appear in the evidence for each finding.";
    default:
      return "Some checks that depend on this column will not run.";
  }
}

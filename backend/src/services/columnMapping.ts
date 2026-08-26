// Working out which column in a merchant's spreadsheet is which.
//
// PURE. No database, no filesystem.
//
// THE DESIGN CONSTRAINT
// --------------------
// A merchant should not have to reformat their warehouse export to use
// VedaSuite. But the cost of guessing wrong is high and silent: mapping a
// "Committed" column onto quantity would produce a page of confident,
// completely wrong discrepancies, and nothing downstream could detect that the
// inputs were mislabelled.
//
// So detection is offered as a SUGGESTION with a confidence, and only a
// confident suggestion is pre-selected. Anything less is presented as a
// question. The merchant's confirmation is what gets persisted — never the
// guess.

export type FieldKey =
  | "sku"
  | "quantity"
  | "orderRef"
  | "tracking"
  | "location"
  | "amount"
  | "expectedAmount"
  | "expectedQuantity"
  | "receivedQuantity"
  | "unitCost"
  | "chargeType"
  | "currency"
  | "observedAt";

export interface FieldDefinition {
  key: FieldKey;
  /** Merchant-facing name of what VedaSuite needs. */
  label: string;
  /** Why VedaSuite wants it, so a merchant can judge which column fits. */
  purpose: string;
  /** Header texts that mean this field, lowercased. */
  aliases: string[];
  /** Values in this column must parse as numbers. */
  numeric: boolean;
}

/**
 * Every field any check type can use.
 *
 * One registry rather than three: the alias lists overlap heavily, and three
 * copies would drift.
 */
export const FIELD_DEFINITIONS: FieldDefinition[] = [
  {
    key: "sku",
    label: "SKU",
    purpose: "Identifies which product a row is about. Matched against the SKU on your Shopify variants.",
    aliases: [
      "sku",
      "product sku",
      "item sku",
      "variant sku",
      "sku code",
      "item code",
      "item number",
      "item no",
      "product code",
      "part number",
      "part no",
      "stock code",
      "barcode",
      "upc",
    ],
    numeric: false,
  },
  {
    key: "quantity",
    label: "Quantity",
    purpose: "How many units the file reports. Compared against your Shopify inventory.",
    aliases: [
      "qty",
      "quantity",
      "available",
      "stock",
      "on hand",
      "onhand",
      "quantity on hand",
      "qty on hand",
      "available qty",
      "available quantity",
      "stock on hand",
      "units",
      "unit count",
      "count",
      "inventory",
      "inventory quantity",
    ],
    numeric: true,
  },
  {
    key: "orderRef",
    label: "Order reference",
    purpose: "Identifies which order a charge or shipment relates to. Matched against your Shopify order numbers.",
    aliases: [
      "order",
      "order id",
      "order number",
      "order no",
      "order ref",
      "order reference",
      "order name",
      "reference",
      "ref",
      "shipment reference",
      "customer order",
      "sales order",
      "so number",
    ],
    numeric: false,
  },
  {
    key: "tracking",
    label: "Tracking number",
    purpose: "Carrier tracking reference, used as evidence and as a secondary match key.",
    aliases: [
      "tracking",
      "tracking number",
      "tracking no",
      "tracking id",
      "awb",
      "waybill",
      "consignment",
      "consignment number",
      "carrier reference",
    ],
    numeric: false,
  },
  {
    key: "location",
    label: "Location",
    purpose: "Warehouse or bin the row refers to. Used to report location mismatches where present.",
    aliases: [
      "location",
      "warehouse",
      "warehouse name",
      "warehouse code",
      "site",
      "facility",
      "bin",
      "bin location",
      "fc",
      "fulfillment center",
      "fulfilment centre",
    ],
    numeric: false,
  },
  {
    key: "amount",
    label: "Billed amount",
    purpose: "The amount actually charged on this line.",
    aliases: [
      "amount",
      "charge",
      "charged",
      "billed",
      "billed amount",
      "total",
      "line total",
      "cost",
      "fee",
      "shipping cost",
      "freight",
      "invoice amount",
      "net amount",
      "price",
    ],
    numeric: true,
  },
  {
    key: "expectedAmount",
    label: "Expected or contracted rate",
    purpose:
      "Your agreed rate for this line. Without it VedaSuite can report that a charge exists, but never that it is wrong.",
    aliases: [
      "expected",
      "expected amount",
      "expected rate",
      "contracted rate",
      "contract rate",
      "agreed rate",
      "quoted rate",
      "quoted amount",
      "rate card",
      "tariff",
      "expected charge",
      "should be",
    ],
    numeric: true,
  },
  {
    key: "expectedQuantity",
    label: "Expected quantity",
    purpose: "How many units were expected or ordered, for comparison against what shipped or arrived.",
    aliases: [
      "expected qty",
      "expected quantity",
      "ordered",
      "ordered qty",
      "ordered quantity",
      "qty ordered",
      "po qty",
      "po quantity",
      "requested",
      "requested qty",
    ],
    numeric: true,
  },
  {
    key: "receivedQuantity",
    label: "Received quantity",
    purpose: "How many units were actually received, for comparison against what was shipped or expected.",
    aliases: [
      "received",
      "received qty",
      "received quantity",
      "qty received",
      "delivered",
      "delivered qty",
      "accepted qty",
      "goods received",
      "grn qty",
    ],
    numeric: true,
  },
  {
    key: "unitCost",
    label: "Unit cost",
    purpose:
      "What one unit costs you. Supplied here, VedaSuite can value a quantity difference; without it, it reports units only.",
    aliases: [
      "unit cost",
      "cost per unit",
      "unit price",
      "cost price",
      "buy price",
      "landed cost",
      "wholesale cost",
      "cogs",
    ],
    numeric: true,
  },
  {
    key: "chargeType",
    label: "Charge type",
    purpose:
      "Which fee each invoice line is for. Matched against your saved rate card so VedaSuite can check the amount against what you agreed.",
    aliases: [
      "charge",
      "charge type",
      "chargetype",
      "fee",
      "fee type",
      "service",
      "service type",
      "service level",
      "activity",
      "activity type",
      "description",
      "charge description",
      "line description",
      "item",
      "line item",
    ],
    numeric: false,
  },
  {
    key: "currency",
    label: "Currency",
    purpose: "Currency of the amounts on this row.",
    aliases: ["currency", "curr", "ccy", "currency code"],
    numeric: false,
  },
  {
    key: "observedAt",
    label: "Snapshot date",
    purpose:
      "When the file's figures were taken. Supplied here, VedaSuite can tell you the snapshot is old; without it, it says nothing about age.",
    aliases: [
      "date",
      "as of",
      "as of date",
      "snapshot date",
      "snapshot",
      "report date",
      "invoice date",
      "ship date",
      "shipped date",
      "received date",
      "timestamp",
      "updated",
      "last updated",
    ],
    numeric: false,
  },
];

const FIELD_BY_KEY = new Map(FIELD_DEFINITIONS.map((field) => [field.key, field]));

export function fieldDefinition(key: FieldKey): FieldDefinition {
  const definition = FIELD_BY_KEY.get(key);
  if (!definition) throw new Error(`Unknown reconciliation field: ${key}`);
  return definition;
}

/**
 * Which fields each check type needs, and which merely help.
 *
 * `required` gates whether a run may start at all. `optional` fields unlock
 * additional checks when present and are simply absent when not — that absence
 * is reported to the merchant rather than worked around.
 */
export const CHECK_TYPE_FIELDS: Record<
  string,
  { required: FieldKey[]; optional: FieldKey[] }
> = {
  inventory: {
    required: ["sku", "quantity"],
    optional: ["location", "unitCost", "currency", "observedAt"],
  },
  "3pl_invoice": {
    required: ["orderRef", "amount"],
    optional: [
      // Unlocks the three-way check against a saved rate card.
      "chargeType",
      "expectedAmount",
      "currency",
      "tracking",
      "observedAt",
      "quantity",
    ],
  },
  supplier_shipment: {
    required: ["sku"],
    optional: [
      "expectedQuantity",
      "receivedQuantity",
      "quantity",
      "tracking",
      "unitCost",
      "currency",
      "observedAt",
      "orderRef",
    ],
  },
};

/** Normalizes a header for comparison. */
export function normalizeHeader(header: string): string {
  return String(header ?? "")
    .toLowerCase()
    .replace(/[_\-.]+/g, " ")
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export type MappingConfidence = "confident" | "uncertain" | "none";

export interface FieldSuggestion {
  field: FieldKey;
  label: string;
  purpose: string;
  required: boolean;
  /** Best guess, or null when nothing looked like this field. */
  suggestedHeader: string | null;
  confidence: MappingConfidence;
  /** Every header that could plausibly be this field, for the merchant to pick from. */
  candidates: string[];
  /** Stated whenever confidence is not `confident`. */
  reason: string;
}

export interface MappingSuggestionResult {
  suggestions: FieldSuggestion[];
  /** Headers not claimed by any confident suggestion. */
  unmappedHeaders: string[];
  /** True when at least one REQUIRED field needs the merchant to choose. */
  needsConfirmation: boolean;
}

/**
 * Suggests a column for each field the check type can use.
 *
 * CONFIDENCE RULES, in order of strength:
 *
 *   confident — exactly one header matches an alias EXACTLY, and the column's
 *               sample values are the right shape (numeric fields need numbers).
 *   uncertain — several headers matched, or the match was only a substring, or
 *               an exact alias hit but the sample values contradict it.
 *   none      — nothing resembled this field.
 *
 * A numeric field whose candidate column contains no numbers is deliberately
 * downgraded rather than accepted: "Quantity" as a header above a column of
 * warehouse names is a mislabelled export, and mapping it would be worse than
 * asking.
 */
export function suggestMapping(input: {
  checkType: string;
  headers: string[];
  /** A few data rows, used only to sanity-check the shape of each column. */
  sampleRows: string[][];
}): MappingSuggestionResult {
  const spec = CHECK_TYPE_FIELDS[input.checkType];
  if (!spec) throw new Error(`Unknown check type: ${input.checkType}`);

  const normalizedHeaders = input.headers.map((header, index) => ({
    original: header,
    normalized: normalizeHeader(header),
    index,
  }));

  const looksNumeric = (columnIndex: number): boolean => {
    const values = input.sampleRows
      .map((row) => (row[columnIndex] ?? "").trim())
      .filter((value) => value.length > 0);
    if (values.length === 0) return false;
    const numeric = values.filter((value) =>
      /^-?[($]?-?[\d,]*\.?\d+\)?$/.test(value.replace(/\s/g, ""))
    ).length;
    return numeric / values.length >= 0.8;
  };

  const claimed = new Set<string>();
  const suggestions: FieldSuggestion[] = [];

  for (const field of [...spec.required, ...spec.optional]) {
    const definition = fieldDefinition(field);
    const required = spec.required.includes(field);

    const exact = normalizedHeaders.filter((header) =>
      definition.aliases.includes(header.normalized)
    );
    const partial = normalizedHeaders.filter(
      (header) =>
        !definition.aliases.includes(header.normalized) &&
        definition.aliases.some(
          (alias) =>
            alias.length >= 3 &&
            (header.normalized.includes(alias) || alias.includes(header.normalized))
        )
    );

    const candidates = [...exact, ...partial];
    let suggestedHeader: string | null = null;
    let confidence: MappingConfidence = "none";
    let reason = `No column in your file looked like ${definition.label.toLowerCase()}.`;

    if (exact.length === 1) {
      const shapeOk = !definition.numeric || looksNumeric(exact[0].index);
      suggestedHeader = exact[0].original;
      if (shapeOk) {
        confidence = "confident";
        reason = "";
      } else {
        confidence = "uncertain";
        reason = `"${exact[0].original}" is named like ${definition.label.toLowerCase()}, but the values in it do not look like numbers. Confirm which column to use.`;
      }
    } else if (exact.length > 1) {
      suggestedHeader = null;
      confidence = "uncertain";
      reason = `${exact.length} columns could be ${definition.label.toLowerCase()} (${exact
        .map((header) => `"${header.original}"`)
        .join(", ")}). Choose the one to use.`;
    } else if (partial.length >= 1) {
      const viable = partial.filter(
        (header) => !definition.numeric || looksNumeric(header.index)
      );
      suggestedHeader = (viable[0] ?? partial[0]).original;
      confidence = "uncertain";
      reason = `"${suggestedHeader}" might be ${definition.label.toLowerCase()}, but VedaSuite is not certain. Confirm or choose another column.`;
    }

    if (confidence === "confident" && suggestedHeader) claimed.add(suggestedHeader);

    suggestions.push({
      field,
      label: definition.label,
      purpose: definition.purpose,
      required,
      suggestedHeader,
      confidence,
      candidates: candidates.map((header) => header.original),
      reason,
    });
  }

  const needsConfirmation = suggestions.some(
    (suggestion) => suggestion.required && suggestion.confidence !== "confident"
  );

  return {
    suggestions,
    unmappedHeaders: input.headers.filter((header) => !claimed.has(header)),
    needsConfirmation,
  };
}

export type ConfirmedMapping = Partial<Record<FieldKey, string>>;

export interface MappingValidation {
  ok: boolean;
  /** Required fields with no column assigned. */
  missingRequired: FieldKey[];
  /** Columns named in the mapping that are not in the file. */
  unknownHeaders: string[];
  /** Two fields pointing at the same column. */
  duplicateAssignments: string[];
  message: string | null;
}

/**
 * Checks a mapping the merchant confirmed against the file's real headers.
 *
 * A mapping arriving from a client is untrusted input: it can name a column
 * that does not exist, omit a required field, or point two fields at one
 * column. Each of those is refused with a sentence naming the problem rather
 * than being silently coerced.
 */
export function validateMapping(input: {
  checkType: string;
  headers: string[];
  mapping: ConfirmedMapping;
}): MappingValidation {
  const spec = CHECK_TYPE_FIELDS[input.checkType];
  if (!spec) {
    return {
      ok: false,
      missingRequired: [],
      unknownHeaders: [],
      duplicateAssignments: [],
      message: "That reconciliation type is not recognised.",
    };
  }

  const headerSet = new Set(input.headers);
  const assigned = new Map<string, FieldKey[]>();
  const unknownHeaders: string[] = [];

  for (const [key, header] of Object.entries(input.mapping)) {
    if (!header) continue;
    if (!headerSet.has(header)) {
      unknownHeaders.push(header);
      continue;
    }
    const existing = assigned.get(header);
    if (existing) existing.push(key as FieldKey);
    else assigned.set(header, [key as FieldKey]);
  }

  const missingRequired = spec.required.filter((field) => {
    const header = input.mapping[field];
    return !header || !headerSet.has(header);
  });
  const duplicateAssignments = Array.from(assigned.entries())
    .filter(([, fields]) => fields.length > 1)
    .map(([header]) => header);

  const problems: string[] = [];
  if (missingRequired.length > 0) {
    problems.push(
      `Choose a column for ${missingRequired
        .map((field) => fieldDefinition(field).label)
        .join(" and ")}.`
    );
  }
  if (unknownHeaders.length > 0) {
    problems.push(
      `${unknownHeaders.map((header) => `"${header}"`).join(", ")} is not a column in this file.`
    );
  }
  if (duplicateAssignments.length > 0) {
    problems.push(
      `${duplicateAssignments
        .map((header) => `"${header}"`)
        .join(", ")} is assigned to more than one field.`
    );
  }

  return {
    ok: problems.length === 0,
    missingRequired,
    unknownHeaders,
    duplicateAssignments,
    message: problems.length > 0 ? problems.join(" ") : null,
  };
}

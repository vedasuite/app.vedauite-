// The shared reconciliation vocabulary and matching engine.
//
// PURE. No database, no network, no Shopify, no filesystem. Every function here
// is a pure function of its inputs, so the whole engine is testable directly
// from dist/ — the same discipline explainabilityCalc.ts follows.
//
// ONE ENGINE, THREE CHECKS
// ------------------------
// Inventory, 3PL invoice and supplier shipment reconciliation are the same
// operation performed on different columns: take two sets of records, decide
// which ones refer to the same thing, and describe where they disagree. Writing
// three matching pipelines would mean three places for the certainty rules to
// drift apart, so there is one.
//
// THE RULE THAT SHAPES EVERYTHING
// -------------------------------
// VedaSuite may never state more than the evidence proves. Two consequences run
// through this file:
//
//   1. MATCH CONFIDENCE AND CERTAINTY ARE SEPARATE. A real quantity difference
//      found across a merely PROBABLE match is a POSSIBLE discrepancy, never a
//      confirmed one. Collapsing the two would let a guess about which row is
//      which be reported as a fact about the numbers.
//
//   2. VEDASUITE DETECTS DIFFERENCES, IT DOES NOT EXPLAIN THEM. "Warehouse file
//      shows 7 fewer units than Shopify" is something the data supports.
//      "Warehouse lost 7 units" is a theory about why, and the file contains no
//      evidence for it.

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export const CHECK_TYPES = ["inventory", "3pl_invoice", "supplier_shipment"] as const;
export type CheckType = (typeof CHECK_TYPES)[number];

export function isCheckType(value: unknown): value is CheckType {
  return typeof value === "string" && (CHECK_TYPES as readonly string[]).includes(value);
}

/** Merchant-facing name for a check type. Used in copy and in findings. */
export const CHECK_TYPE_LABEL: Record<CheckType, string> = {
  inventory: "Inventory",
  "3pl_invoice": "3PL invoice",
  supplier_shipment: "Supplier shipment",
};

/**
 * How sure VedaSuite is that two records refer to the same thing.
 *
 * `exact` requires a stable shared identifier. Nothing else earns it — in
 * particular, similar product titles never do, because a title is a label a
 * human chose and two different products can share one.
 */
export type MatchConfidence = "exact" | "probable" | "unmatched";

/**
 * How sure VedaSuite is about the DISCREPANCY, which is a different question
 * from how sure it is about the match.
 */
export type Certainty = "confirmed" | "possible" | "insufficient_data";

export const CERTAINTY_LABEL: Record<Certainty, string> = {
  confirmed: "Confirmed discrepancy",
  possible: "Possible discrepancy",
  insufficient_data: "Insufficient data",
};

/** Lifecycle of an uploaded source. A partial import never reaches `ready`. */
export const SOURCE_STATUSES = [
  "uploaded",
  "validating",
  "needs_mapping",
  "ready",
  "reconciling",
  "completed",
  "failed",
] as const;
export type SourceStatus = (typeof SOURCE_STATUSES)[number];

/** Lifecycle of a run. `completed_with_warnings` is not a success. */
export const RUN_STATUSES = [
  "queued",
  "running",
  "completed",
  "completed_with_warnings",
  "failed",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export function isSuccessfulRunStatus(status: string): boolean {
  return status === "completed";
}

// ---------------------------------------------------------------------------
// Normalized records
// ---------------------------------------------------------------------------

/**
 * One row from either side of a comparison, reduced to the fields
 * reconciliation actually needs.
 *
 * Deliberately narrow. There is no name, email, address or phone field here,
 * so a future contributor cannot casually carry customer identity into the
 * engine: reconciliation is about identifiers, quantities and amounts.
 */
export interface NormalizedRecord {
  /** Which side this came from. */
  side: "shopify" | "external";
  /** 1-based line in the merchant's own file, or 0 for Shopify-derived rows. */
  rowNumber: number;
  sku?: string | null;
  /** Order name or number, e.g. "#1042" or "1042". */
  orderRef?: string | null;
  tracking?: string | null;
  location?: string | null;
  quantity?: number | null;
  amount?: number | null;
  currency?: string | null;
  observedAtIso?: string | null;
  /** Free-form label for evidence, e.g. a product title. Never an identifier. */
  label?: string | null;
}

/**
 * Normalizes an identifier for comparison WITHOUT changing what it means.
 *
 * Case and surrounding whitespace are noise introduced by spreadsheets, so they
 * are removed. Nothing else is: internal punctuation, dashes and leading zeros
 * are all part of the identifier a merchant chose, and "helpfully" stripping
 * them would match SKUs that are genuinely different.
 */
export function normalizeKey(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.toLowerCase();
}

/**
 * Normalizes an order reference.
 *
 * Shopify order names carry a "#" that merchants' 3PL exports usually drop, and
 * that prefix is presentation rather than identity. This is the ONLY reference
 * transformation performed, and it is applied to both sides equally.
 */
export function normalizeOrderRef(value: string | null | undefined): string | null {
  const base = normalizeKey(value);
  if (!base) return null;
  return base.replace(/^#+/, "") || null;
}

/** Parses a spreadsheet cell into a number, or null when it is not one. */
export function parseNumeric(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== "string") return null;
  const cleaned = value.trim().replace(/[$£€,\s]/g, "");
  if (!cleaned) return null;
  // Accounting-style negatives: (12.50) means -12.50.
  const parenthesised = /^\((.+)\)$/.exec(cleaned);
  const candidate = parenthesised ? `-${parenthesised[1]}` : cleaned;
  if (!/^-?\d*\.?\d+$/.test(candidate)) return null;
  const parsed = Number(candidate);
  return Number.isFinite(parsed) ? parsed : null;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/** Which identifier a match was made on. Shown as evidence. */
export type MatchKeyKind = "sku" | "order_ref" | "tracking";

export interface MatchPair {
  key: string;
  keyKind: MatchKeyKind;
  confidence: MatchConfidence;
  shopify: NormalizedRecord[];
  external: NormalizedRecord[];
  /** Why this is `probable` rather than `exact`, when it is. */
  ambiguityReason?: string;
}

export interface MatchResult {
  matched: MatchPair[];
  /** Present on one side only. Each carries which side it was missing from. */
  shopifyOnly: NormalizedRecord[];
  externalOnly: NormalizedRecord[];
  /** External rows carrying no usable key at all. */
  unkeyed: NormalizedRecord[];
  counts: {
    exact: number;
    probable: number;
    unmatched: number;
  };
}

/**
 * Matches two sets of records on a stable identifier.
 *
 * DETERMINISTIC AND IDENTIFIER-ONLY. There is no fuzzy title matching here, by
 * design: a near-match on a product name is a guess, and presenting a guess as
 * a match would let a discrepancy be reported about two unrelated products.
 * When an identifier is missing the row is reported as unmatched, which is a
 * fact, rather than attached to whatever looked closest.
 *
 * DUPLICATES DOWNGRADE, THEY DO NOT DISAPPEAR. If a key appears more than once
 * on either side, the pairing is `probable` rather than `exact` and carries the
 * reason — VedaSuite can see the rows relate to the same identifier but cannot
 * tell which line corresponds to which.
 */
export function matchRecords(input: {
  shopify: NormalizedRecord[];
  external: NormalizedRecord[];
  keyKind: MatchKeyKind;
}): MatchResult {
  const keyOf = (record: NormalizedRecord): string | null => {
    switch (input.keyKind) {
      case "sku":
        return normalizeKey(record.sku);
      case "order_ref":
        return normalizeOrderRef(record.orderRef);
      case "tracking":
        return normalizeKey(record.tracking);
    }
  };

  const group = (records: NormalizedRecord[]) => {
    const byKey = new Map<string, NormalizedRecord[]>();
    const unkeyed: NormalizedRecord[] = [];
    for (const record of records) {
      const key = keyOf(record);
      if (!key) {
        unkeyed.push(record);
        continue;
      }
      const bucket = byKey.get(key);
      if (bucket) bucket.push(record);
      else byKey.set(key, [record]);
    }
    return { byKey, unkeyed };
  };

  const left = group(input.shopify);
  const right = group(input.external);

  const matched: MatchPair[] = [];
  const shopifyOnly: NormalizedRecord[] = [];
  const externalOnly: NormalizedRecord[] = [];

  for (const [key, shopifyRows] of left.byKey) {
    const externalRows = right.byKey.get(key);
    if (!externalRows) {
      shopifyOnly.push(...shopifyRows);
      continue;
    }
    const duplicated = shopifyRows.length > 1 || externalRows.length > 1;
    matched.push({
      key,
      keyKind: input.keyKind,
      confidence: duplicated ? "probable" : "exact",
      shopify: shopifyRows,
      external: externalRows,
      ambiguityReason: duplicated
        ? `${input.keyKind === "sku" ? "This SKU" : "This reference"} appears ${
            externalRows.length > 1 ? `${externalRows.length} times in the uploaded file` : "once in the uploaded file"
          } and ${
            shopifyRows.length > 1 ? `${shopifyRows.length} times in Shopify` : "once in Shopify"
          }, so VedaSuite cannot tell which line corresponds to which.`
        : undefined,
    });
  }

  for (const [key, externalRows] of right.byKey) {
    if (!left.byKey.has(key)) externalOnly.push(...externalRows);
  }

  return {
    matched,
    shopifyOnly,
    externalOnly,
    unkeyed: right.unkeyed,
    counts: {
      exact: matched.filter((pair) => pair.confidence === "exact").length,
      probable: matched.filter((pair) => pair.confidence === "probable").length,
      unmatched: shopifyOnly.length + externalOnly.length + right.unkeyed.length,
    },
  };
}

// ---------------------------------------------------------------------------
// Discrepancies
// ---------------------------------------------------------------------------

export interface DiscrepancyEvidence {
  label: string;
  value: string;
}

export type DiscrepancyImpact =
  | {
      status: "quantified";
      amount: number;
      currency: string;
      /** Required. How the number was arrived at, in the merchant's terms. */
      basis: string;
    }
  | { status: "not_quantified"; reason: string };

export interface Discrepancy {
  kind: string;
  certainty: Certainty;
  matchConfidence: MatchConfidence;
  subjectKey: string;
  /** One sentence stating the DIFFERENCE. Never a cause. */
  summary: string;
  shopifyValue: string | null;
  externalValue: string | null;
  /**
   * The AGREED leg of a three-way comparison: what the rate card said.
   *
   * Absent for two-way checks, and absent for any charge with no confidently
   * mapped rate — which is precisely the case where no overcharge may be
   * claimed, so its absence is load-bearing rather than incidental.
   */
  expectedValue?: string | null;
  /** Charge type as the merchant wrote it, when the check has one. */
  chargeType?: string | null;
  /** Rate-card version that supplied expectedValue, pinned at run time. */
  rateCardVersion?: number | null;
  difference: number | null;
  impact: DiscrepancyImpact;
  evidence: DiscrepancyEvidence[];
}

/**
 * Derives certainty from the match it rests on.
 *
 * A discrepancy can never be more certain than the pairing that produced it.
 * `intrinsicCertainty` is the best the finding could be if the match were
 * perfect; this caps it.
 */
export function certaintyFor(
  matchConfidence: MatchConfidence,
  intrinsicCertainty: Certainty = "confirmed"
): Certainty {
  if (matchConfidence === "unmatched") {
    // Nothing was compared, so nothing about a difference is confirmable.
    return intrinsicCertainty === "insufficient_data" ? "insufficient_data" : "possible";
  }
  if (matchConfidence === "probable") {
    return intrinsicCertainty === "insufficient_data" ? "insufficient_data" : "possible";
  }
  return intrinsicCertainty;
}

/**
 * Money, only where a defensible input existed.
 *
 * There is no default unit cost anywhere in this engine. A quantity difference
 * with no known cost is reported as a quantity difference, full stop —
 * substituting an average or a guess would turn "7 units differ" into a dollar
 * figure the merchant could not check.
 */
export function quantifyByUnitCost(input: {
  units: number;
  unitCost: number | null | undefined;
  currency: string | null | undefined;
  costIsObserved: boolean;
  /** Names where the cost came from, e.g. "the cost column in your file". */
  costSourceLabel?: string;
}): DiscrepancyImpact {
  if (!input.costIsObserved) {
    return {
      status: "not_quantified",
      reason:
        "VedaSuite has no recorded cost for this product, so the value of the difference is not calculated. Shopify does not send product cost, and none was supplied in the uploaded file.",
    };
  }
  if (
    input.unitCost == null ||
    !Number.isFinite(input.unitCost) ||
    input.unitCost <= 0
  ) {
    return {
      status: "not_quantified",
      reason: "The recorded cost for this product is not a usable figure, so no value is calculated.",
    };
  }
  if (!input.currency) {
    return {
      status: "not_quantified",
      reason: "No currency was recorded for this cost, so no value is calculated.",
    };
  }
  return {
    status: "quantified",
    amount: round2(Math.abs(input.units) * input.unitCost),
    currency: input.currency,
    basis: `${Math.abs(input.units)} units x ${input.unitCost} ${input.currency} from ${
      input.costSourceLabel ?? "the recorded product cost"
    }.`,
  };
}

/**
 * Money from a difference between two stated amounts.
 *
 * Requires BOTH amounts. This is the difference between "your file says $11 and
 * your reference rate says $8" — which is arithmetic on two things the merchant
 * supplied — and "your file says $11", which supports no claim about whether
 * $11 was the right number.
 */
export function quantifyByAmountDifference(input: {
  billed: number | null | undefined;
  expected: number | null | undefined;
  currency: string | null | undefined;
  expectedSourceLabel: string;
}): DiscrepancyImpact {
  if (input.expected == null || !Number.isFinite(input.expected)) {
    return {
      status: "not_quantified",
      reason:
        "VedaSuite has no expected or contracted rate to compare this charge against, so it cannot say whether the amount is wrong — only that it was charged.",
    };
  }
  if (input.billed == null || !Number.isFinite(input.billed)) {
    return {
      status: "not_quantified",
      reason: "No billed amount was readable on this line, so no difference is calculated.",
    };
  }
  if (!input.currency) {
    return {
      status: "not_quantified",
      reason: "No currency was recorded on this line, so no difference is calculated.",
    };
  }
  return {
    status: "quantified",
    amount: round2(input.billed - input.expected),
    currency: input.currency,
    basis: `Billed ${input.billed} minus expected ${input.expected} from ${input.expectedSourceLabel}.`,
  };
}

export const round2 = (value: number) => Math.round(value * 100) / 100;

// ---------------------------------------------------------------------------
// Wording
// ---------------------------------------------------------------------------

/**
 * The words VedaSuite is allowed to use about a difference.
 *
 * Every phrase here describes what the two documents SAY. None of them asserts
 * what happened in the world. "Warehouse file shows 7 fewer units than Shopify"
 * is checkable against the file; "warehouse lost 7 units" is not, and it accuses
 * someone.
 */
export function describeQuantityDifference(input: {
  subject: string;
  shopifyQuantity: number;
  externalQuantity: number;
  externalLabel: string;
}): string {
  const difference = input.externalQuantity - input.shopifyQuantity;
  const magnitude = Math.abs(difference);
  const direction = difference < 0 ? "fewer" : "more";
  return `${input.externalLabel} shows ${magnitude} ${
    magnitude === 1 ? "unit" : "units"
  } ${direction} than Shopify for ${input.subject} (Shopify ${input.shopifyQuantity}, file ${input.externalQuantity}).`;
}

/**
 * Guards against causal language reaching a merchant.
 *
 * Used by the tests to hold every generated sentence to the rule, and exported
 * so a future check type is held to it too.
 */
export const FORBIDDEN_CAUSAL_PHRASES = [
  "lost",
  "stole",
  "stolen",
  "theft",
  "overcharged",
  "overcharge",
  "fraud",
  "negligent",
  "mistake",
  "error by",
  "at fault",
  "failed to ship",
];

export function containsCausalClaim(sentence: string): boolean {
  const lower = sentence.toLowerCase();
  return FORBIDDEN_CAUSAL_PHRASES.some((phrase) =>
    new RegExp(`\\b${phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(lower)
  );
}

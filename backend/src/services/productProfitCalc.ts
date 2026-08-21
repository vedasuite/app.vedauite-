// PART 2 — Product Profit Intelligence. PURE deterministic calculation.
//
// No database, network, Shopify or LLM dependency.
//
// WHAT THIS ANSWERS
// -----------------
// "For this product, is the margin RETAINED after known erosion weak or
//  negative — and how complete is the data behind that answer?"
//
// THE CENTRAL RULE
// ----------------
// This never claims to compute true profit. It computes RETAINED UNIT
// ECONOMICS from stored inputs, and it refuses to produce a number whenever a
// required input is absent. Specifically:
//
//   - No ProfitOptimizationData row              -> not quantifiable
//   - productCost <= 0                           -> treated as MISSING, not free.
//         A zero cost is overwhelmingly absent data rather than a genuinely
//         costless product, and assuming otherwise would manufacture margin.
//   - shippingCost null                          -> NOT defaulted to 0.
//         Reported missing; the result is explicitly "before shipping".
//   - returnRate null                            -> reported missing; the result
//         is explicitly "before returns".
//
// A result is only ever labelled complete when every required AND optional
// erosion input is present. Otherwise the label says what it excludes.
//
// DATA VEDASUITE DOES NOT HAVE — never invented, always reported
//   - order line items, so realised per-product sales, refunds and discounts
//     cannot be attributed to a product. returnRate and salesVelocity are
//     pre-existing stored estimates, not recomputed transaction facts.
//   - chargebacks and discount amounts (no field anywhere in the schema)
//   - per-product COGS history (a single current productCost only)
//
// NOTHING HERE CHANGES A PRODUCT, A PRICE OR THE STORE.

import {
  buildAggregateEvidence,
  round2,
  type AggregateEvidence,
  type Confidence,
  type FinancialImpact,
} from "./explainabilityCalc";

/** Documented thresholds. */
export const PRODUCT_PROFIT = {
  /** Below this selling price the unit economics are not meaningful. */
  minSellingPrice: 0.01,
  /** Retained margin at or below this share of price counts as weakened. */
  weakenedMarginRatio: 0.15,
  /** A return rate outside [0,1] is corrupt input, not a signal. */
  maxReturnRate: 1,
} as const;

export interface ProductProfitInput {
  /** Canonical product identity for dedupe. */
  productHandle: string;
  productTitle?: string | null;
  currency: string | null;
  /** From ProfitOptimizationData. null when no row exists at all. */
  sellingPrice: number | null;
  productCost: number | null;
  shippingCost: number | null;
  returnRate: number | null;
  /** Stored estimate, used only for evidence — never to fabricate impact. */
  salesVelocity: number | null;
  /** Timestamp of the ProfitOptimizationData row, for freshness. */
  dataAsOfIso: string | null;
}

export type ProfitCompletenessLevel = "complete" | "partial" | "insufficient";

export interface ProductProfitResult {
  pattern: "negative_retained_margin" | "weakened_retained_margin" | null;
  /** Per-unit economics. null when required inputs are missing. */
  unitEconomics: {
    sellingPrice: number;
    productCost: number;
    /** null when shippingCost was absent — never silently 0. */
    shippingCost: number | null;
    /** Price - cost, and - shipping when shipping is known. */
    retainedBeforeReturns: number;
    /** null when returnRate was absent. */
    returnRate: number | null;
    /** null when returnRate was absent. */
    retainedAfterReturns: number | null;
    /** Ratio of the most complete retained figure to selling price. */
    retainedMarginRatio: number;
    currency: string;
  } | null;
  financialImpact: FinancialImpact;
  confidence: Confidence;
  completeness: {
    level: ProfitCompletenessLevel;
    missingInputs: string[];
    /** Exactly what the number does and does not account for. */
    label: string;
    note: string;
  };
  /** What actually moved the result. */
  drivers: string[];
  evidence: AggregateEvidence[];
  reasons: string[];
}

const STRUCTURALLY_MISSING = [
  "order_line_items",
  "per_product_realised_sales",
  "chargebacks",
  "discount_amounts",
] as const;

function notQuantifiable(reason: string): FinancialImpact {
  return { status: "impact_not_quantifiable", reason };
}

function insufficient(
  reason: string,
  missing: string[]
): ProductProfitResult {
  return {
    pattern: null,
    unitEconomics: null,
    financialImpact: notQuantifiable(reason),
    confidence: "insufficient_data",
    completeness: {
      level: "insufficient",
      missingInputs: [...missing, ...STRUCTURALLY_MISSING],
      label: "Retained economics unavailable",
      note: reason,
    },
    drivers: [],
    evidence: [],
    reasons: [reason],
  };
}

export function computeProductProfit(input: ProductProfitInput): ProductProfitResult {
  const missing: string[] = [];

  const sellingPrice = Number.isFinite(input.sellingPrice as number)
    ? (input.sellingPrice as number)
    : null;
  // A cost of 0 or below is absent data, NOT a free product. This is the guard
  // that stops a missing COGS from becoming a 100% margin claim.
  const productCost =
    Number.isFinite(input.productCost as number) && (input.productCost as number) > 0
      ? (input.productCost as number)
      : null;

  if (sellingPrice === null) missing.push("selling_price");
  if (productCost === null) missing.push("product_cost");

  if (sellingPrice === null || productCost === null) {
    return insufficient(
      "Required cost or price input is missing, so retained economics cannot be computed. This is not a profit figure.",
      missing
    );
  }
  if (sellingPrice < PRODUCT_PROFIT.minSellingPrice) {
    return insufficient(
      `Selling price below ${PRODUCT_PROFIT.minSellingPrice} — unit economics are not meaningful`,
      missing
    );
  }

  const currency = (input.currency || "").trim().toUpperCase();
  if (!currency) {
    return insufficient("No currency on the product, so a monetary result cannot be stated", [
      ...missing,
      "product_currency",
    ]);
  }

  // Shipping: absent means unknown, never zero.
  const shippingKnown =
    Number.isFinite(input.shippingCost as number) && (input.shippingCost as number) >= 0;
  const shippingCost = shippingKnown ? round2(input.shippingCost as number) : null;
  if (!shippingKnown) missing.push("shipping_cost");

  // Return rate: must be a sane proportion, else treat as absent.
  const returnRateValid =
    Number.isFinite(input.returnRate as number) &&
    (input.returnRate as number) >= 0 &&
    (input.returnRate as number) <= PRODUCT_PROFIT.maxReturnRate;
  const returnRate = returnRateValid ? (input.returnRate as number) : null;
  if (!returnRateValid) missing.push("return_rate");

  const drivers: string[] = [
    `selling price ${round2(sellingPrice)} ${currency}`,
    `unit cost ${round2(productCost)} ${currency}`,
  ];

  const retainedBeforeReturns = round2(
    sellingPrice - productCost - (shippingCost ?? 0)
  );
  if (shippingCost !== null) drivers.push(`shipping ${shippingCost} ${currency}`);

  let retainedAfterReturns: number | null = null;
  if (returnRate !== null) {
    // Returned units retain no margin but still incur the unit cost path, so
    // the retained figure is scaled by the proportion that is NOT returned.
    retainedAfterReturns = round2(retainedBeforeReturns * (1 - returnRate));
    drivers.push(`return rate ${(returnRate * 100).toFixed(1)}%`);
  }

  const effectiveRetained = retainedAfterReturns ?? retainedBeforeReturns;
  const retainedMarginRatio = round2(effectiveRetained / sellingPrice);

  const level: ProfitCompletenessLevel =
    shippingCost !== null && returnRate !== null ? "complete" : "partial";

  const label =
    level === "complete"
      ? "Retained unit economics after shipping and returns (estimate)"
      : `Retained unit economics ${[
          shippingCost === null ? "before shipping" : null,
          returnRate === null ? "before returns" : null,
        ]
          .filter(Boolean)
          .join(" and ")} (estimate)`;

  const unitEconomics = {
    sellingPrice: round2(sellingPrice),
    productCost: round2(productCost),
    shippingCost,
    retainedBeforeReturns,
    returnRate,
    retainedAfterReturns,
    retainedMarginRatio,
    currency,
  };

  const pattern =
    effectiveRetained < 0
      ? ("negative_retained_margin" as const)
      : retainedMarginRatio <= PRODUCT_PROFIT.weakenedMarginRatio
      ? ("weakened_retained_margin" as const)
      : null;

  const evidence = buildAggregateEvidence({
    unit_selling_price: `${unitEconomics.sellingPrice} ${currency}`,
    unit_cost: `${unitEconomics.productCost} ${currency}`,
    retained_margin_ratio: `${(retainedMarginRatio * 100).toFixed(1)}%`,
    return_rate: returnRate !== null ? `${(returnRate * 100).toFixed(1)}%` : null,
    sales_velocity: input.salesVelocity ?? null,
    data_completeness: level,
    missing_inputs: missing.length ? missing.join(", ") : null,
  });

  if (!pattern) {
    return {
      pattern: null,
      unitEconomics,
      financialImpact: notQuantifiable(
        `Retained margin ${(retainedMarginRatio * 100).toFixed(1)}% is above the ${(
          PRODUCT_PROFIT.weakenedMarginRatio * 100
        ).toFixed(0)}% weakened threshold`
      ),
      confidence: level === "complete" ? "medium" : "low",
      completeness: {
        level,
        missingInputs: [...missing, ...STRUCTURALLY_MISSING],
        label,
        note: "Computed from stored cost and price inputs. Not a realised profit figure.",
      },
      drivers,
      evidence,
      reasons: [`${label}: ${effectiveRetained} ${currency} per unit.`],
    };
  }

  // Per-unit only. Extrapolating to a period would require realised per-product
  // sales volume, which cannot be derived without order line items.
  const financialImpact: FinancialImpact = {
    status: "quantified",
    min: effectiveRetained < 0 ? round2(effectiveRetained) : 0,
    max: effectiveRetained < 0 ? 0 : round2(effectiveRetained),
    currency,
    period: "per_order",
    basis:
      `${label}. Per unit, from stored productCost and sellingPrice` +
      `${shippingCost !== null ? ", shipping" : ""}${returnRate !== null ? ", return rate" : ""}. ` +
      "Not extrapolated to a period: realised per-product sales volume is not available " +
      "because order line items are not stored. Chargebacks and discounts are not included.",
    isEstimate: true,
  };

  return {
    pattern,
    unitEconomics,
    financialImpact,
    confidence: level === "complete" ? "medium" : "low",
    completeness: {
      level,
      missingInputs: [...missing, ...STRUCTURALLY_MISSING],
      label,
      note:
        "Retained unit economics from stored inputs — explicitly NOT true profit. " +
        (missing.length
          ? `Missing: ${missing.join(", ")}.`
          : "All stored erosion inputs were present."),
    },
    drivers,
    evidence,
    reasons: [
      pattern === "negative_retained_margin"
        ? `Each unit retains ${effectiveRetained} ${currency} — the retained economics are negative.`
        : `Each unit retains ${effectiveRetained} ${currency} (${(retainedMarginRatio * 100).toFixed(
            1
          )}% of price), at or below the ${(PRODUCT_PROFIT.weakenedMarginRatio * 100).toFixed(
            0
          )}% weakened threshold.`,
      `Drivers: ${drivers.join(", ")}.`,
      level === "complete"
        ? "Shipping and return rate were both available."
        : `Incomplete inputs — ${missing.join(", ")} not stored. Figure stated as ${label.toLowerCase()}.`,
    ],
  };
}

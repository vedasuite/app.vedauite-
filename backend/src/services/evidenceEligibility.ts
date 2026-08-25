// The SINGLE rule for whether VedaSuite may state a monetary figure.
//
// Dashboard and Pricing previously answered this question separately and
// contradicted each other in production: Pricing said "Projected gain: Not
// enough data yet" while the Dashboard headline showed "Potential revenue
// $5,641" and "Expected return $680" for the same underlying opportunity.
//
// WHY THOSE FIGURES WERE NOT EVIDENCE
// -----------------------------------
// Both trace to ProfitOptimizationData, whose profit inputs are assumptions:
//
//   productCost   = latestProfit?.productCost ?? currentPrice * 0.58
//   salesVelocity = latestProfit?.salesVelocity ?? max(4, orders / products)
//   shippingCost  = ?? currentPrice * 0.06
//   advertising   = ?? currentPrice * 0.10
//
// projectedMonthlyProfit multiplies those together and by a constant 4.
//
// Crucially the fallbacks are PERSISTED, so a later `salesVelocity != null`
// check passes and a guess is laundered into "observed data".
//
// AND THEY CANNOT BE OBSERVED TODAY
// ---------------------------------
// This is not a provenance-tracking problem. With the current data model these
// inputs can never be measured, so there is nothing to distinguish:
//
//   - There is NO order line-item table. Orders cannot be attributed to
//     products, so per-product sales velocity is not derivable at all.
//   - There is NO product cost field synced from Shopify. ProfitOptimizationData
//     .productCost is NOT NULL, so its first write is always the 0.58 assumption.
//
// Adding costSource/velocitySource columns would therefore record "assumed"
// for 100% of rows. A schema change buys nothing.
//
// THE RULE
// --------
// A monetary opportunity, expected return, ROI, gain or confidence score may be
// shown ONLY when every input it depends on is observed. Otherwise the surface
// says "Not enough data yet" and names what is missing.

/**
 * Inputs a per-product monetary projection depends on, and whether VedaSuite
 * can currently observe them.
 *
 * `observable: false` means the data model has no source for it — not that this
 * particular store lacks it.
 */
export const PROFIT_INPUTS = {
  salesVelocity: {
    observable: false,
    merchantLabel: "how many units each product actually sells",
    reason:
      "VedaSuite receives orders but not order line items, so it cannot yet attribute sales to individual products.",
  },
  productCost: {
    observable: false,
    merchantLabel: "what each product costs you",
    reason:
      "Shopify does not share product cost with VedaSuite, so margin cannot be calculated from real figures.",
  },
} as const;

export type ProfitInputName = keyof typeof PROFIT_INPUTS;

/**
 * The five states every surface shares.
 *
 * Dashboard, Action Center, Pricing, Customer Loss and Market Signals all
 * classify into these, so the same underlying evidence cannot produce
 * contradictory claims on different screens.
 */
export type EvidenceState =
  | "evidence_backed"
  | "partially_supported"
  | "insufficient_data"
  | "stale"
  | "unavailable";

/** Which states permit a merchant-facing monetary figure. */
export const MONETARY_ALLOWED_STATES: readonly EvidenceState[] = ["evidence_backed"];

/** Which states permit an exact recommendation (a target price, say). */
export const EXACT_CLAIM_ALLOWED_STATES: readonly EvidenceState[] = [
  "evidence_backed",
  "partially_supported",
];

/** Merchant-facing label for each state. Never claims AI. */
export const EVIDENCE_STATE_LABEL: Record<EvidenceState, string> = {
  evidence_backed: "Evidence-backed",
  partially_supported: "Limited evidence",
  insufficient_data: "Not enough evidence yet",
  stale: "Based on older data",
  unavailable: "Could not be checked",
};

export interface MonetaryClaimVerdict {
  /** The shared five-state classification. */
  state: EvidenceState;
  /** May a currency figure be shown at all? */
  allowed: boolean;
  /** Inputs that are missing or assumed, in merchant language. */
  missing: string[];
  /** What the merchant should be told instead of a number. */
  explanation: string;
  /**
   * Confidence that may be attached. Never a constant: when the inputs are not
   * observed there is no defensible confidence, so it is "insufficient_data".
   */
  confidence: "high" | "medium" | "low" | "insufficient_data";
}

/**
 * The shared gate. Both the Dashboard and Pricing call this, so they cannot
 * disagree about the same opportunity.
 *
 * Callers pass what they genuinely observed. A value read back from
 * ProfitOptimizationData does NOT count as observed — it may be a persisted
 * fallback, and per PROFIT_INPUTS it cannot be observed today in any case.
 */
export function classifyMonetaryClaim(input: {
  salesVelocityObserved: boolean;
  productCostObserved: boolean;
  /** Optional: a real competitor price for this product. */
  competitorPriceObserved?: boolean;
}): MonetaryClaimVerdict {
  const missing: string[] = [];
  if (!input.salesVelocityObserved) {
    missing.push(PROFIT_INPUTS.salesVelocity.merchantLabel);
  }
  if (!input.productCostObserved) {
    missing.push(PROFIT_INPUTS.productCost.merchantLabel);
  }

  if (missing.length === 0) {
    return {
      state: "evidence_backed",
      allowed: true,
      missing: [],
      explanation: "",
      // Competitor corroboration raises confidence; without it this is a
      // margin-only estimate.
      confidence: input.competitorPriceObserved ? "high" : "medium",
    };
  }

  // Exactly one input present is PARTIALLY supported: enough to point at the
  // opportunity and show a direction, never enough to put money on it.
  if (missing.length === 1) {
    const reason = !input.salesVelocityObserved
      ? PROFIT_INPUTS.salesVelocity.reason
      : PROFIT_INPUTS.productCost.reason;
    return {
      state: "partially_supported",
      allowed: false,
      missing,
      explanation: `VedaSuite can see part of this but not all of it: it does not know ${missing[0]}. ${reason}`,
      confidence: "low",
    };
  }

  const reasons: string[] = [];
  if (!input.salesVelocityObserved) reasons.push(PROFIT_INPUTS.salesVelocity.reason);
  if (!input.productCostObserved) reasons.push(PROFIT_INPUTS.productCost.reason);

  return {
    state: "insufficient_data",
    allowed: false,
    missing,
    explanation: `VedaSuite cannot put a reliable figure on this yet because it does not know ${missing.join(
      " or "
    )}. ${reasons.join(" ")}`,
    confidence: "insufficient_data",
  };
}

/**
 * Whether a value read from ProfitOptimizationData may be treated as observed.
 *
 * Always false, deliberately and with a stated reason. The field is non-null
 * even when nothing was measured, because coreEngineService persists its
 * fallback — so a null check is not a evidence check.
 */
export function storedProfitValueIsObserved(): boolean {
  return false;
}

/**
 * Reads REAL provenance from a ProfitOptimizationData row.
 *
 * Replaces the blanket "never observed" assumption now that the row records
 * how each value was obtained. It still returns false for every existing row,
 * because the migration defaults them to "assumed" - which is accurate, not
 * pessimistic: neither input was observable when they were written.
 */
export function profitRowProvenance(row: {
  productCost?: number | null;
  costSource?: string | null;
  salesVelocity?: number | null;
  velocitySource?: string | null;
} | null | undefined): { costObserved: boolean; velocityObserved: boolean } {
  return {
    costObserved: row?.costSource === "observed" && row?.productCost != null,
    velocityObserved: row?.velocitySource === "observed" && row?.salesVelocity != null,
  };
}

/** Merchant-facing placeholder wherever a figure is not permitted. */
export const NOT_ENOUGH_DATA = "Not enough data yet";

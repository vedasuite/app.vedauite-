// What a pricing recommendation is actually based on — and therefore what may
// honestly be shown to a merchant.
//
// THE PROBLEM THIS SOLVES
// -----------------------
// Production showed 42 recommendations with exact targets like
// "$2629.95 -> $2735.15", labelled "AI-generated", while Profit opportunities
// read 0 and Projected gain read "Not enough data yet".
//
// Those targets came from baselinePriceRecommendation() in coreEngineService:
//
//   recommendedPrice = currentPrice
//                    + currentPrice * (pricingBias - 50) / 180   // a slider
//                    + competitorGap * 0.35                      // 0 with no competitor data
//                    - returnPenalty * 0.08                      // ~0 with no return data
//                    + min(4, salesVelocity / 6)                 // salesVelocity DEFAULTS to 8
//
// With no competitor rows and no profit rows, the first and last terms are all
// that remain: a store-wide slider percentage plus a constant derived from an
// ASSUMED sales velocity. Nothing about that product's real performance is in
// it. Presenting it to two decimal places implies an analysis that did not
// happen.
//
// This module does not change the arithmetic. It decides how much confidence
// the OUTPUT is allowed to project.

/** What genuinely informed a recommendation, strongest first. */
export type PricingEvidenceBasis =
  | "profit_informed"
  | "competitor_informed"
  | "insufficient_evidence";

export interface PricingEvidence {
  basis: PricingEvidenceBasis;
  /** Merchant-facing label. Never claims AI for deterministic arithmetic. */
  label: string;
  /**
   * May an exact target price be shown? False when the target carries no
   * product-specific evidence, because an exact figure reads as a finding.
   */
  showExactTarget: boolean;
  /** May a projected monetary gain be shown? */
  showProjectedGain: boolean;
  /** What is missing, in merchant language. */
  missingInputs: string[];
  /** What the merchant could do to make this actionable. */
  whatWouldHelp: string;
}

/**
 * Classifies one recommendation.
 *
 * Deliberately conservative: anything that is not clearly informed by this
 * product's competitor or profit data is `insufficient_evidence`, however
 * confident the underlying score looks. A high score computed from assumed
 * inputs is not evidence.
 */
export function classifyPricingEvidence(input: {
  /** Competitor rows exist AND this product has usable competitor pricing. */
  competitorReady: boolean;
  competitorAveragePrice: number | null | undefined;
  /** Profit rows exist for this product. */
  profitReady: boolean;
  /** True when sales velocity was OBSERVED, not defaulted. */
  salesVelocityObserved: boolean;
  /** True when this row is a catalog placeholder rather than a real analysis. */
  isCatalogExample?: boolean;
}): PricingEvidence {
  const hasCompetitor =
    input.competitorReady &&
    typeof input.competitorAveragePrice === "number" &&
    Number.isFinite(input.competitorAveragePrice);

  // Profit evidence is the strongest basis: it means margin is actually known.
  if (!input.isCatalogExample && input.profitReady && input.salesVelocityObserved) {
    return {
      basis: "profit_informed",
      label: "Profit-informed",
      showExactTarget: true,
      showProjectedGain: true,
      missingInputs: [],
      whatWouldHelp: "",
    };
  }

  // Competitor evidence moves the price for a real, external reason.
  if (!input.isCatalogExample && hasCompetitor) {
    return {
      basis: "competitor_informed",
      label: "Competitor-informed",
      showExactTarget: true,
      // Without observed velocity, a monetary projection would be invented.
      showProjectedGain: input.salesVelocityObserved,
      missingInputs: input.salesVelocityObserved ? [] : ["observed sales velocity"],
      whatWouldHelp: input.salesVelocityObserved
        ? ""
        : "Once VedaSuite has enough order history to measure how fast this product sells, it can estimate the financial effect of a price change.",
    };
  }

  // Everything else. The number exists, but nothing product-specific supports it.
  const missing: string[] = [];
  if (!hasCompetitor) missing.push("competitor pricing for this product");
  if (!input.profitReady) missing.push("product cost or margin data");
  if (!input.salesVelocityObserved) missing.push("observed sales velocity");

  return {
    basis: "insufficient_evidence",
    label: "Not enough evidence yet",
    showExactTarget: false,
    showProjectedGain: false,
    missingInputs: missing,
    whatWouldHelp:
      "VedaSuite has not yet got enough data about this product to recommend a specific price. " +
      `Connect or sync ${missing.join(", ")} and this will become an actionable recommendation.`,
  };
}

/**
 * Direction of travel, safe to show even without a precise target.
 *
 * A merchant can act on "there may be room to increase" without being handed a
 * false-precision figure.
 */
export function directionalHint(currentPrice: number, recommendedPrice: number): string {
  const delta = recommendedPrice - currentPrice;
  const pct = currentPrice > 0 ? Math.abs(delta / currentPrice) * 100 : 0;
  if (Math.abs(delta) < 0.5 || pct < 1) {
    return "No change indicated";
  }
  return delta > 0
    ? "May have room to increase — evidence needed to say how much"
    : "May be priced above the market — evidence needed to say how much";
}

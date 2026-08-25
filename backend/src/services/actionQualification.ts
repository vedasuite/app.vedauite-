// What qualifies as an Action Center item, and what stays in a workspace.
//
// Action Center is a prioritized merchant-ACTION layer, not a raw event feed.
// A store with 400 flagged orders must not produce 400 findings: that buries
// the operational and profit findings that actually need a decision, and turns
// the feed into the thing it was built to replace.
//
// THE RULE
// --------
//   raw evidence            -> specialist workspace (Customer Loss, Market
//                              Signals, Pricing Workspace)
//   significant actionable  -> IntelligenceFinding -> Action Center
//
// Qualification is derived from evidence that already exists. No confidence or
// monetary threshold is invented merely to reduce volume — where volume must be
// bounded, related items are AGGREGATED into one finding that states how many
// it covers, and the detail stays reachable in the workspace.

/** Families that may raise findings. Mirrors the specialist engines. */
export type ActionFamily =
  | "operational"
  | "customer_loss"
  | "product_profit"
  | "pricing"
  | "competitor";

/**
 * How many INDIVIDUAL findings one family may raise before the rest are
 * aggregated into a single summary finding.
 *
 * This is a presentation bound, not an evidence threshold: nothing is
 * discarded, and the aggregate says exactly how many items it represents.
 * Chosen so that all five families together stay within a feed a merchant can
 * actually read in one sitting.
 */
export const INDIVIDUAL_FINDING_LIMIT: Record<ActionFamily, number> = {
  // Bounded by the number of detectors, not by store size.
  operational: 6,
  customer_loss: 5,
  product_profit: 5,
  pricing: 5,
  competitor: 5,
};

export interface Aggregatable {
  /** Stable identity, used for deterministic ordering. */
  id: string;
  /**
   * Observed monetary impact, when one is defensible. Used ONLY for ranking
   * which items are shown individually — never invented, and null is fine.
   */
  rankValue: number | null;
}

export interface AggregationOutcome<T extends Aggregatable> {
  /** Items that get their own finding, highest ranked first. */
  individual: T[];
  /** Items folded into a single summary finding. */
  aggregated: T[];
  /** True when a summary finding should be raised. */
  needsAggregate: boolean;
}

/**
 * Splits qualifying items into individually-surfaced and aggregated.
 *
 * Deterministic: sorted by rankValue descending, then by id, so the same input
 * always produces the same split and therefore the same fingerprints. Items
 * with no rankValue sort last but are never dropped.
 */
export function splitForActionCenter<T extends Aggregatable>(
  family: ActionFamily,
  items: T[]
): AggregationOutcome<T> {
  const limit = INDIVIDUAL_FINDING_LIMIT[family];
  const sorted = [...items].sort((a, b) => {
    const av = a.rankValue ?? -1;
    const bv = b.rankValue ?? -1;
    if (av !== bv) return bv - av;
    return a.id.localeCompare(b.id);
  });

  const individual = sorted.slice(0, limit);
  const aggregated = sorted.slice(limit);

  return {
    individual,
    aggregated,
    // One left over is not worth a summary finding — surface it individually.
    needsAggregate: aggregated.length > 1,
  };
}

/**
 * Whether a pricing opportunity is worth a merchant's attention.
 *
 * Evidence-derived, not a volume filter: an exact target price must be
 * defensible, which is precisely the condition pricingEvidenceCalc already
 * enforces for display. A recommendation VedaSuite will not show a price for is
 * not an action a merchant can take.
 */
export function qualifiesAsPricingAction(input: {
  /** From classifyPricingEvidence: may an exact target be shown? */
  showExactTarget: boolean;
  currentPrice: number;
  recommendedPrice: number;
}): boolean {
  if (!input.showExactTarget) return false;
  if (!(input.currentPrice > 0)) return false;

  // A move too small to act on is not an action. One percent is the same
  // no-change band the pricing card already uses, so the two agree.
  const pct = Math.abs(input.recommendedPrice - input.currentPrice) / input.currentPrice;
  return pct >= 0.01;
}

/**
 * Whether a competitor signal is worth a merchant's attention.
 *
 * Requires an OBSERVED competitor price and a real difference. A "competitor
 * exists" row is evidence for the workspace, not an action.
 */
export function qualifiesAsCompetitorAction(input: {
  competitorPrice: number | null;
  ourPrice: number | null;
  /** Freshness from competitorFreshnessCalc. Stale data is not an action. */
  evidenceIsCurrent: boolean;
}): boolean {
  if (!input.evidenceIsCurrent) return false;
  if (input.competitorPrice == null || input.ourPrice == null) return false;
  if (!(input.ourPrice > 0)) return false;

  // Below this the difference is noise rather than market pressure. Same 1%
  // band as pricing, so the two surfaces cannot disagree about "meaningful".
  const gap = Math.abs(input.competitorPrice - input.ourPrice) / input.ourPrice;
  return gap >= 0.01;
}

/**
 * Whether a customer-loss pattern is worth its own finding.
 *
 * The detector already establishes the pattern; this only decides whether it
 * is material enough to interrupt the merchant, or belongs in the workspace
 * with the others. Both conditions come from evidence the detector computed.
 */
export function qualifiesAsCustomerLossAction(input: {
  /** The calc found a defensible repeated-loss pattern. */
  hasPattern: boolean;
  /** Confidence the calc derived from the evidence, never a constant. */
  confidence: "high" | "medium" | "low" | "insufficient_data";
  /** Observed refunded value, when quantified. */
  observedLoss: number | null;
}): boolean {
  if (!input.hasPattern) return false;
  // Only genuinely absent evidence disqualifies. A LOW-confidence pattern is
  // still a real pattern the merchant may want to act on, and raising the bar
  // to high/medium would be an arbitrary threshold used to control volume —
  // which is what splitForActionCenter is for. Volume is bounded by
  // aggregation, never by discarding qualifying evidence.
  return input.confidence !== "insufficient_data";
}

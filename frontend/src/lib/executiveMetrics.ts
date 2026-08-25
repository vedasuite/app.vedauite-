// Effort and urgency label mappings for the module insight panels.
//
// PHASE J. This file used to also hold the executive-hero derivations:
// potentialMonthlyRevenue, expectedReturn, largestOf, biggestOpportunity,
// biggestRisk, recommendedModule, formatRange, periodLabel and aiConfidence.
// Those fed the store-level Dashboard sections that Phase F/G removed, because
// they restated money and confidence the Action Center already owned and could
// contradict it. With their only callers gone they were dead code - and dead
// code that computes a store-wide money total and something called "AI
// confidence" is an invitation to reintroduce exactly the contradiction that
// was just removed, so it is deleted rather than left lying around.
//
// What remains is presentation only: label mappings over enums the engine
// already assigns. They add no claim, only a readable form.

import type { EaseOfAction, ExplainableInsight, Urgency } from "./insightsTypes";

const EFFORT: Record<EaseOfAction, { minutes: string; difficulty: "Easy" | "Moderate" | "Manual" }> = {
  one_click_review: { minutes: "~2 min", difficulty: "Easy" },
  guided: { minutes: "~10 min", difficulty: "Moderate" },
  manual: { minutes: "~30 min", difficulty: "Manual" },
};

export function effortFor(ease: EaseOfAction) {
  return EFFORT[ease] ?? EFFORT.manual;
}

/**
 * Headline "expected return": the top opportunity's own quantified range.
 * Returns null when the engine could not quantify it, so the UI can say
 * "Not quantified" rather than showing a fabricated figure.
 */

export type UrgencyMix = {
  critical: number;
  high: number;
  medium: number;
  low: number;
  total: number;
  /** 0–100 pressure reading derived from the urgency mix already assigned. */
  pressure: number;
};

/**
 * Aggregate urgency profile for a set of insights, used by the module risk
 * meters. Weighted average of existing urgency labels — no new scoring.
 */
export function urgencyMix(insights: ExplainableInsight[]): UrgencyMix {
  const mix: UrgencyMix = { critical: 0, high: 0, medium: 0, low: 0, total: 0, pressure: 0 };
  for (const i of insights) {
    mix[i.urgency] += 1;
    mix.total += 1;
  }
  if (mix.total > 0) {
    const weighted =
      mix.critical * 1 + mix.high * 0.7 + mix.medium * 0.4 + mix.low * 0.15;
    mix.pressure = Math.round((weighted / mix.total) * 100);
  }
  return mix;
}

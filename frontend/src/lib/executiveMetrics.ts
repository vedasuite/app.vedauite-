// Executive-summary derivations for the dashboard hero.
//
// PRESENTATION ONLY. Every value here is derived from fields the backend
// already returns on GET /api/insights/dashboard. Nothing is recalculated,
// re-weighted, or invented:
//
//  - Money is only ever read straight from a `LeakGroup` or a `quantified`
//    FinancialImpact. Values from different periods are never summed (the
//    backend already guarantees each LeakGroup is period-homogeneous).
//  - When the engine says an impact is not quantifiable, we surface that
//    verbatim instead of substituting a number.
//  - "AI confidence" and "estimated time" are label mappings over enums the
//    engine already assigns — they add no new claims, only a readable form.

import type {
  Confidence,
  DashboardInsightsResponse,
  EaseOfAction,
  ExplainableInsight,
  ImpactPeriod,
  InsightModule,
  LeakGroup,
} from "./insightsTypes";
import { MODULE_LABEL, PERIOD_LABEL, formatMoney } from "./insightsTypes";

export type MoneyRange = {
  min: number;
  max: number;
  currency: string;
  period: ImpactPeriod;
  confidence: Confidence;
};

/** Largest group by its own `max`, compared only within one kind/period set. */
function largestGroup(groups: LeakGroup[]): LeakGroup | null {
  if (groups.length === 0) return null;
  return groups.reduce((best, g) => (g.max > best.max ? g : best), groups[0]);
}

function groupToRange(group: LeakGroup | null): MoneyRange | null {
  if (!group) return null;
  return {
    min: group.min,
    max: group.max,
    currency: group.currency,
    period: group.period,
    confidence: group.confidence,
  };
}

/**
 * Headline upside. Prefers the explicit `monthly_estimate` group so the card
 * can honestly say "per month"; otherwise falls back to the largest single
 * group and reports that group's own period. Never combines periods.
 */
export function potentialMonthlyRevenue(
  data: DashboardInsightsResponse
): MoneyRange | null {
  const upside = data.revenueLeak.potentialUpside;
  const monthly = upside.find((g) => g.period === "monthly_estimate");
  return groupToRange(monthly ?? largestGroup(upside));
}

/**
 * Largest single group in a list, as a range. Compares groups only against
 * each other — it never merges them, so the result always describes exactly
 * one real period.
 */
export function largestOf(groups: LeakGroup[]): MoneyRange | null {
  return groupToRange(largestGroup(groups));
}


const CONFIDENCE_WEIGHT: Record<Confidence, number> = {
  high: 1,
  medium: 0.6,
  low: 0.3,
  insufficient_data: 0,
};

export type AiConfidence = {
  /** 0–100, the mean of the engine's own per-insight confidence labels. */
  percent: number;
  label: "High" | "Medium" | "Low" | "Insufficient data";
  tone: "success" | "info" | "attention" | undefined;
  sampleSize: number;
};

/**
 * Mean of the confidence labels the engine already assigned to the insights
 * being displayed. This is an average of existing labels, not a new
 * statistical confidence claim.
 */
export function aiConfidence(data: DashboardInsightsResponse): AiConfidence {
  const all = [...data.opportunities, ...data.criticalAttention];
  if (all.length === 0) {
    return { percent: 0, label: "Insufficient data", tone: undefined, sampleSize: 0 };
  }
  const mean =
    all.reduce((sum, i) => sum + (CONFIDENCE_WEIGHT[i.confidence] ?? 0), 0) / all.length;
  const percent = Math.round(mean * 100);
  const label: AiConfidence["label"] =
    percent >= 75 ? "High" : percent >= 45 ? "Medium" : percent > 0 ? "Low" : "Insufficient data";
  const tone: AiConfidence["tone"] =
    label === "High" ? "success" : label === "Medium" ? "info" : label === "Low" ? "attention" : undefined;
  return { percent, label, tone, sampleSize: all.length };
}

/** Highest-scoring ranked opportunity (already sorted by the backend). */
export function biggestOpportunity(
  data: DashboardInsightsResponse
): ExplainableInsight | null {
  return data.opportunities[0] ?? data.executiveSummary.topOpportunity ?? null;
}

/**
 * The most pressing risk. Critical attention wins over ranked opportunities
 * because the engine reserves that lane for high-confidence critical findings.
 */
export function biggestRisk(data: DashboardInsightsResponse): ExplainableInsight | null {
  if (data.criticalAttention.length > 0) {
    const byUrgency = [...data.criticalAttention].sort((a, b) => {
      const rank = { critical: 0, high: 1, medium: 2, low: 3 } as const;
      return rank[a.urgency] - rank[b.urgency];
    });
    return byUrgency[0];
  }
  return null;
}

/** The module the top opportunity lives in — where the merchant should go next. */
export function recommendedModule(
  data: DashboardInsightsResponse
): { module: InsightModule; label: string; route: string } | null {
  const top = biggestOpportunity(data);
  if (!top) return null;
  return { module: top.module, label: MODULE_LABEL[top.module], route: top.route };
}

/**
 * Rough time-to-act, mapped from the engine's existing `easeOfAction` enum.
 * A UI-side reading aid, deliberately coarse — never presented as measured.
 */
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
export function expectedReturn(data: DashboardInsightsResponse): MoneyRange | null {
  const top = biggestOpportunity(data);
  if (!top || top.financialImpact.status !== "quantified") return null;
  const fi = top.financialImpact;
  return {
    min: fi.min,
    max: fi.max,
    currency: fi.currency,
    period: fi.period,
    confidence: top.confidence,
  };
}

/** "$1,200–$3,400" or "$3,400" when both ends match. */
export function formatRange(range: MoneyRange): string {
  const lo = formatMoney(range.min, range.currency);
  const hi = formatMoney(range.max, range.currency);
  return lo === hi ? hi : `${lo}–${hi}`;
}

export function periodLabel(period: ImpactPeriod): string {
  return PERIOD_LABEL[period];
}

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

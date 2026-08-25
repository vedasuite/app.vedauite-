// Phase 1 insight types — mirror of backend/src/services/explainabilityCalc.ts.
// Keep in sync with the server contract for GET /api/insights/dashboard.

export type Confidence = "high" | "medium" | "low" | "insufficient_data";
export type Urgency = "critical" | "high" | "medium" | "low";
export type InsightModule =
  | "fraud" | "trust" | "return_abuse" | "competitor" | "pricing" | "profit"
  // Store health / data delivery. Never entitlement-gated server-side.
  | "operational";

export type ImpactPeriod =
  | "per_order"
  | "current_open_exposure"
  | "last_7_days"
  | "last_30_days"
  | "monthly_estimate";

export type EaseOfAction = "one_click_review" | "guided" | "manual";

export interface AggregateEvidence {
  label: string;
  value: string;
}

export type FinancialImpact =
  | {
      status: "quantified";
      min: number;
      max: number;
      currency: string;
      period: ImpactPeriod;
      basis: string;
      isEstimate: true;
    }
  | { status: "impact_not_quantifiable"; reason: string };

export interface OpportunityScoreBreakdown {
  total: number;
  components: {
    financialImpact: number;
    urgency: number;
    confidence: number;
    easeOfAction: number;
    recency: number;
  };
  weights: {
    financialImpact: number;
    urgency: number;
    confidence: number;
    easeOfAction: number;
    recency: number;
  };
  excludedFromMonetaryRanking: boolean;
  excludedReason?: string;
}

export interface Methodology {
  summary: string;
  assumptions: string[];
  caps: string[];
}

export interface ExplainableInsight {
  id: string;
  storeId: string;
  module: InsightModule;
  title: string;
  reasons: string[];
  evidence: AggregateEvidence[];
  financialImpact: FinancialImpact;
  confidence: Confidence;
  recency: string;
  urgency: Urgency;
  easeOfAction: EaseOfAction;
  recommendedAction: string;
  score: OpportunityScoreBreakdown;
  methodology: Methodology;
  route: string;
  dataQuality: "ok" | "insufficient_data";
  isCriticalNonMonetary?: boolean;
}

export interface LeakItem {
  key: string;
  label: string;
  min: number;
  max: number;
  period: ImpactPeriod;
  confidence: Confidence;
}
export interface LeakGroup {
  kind: "potential_upside" | "revenue_at_risk";
  period: ImpactPeriod;
  min: number;
  max: number;
  currency: string;
  items: LeakItem[];
  confidence: Confidence;
}
export interface RevenueLeakModel {
  potentialUpside: LeakGroup[];
  revenueAtRisk: LeakGroup[];
}

export interface ExecutiveSummary {
  generatedAt: string;
  headline: string;
  bullets: string[];
  topOpportunity: ExplainableInsight | null;
  dataReady: boolean;
}

export interface DataCoverage {
  module: InsightModule | "all";
  rowsAvailable: number;
  lastSyncAt: string | null;
  sufficient: boolean;
  note?: string;
}

export interface DashboardInsightsResponse {
  executiveSummary: ExecutiveSummary;
  opportunities: ExplainableInsight[];
  criticalAttention: ExplainableInsight[];
  revenueLeak: RevenueLeakModel;
  dataCoverage: DataCoverage[];
  generatedAt: string;
}

// ---- Presentation helpers (pure) ----

export function formatMoney(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 0 }).format(value);
  } catch {
    return `${Math.round(value)} ${currency}`;
  }
}

export const PERIOD_LABEL: Record<ImpactPeriod, string> = {
  per_order: "per order",
  current_open_exposure: "currently open",
  last_7_days: "last 7 days",
  last_30_days: "last 30 days",
  monthly_estimate: "monthly estimate",
};

/**
 * The five merchant-facing intelligence families.
 *
 * VedaSuite has SEVEN internal insight modules but presents FIVE workspaces:
 * fraud, trust and return_abuse are all ways money leaves through a customer,
 * and pricing and profit are two halves of product economics. Coverage rows
 * used to be labelled with the internal module names — "Fraud", "Competitor",
 * "Pricing" — which put the old product vocabulary back in front of the
 * merchant on the very page that is meant to summarise the new one.
 *
 * The KEYS are internal identifiers and are deliberately unchanged; they key
 * entitlements, the capability map and every stored finding. Only what the
 * merchant reads is mapped here.
 */
export const MODULE_FAMILY: Record<InsightModule, string> = {
  fraud: "Customer Loss",
  trust: "Customer Loss",
  return_abuse: "Customer Loss",
  competitor: "Market Signals",
  pricing: "Pricing & Product Profit",
  profit: "Pricing & Product Profit",
  operational: "Store Health",
};

/**
 * Row label for a single module.
 *
 * Leads with the family, then names the evidence that module contributes —
 * three Customer Loss rows all reading "Customer Loss" would be worse than the
 * old labels, not better, because a merchant could not tell which one is short
 * of data.
 */
export const MODULE_LABEL: Record<InsightModule, string> = {
  fraud: "Customer Loss — order risk",
  trust: "Customer Loss — shopper trust",
  return_abuse: "Customer Loss — returns",
  competitor: "Market Signals",
  pricing: "Pricing & Product Profit — pricing",
  profit: "Pricing & Product Profit — product economics",
  operational: "Store Health",
};

export function impactRangeText(fi: FinancialImpact): string {
  if (fi.status === "impact_not_quantifiable") return "Impact not quantified";
  const lo = formatMoney(fi.min, fi.currency);
  const hi = formatMoney(fi.max, fi.currency);
  return `${lo}–${hi} (est., ${PERIOD_LABEL[fi.period]})`;
}

// Badge-compatible tones only (Polaris Badge has no "subdued").
export type ConfidenceTone = "success" | "info" | "attention" | undefined;
export function confidenceTone(c: Confidence): ConfidenceTone {
  if (c === "high") return "success";
  if (c === "medium") return "info";
  if (c === "low") return "attention";
  return undefined;
}
// Urgency is mapped to a full severity style (icon + label + tone) by
// components/intelligence/severity.ts — see severityForUrgency().

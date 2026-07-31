// Phase 1 insight types — mirror of backend/src/services/explainabilityCalc.ts.
// Keep in sync with the server contract for GET /api/insights/dashboard.

export type Confidence = "high" | "medium" | "low" | "insufficient_data";
export type Urgency = "critical" | "high" | "medium" | "low";
export type InsightModule =
  | "fraud" | "trust" | "return_abuse" | "competitor" | "pricing" | "profit";

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

export const MODULE_LABEL: Record<InsightModule, string> = {
  fraud: "Fraud",
  trust: "Shopper trust",
  return_abuse: "Return abuse",
  competitor: "Competitor",
  pricing: "Pricing",
  profit: "Profit",
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
export function urgencyTone(u: Urgency): "critical" | "warning" | "attention" | "info" {
  if (u === "critical") return "critical";
  if (u === "high") return "warning";
  if (u === "medium") return "attention";
  return "info";
}

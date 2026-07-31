// Phase 1 explainability — PURE deterministic calculations.
//
// This module has NO database, network, Shopify, or LLM dependency. Every
// function is a pure function of its inputs so it can be unit-tested directly
// from dist/. All financial figures are conservative, bounded ESTIMATES; where
// they cannot be defended from available data we return `impact_not_quantifiable`.
//
// Governing docs: docs/phase-1-implementation-plan.md, docs/phase-1-final-readiness-check.md.

// ---------- Types (mirrored on the frontend as insightsTypes.ts) ----------

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
    financialImpact: 0.35;
    urgency: 0.25;
    confidence: 0.2;
    easeOfAction: 0.1;
    recency: 0.1;
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
  // No combined total field exists by design.
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

// ---------- Constants (single source of truth) ----------

export const OPPORTUNITY_WEIGHTS = {
  financialImpact: 0.35,
  urgency: 0.25,
  confidence: 0.2,
  easeOfAction: 0.1,
  recency: 0.1,
} as const;

export const GAP_CAP = 0.15;
export const COMPETITOR_CONFIDENCE_FACTOR: Record<string, number> = {
  high: 0.6,
  medium: 0.3,
};
export const COMPETITOR_FRESHNESS_DAYS = 14;

export const RETURN_ABUSE = {
  lookbackDays: 90,
  monetaryWindowDays: 30,
  minCustomerOrders: 5,
  minStoreOrders: 50,
};

// Completed/eligible order statuses (Shopify displayFinancialStatus lowercased).
export const ELIGIBLE_ORDER_STATUSES = ["paid", "approved"] as const;
// Statuses where a High-risk order is still "open/unresolved" and money is
// exposed. `manual_review` is the app's explicit review queue. Refunded/voided/
// expired/cancelled/baseline are excluded (settled or synthetic).
export const OPEN_HIGH_RISK_STATUSES = ["paid", "approved", "manual_review"] as const;

export const RECENCY_DECAY_DAYS = 30;

// Insight module -> capability module used by the existing entitlement system.
export const MODULE_CAPABILITY: Record<InsightModule, "fraud" | "competitor" | "pricing" | "profit"> = {
  fraud: "fraud",
  trust: "fraud",
  return_abuse: "fraud",
  competitor: "competitor",
  pricing: "pricing",
  profit: "profit",
};

// ---------- Small helpers ----------

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round2 = (v: number) => Math.round(v * 100) / 100;
const isEligibleStatus = (status: string) =>
  (ELIGIBLE_ORDER_STATUSES as readonly string[]).includes((status || "").toLowerCase());

function daysBetween(nowIso: string, thenIso: string): number {
  const now = new Date(nowIso).getTime();
  const then = new Date(thenIso).getTime();
  if (!Number.isFinite(now) || !Number.isFinite(then)) return Infinity;
  return (now - then) / (1000 * 60 * 60 * 24);
}

// ---------- 1. Opportunity Score ----------

const URGENCY_SCORE: Record<Urgency, number> = { critical: 100, high: 75, medium: 50, low: 25 };
const CONFIDENCE_SCORE: Record<Confidence, number | undefined> = {
  high: 100, medium: 60, low: 30, insufficient_data: undefined,
};
const EASE_SCORE: Record<EaseOfAction, number> = { one_click_review: 100, guided: 60, manual: 30 };

export interface OpportunityScoreInput {
  financialImpact: FinancialImpact;
  urgency: Urgency;
  confidence: Confidence;
  easeOfAction: EaseOfAction;
  recencyIso: string;
  nowIso: string;
  storeImpactCap: number; // deterministic per-store cap (>0); fallback provided by caller
}

export function computeOpportunityScore(input: OpportunityScoreInput): OpportunityScoreBreakdown {
  const weights = { ...OPPORTUNITY_WEIGHTS } as OpportunityScoreBreakdown["weights"];

  const confidenceComponent = CONFIDENCE_SCORE[input.confidence];
  const impact = input.financialImpact;
  const impactQuantified = impact.status === "quantified";

  // Hard rule: missing impact OR insufficient confidence excludes from monetary ranking.
  const excluded = !impactQuantified || confidenceComponent === undefined;

  const financialImpactComponent =
    impact.status === "quantified"
      ? 100 * clamp(impact.max / Math.max(1e-9, input.storeImpactCap), 0, 1)
      : 0;
  const urgencyComponent = URGENCY_SCORE[input.urgency];
  const confidenceComponentSafe = confidenceComponent ?? 0;
  const easeComponent = EASE_SCORE[input.easeOfAction];
  const recencyComponent = clamp(
    100 * (1 - daysBetween(input.nowIso, input.recencyIso) / RECENCY_DECAY_DAYS),
    0,
    100
  );

  const total = excluded
    ? 0
    : round2(
        weights.financialImpact * financialImpactComponent +
          weights.urgency * urgencyComponent +
          weights.confidence * confidenceComponentSafe +
          weights.easeOfAction * easeComponent +
          weights.recency * recencyComponent
      );

  return {
    total,
    components: {
      financialImpact: round2(financialImpactComponent),
      urgency: urgencyComponent,
      confidence: round2(confidenceComponentSafe),
      easeOfAction: easeComponent,
      recency: round2(recencyComponent),
    },
    weights,
    excludedFromMonetaryRanking: excluded,
    excludedReason: excluded
      ? !impactQuantified
        ? "Financial impact not quantifiable"
        : "Confidence insufficient"
      : undefined,
  };
}

// ---------- 2. Ease-of-action mapping (no LLM) ----------

export function mapEaseOfAction(recommendationType: string): EaseOfAction {
  const t = (recommendationType || "").toLowerCase();
  if (/review|flag|open|inspect|verify/.test(t) && !/playbook|strategy|multi/.test(t)) {
    return "one_click_review";
  }
  if (/price|publish|apply|recommended price|update price|margin adjust/.test(t)) {
    return "guided";
  }
  return "manual"; // conservative default
}

// ---------- 3. Potential-upside deduplication ----------

export interface UpsideCandidate {
  storeId: string;
  productId?: string | null;   // preferred canonical identity when reliable
  productHandle: string;
  createdAtIso: string;
  source: "price_history" | "profit_optimization" | "derived";
  amount: number | null;       // profit/gain estimate for this source
  valid: boolean;              // source-specific validity (non-null, >0, fresh)
}

export function canonicalProductIdentity(c: { productId?: string | null; productHandle: string }): string {
  if (c.productId && String(c.productId).trim()) return `id:${String(c.productId).trim()}`;
  return `handle:${(c.productHandle || "").trim().toLowerCase()}`;
}

// UTC day window bucket.
export function analysisWindowUTC(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "invalid";
  return d.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

export function dedupeKey(storeId: string, identity: string, windowKey: string): string {
  return `${storeId}::${identity}::${windowKey}`;
}

const SOURCE_PRIORITY: Record<UpsideCandidate["source"], number> = {
  price_history: 1,
  profit_optimization: 2,
  derived: 3,
};

/**
 * For each (storeId, canonical product, UTC window) choose exactly ONE amount by
 * source priority: price_history > profit_optimization > derived. Among rows of
 * the winning source, the latest valid row wins. Never sums duplicates.
 * Returns one selected candidate per dedup key (only valid amounts contribute).
 */
export function dedupePotentialUpside(candidates: UpsideCandidate[]): UpsideCandidate[] {
  const byKey = new Map<string, UpsideCandidate[]>();
  for (const c of candidates) {
    if (!c.valid || c.amount == null || c.amount <= 0) continue;
    const key = dedupeKey(c.storeId, canonicalProductIdentity(c), analysisWindowUTC(c.createdAtIso));
    const arr = byKey.get(key) ?? [];
    arr.push(c);
    byKey.set(key, arr);
  }

  const selected: UpsideCandidate[] = [];
  for (const arr of byKey.values()) {
    arr.sort((a, b) => {
      const p = SOURCE_PRIORITY[a.source] - SOURCE_PRIORITY[b.source];
      if (p !== 0) return p; // lower priority number wins
      // same source: latest valid row wins
      return new Date(b.createdAtIso).getTime() - new Date(a.createdAtIso).getTime();
    });
    selected.push(arr[0]);
  }
  return selected;
}

// ---------- 4. Return-abuse exposure ----------

export interface ReturnAbuseOrder {
  id: string;
  status: string;
  refunded: boolean;
  totalAmount: number;
  createdAtIso: string;
}
export interface ReturnAbuseInput {
  nowIso: string;
  currency: string;
  customerOrders: ReturnAbuseOrder[]; // this customer's orders (any status)
  storeEligibleOrderCount: number;    // # eligible orders store-wide (lookback)
  storeRefundedEligibleCount: number; // # refunded eligible orders store-wide (lookback)
}
export interface ReturnAbuseResult {
  behavioural: {
    customerRefundRate: number;
    storeBaselineRefundRate: number;
    excessRate: number;
    eligibleCustomerOrders: number;
    finding: string;
  } | null;
  financialImpact: FinancialImpact;
}

function dedupeById<T extends { id: string }>(rows: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const r of rows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
  }
  return out;
}

export function computeReturnAbuseExposure(input: ReturnAbuseInput): ReturnAbuseResult {
  const { lookbackDays, monetaryWindowDays, minCustomerOrders, minStoreOrders } = RETURN_ABUSE;

  const orders = dedupeById(input.customerOrders);
  const eligibleLookback = orders.filter(
    (o) => isEligibleStatus(o.status) && daysBetween(input.nowIso, o.createdAtIso) <= lookbackDays
  );
  const eligibleCustomerOrders = eligibleLookback.length;

  const notQuantifiable = (reason: string): FinancialImpact => ({
    status: "impact_not_quantifiable",
    reason,
  });

  // Thresholds gate the MONEY, not the behavioural finding.
  const storeOk = input.storeEligibleOrderCount >= minStoreOrders;
  const customerOk = eligibleCustomerOrders >= minCustomerOrders;

  let behavioural: ReturnAbuseResult["behavioural"] = null;
  let excessRate = 0;
  let storeBaselineRefundRate = 0;
  let customerRefundRate = 0;

  if (customerOk && storeOk) {
    const refundedCustomer = eligibleLookback.filter((o) => o.refunded).length;
    customerRefundRate = refundedCustomer / eligibleCustomerOrders;
    storeBaselineRefundRate =
      input.storeEligibleOrderCount > 0
        ? input.storeRefundedEligibleCount / input.storeEligibleOrderCount
        : 0;
    excessRate = Math.max(0, customerRefundRate - storeBaselineRefundRate);
    behavioural = {
      customerRefundRate: round2(customerRefundRate),
      storeBaselineRefundRate: round2(storeBaselineRefundRate),
      excessRate: round2(excessRate),
      eligibleCustomerOrders,
      finding: `Refund rate ${(customerRefundRate * 100).toFixed(1)}% vs store baseline ${(
        storeBaselineRefundRate * 100
      ).toFixed(1)}% across ${eligibleCustomerOrders} completed orders (90-day window).`,
    };
  }

  if (!customerOk) {
    return { behavioural, financialImpact: notQuantifiable("Fewer than 5 eligible customer orders") };
  }
  if (!storeOk) {
    return { behavioural, financialImpact: notQuantifiable("Fewer than 50 eligible store orders") };
  }

  // Money uses the most recent 30-day window only.
  const win = eligibleLookback.filter(
    (o) => daysBetween(input.nowIso, o.createdAtIso) <= monetaryWindowDays
  );
  const refunded30 = win.filter((o) => o.refunded);
  const refundedValue30d = refunded30.reduce((s, o) => s + o.totalAmount, 0);
  const eligibleOrderValue30d = win.reduce((s, o) => s + o.totalAmount, 0);

  if (eligibleOrderValue30d <= 0) {
    return { behavioural, financialImpact: notQuantifiable("No eligible order value in the last 30 days") };
  }

  const max = Math.min(excessRate * refundedValue30d, eligibleOrderValue30d);
  if (max <= 0) {
    return { behavioural, financialImpact: notQuantifiable("Refund behaviour at or below store baseline") };
  }

  return {
    behavioural,
    financialImpact: {
      status: "quantified",
      min: 0,
      max: round2(max),
      currency: input.currency,
      period: "last_30_days",
      basis:
        "Excess-over-baseline refund exposure. Full order value is used because partial-refund amounts are not stored.",
      isEstimate: true,
    },
  };
}

// ---------- 5. Competitor-price-pressure estimate ----------

export interface CompetitorImpactInput {
  nowIso: string;
  currency: string;
  ourPrice: number;
  competitorPrice: number | null;
  salesVelocity: number | null; // MUST be a real stored value; null => not quantifiable
  sellingPrice: number | null;  // for revenue proxy; null => not quantifiable
  matchConfidence: "high" | "medium" | "low" | string;
  collectedAtIso: string | null;
}

export function computeCompetitorImpact(input: CompetitorImpactInput): FinancialImpact {
  const nq = (reason: string): FinancialImpact => ({ status: "impact_not_quantifiable", reason });

  if (input.salesVelocity == null || !Number.isFinite(input.salesVelocity)) {
    return nq("No real stored sales velocity");
  }
  if (input.sellingPrice == null || input.sellingPrice <= 0) {
    return nq("No product selling price for revenue proxy");
  }
  if (input.competitorPrice == null || !(input.competitorPrice > 0)) {
    return nq("No competitor price");
  }
  if (input.matchConfidence !== "high" && input.matchConfidence !== "medium") {
    return nq("Product-match confidence too low");
  }
  if (!input.collectedAtIso || daysBetween(input.nowIso, input.collectedAtIso) > COMPETITOR_FRESHNESS_DAYS) {
    return nq("Competitor data older than 14 days");
  }

  const validPriceGap = (input.ourPrice - input.competitorPrice) / input.ourPrice;
  if (!(validPriceGap > 0)) {
    return nq("No positive price gap (we are not priced above the competitor)");
  }

  const recentProductRevenueProxy = input.sellingPrice * input.salesVelocity;
  const confidenceFactor = COMPETITOR_CONFIDENCE_FACTOR[input.matchConfidence];
  const max = recentProductRevenueProxy * Math.min(validPriceGap, GAP_CAP) * confidenceFactor;

  if (!(max > 0)) return nq("Estimated exposure is zero");

  return {
    status: "quantified",
    min: 0,
    max: round2(max),
    currency: input.currency,
    period: "monthly_estimate",
    basis:
      "revenueProxy(sellingPrice × salesVelocity) × min(priceGap, 15%) × confidenceFactor. Product importance affects prioritization only, never this amount.",
    isEstimate: true,
  };
}

// ---------- 6. High-risk-order exposure (current_open_exposure) ----------

export interface RiskOrder {
  id: string;
  fraudRiskLevel: string;
  status: string;
  refunded: boolean;
  totalAmount: number;
}
export function computeHighRiskOpenExposure(
  orders: RiskOrder[],
  currency: string
): { financialImpact: FinancialImpact; orderCount: number } {
  const open = dedupeById(orders).filter(
    (o) =>
      o.fraudRiskLevel === "High" &&
      !o.refunded &&
      (OPEN_HIGH_RISK_STATUSES as readonly string[]).includes((o.status || "").toLowerCase())
  );
  if (open.length === 0) {
    return {
      financialImpact: { status: "impact_not_quantifiable", reason: "No currently-open high-risk orders" },
      orderCount: 0,
    };
  }
  const sum = open.reduce((s, o) => s + o.totalAmount, 0);
  return {
    financialImpact: {
      status: "quantified",
      min: 0,
      max: round2(sum),
      currency,
      period: "current_open_exposure",
      basis: `Sum of totalAmount for ${open.length} currently-open High-risk orders (statuses: ${OPEN_HIGH_RISK_STATUSES.join(", ")}; excludes refunded).`,
      isEstimate: true,
    },
    orderCount: open.length,
  };
}

// ---------- 7. Period-homogeneous Revenue Leak grouping ----------

/**
 * Groups leak items into period-homogeneous LeakGroups. Items of different
 * periods are NEVER summed together — each period becomes its own group.
 */
export function groupLeaksByPeriod(
  kind: LeakGroup["kind"],
  items: LeakItem[],
  currency: string
): LeakGroup[] {
  const byPeriod = new Map<ImpactPeriod, LeakItem[]>();
  for (const it of items) {
    const arr = byPeriod.get(it.period) ?? [];
    arr.push(it);
    byPeriod.set(it.period, arr);
  }
  const groups: LeakGroup[] = [];
  for (const [period, arr] of byPeriod.entries()) {
    const min = arr.reduce((s, i) => s + i.min, 0);
    const max = arr.reduce((s, i) => s + i.max, 0);
    groups.push({
      kind,
      period,
      min: round2(min),
      max: round2(max),
      currency,
      items: arr,
      confidence: rollupConfidence(arr.map((i) => i.confidence)),
    });
  }
  return groups;
}

function rollupConfidence(list: Confidence[]): Confidence {
  if (list.length === 0) return "insufficient_data";
  const order: Confidence[] = ["insufficient_data", "low", "medium", "high"];
  // group confidence = the weakest present (conservative)
  let idx = order.length - 1;
  for (const c of list) idx = Math.min(idx, order.indexOf(c));
  return order[Math.max(0, idx)];
}

// ---------- 8. Critical Attention selection ----------

/**
 * A finding enters criticalAttention when urgency=critical AND confidence in
 * {high,medium} — EVEN IF financial impact is not quantifiable. No fabricated
 * monetary score; ordering is by urgency, then confidence, then recency.
 */
export function selectCriticalAttention(insights: ExplainableInsight[]): ExplainableInsight[] {
  const confRank: Record<Confidence, number> = { high: 3, medium: 2, low: 1, insufficient_data: 0 };
  return insights
    .filter((i) => i.urgency === "critical" && (i.confidence === "high" || i.confidence === "medium"))
    .map((i) => ({
      ...i,
      isCriticalNonMonetary: i.financialImpact.status === "impact_not_quantifiable",
    }))
    .sort((a, b) => {
      const c = confRank[b.confidence] - confRank[a.confidence];
      if (c !== 0) return c;
      return new Date(b.recency).getTime() - new Date(a.recency).getTime();
    });
}

// ---------- 9. Aggregate evidence allowlisting ----------

// Only these labels are ever emitted as generic evidence.
export const EVIDENCE_ALLOWLIST = new Set([
  "return_rate",
  "order_count",
  "refund_count",
  "address_count",
  "order_frequency_band",
  "risk_signal_count",
  "price_gap",
  "match_confidence",
  "margin_percentage",
  "sales_velocity",
]);

const EVIDENCE_LABELS: Record<string, string> = {
  return_rate: "Return rate",
  order_count: "Order count",
  refund_count: "Refund count",
  address_count: "Address count",
  order_frequency_band: "Order frequency",
  risk_signal_count: "Risk signals",
  price_gap: "Price gap",
  match_confidence: "Match confidence",
  margin_percentage: "Margin %",
  sales_velocity: "Sales velocity",
};

/**
 * Build evidence from an allowlisted key→value map. Any key not on the allowlist
 * is DROPPED (never emitted). Guarantees no raw PII (email/address/IP/device/
 * payment fingerprint/raw payloads) can leave through evidence.
 */
export function buildAggregateEvidence(fields: Record<string, string | number | null | undefined>): AggregateEvidence[] {
  const out: AggregateEvidence[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (!EVIDENCE_ALLOWLIST.has(key)) continue;
    if (value === null || value === undefined || value === "") continue;
    out.push({ label: EVIDENCE_LABELS[key] ?? key, value: String(value) });
  }
  return out;
}

// ---------- Capability filtering & tenant scoping (pure) ----------

export function filterInsightsByCapability(
  insights: ExplainableInsight[],
  enabledModules: string[]
): ExplainableInsight[] {
  const enabled = new Set(enabledModules);
  return insights.filter((i) => enabled.has(MODULE_CAPABILITY[i.module]));
}

/** Defense-in-depth on top of DB scoping: keep only the authenticated store's rows. */
export function scopeInsightsToStore(insights: ExplainableInsight[], storeId: string): ExplainableInsight[] {
  return insights.filter((i) => i.storeId === storeId);
}

// ---------- 10. Executive Summary templating (deterministic, no LLM) ----------

export function buildExecutiveSummary(input: {
  nowIso: string;
  dataReady: boolean;
  opportunities: ExplainableInsight[];
  criticalAttention: ExplainableInsight[];
  revenueLeak: RevenueLeakModel;
}): ExecutiveSummary {
  if (!input.dataReady) {
    return {
      generatedAt: input.nowIso,
      headline: "VedaSuite is still preparing this store’s insights.",
      bullets: ["Insights appear once connection, sync and plan are ready."],
      topOpportunity: null,
      dataReady: false,
    };
  }

  const top = input.opportunities[0] ?? null;
  const bullets: string[] = [];

  if (input.criticalAttention.length > 0) {
    bullets.push(
      `${input.criticalAttention.length} finding(s) need critical attention` +
        (input.criticalAttention.some((c) => c.isCriticalNonMonetary) ? " (some impact not quantified)." : ".")
    );
  }
  if (top) {
    const impact =
      top.financialImpact.status === "quantified"
        ? ` (up to ${top.financialImpact.max} ${top.financialImpact.currency}, ${top.financialImpact.period})`
        : "";
    bullets.push(`Top opportunity: ${top.title}${impact}.`);
  }

  const upsideGroups = input.revenueLeak.potentialUpside.length;
  const riskGroups = input.revenueLeak.revenueAtRisk.length;
  if (upsideGroups > 0) bullets.push(`${upsideGroups} potential-upside group(s) identified (shown by period).`);
  if (riskGroups > 0) bullets.push(`${riskGroups} revenue-at-risk group(s) identified (shown by period).`);
  if (bullets.length === 0) bullets.push("No prioritized findings right now. Store is healthy on available signals.");

  return {
    generatedAt: input.nowIso,
    headline: top ? `Review first: ${top.title}.` : "Your store looks healthy on available signals.",
    bullets,
    topOpportunity: top,
    dataReady: true,
  };
}

// Phase 1 explainability — orchestration (read-only, store-scoped, no writes).
//
// Performs ONE store-scoped read, delegates every calculation to the pure
// functions in explainabilityCalc.ts, enforces plan capabilities server-side
// (reusing the existing entitlement system, no billing files changed), and
// returns a single deterministic DashboardInsightsResponse with one generatedAt.
//
// No Shopify writes. No DB writes. No LLM. No raw PII in output or logs.

import { prisma } from "../db/prismaClient";
import { logEvent } from "./observabilityService";
import { resolveEntitlements } from "./subscriptionService";
import * as calc from "./explainabilityCalc";

const MAX_INSIGHTS_PER_MODULE = 10;
const IMPACT_CAP_FALLBACK = 1000;
// Bound in-memory rows. Detail lists only surface the top N per module, so these
// caps never affect the output for typical stores; exact totals come from count().
const READ_CAPS = { orders: 5000, highRisk: 1000, products: 500 };

function pickCurrency(orderCurrencies: string[]): string {
  const counts = new Map<string, number>();
  for (const c of orderCurrencies) if (c) counts.set(c, (counts.get(c) ?? 0) + 1);
  let best = "USD";
  let bestN = 0;
  for (const [c, n] of counts) if (n > bestN) { best = c; bestN = n; }
  return best;
}

function competitorConfidenceFromJson(insightsJson: string | null): string {
  if (!insightsJson) return "low";
  try {
    const parsed = JSON.parse(insightsJson) as { confidenceLabel?: string };
    return parsed.confidenceLabel ?? "low";
  } catch {
    return "low";
  }
}

// 90th-percentile cap of quantified impacts, with a safe fallback.
function computeImpactCap(maxes: number[]): number {
  const vals = maxes.filter((v) => v > 0).sort((a, b) => a - b);
  if (vals.length === 0) return IMPACT_CAP_FALLBACK;
  const idx = Math.min(vals.length - 1, Math.floor(0.9 * (vals.length - 1)));
  return Math.max(vals[idx], 1);
}

const EMPTY_RESPONSE = (nowIso: string): calc.DashboardInsightsResponse => ({
  executiveSummary: calc.buildExecutiveSummary({
    nowIso,
    dataReady: false,
    opportunities: [],
    criticalAttention: [],
    revenueLeak: { potentialUpside: [], revenueAtRisk: [] },
  }),
  opportunities: [],
  criticalAttention: [],
  revenueLeak: { potentialUpside: [], revenueAtRisk: [] },
  dataCoverage: [],
  generatedAt: nowIso,
});

export async function getDashboardInsights(
  shopDomain: string
): Promise<calc.DashboardInsightsResponse> {
  const nowIso = new Date().toISOString();

  // ---- bounded, store-scoped reads (fixed query count; no N+1, no unbounded
  // in-memory loads). Detail rows use where+orderBy+take; exact baseline and
  // coverage numbers come from DB count() so caps don't change the output. ----
  const storeCore = await prisma.store.findUnique({
    where: { shop: shopDomain },
    select: { id: true, lastSyncAt: true, lastSyncStatus: true, lastConnectionStatus: true },
  });
  if (!storeCore) return EMPTY_RESPONSE(nowIso);
  const storeId = storeCore.id;
  const lookbackStart = new Date(Date.now() - calc.RETURN_ABUSE.lookbackDays * 86400000);
  const eligibleStatuses = [...calc.ELIGIBLE_ORDER_STATUSES];

  const [
    recentOrders, openHighRiskOrders, priceHistory, profitData, competitorData,
    storeEligibleOrderCount, storeRefundedEligibleCount,
    orderTotalCount, competitorTotalCount, priceHistoryCount, profitDataCount,
  ] = await Promise.all([
    // Recent orders within the return-abuse lookback (bounded).
    prisma.order.findMany({
      where: { storeId, createdAt: { gte: lookbackStart } },
      select: { id: true, status: true, refunded: true, totalAmount: true, currency: true, createdAt: true, customerId: true },
      orderBy: { createdAt: "desc" }, take: READ_CAPS.orders,
    }),
    // Currently-open high-risk orders only (targeted + bounded = exact working set).
    prisma.order.findMany({
      where: { storeId, fraudRiskLevel: "High", refunded: false, status: { in: [...calc.OPEN_HIGH_RISK_STATUSES] } },
      select: { id: true, fraudRiskLevel: true, status: true, refunded: true, totalAmount: true },
      orderBy: { createdAt: "desc" }, take: READ_CAPS.highRisk,
    }),
    prisma.priceHistory.findMany({
      where: { storeId },
      select: { id: true, productHandle: true, currentPrice: true, recommendedPrice: true, expectedProfitGain: true, expectedMarginDelta: true, createdAt: true },
      orderBy: { createdAt: "desc" }, take: READ_CAPS.products,
    }),
    prisma.profitOptimizationData.findMany({
      where: { storeId },
      select: { id: true, productHandle: true, productCost: true, sellingPrice: true, salesVelocity: true, projectedMonthlyProfit: true, projectedMarginIncrease: true, optimalPrice: true, createdAt: true },
      orderBy: { createdAt: "desc" }, take: READ_CAPS.products,
    }),
    prisma.competitorData.findMany({
      where: { storeId },
      select: { id: true, productHandle: true, price: true, collectedAt: true, insightsJson: true },
      orderBy: { collectedAt: "desc" }, take: READ_CAPS.products,
    }),
    // Exact baseline counts (return-abuse) — DB-side, O(1) memory.
    prisma.order.count({ where: { storeId, status: { in: eligibleStatuses }, createdAt: { gte: lookbackStart } } }),
    prisma.order.count({ where: { storeId, status: { in: eligibleStatuses }, refunded: true, createdAt: { gte: lookbackStart } } }),
    // Exact coverage counts.
    prisma.order.count({ where: { storeId } }),
    prisma.competitorData.count({ where: { storeId } }),
    prisma.priceHistory.count({ where: { storeId } }),
    prisma.profitOptimizationData.count({ where: { storeId } }),
  ]);

  const store = {
    id: storeCore.id,
    lastSyncAt: storeCore.lastSyncAt,
    lastSyncStatus: storeCore.lastSyncStatus,
    lastConnectionStatus: storeCore.lastConnectionStatus,
    orders: recentOrders,
    priceHistory,
    profitData,
    competitorData,
  };

  // ---- server-side capability enforcement (reuse existing entitlements) ----
  let enabledModules: string[] = [];
  try {
    const ent = await resolveEntitlements(shopDomain);
    enabledModules = ent.enabledModules ?? [];
  } catch {
    enabledModules = [];
  }

  const dataReady =
    store.lastSyncStatus !== "syncing" &&
    store.lastConnectionStatus !== "UNINSTALLED" &&
    (orderTotalCount > 0 || priceHistoryCount > 0 || profitDataCount > 0);

  const currency = pickCurrency(store.orders.map((o) => o.currency));
  const insights: calc.ExplainableInsight[] = [];
  const upsideItems: calc.LeakItem[] = [];
  const riskItems: calc.LeakItem[] = [];

  const blankScore = (): calc.OpportunityScoreBreakdown =>
    ({ total: 0, components: { financialImpact: 0, urgency: 0, confidence: 0, easeOfAction: 0, recency: 0 },
       weights: { ...calc.OPPORTUNITY_WEIGHTS } as any, excludedFromMonetaryRanking: true });

  // ---------- Potential upside (dedup: PriceHistory > ProfitOptimization > derived) ----------
  const upsideCandidates: calc.UpsideCandidate[] = [];
  for (const p of store.priceHistory) {
    upsideCandidates.push({
      storeId: store.id, productHandle: p.productHandle, createdAtIso: p.createdAt.toISOString(),
      source: "price_history",
      amount: p.expectedProfitGain != null && p.expectedProfitGain > 0 ? p.expectedProfitGain : null,
      valid: p.expectedProfitGain != null && p.expectedProfitGain > 0,
    });
  }
  for (const pd of store.profitData) {
    upsideCandidates.push({
      storeId: store.id, productHandle: pd.productHandle, createdAtIso: pd.createdAt.toISOString(),
      source: "profit_optimization",
      amount: pd.projectedMonthlyProfit != null && pd.projectedMonthlyProfit > 0 ? pd.projectedMonthlyProfit : null,
      valid: pd.projectedMonthlyProfit != null && pd.projectedMonthlyProfit > 0,
    });
    // derived (only real stored velocity)
    if (pd.salesVelocity != null && pd.optimalPrice != null && pd.sellingPrice != null && pd.optimalPrice > pd.sellingPrice) {
      const derived = (pd.optimalPrice - pd.sellingPrice) * pd.salesVelocity;
      upsideCandidates.push({
        storeId: store.id, productHandle: pd.productHandle, createdAtIso: pd.createdAt.toISOString(),
        source: "derived", amount: derived > 0 ? derived : null, valid: derived > 0,
      });
    }
  }
  const selectedUpside = calc.dedupePotentialUpside(upsideCandidates).slice(0, MAX_INSIGHTS_PER_MODULE);
  for (const s of selectedUpside) {
    const impact: calc.FinancialImpact = {
      status: "quantified", min: 0, max: Math.round((s.amount ?? 0) * 100) / 100,
      currency, period: "monthly_estimate", basis: `Selected source: ${s.source} (deduplicated per product/window).`, isEstimate: true,
    };
    insights.push({
      id: `upside:${s.storeId}:${calc.canonicalProductIdentity(s)}:${calc.analysisWindowUTC(s.createdAtIso)}`,
      storeId: store.id, module: "pricing", title: `Pricing opportunity on ${s.productHandle}`,
      reasons: ["Recommended price is above current price with positive expected gain."],
      evidence: calc.buildAggregateEvidence({ margin_percentage: "" }),
      financialImpact: impact, confidence: "medium", recency: s.createdAtIso,
      urgency: "medium", easeOfAction: "guided",
      recommendedAction: "Review and apply the recommended price in Shopify.",
      score: blankScore(),
      methodology: { summary: "One estimate per product/window via source priority.", assumptions: ["Advisory estimate; merchant applies price."], caps: ["Never sums multiple sources for one product."] },
      route: "/app/ai-pricing-engine", dataQuality: "ok",
    });
    upsideItems.push({ key: s.productHandle, label: `Upside — ${s.productHandle}`, min: 0, max: impact.status === "quantified" ? impact.max : 0, period: "monthly_estimate", confidence: "medium" });
  }

  // ---------- Competitor price pressure ----------
  const profitByHandle = new Map<string, { sellingPrice: number | null; salesVelocity: number | null }>();
  for (const pd of store.profitData) profitByHandle.set(pd.productHandle, { sellingPrice: pd.sellingPrice, salesVelocity: pd.salesVelocity });
  let compCount = 0;
  for (const c of store.competitorData) {
    if (compCount >= MAX_INSIGHTS_PER_MODULE) break;
    const pf = profitByHandle.get(c.productHandle);
    const ourPrice = pf?.sellingPrice ?? null;
    const impact = calc.computeCompetitorImpact({
      nowIso, currency, ourPrice: ourPrice ?? 0, competitorPrice: c.price,
      salesVelocity: pf?.salesVelocity ?? null, sellingPrice: ourPrice,
      matchConfidence: competitorConfidenceFromJson(c.insightsJson),
      collectedAtIso: c.collectedAt.toISOString(),
    });
    const gap = ourPrice && c.price ? (ourPrice - c.price) / ourPrice : null;
    insights.push({
      id: `competitor:${store.id}:${c.id}`, storeId: store.id, module: "competitor",
      title: `Competitor price pressure on ${c.productHandle}`,
      reasons: ["A tracked competitor is priced below your product."],
      evidence: calc.buildAggregateEvidence({
        price_gap: gap != null ? `${(gap * 100).toFixed(1)}%` : undefined,
        match_confidence: competitorConfidenceFromJson(c.insightsJson),
      }),
      financialImpact: impact, confidence: (competitorConfidenceFromJson(c.insightsJson) as calc.Confidence),
      recency: c.collectedAt.toISOString(), urgency: "medium", easeOfAction: "manual",
      recommendedAction: "Review competitor pricing and decide on a response.",
      score: blankScore(),
      methodology: { summary: "revenueProxy × min(gap,15%) × confidenceFactor; importance affects prioritization only.", assumptions: ["Requires real velocity, fresh data, positive gap, ≥medium match."], caps: ["gapCap=0.15", "confidenceFactor<1"] },
      route: "/app/competitor-intelligence", dataQuality: impact.status === "quantified" ? "ok" : "insufficient_data",
    });
    if (impact.status === "quantified") {
      riskItems.push({ key: c.productHandle, label: `Competitor pressure — ${c.productHandle}`, min: 0, max: impact.max, period: "monthly_estimate", confidence: (competitorConfidenceFromJson(c.insightsJson) as calc.Confidence) });
    }
    compCount++;
  }

  // ---------- Return-abuse exposure (per customer, top offenders) ----------
  const ordersByCustomer = new Map<string, calc.ReturnAbuseOrder[]>();
  for (const o of store.orders) {
    if (!o.customerId) continue;
    const arr = ordersByCustomer.get(o.customerId) ?? [];
    arr.push({ id: o.id, status: o.status, refunded: o.refunded, totalAmount: o.totalAmount, createdAtIso: o.createdAt.toISOString() });
    ordersByCustomer.set(o.customerId, arr);
  }
  // store baseline uses the exact DB counts (computed above), not in-memory rows.
  const returnAbuseInsights: calc.ExplainableInsight[] = [];
  for (const [customerId, custOrders] of ordersByCustomer) {
    const r = calc.computeReturnAbuseExposure({
      nowIso, currency, customerOrders: custOrders,
      storeEligibleOrderCount, storeRefundedEligibleCount,
    });
    if (!r.behavioural) continue; // thresholds not met and no finding
    if (r.behavioural.excessRate <= 0 && r.financialImpact.status !== "quantified") continue;
    returnAbuseInsights.push({
      id: `return_abuse:${store.id}:${customerId}`, storeId: store.id, module: "return_abuse",
      title: "Elevated return behaviour on a repeat-refund shopper",
      reasons: [r.behavioural.finding],
      evidence: calc.buildAggregateEvidence({
        return_rate: `${(r.behavioural.customerRefundRate * 100).toFixed(1)}%`,
        order_count: r.behavioural.eligibleCustomerOrders,
      }),
      financialImpact: r.financialImpact,
      confidence: r.financialImpact.status === "quantified" ? "medium" : "low",
      recency: nowIso, urgency: "medium", easeOfAction: "one_click_review",
      recommendedAction: "Review this shopper’s refund history in Fraud Intelligence.",
      score: blankScore(),
      methodology: { summary: "Excess-over-baseline; money over last 30 days; full order value used (no partial-refund amounts stored).", assumptions: ["≥5 customer & ≥50 store eligible orders."], caps: ["Capped at eligible 30-day order value."] },
      route: "/app/fraud-intelligence", dataQuality: r.financialImpact.status === "quantified" ? "ok" : "insufficient_data",
    });
  }
  returnAbuseInsights.sort((a, b) => (b.financialImpact.status === "quantified" ? b.financialImpact.max : 0) - (a.financialImpact.status === "quantified" ? a.financialImpact.max : 0));
  for (const ins of returnAbuseInsights.slice(0, MAX_INSIGHTS_PER_MODULE)) {
    insights.push(ins);
    if (ins.financialImpact.status === "quantified") {
      riskItems.push({ key: ins.id, label: "Return-abuse exposure", min: 0, max: ins.financialImpact.max, period: "last_30_days", confidence: "medium" });
    }
  }

  // ---------- High-risk open exposure (one aggregate insight) ----------
  const hr = calc.computeHighRiskOpenExposure(
    openHighRiskOrders.map((o) => ({ id: o.id, fraudRiskLevel: o.fraudRiskLevel, status: o.status, refunded: o.refunded, totalAmount: o.totalAmount })),
    currency
  );
  if (hr.orderCount > 0) {
    insights.push({
      id: `high_risk_open:${store.id}`, storeId: store.id, module: "fraud",
      title: `${hr.orderCount} high-risk order(s) currently open`,
      reasons: ["Orders flagged High risk are still open/unresolved."],
      evidence: calc.buildAggregateEvidence({ risk_signal_count: hr.orderCount, order_count: hr.orderCount }),
      financialImpact: hr.financialImpact,
      confidence: "high", recency: nowIso,
      urgency: hr.orderCount >= 3 ? "critical" : "high", easeOfAction: "one_click_review",
      recommendedAction: "Review open high-risk orders in Fraud Intelligence.",
      score: blankScore(),
      methodology: { summary: `Sum of open High-risk order totals (statuses: ${calc.OPEN_HIGH_RISK_STATUSES.join(", ")}; excludes refunded).`, assumptions: ["Full order value at risk while unresolved."], caps: ["Point-in-time snapshot (current_open_exposure)."] },
      route: "/app/fraud-intelligence", dataQuality: "ok",
    });
    if (hr.financialImpact.status === "quantified") {
      riskItems.push({ key: "high_risk_open", label: "Open high-risk order exposure", min: 0, max: hr.financialImpact.max, period: "current_open_exposure", confidence: "high" });
    }
  }

  // ---------- Capability filter BEFORE scoring/aggregation (gated data excluded everywhere) ----------
  let scoped = calc.scopeInsightsToStore(insights, store.id);
  scoped = calc.filterInsightsByCapability(scoped, enabledModules);
  const allowedCaps = new Set(enabledModules);
  const upsideAllowed = allowedCaps.has("pricing") || allowedCaps.has("profit");
  const filteredUpsideItems = upsideAllowed ? upsideItems : [];
  const filteredRiskItems = riskItems.filter((it) => {
    if (it.period === "monthly_estimate" && it.label.startsWith("Competitor")) return allowedCaps.has("competitor");
    return allowedCaps.has("fraud"); // return-abuse + high-risk are fraud-module
  });

  // ---------- Score ----------
  const quantMaxes = scoped
    .map((i) => (i.financialImpact.status === "quantified" ? i.financialImpact.max : 0))
    .filter((v) => v > 0);
  const storeImpactCap = computeImpactCap(quantMaxes);
  for (const ins of scoped) {
    ins.score = calc.computeOpportunityScore({
      financialImpact: ins.financialImpact, urgency: ins.urgency, confidence: ins.confidence,
      easeOfAction: ins.easeOfAction, recencyIso: ins.recency, nowIso, storeImpactCap,
    });
  }

  const opportunities = scoped
    .filter((i) => !i.score.excludedFromMonetaryRanking)
    .sort((a, b) => b.score.total - a.score.total);
  const criticalAttention = calc.selectCriticalAttention(scoped);

  const revenueLeak: calc.RevenueLeakModel = {
    potentialUpside: calc.groupLeaksByPeriod("potential_upside", filteredUpsideItems, currency),
    revenueAtRisk: calc.groupLeaksByPeriod("revenue_at_risk", filteredRiskItems, currency),
  };

  // ---------- Data coverage (allowed modules only) ----------
  const dataCoverage: calc.DataCoverage[] = [];
  const lastSyncAt = store.lastSyncAt ? store.lastSyncAt.toISOString() : null;
  if (allowedCaps.has("fraud"))
    dataCoverage.push({ module: "fraud", rowsAvailable: orderTotalCount, lastSyncAt, sufficient: orderTotalCount >= 5, note: orderTotalCount < 5 ? "More order history needed." : undefined });
  if (allowedCaps.has("competitor"))
    dataCoverage.push({ module: "competitor", rowsAvailable: competitorTotalCount, lastSyncAt, sufficient: competitorTotalCount > 0, note: competitorTotalCount === 0 ? "Add competitor domains to enable pressure estimates." : undefined });
  if (allowedCaps.has("pricing") || allowedCaps.has("profit"))
    dataCoverage.push({ module: "pricing", rowsAvailable: priceHistoryCount + profitDataCount, lastSyncAt, sufficient: priceHistoryCount + profitDataCount > 0, note: store.profitData.every((p) => !p.productCost) ? "Add product cost to quantify margin." : undefined });

  const executiveSummary = calc.buildExecutiveSummary({ nowIso, dataReady, opportunities, criticalAttention, revenueLeak });

  logEvent("info", "insights.dashboard_built", {
    shop: shopDomain, opportunities: opportunities.length, critical: criticalAttention.length,
    enabledModules, dataReady,
  });

  return {
    executiveSummary,
    opportunities: dataReady ? opportunities : [],
    criticalAttention: dataReady ? criticalAttention : [],
    revenueLeak: dataReady ? revenueLeak : { potentialUpside: [], revenueAtRisk: [] },
    dataCoverage,
    generatedAt: nowIso,
  };
}

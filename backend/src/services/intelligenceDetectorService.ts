// PART 2 — detector orchestration for Customer Loss and Product Profit.
//
// Reads store-scoped data, delegates every calculation to the pure modules
// (customerLossCalc.ts, productProfitCalc.ts), shapes the results as the
// EXISTING ExplainableInsight, and persists them through the Part 1 finding
// foundation.
//
// WHAT IT DOES NOT DO
//   - No Shopify calls. No writes to Order, Customer, Product or any store data.
//   - No route. No Action Center. Findings are persisted, not yet served.
//   - Not wired into sync or any background job, so existing behaviour is
//     untouched. It runs only when called explicitly.
//   - No automatic customer/product/store change of any kind.
//
// Persistence is gated by the Part 1 feature flag: recordFinding() returns null
// when ENABLE_INTELLIGENCE_FINDING_PERSISTENCE is off, so this whole path is
// inert until deliberately enabled in an environment.
//
// IDEMPOTENCY. The fingerprint is derived from (module, findingType, subject),
// where subject is the customer id or the canonical product identity — never
// from money, ratios or timestamps. Re-running produces the SAME finding row
// with an advanced lastSeenAt, never a duplicate.

import { prisma } from "../db/prismaClient";
import { logEvent } from "./observabilityService";
import {
  analysisWindowUTC,
  canonicalProductIdentity,
  computeOpportunityScore,
  isEligibleStatus,
  RETURN_ABUSE,
  type ExplainableInsight,
  type FinancialImpact,
  type InsightModule,
  type Urgency,
} from "./explainabilityCalc";
import { computeCustomerLoss, CUSTOMER_LOSS } from "./customerLossCalc";
import { computeProductProfit, PRODUCT_PROFIT } from "./productProfitCalc";
import { recordFinding } from "./intelligenceFindingService";

/** Bounded reads so a large store cannot pull an unbounded row set. */
const READ_CAPS = {
  customers: 500,
  ordersPerCustomer: 500,
  products: 500,
} as const;

/** Deterministic fallback cap for opportunity scoring, mirroring Phase 1. */
const IMPACT_CAP_FALLBACK = 1000;

export const CUSTOMER_LOSS_FINDING_TYPE = "customer_loss_repeated_refund";
export const PRODUCT_PROFIT_FINDING_TYPE = "product_profit_weakened_retained_margin";

function impactMax(impact: FinancialImpact): number {
  return impact.status === "quantified" ? impact.max : 0;
}

function buildInsight(input: {
  storeId: string;
  module: InsightModule;
  id: string;
  title: string;
  reasons: string[];
  evidence: ExplainableInsight["evidence"];
  financialImpact: FinancialImpact;
  confidence: ExplainableInsight["confidence"];
  urgency: Urgency;
  recommendedAction: string;
  route: string;
  methodology: ExplainableInsight["methodology"];
  dataQuality: ExplainableInsight["dataQuality"];
  nowIso: string;
  storeImpactCap: number;
}): ExplainableInsight {
  return {
    id: input.id,
    storeId: input.storeId,
    module: input.module,
    title: input.title,
    reasons: input.reasons,
    evidence: input.evidence,
    financialImpact: input.financialImpact,
    confidence: input.confidence,
    recency: input.nowIso,
    urgency: input.urgency,
    // Every Part 2 finding is advisory: the merchant decides and acts manually.
    easeOfAction: "manual",
    recommendedAction: input.recommendedAction,
    score: computeOpportunityScore({
      financialImpact: input.financialImpact,
      urgency: input.urgency,
      confidence: input.confidence,
      easeOfAction: "manual",
      recencyIso: input.nowIso,
      nowIso: input.nowIso,
      storeImpactCap: input.storeImpactCap,
    }),
    methodology: input.methodology,
    route: input.route,
    dataQuality: input.dataQuality,
  };
}

// ---------------------------------------------------------------------------
// A. Customer Loss
// ---------------------------------------------------------------------------

export async function detectCustomerLoss(input: {
  storeId: string;
  nowIso?: string;
}): Promise<ExplainableInsight[]> {
  const nowIso = input.nowIso ?? new Date().toISOString();
  const lookbackStart = new Date(
    new Date(nowIso).getTime() - RETURN_ABUSE.lookbackDays * 86_400_000
  );

  // Store baseline, computed once from the same eligible-status rule the
  // existing return-abuse calculation uses.
  const baselineOrders = await prisma.order.findMany({
    where: { storeId: input.storeId, createdAt: { gte: lookbackStart } },
    select: { status: true, refunded: true },
  });
  const eligibleBaseline = baselineOrders.filter((o) => isEligibleStatus(o.status));
  const storeEligibleOrderCount = eligibleBaseline.length;
  const storeRefundedEligibleCount = eligibleBaseline.filter((o) => o.refunded).length;

  const customers = await prisma.customer.findMany({
    where: { storeId: input.storeId },
    select: { id: true, fraudSignalsCount: true },
    take: READ_CAPS.customers,
    orderBy: { updatedAt: "desc" },
  });

  const insights: ExplainableInsight[] = [];

  for (const customer of customers) {
    const orders = await prisma.order.findMany({
      where: { storeId: input.storeId, customerId: customer.id },
      select: {
        id: true,
        status: true,
        refunded: true,
        totalAmount: true,
        currency: true,
        createdAt: true,
      },
      take: READ_CAPS.ordersPerCustomer,
      orderBy: { createdAt: "desc" },
    });

    const result = computeCustomerLoss({
      nowIso,
      customerOrders: orders.map((o) => ({
        id: o.id,
        status: o.status,
        refunded: o.refunded,
        totalAmount: o.totalAmount,
        currency: o.currency,
        createdAtIso: o.createdAt.toISOString(),
      })),
      storeEligibleOrderCount,
      storeRefundedEligibleCount,
      riskSignalCount: customer.fraudSignalsCount,
    });

    if (result.pattern === null || !result.observed) continue;

    const observed = result.observed;
    const insight = buildInsight({
      storeId: input.storeId,
      module: "return_abuse",
      id: `customer_loss:${customer.id}:${analysisWindowUTC(nowIso)}`,
      title: "Repeated refund loss across multiple orders",
      reasons: result.reasons,
      evidence: result.evidence,
      // The finding's headline number is OBSERVED loss. Future risk travels
      // alongside it in methodology, never summed into it.
      financialImpact: result.observedImpact,
      confidence: result.confidence,
      urgency: result.confidence === "high" ? "high" : "medium",
      recommendedAction:
        "Review this customer's refund history before their next order. No automatic action was taken.",
      route: "/app/fraud-intelligence",
      methodology: {
        summary:
          `Observed loss over the last ${observed.windowDays} days: refunded order value ` +
          `${observed.refundedOrderValue} of ${observed.eligibleOrderValue} ${observed.currency} ` +
          `across ${observed.eligibleOrders} completed orders. Future risk is reported separately ` +
          `and is NOT added to observed loss.`,
        assumptions: [
          `Observation window ${observed.firstOrderIso.slice(0, 10)} to ${observed.lastOrderIso.slice(0, 10)}.`,
          "Refunded ORDER value is an upper bound on true loss — per-order refund amounts are not stored.",
          `Thresholds: >=${CUSTOMER_LOSS.minEligibleOrders} eligible orders, >=${CUSTOMER_LOSS.minRefundedOrders} refunded, ` +
            `>=${(CUSTOMER_LOSS.minObservedLossRatio * 100).toFixed(0)}% of order value, ` +
            `store baseline >=${CUSTOMER_LOSS.minStoreOrders} orders.`,
          `Future risk (separate): ${
            result.futureRisk.status === "quantified"
              ? `up to ${result.futureRisk.max} ${result.futureRisk.currency} (${result.futureRisk.period})`
              : `not quantifiable — ${result.futureRisk.reason}`
          }.`,
        ],
        caps: [
          `Missing inputs: ${result.completeness.missingInputs.join(", ")}.`,
          "Only completed orders in a single currency are counted; mixed-currency histories are refused.",
        ],
      },
      dataQuality: "ok",
      nowIso,
      storeImpactCap: Math.max(impactMax(result.observedImpact), IMPACT_CAP_FALLBACK),
    });

    insights.push(insight);

    await recordFinding({
      storeId: input.storeId,
      module: "return_abuse",
      findingType: CUSTOMER_LOSS_FINDING_TYPE,
      // Subject is the customer — stable across runs, independent of amounts.
      subjectKey: customer.id,
      snapshot: insight,
      sourceInsightId: insight.id,
    });
  }

  logEvent("info", "intelligence.customer_loss_detected", {
    storeId: input.storeId,
    customersEvaluated: customers.length,
    findings: insights.length,
    storeEligibleOrderCount,
  });

  return insights;
}

// ---------------------------------------------------------------------------
// B. Product Profit
// ---------------------------------------------------------------------------

export async function detectProductProfit(input: {
  storeId: string;
  nowIso?: string;
}): Promise<ExplainableInsight[]> {
  const nowIso = input.nowIso ?? new Date().toISOString();

  // Latest ProfitOptimizationData row per product handle. Reuses the existing
  // stored cost data rather than deriving costs from anywhere else.
  const profitRows = await prisma.profitOptimizationData.findMany({
    where: { storeId: input.storeId },
    orderBy: { createdAt: "desc" },
    take: READ_CAPS.products,
  });

  const latestByHandle = new Map<string, (typeof profitRows)[number]>();
  for (const row of profitRows) {
    const key = (row.productHandle || "").trim().toLowerCase();
    if (!key || latestByHandle.has(key)) continue;
    latestByHandle.set(key, row);
  }

  const snapshots = await prisma.productSnapshot.findMany({
    where: { storeId: input.storeId },
    select: { handle: true, title: true, currency: true, currentPrice: true },
    take: READ_CAPS.products,
  });
  const snapshotByHandle = new Map(
    snapshots.map((s) => [(s.handle || "").trim().toLowerCase(), s])
  );

  const insights: ExplainableInsight[] = [];

  for (const [handle, row] of latestByHandle) {
    const snapshot = snapshotByHandle.get(handle);

    const result = computeProductProfit({
      productHandle: handle,
      productTitle: snapshot?.title ?? null,
      // Currency comes from the product record; never assumed.
      currency: snapshot?.currency ?? null,
      sellingPrice: row.sellingPrice,
      productCost: row.productCost,
      shippingCost: row.shippingCost,
      returnRate: row.returnRate,
      salesVelocity: row.salesVelocity,
      dataAsOfIso: row.createdAt.toISOString(),
    });

    if (result.pattern === null || !result.unitEconomics) continue;

    const unit = result.unitEconomics;
    const identity = canonicalProductIdentity({ productHandle: handle });

    const insight = buildInsight({
      storeId: input.storeId,
      module: "profit",
      id: `product_profit:${identity}:${analysisWindowUTC(nowIso)}`,
      title:
        result.pattern === "negative_retained_margin"
          ? `Negative retained economics on ${snapshot?.title ?? handle}`
          : `Weakened retained economics on ${snapshot?.title ?? handle}`,
      reasons: result.reasons,
      evidence: result.evidence,
      financialImpact: result.financialImpact,
      confidence: result.confidence,
      urgency: result.pattern === "negative_retained_margin" ? "high" : "medium",
      recommendedAction:
        "Review this product's cost, shipping and return inputs before changing price. No automatic action was taken.",
      route: "/app/ai-pricing-engine",
      methodology: {
        summary:
          `${result.completeness.label}: ${
            unit.retainedAfterReturns ?? unit.retainedBeforeReturns
          } ${unit.currency} per unit ` +
          `(${(unit.retainedMarginRatio * 100).toFixed(1)}% of the ${unit.sellingPrice} ${unit.currency} price). ` +
          "This is NOT a true profit figure.",
        assumptions: [
          `Drivers: ${result.drivers.join(", ")}.`,
          `Completeness: ${result.completeness.level}. ${result.completeness.note}`,
          `Weakened threshold: retained margin <= ${(PRODUCT_PROFIT.weakenedMarginRatio * 100).toFixed(0)}% of price.`,
          "A cost of zero or below is treated as MISSING data, never as a free product.",
        ],
        caps: [
          `Missing inputs: ${result.completeness.missingInputs.join(", ")}.`,
          "Per unit only — not extrapolated to a period, because realised per-product sales volume requires order line items, which are not stored.",
        ],
      },
      dataQuality: result.completeness.level === "complete" ? "ok" : "insufficient_data",
      nowIso,
      storeImpactCap: Math.max(
        Math.abs(impactMax(result.financialImpact)),
        IMPACT_CAP_FALLBACK
      ),
    });

    insights.push(insight);

    await recordFinding({
      storeId: input.storeId,
      module: "profit",
      findingType: PRODUCT_PROFIT_FINDING_TYPE,
      // Subject is the canonical product identity — stable across runs.
      subjectKey: identity,
      snapshot: insight,
      sourceInsightId: insight.id,
    });
  }

  logEvent("info", "intelligence.product_profit_detected", {
    storeId: input.storeId,
    productsEvaluated: latestByHandle.size,
    findings: insights.length,
  });

  return insights;
}

/**
 * Runs both detectors for one store. Explicit entry point — deliberately NOT
 * scheduled and NOT called from sync, onboarding, billing or any route, so no
 * existing behaviour changes until it is wired up in a later part.
 */
export async function runIntelligenceDetectors(input: {
  storeId: string;
  nowIso?: string;
}) {
  const [customerLoss, productProfit] = await Promise.all([
    detectCustomerLoss(input),
    detectProductProfit(input),
  ]);
  return { customerLoss, productProfit };
}

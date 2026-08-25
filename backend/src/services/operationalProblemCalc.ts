// PART 3 — Operational Problem Intelligence. PURE deterministic calculations.
//
// No database, network, Shopify or LLM dependency.
//
// SCOPE DISCIPLINE
// ----------------
// Every detector here is built ONLY on data the repository proves VedaSuite
// receives. Verified by inspection of prisma/schema.prisma:
//
//   Order            status, refunded, refundRequested, totalAmount, currency,
//                    fraudRiskLevel, fraudScore, createdAt, customerId
//   SyncJob          jobType, status, errorMessage, startedAt, finishedAt
//   Store            lastSyncAt, lastSyncStatus, lastConnectionStatus,
//                    lastWebhookRegistrationStatus, accessTokenExpiresAt
//   ProductSnapshot  handle, status, currency
//   ProfitOptimizationData  productHandle, productCost
//
// DELIBERATELY NOT BUILT — no integration supplies the evidence. A grep of the
// whole schema for inventory / stock / supplier / carrier / shipment / tracking
// / warehouse / fulfillment returns ZERO fields, so none of the following can be
// claimed without inventing data:
//   supplier or purchase-order delays, advertising or product-feed failures,
//   marketplace / ERP / WMS mismatches, carrier or 3PL problems, stockouts,
//   shipping delays, chargeback events (no chargeback field exists anywhere).
// These are recorded as future integration opportunities, never as findings.
//
// NOTHING HERE CHANGES THE STORE. Detectors compute and explain only.

import {
  buildAggregateEvidence,
  daysBetween,
  isEligibleStatus,
  round2,
  type AggregateEvidence,
  type Confidence,
  type FinancialImpact,
  type Urgency,
} from "./explainabilityCalc";

/**
 * Documented thresholds and baselines for every operational detector.
 * Small-store protection lives here: each detector states the minimum volume
 * below which it refuses to fire at all.
 */
export const OPERATIONAL = {
  refundShift: {
    /** Recent window under test. */
    recentDays: 14,
    /** Historical baseline window, immediately preceding the recent one. */
    baselineDays: 76, // 14 + 76 = 90-day total history
    /** New-store protection: minimum eligible orders in EACH window. */
    minOrdersPerWindow: 20,
    /** Absolute percentage-point rise required. */
    minAbsoluteRise: 0.1,
    /** AND a relative multiple, so a low baseline cannot trip on noise. */
    minRelativeMultiple: 1.5,
  },
  highRiskBacklog: {
    /** Minimum open high-risk orders before this is an operational problem. */
    minOpenOrders: 3,
    /** Age at which an unresolved high-risk order is escalated. */
    agingDays: 7,
    /** Store must have some history before a backlog is meaningful. */
    minStoreOrders: 20,
  },
  syncHealth: {
    /** Consecutive recent failures that constitute a degradation. */
    failureStreak: 2,
    /** A successful sync older than this is stale. */
    staleSyncDays: 3,
    /** Token expiry warning horizon. */
    tokenExpiryWarningDays: 3,
    /** Only consider sync jobs from this recent period. */
    lookbackDays: 14,
  },
  coverage: {
    /** Below this share of products having usable cost data, warn. */
    minCostCoverage: 0.5,
    /** Below this share of orders linked to a customer, warn. */
    minCustomerLinkage: 0.8,
    /** Never warn about coverage for a store with almost no data yet. */
    minProducts: 10,
    minOrders: 20,
  },
} as const;

export type OperationalDetectorKey =
  | "refund_rate_shift"
  | "high_risk_order_backlog"
  | "sync_health_degraded"
  | "data_coverage_low";

export interface OperationalProblem {
  detector: OperationalDetectorKey;
  title: string;
  /** What happened. */
  what: string;
  /** Why it matters to the merchant. */
  why: string;
  severity: Urgency;
  confidence: Confidence;
  /** Exact window the evidence covers. */
  window: { days: number; fromIso: string; toIso: string };
  evidence: AggregateEvidence[];
  /** Only quantified where genuinely defensible. */
  impact: FinancialImpact;
  completeness: { level: "complete" | "partial"; missingInputs: string[]; note: string };
  /** Merchant-controlled, never automatic. */
  recommendedAction: string;
  /** Stable dedupe subject for this detector. */
  subjectKey: string;
}

const notQuantifiable = (reason: string): FinancialImpact => ({
  status: "impact_not_quantifiable",
  reason,
});

function windowOf(nowIso: string, days: number) {
  const to = new Date(nowIso);
  const from = new Date(to.getTime() - days * 86_400_000);
  return { days, fromIso: from.toISOString(), toIso: to.toISOString() };
}

// ===========================================================================
// O1. Refund-rate shift — abrupt change vs the store's own recent history
// ===========================================================================

export interface RefundShiftOrder {
  id: string;
  status: string;
  refunded: boolean;
  totalAmount: number;
  createdAtIso: string;
}

export function detectRefundRateShift(input: {
  nowIso: string;
  orders: RefundShiftOrder[];
  currency: string | null;
}): OperationalProblem | null {
  const t = OPERATIONAL.refundShift;

  const seen = new Set<string>();
  const eligible = input.orders.filter((o) => {
    if (!isEligibleStatus(o.status)) return false;
    if (!Number.isFinite(o.totalAmount) || o.totalAmount < 0) return false;
    if (seen.has(o.id)) return false;
    seen.add(o.id);
    return true;
  });

  const age = (o: RefundShiftOrder) => daysBetween(input.nowIso, o.createdAtIso);
  const recent = eligible.filter((o) => age(o) <= t.recentDays);
  const baseline = eligible.filter(
    (o) => age(o) > t.recentDays && age(o) <= t.recentDays + t.baselineDays
  );

  // New-store / small-data protection: BOTH windows need real volume, or a
  // handful of orders could manufacture a dramatic-looking "shift".
  if (recent.length < t.minOrdersPerWindow || baseline.length < t.minOrdersPerWindow) {
    return null;
  }

  const recentRate = recent.filter((o) => o.refunded).length / recent.length;
  const baselineRate = baseline.filter((o) => o.refunded).length / baseline.length;
  const absoluteRise = recentRate - baselineRate;

  // Two independent gates. The absolute gate stops tiny-baseline noise from
  // passing the relative gate; the relative gate stops a high-but-stable
  // refund store from being flagged every run.
  if (absoluteRise < t.minAbsoluteRise) return null;
  if (baselineRate > 0 && recentRate < baselineRate * t.minRelativeMultiple) return null;

  const refundedRecentValue = round2(
    recent.filter((o) => o.refunded).reduce((s, o) => s + o.totalAmount, 0)
  );

  const currency = (input.currency || "").trim().toUpperCase();
  const impact: FinancialImpact = currency
    ? {
        status: "quantified",
        min: 0,
        max: refundedRecentValue,
        currency,
        period: "last_30_days",
        basis:
          `Order value of refunded completed orders in the last ${t.recentDays} days. ` +
          "An upper bound, not an exact refund total, because per-order refund amounts are not stored.",
        isEstimate: true,
      }
    : notQuantifiable("No single store currency, so refunded value cannot be summed");

  const severity: Urgency = absoluteRise >= t.minAbsoluteRise * 2 ? "high" : "medium";

  return {
    detector: "refund_rate_shift",
    title: "Refund rate has risen sharply against your own recent baseline",
    what:
      `Refunds rose to ${(recentRate * 100).toFixed(1)}% of completed orders in the last ` +
      `${t.recentDays} days, from ${(baselineRate * 100).toFixed(1)}% over the preceding ` +
      `${t.baselineDays} days.`,
    why:
      "A sudden refund shift usually means a product, pricing or expectation problem that is " +
      "still active, so the cost continues to accrue until it is identified.",
    severity,
    confidence: recent.length >= t.minOrdersPerWindow * 3 ? "high" : "medium",
    window: windowOf(input.nowIso, t.recentDays),
    evidence: buildAggregateEvidence({
      refund_rate_recent: `${(recentRate * 100).toFixed(1)}%`,
      refund_rate_baseline: `${(baselineRate * 100).toFixed(1)}%`,
      refund_rate_shift: `+${(absoluteRise * 100).toFixed(1)} pts`,
      order_count: recent.length,
      refund_count: recent.filter((o) => o.refunded).length,
      window_days: t.recentDays,
    }),
    impact,
    completeness: {
      level: "partial",
      missingInputs: ["refund_amount_per_order", "refund_reasons", "order_line_items"],
      note:
        "Refund COUNTS are exact. Refunded value is bounded above by order value because " +
        "per-order refund amounts are not stored, and no refund reason is captured.",
    },
    recommendedAction:
      "Review recently refunded orders to identify the common product or cause. No automatic action was taken.",
    subjectKey: `refund_shift:${windowOf(input.nowIso, t.recentDays).toIso.slice(0, 10)}`,
  };
}

// ===========================================================================
// O2. High-risk order backlog — unresolved exposure accumulating
// ===========================================================================

export interface BacklogOrder {
  id: string;
  status: string;
  refunded: boolean;
  fraudRiskLevel: string;
  totalAmount: number;
  createdAtIso: string;
}

export function detectHighRiskBacklog(input: {
  nowIso: string;
  orders: BacklogOrder[];
  /** Pre-computed by the existing computeHighRiskOpenExposure. */
  openExposure: FinancialImpact;
  openOrderCount: number;
  storeEligibleOrderCount: number;
}): OperationalProblem | null {
  const t = OPERATIONAL.highRiskBacklog;

  if (input.storeEligibleOrderCount < t.minStoreOrders) return null;
  if (input.openOrderCount < t.minOpenOrders) return null;

  const seen = new Set<string>();
  const open = input.orders.filter((o) => {
    if (o.fraudRiskLevel !== "High" || o.refunded) return false;
    if (seen.has(o.id)) return false;
    seen.add(o.id);
    return true;
  });

  const ages = open
    .map((o) => daysBetween(input.nowIso, o.createdAtIso))
    .filter((d) => Number.isFinite(d));
  const oldestDays = ages.length ? Math.floor(Math.max(...ages)) : 0;

  const aging = oldestDays >= t.agingDays;
  const severity: Urgency = aging ? "high" : "medium";

  return {
    detector: "high_risk_order_backlog",
    title: "High-risk orders are waiting unresolved",
    what:
      `${input.openOrderCount} high-risk orders are still open` +
      (aging ? `, the oldest for ${oldestDays} days.` : "."),
    why:
      "Open high-risk orders keep money exposed. The longer they sit, the harder a chargeback " +
      "or refund is to contest.",
    severity,
    confidence: "high",
    window: windowOf(input.nowIso, Math.max(oldestDays, 1)),
    evidence: buildAggregateEvidence({
      open_high_risk_orders: input.openOrderCount,
      oldest_open_days: oldestDays,
      order_count: input.storeEligibleOrderCount,
    }),
    // Reuses the EXISTING exposure calculation rather than re-deriving it.
    impact: input.openExposure,
    completeness: {
      level: "complete",
      missingInputs: ["chargeback_events"],
      note:
        "Order statuses and risk levels are exact. Whether a chargeback has actually been " +
        "raised is not knowable — VedaSuite stores no chargeback data.",
    },
    recommendedAction:
      "Open Fraud Intelligence and clear the oldest high-risk orders first. No automatic action was taken.",
    subjectKey: "high_risk_backlog",
  };
}

// ===========================================================================
// O3. Sync / connection health degradation
// ===========================================================================

export interface SyncJobRecord {
  id: string;
  jobType: string;
  status: string;
  finishedAtIso: string | null;
  createdAtIso: string;
}

const FAILED_SYNC_STATUSES = new Set(["FAILED"]);
const SUCCESS_SYNC_STATUSES = new Set([
  "READY_WITH_DATA",
  "SUCCEEDED",
  "SUCCEEDED_NO_DATA",
  "SUCCEEDED_PROCESSING_PENDING",
]);

export function detectSyncHealth(input: {
  nowIso: string;
  syncJobs: SyncJobRecord[];
  lastSyncAtIso: string | null;
  lastConnectionStatus: string | null;
  lastWebhookRegistrationStatus: string | null;
  accessTokenExpiresAtIso: string | null;
}): OperationalProblem | null {
  const t = OPERATIONAL.syncHealth;

  const jobs = input.syncJobs
    .filter(
      (j) =>
        j.jobType === "shopify_sync" &&
        daysBetween(input.nowIso, j.createdAtIso) <= t.lookbackDays
    )
    .sort(
      (a, b) => new Date(b.createdAtIso).getTime() - new Date(a.createdAtIso).getTime()
    );

  // Consecutive failures from the most recent job backwards.
  let failureStreak = 0;
  for (const job of jobs) {
    if (FAILED_SYNC_STATUSES.has(job.status)) failureStreak += 1;
    else break;
  }

  const lastSuccess = jobs.find((j) => SUCCESS_SYNC_STATUSES.has(j.status));
  const lastSuccessIso = lastSuccess?.finishedAtIso ?? input.lastSyncAtIso ?? null;
  const daysSinceSuccess = lastSuccessIso
    ? Math.floor(daysBetween(input.nowIso, lastSuccessIso))
    : null;

  const connectionBroken =
    !!input.lastConnectionStatus &&
    ["SHOPIFY_AUTH_REQUIRED", "SHOPIFY_RECONNECT_REQUIRED", "MISSING_ACCESS_TOKEN"].includes(
      input.lastConnectionStatus
    );
  const webhooksFailed = input.lastWebhookRegistrationStatus === "FAILED";

  const stale = daysSinceSuccess !== null && daysSinceSuccess > t.staleSyncDays;
  const streaking = failureStreak >= t.failureStreak;

  // ---------------------------------------------------------------------
  // EVIDENCE PRECEDENCE
  //
  // These signals are not equal, and treating them as equal produced a
  // critical "VedaSuite is not receiving reliable Shopify data" alert on a
  // store whose sync had just completed successfully.
  //
  //   1. Live sync outcome   — STRONGEST. A sync that succeeded recently is
  //                            direct proof the connection authenticated and
  //                            returned data.
  //   2. lastConnectionStatus— set when Shopify actually rejected a call.
  //   3. webhook registration— a real registration outcome.
  //   4. accessTokenExpiresAt— WEAKEST. A prediction, not an observation. This
  //                            app uses expiring offline tokens WITH a refresh
  //                            token (tokenAcquisitionMode "offline_expiring"),
  //                            so an approaching expiry is routine and handled
  //                            automatically, not a fault.
  //
  // Token metadata may therefore never, on its own, raise a critical alert or
  // contradict a sync that demonstrably just worked.
  // ---------------------------------------------------------------------
  const tokenDaysLeft = input.accessTokenExpiresAtIso
    ? Math.floor(-daysBetween(input.nowIso, input.accessTokenExpiresAtIso))
    : null;
  const tokenExpired = tokenDaysLeft !== null && tokenDaysLeft < 0;
  const tokenNearExpiry =
    tokenDaysLeft !== null && tokenDaysLeft >= 0 && tokenDaysLeft <= t.tokenExpiryWarningDays;

  // Direct, current proof the connection works. Deliberately time-bounded by
  // the same staleness threshold, so an OLD success can never mask a genuine
  // break: once the last success is stale, this is false again.
  const connectionProvenWorking = !stale && daysSinceSuccess !== null && !connectionBroken;

  // Token metadata only speaks when we have no live proof to the contrary.
  const tokenConcern = (tokenExpired || tokenNearExpiry) && !connectionProvenWorking;

  // New-store protection: with NO sync history at all there is nothing to
  // degrade. A store that has never synced is an onboarding state, not a fault.
  //
  // "No history" deliberately means no recent job AND no lastSyncAt. Testing
  // only the job list would misread a store whose last successful sync predates
  // the lookback window as never-synced, and silently swallow a genuinely stale
  // store — the exact case this detector exists to catch.
  const neverSynced = jobs.length === 0 && !lastSuccessIso;
  if (neverSynced && !connectionBroken && !webhooksFailed && !tokenConcern) {
    return null;
  }
  if (!streaking && !stale && !connectionBroken && !webhooksFailed && !tokenConcern) {
    return null;
  }

  const problems: string[] = [];
  if (connectionBroken) problems.push("the Shopify connection needs reauthorisation");
  if (streaking) problems.push(`${failureStreak} consecutive sync failures`);
  if (stale) problems.push(`no successful sync for ${daysSinceSuccess} days`);
  if (webhooksFailed) problems.push("webhook registration failed");
  if (tokenConcern) {
    problems.push(
      tokenExpired
        ? `the stored access token expired ${Math.abs(tokenDaysLeft as number)} day(s) ago and no sync has succeeded since`
        : `the access token expires in ${tokenDaysLeft} day(s) and no recent sync confirms the connection`
    );
  }

  // Only an observed failure can be critical. Token metadata is a prediction,
  // so it caps at medium however close the expiry is.
  const severity: Urgency = connectionBroken
    ? "critical"
    : streaking
    ? "high"
    : "medium";

  return {
    detector: "sync_health_degraded",
    title: "VedaSuite is not receiving reliable Shopify data",
    what: `Detected: ${problems.join("; ")}.`,
    why:
      "Every insight depends on fresh Shopify data. While this persists, findings are based on " +
      "stale information and new problems may go unnoticed.",
    severity,
    confidence: "high",
    window: windowOf(input.nowIso, t.lookbackDays),
    evidence: buildAggregateEvidence({
      sync_failure_streak: failureStreak,
      last_successful_sync_days: daysSinceSuccess ?? null,
      window_days: t.lookbackDays,
    }),
    // Operational, not monetary. Inventing a number here would be indefensible.
    impact: notQuantifiable(
      "Data-delivery problems have no directly attributable monetary value"
    ),
    completeness: {
      level: "complete",
      missingInputs: [],
      note: "Derived entirely from stored sync-job, connection and token state.",
    },
    recommendedAction: connectionBroken
      ? "Reconnect VedaSuite to Shopify from Settings, then run Sync Data. No automatic action was taken."
      : "Run Sync Data and check the connection status in Settings. No automatic action was taken.",
    subjectKey: "sync_health",
  };
}

// ===========================================================================
// O4. Data coverage — what is limiting the other detectors
// ===========================================================================

export function detectDataCoverage(input: {
  nowIso: string;
  totalProducts: number;
  productsWithUsableCost: number;
  totalOrders: number;
  ordersWithCustomer: number;
  distinctOrderCurrencies: number;
}): OperationalProblem | null {
  const t = OPERATIONAL.coverage;

  // New-store protection: coverage is meaningless before there is data.
  if (input.totalProducts < t.minProducts || input.totalOrders < t.minOrders) return null;

  const costCoverage = input.totalProducts
    ? input.productsWithUsableCost / input.totalProducts
    : 0;
  const linkage = input.totalOrders ? input.ordersWithCustomer / input.totalOrders : 0;

  const gaps: string[] = [];
  if (costCoverage < t.minCostCoverage) {
    gaps.push(
      `only ${(costCoverage * 100).toFixed(0)}% of products have usable cost data`
    );
  }
  if (linkage < t.minCustomerLinkage) {
    gaps.push(`only ${(linkage * 100).toFixed(0)}% of orders are linked to a customer`);
  }
  if (input.distinctOrderCurrencies > 1) {
    gaps.push(
      `orders span ${input.distinctOrderCurrencies} currencies, so per-customer totals cannot be summed`
    );
  }

  if (gaps.length === 0) return null;

  return {
    detector: "data_coverage_low",
    title: "Missing inputs are limiting VedaSuite's analysis",
    what: `Coverage gaps: ${gaps.join("; ")}.`,
    why:
      "These gaps are why some findings show as estimates or cannot be quantified. Filling them " +
      "improves accuracy — they are not themselves a store problem.",
    severity: "low",
    confidence: "high",
    window: windowOf(input.nowIso, OPERATIONAL.refundShift.recentDays),
    evidence: buildAggregateEvidence({
      cost_coverage_ratio: `${(costCoverage * 100).toFixed(0)}%`,
      customer_linkage_ratio: `${(linkage * 100).toFixed(0)}%`,
      order_count: input.totalOrders,
    }),
    impact: notQuantifiable("A data-coverage gap has no monetary value of its own"),
    completeness: {
      level: "complete",
      missingInputs: gaps.length ? ["see reported gaps"] : [],
      note: "Computed from counts of stored rows only.",
    },
    recommendedAction:
      "Add product cost data in the AI Pricing Engine to improve margin accuracy. No automatic action was taken.",
    subjectKey: "data_coverage",
  };
}

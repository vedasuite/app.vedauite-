// PART 2 — Customer Loss Intelligence. PURE deterministic calculation.
//
// No database, network, Shopify or LLM dependency. Every function is a pure
// function of its inputs, testable directly from dist/.
//
// WHAT THIS ANSWERS
// -----------------
// "Across multiple orders, has this customer produced repeated, above-baseline
//  refund losses — and how much of that is OBSERVED versus FUTURE RISK?"
//
// The two are deliberately never mixed:
//   observed   = money already refunded, in a stated window, from stored rows
//   futureRisk = forward exposure, delegated to the EXISTING
//                computeReturnAbuseExposure so there is one definition of
//                excess-over-baseline exposure in the codebase.
//
// DATA THIS USES (all verified present in schema.prisma)
//   Order.totalAmount, Order.currency, Order.refunded, Order.status,
//   Order.createdAt, Order.customerId
//   FraudSignal count per customer (risk signal corroboration only)
//
// DATA VEDASUITE DOES NOT HAVE — never invented, always reported as missing
//   - refund AMOUNT per order (Order.refunded is a boolean), so refunded ORDER
//     VALUE is an UPPER BOUND on true loss, never presented as exact
//   - chargebacks (no field anywhere in the schema)
//   - discount amounts (no field anywhere in the schema)
//   - return/RMA records (distinct from refunds; not modelled)
//   - order line items, so loss cannot be attributed to products
//
// NOTHING HERE CHANGES A CUSTOMER OR THE STORE. It computes and explains only.

import {
  buildAggregateEvidence,
  computeReturnAbuseExposure,
  daysBetween,
  isEligibleStatus,
  round2,
  type AggregateEvidence,
  type Confidence,
  type FinancialImpact,
} from "./explainabilityCalc";

/**
 * Documented thresholds. Deliberately conservative: this detector describes a
 * merchant's customer, so a false positive is expensive in trust terms.
 *
 * `minStoreOrders` mirrors RETURN_ABUSE.minStoreOrders so a store baseline is
 * never computed from too little history.
 */
export const CUSTOMER_LOSS = {
  /** Observation window for OBSERVED loss. Stated in every finding. */
  observedWindowDays: 365,
  /** "Across multiple orders" — a single order can never produce a finding. */
  minEligibleOrders: 3,
  /** Repeated behaviour, not a one-off return. */
  minRefundedOrders: 2,
  /** Store needs enough history before any baseline comparison is meaningful. */
  minStoreOrders: 50,
  /** Refunded share of eligible order value that counts as material. */
  minObservedLossRatio: 0.3,
  /** Absolute floor, so trivial amounts never raise a finding. */
  minObservedLossValue: 1,
} as const;

export interface CustomerLossOrder {
  id: string;
  status: string;
  refunded: boolean;
  totalAmount: number;
  currency: string;
  createdAtIso: string;
}

export interface CustomerLossInput {
  nowIso: string;
  customerOrders: CustomerLossOrder[];
  /** Store-wide eligible order count over the return-abuse lookback. */
  storeEligibleOrderCount: number;
  /** Store-wide refunded eligible count over the same lookback. */
  storeRefundedEligibleCount: number;
  /** Count of stored fraud signals for this customer. Corroboration only. */
  riskSignalCount: number;
}

export interface ObservedLoss {
  windowDays: number;
  /** Exact bounds of the evaluated window, from real order timestamps. */
  firstOrderIso: string;
  lastOrderIso: string;
  eligibleOrders: number;
  refundedOrders: number;
  eligibleOrderValue: number;
  /** Refunded ORDER value — an upper bound, not an exact refund total. */
  refundedOrderValue: number;
  lossRatio: number;
  currency: string;
}

export interface CustomerLossCompleteness {
  /** "complete" is impossible here by construction — see missingInputs. */
  level: "partial" | "insufficient";
  missingInputs: string[];
  note: string;
}

export interface CustomerLossResult {
  /** null when no defensible pattern was found. */
  pattern: "repeated_refund_loss" | null;
  observed: ObservedLoss | null;
  /** Money already lost. Quantified only when the observed pattern holds. */
  observedImpact: FinancialImpact;
  /** Forward exposure. Delegated to the existing return-abuse calculation. */
  futureRisk: FinancialImpact;
  confidence: Confidence;
  completeness: CustomerLossCompleteness;
  evidence: AggregateEvidence[];
  reasons: string[];
  /** Stable per-customer subject for finding deduplication. */
  windowKey: string;
}

/**
 * Inputs the schema simply does not carry. Always surfaced so a merchant is
 * never shown a loss figure that silently pretends to be complete.
 */
const STRUCTURALLY_MISSING = [
  "refund_amount_per_order",
  "chargebacks",
  "discount_amounts",
  "return_records",
  "order_line_items",
] as const;

function notQuantifiable(reason: string): FinancialImpact {
  return { status: "impact_not_quantifiable", reason };
}

function emptyResult(
  reason: string,
  futureRisk: FinancialImpact,
  extraMissing: string[] = []
): CustomerLossResult {
  return {
    pattern: null,
    observed: null,
    observedImpact: notQuantifiable(reason),
    futureRisk,
    confidence: "insufficient_data",
    completeness: {
      level: "insufficient",
      missingInputs: [...extraMissing, ...STRUCTURALLY_MISSING],
      note: reason,
    },
    evidence: [],
    reasons: [reason],
    windowKey: "",
  };
}

/**
 * Confidence is earned, never assumed:
 *   high   — many eligible orders, repeated refunds, corroborating risk signals
 *   medium — the threshold pattern holds
 *   low    — pattern holds but sits close to the minimum bar
 */
function gradeConfidence(observed: ObservedLoss, riskSignalCount: number): Confidence {
  const strongVolume = observed.eligibleOrders >= CUSTOMER_LOSS.minEligibleOrders * 2;
  const strongRepeat = observed.refundedOrders >= CUSTOMER_LOSS.minRefundedOrders + 1;
  if (strongVolume && strongRepeat && riskSignalCount > 0) return "high";
  if (strongVolume || strongRepeat) return "medium";
  return "low";
}

export function computeCustomerLoss(input: CustomerLossInput): CustomerLossResult {
  // Future risk always comes from the ONE existing definition, whatever happens
  // below. Currency is taken from the customer's own orders when consistent.
  const currencies = Array.from(
    new Set(
      input.customerOrders
        .filter((o) => isEligibleStatus(o.status))
        .map((o) => (o.currency || "").trim().toUpperCase())
        .filter(Boolean)
    )
  );
  const singleCurrency = currencies.length === 1 ? currencies[0] : null;

  const futureRisk = computeReturnAbuseExposure({
    nowIso: input.nowIso,
    currency: singleCurrency ?? "USD",
    customerOrders: input.customerOrders.map((o) => ({
      id: o.id,
      status: o.status,
      refunded: o.refunded,
      totalAmount: o.totalAmount,
      createdAtIso: o.createdAtIso,
    })),
    storeEligibleOrderCount: input.storeEligibleOrderCount,
    storeRefundedEligibleCount: input.storeRefundedEligibleCount,
  }).financialImpact;

  // Mixed currencies can never be summed. Refusing is the only honest option.
  if (currencies.length > 1) {
    return emptyResult(
      `Orders span multiple currencies (${currencies.join(", ")}); observed loss cannot be summed`,
      futureRisk,
      ["single_order_currency"]
    );
  }
  if (!singleCurrency) {
    return emptyResult("No eligible orders with a currency", futureRisk, ["order_currency"]);
  }

  // Only completed orders inside the observation window, de-duplicated by id so
  // a repeated row can never inflate the loss.
  const seen = new Set<string>();
  const windowOrders = input.customerOrders.filter((o) => {
    if (!isEligibleStatus(o.status)) return false;
    if (daysBetween(input.nowIso, o.createdAtIso) > CUSTOMER_LOSS.observedWindowDays) return false;
    if (!Number.isFinite(o.totalAmount) || o.totalAmount < 0) return false;
    if (seen.has(o.id)) return false;
    seen.add(o.id);
    return true;
  });

  if (windowOrders.length < CUSTOMER_LOSS.minEligibleOrders) {
    return emptyResult(
      `Fewer than ${CUSTOMER_LOSS.minEligibleOrders} eligible orders in the last ${CUSTOMER_LOSS.observedWindowDays} days`,
      futureRisk
    );
  }
  if (input.storeEligibleOrderCount < CUSTOMER_LOSS.minStoreOrders) {
    return emptyResult(
      `Store has fewer than ${CUSTOMER_LOSS.minStoreOrders} eligible orders, so no baseline is defensible`,
      futureRisk
    );
  }

  const refundedOrders = windowOrders.filter((o) => o.refunded);
  if (refundedOrders.length < CUSTOMER_LOSS.minRefundedOrders) {
    return emptyResult(
      `Fewer than ${CUSTOMER_LOSS.minRefundedOrders} refunded orders — not a repeated pattern`,
      futureRisk
    );
  }

  const eligibleOrderValue = round2(windowOrders.reduce((s, o) => s + o.totalAmount, 0));
  const refundedOrderValue = round2(refundedOrders.reduce((s, o) => s + o.totalAmount, 0));

  if (eligibleOrderValue <= 0) {
    return emptyResult("No eligible order value in the observation window", futureRisk);
  }

  const lossRatio = round2(refundedOrderValue / eligibleOrderValue);
  const timestamps = windowOrders
    .map((o) => new Date(o.createdAtIso).getTime())
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b);

  const observed: ObservedLoss = {
    windowDays: CUSTOMER_LOSS.observedWindowDays,
    firstOrderIso: new Date(timestamps[0]).toISOString(),
    lastOrderIso: new Date(timestamps[timestamps.length - 1]).toISOString(),
    eligibleOrders: windowOrders.length,
    refundedOrders: refundedOrders.length,
    eligibleOrderValue,
    refundedOrderValue,
    lossRatio,
    currency: singleCurrency,
  };

  const materialRatio = lossRatio >= CUSTOMER_LOSS.minObservedLossRatio;
  const materialValue = refundedOrderValue >= CUSTOMER_LOSS.minObservedLossValue;

  if (!materialRatio || !materialValue) {
    return {
      pattern: null,
      observed,
      observedImpact: notQuantifiable(
        !materialRatio
          ? `Refunded share ${(lossRatio * 100).toFixed(1)}% is below the ${(
              CUSTOMER_LOSS.minObservedLossRatio * 100
            ).toFixed(0)}% threshold`
          : "Refunded value below the materiality floor"
      ),
      futureRisk,
      confidence: "insufficient_data",
      completeness: {
        level: "partial",
        missingInputs: [...STRUCTURALLY_MISSING],
        note: "Observed values computed, but the pattern did not meet the reporting thresholds.",
      },
      evidence: [],
      reasons: ["Refund behaviour did not meet the observed-loss thresholds."],
      windowKey: "",
    };
  }

  const confidence = gradeConfidence(observed, input.riskSignalCount);

  const evidence = buildAggregateEvidence({
    order_count: observed.eligibleOrders,
    refund_count: observed.refundedOrders,
    observed_window_days: observed.windowDays,
    observed_loss_ratio: `${(lossRatio * 100).toFixed(1)}%`,
    observed_loss_value: `${refundedOrderValue} ${singleCurrency}`,
    eligible_order_value: `${eligibleOrderValue} ${singleCurrency}`,
    risk_signal_count: input.riskSignalCount,
  });

  return {
    pattern: "repeated_refund_loss",
    observed,
    observedImpact: {
      status: "quantified",
      // A range, not a point: the true refund total lies at or below the
      // refunded order value because per-order refund amounts are not stored.
      min: 0,
      max: refundedOrderValue,
      currency: singleCurrency,
      period: "current_open_exposure",
      basis:
        "Sum of the ORDER value of refunded completed orders in the stated window. " +
        "An upper bound, not an exact refund total, because per-order refund amounts are not stored. " +
        "Chargebacks and discounts are not included — VedaSuite does not store them.",
      isEstimate: true,
    },
    futureRisk,
    confidence,
    completeness: {
      level: "partial",
      missingInputs: [...STRUCTURALLY_MISSING],
      note:
        "Observed loss is bounded above by refunded order value. Exact refund amounts, " +
        "chargebacks, discounts and return records are not available in VedaSuite's data.",
    },
    evidence,
    reasons: [
      `${observed.refundedOrders} of ${observed.eligibleOrders} completed orders were refunded ` +
        `between ${observed.firstOrderIso.slice(0, 10)} and ${observed.lastOrderIso.slice(0, 10)}.`,
      `Refunded orders account for ${(lossRatio * 100).toFixed(1)}% of this customer's ` +
        `${eligibleOrderValue} ${singleCurrency} eligible order value.`,
      "Observed loss is money already refunded; future risk is reported separately and is not added to it.",
    ],
    windowKey: `${observed.firstOrderIso.slice(0, 10)}_${observed.lastOrderIso.slice(0, 10)}`,
  };
}

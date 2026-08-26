// Turning discrepancies into Action Center findings.
//
// PURE. No database.
//
// RECONCILIATION IS NOT A SEPARATE DASHBOARD. Its output flows into the same
// IntelligenceFinding lifecycle every other VedaSuite detector uses — the same
// statuses, the same fingerprint-based deduplication, the same healing
// behaviour. This module only decides WHAT to say and under WHICH fingerprint;
// recordFinding and closeHealedFindings do the rest, unchanged.
//
// GROUPED, NOT SPAMMED
// --------------------
// Seven mismatched SKUs is ONE thing a merchant needs to look at, not seven
// notifications. So each (check type, discrepancy kind) produces a single
// grouped finding whose fingerprint is stable across runs, and the individual
// rows travel inside it as evidence. That is also what makes Scenario 4 work:
// re-running the same unresolved discrepancy reconfirms one finding rather than
// minting a second.

import type {
  Certainty,
  Discrepancy,
  DiscrepancyEvidence,
} from "./reconciliationModel";
import { CHECK_TYPE_LABEL, type CheckType } from "./reconciliationModel";
import type { Urgency, Confidence, FinancialImpact } from "./explainabilityCalc";

/** The module value written to IntelligenceFinding.module. */
export const RECONCILIATION_MODULE = "reconciliation";

/** Prefix for every reconciliation finding type. */
export const RECONCILIATION_FINDING_PREFIX = "reconciliation_";

/** Most discrepancies of one kind listed individually inside a finding. */
export const MAX_EVIDENCE_ROWS = 8;

export interface ReconciliationFinding {
  /** Stable across runs. Feeds computeFindingFingerprint as the subjectKey. */
  subjectKey: string;
  findingType: string;
  title: string;
  /** WHAT HAPPENED and WHY IT MATTERS, in that order. */
  reasons: string[];
  evidence: DiscrepancyEvidence[];
  financialImpact: FinancialImpact;
  confidence: Confidence;
  urgency: Urgency;
  recommendedAction: string;
  certainty: Certainty;
  /** Discrepancies this finding covers, for persisting the back-reference. */
  discrepancies: Discrepancy[];
}

/**
 * Merchant-facing wording per discrepancy kind.
 *
 * `headline` takes the count. `why` explains why it matters WITHOUT asserting a
 * cause — "units you can sell may not exist" is a consequence the merchant can
 * verify; "the warehouse lost them" is a theory.
 */
const KIND_COPY: Record<
  string,
  { headline: (count: number) => string; why: string; action: string; urgency: Urgency }
> = {
  inventory_quantity_mismatch: {
    headline: (count) =>
      `${count} ${count === 1 ? "SKU has" : "SKUs have"} inventory mismatches between Shopify and your uploaded file`,
    why: "Where Shopify shows more than your warehouse file, you may be selling stock that is not there. Where it shows less, stock you are holding is not available to sell.",
    action:
      "Open each SKU below and compare it against your warehouse system. VedaSuite has not changed anything in Shopify.",
    urgency: "high",
  },
  inventory_missing_externally: {
    headline: (count) =>
      `${count} Shopify ${count === 1 ? "SKU does" : "SKUs do"} not appear in your uploaded file`,
    why: "These products exist in Shopify but the file does not mention them, so their stock level is unconfirmed. That can be normal if they are stored elsewhere or excluded from the export.",
    action: "Check whether these SKUs should have been included in the export.",
    urgency: "medium",
  },
  inventory_external_only: {
    headline: (count) =>
      `${count} ${count === 1 ? "SKU in your file has" : "SKUs in your file have"} no matching Shopify product`,
    why: "Stock is being held for products Shopify does not know about under that SKU, so it cannot be sold through your store.",
    action: "Check whether the SKU differs between the two systems, or the product is missing from Shopify.",
    urgency: "medium",
  },
  inventory_duplicate_row: {
    headline: (count) =>
      `${count} ${count === 1 ? "SKU appears" : "SKUs appear"} on more than one row of your file`,
    why: "Repeated rows are normal for multi-location exports and a data problem otherwise. VedaSuite added them together, which is wrong if they are duplicates.",
    action: "Confirm whether these rows are separate locations or repeated lines.",
    urgency: "low",
  },
  inventory_location_mismatch: {
    headline: (count) =>
      `${count} ${count === 1 ? "SKU is" : "SKUs are"} split across multiple locations in your file`,
    why: "VedaSuite added the locations together because Shopify does not tell it which location holds which units. If you track stock per location, the split cannot be verified here.",
    action: "Review the per-location split in your warehouse system.",
    urgency: "low",
  },
  inventory_negative_quantity: {
    headline: (count) =>
      `${count} ${count === 1 ? "row reports" : "rows report"} a negative quantity`,
    why: "A negative stock figure usually means the source system recorded an oversell or an unbalanced adjustment.",
    action: "Check these rows in the system that produced the file.",
    urgency: "medium",
  },
  inventory_untracked_in_shopify: {
    headline: (count) =>
      `${count} ${count === 1 ? "SKU cannot" : "SKUs cannot"} be compared because Shopify does not track their inventory`,
    why: "Your file reports stock for these products, but inventory tracking is off for them in Shopify, so there is no Shopify figure to compare against.",
    action: "Turn on inventory tracking in Shopify for these variants if you want them reconciled.",
    urgency: "low",
  },
  invoice_unmatched_charge: {
    headline: (count) =>
      `${count} ${count === 1 ? "charge does" : "charges do"} not match any Shopify order`,
    why: "You are being billed against references VedaSuite cannot find in your synced orders. That may be a formatting difference, an older order, or a charge that should not be there.",
    action:
      "Check these references against your 3PL portal. VedaSuite is not claiming the amounts are wrong, only that it cannot match them.",
    urgency: "high",
  },
  invoice_duplicate_charge: {
    headline: (count) =>
      `${count} ${count === 1 ? "order carries" : "orders carry"} more than one charge in this invoice`,
    why: "Some contracts bill one order across several lines, so this is not automatically wrong — but a repeated identical amount is worth checking.",
    action: "Compare these lines against your rate agreement.",
    urgency: "medium",
  },
  invoice_cancelled_order_charge: {
    headline: (count) =>
      `${count} cancelled ${count === 1 ? "order was" : "orders were"} charged in this invoice`,
    why: "Shopify records these orders as cancelled, yet the invoice bills for them.",
    action: "Ask your 3PL whether these shipments went out before the cancellation.",
    urgency: "high",
  },
  invoice_refunded_order_charge: {
    headline: (count) =>
      `${count} refunded ${count === 1 ? "order appears" : "orders appear"} in this invoice`,
    why: "A refunded order may still have shipped, so a charge can be legitimate. It is listed so you can decide.",
    action: "Check whether these orders shipped before they were refunded.",
    urgency: "medium",
  },
  invoice_amount_difference: {
    headline: (count) =>
      `${count} ${count === 1 ? "charge differs" : "charges differ"} from the reference rates you supplied`,
    why: "The billed amount and the expected rate in your own file do not agree.",
    action: "Raise these lines with your 3PL against your rate card.",
    urgency: "high",
  },
  invoice_unverified_charge: {
    headline: (count) => `${count} ${count === 1 ? "charge is" : "charges are"} unverified`,
    why: "VedaSuite has no contracted rate for these lines, so it can show them to you but cannot check the amounts.",
    action: "Add an expected rate column to your file to have these amounts checked.",
    urgency: "low",
  },
  supplier_quantity_shortfall: {
    headline: (count) =>
      `${count} shipment ${count === 1 ? "line is" : "lines are"} short against what was expected`,
    why: "Fewer units were recorded as received than were expected, so you may have paid for stock that has not arrived.",
    action: "Compare these lines against the supplier's paperwork before paying the invoice.",
    urgency: "high",
  },
  supplier_partial_shipment: {
    headline: (count) =>
      `${count} shipment ${count === 1 ? "line arrived" : "lines arrived"} only partially`,
    why: "Part of the expected quantity arrived. The remainder is either still in transit or was never sent.",
    action: "Confirm with the supplier whether the balance is still coming.",
    urgency: "medium",
  },
  supplier_quantity_overage: {
    headline: (count) =>
      `${count} shipment ${count === 1 ? "line arrived" : "lines arrived"} with more units than expected`,
    why: "More units arrived than the file expected. That is not a loss, but it will put your stock figures out.",
    action: "Update your receiving records so inventory stays accurate.",
    urgency: "low",
  },
  supplier_unexpected_sku: {
    headline: (count) =>
      `${count} ${count === 1 ? "SKU in this shipment has" : "SKUs in this shipment have"} no matching Shopify product`,
    why: "Stock arrived for products Shopify does not carry under that SKU, so it cannot be sold through your store.",
    action: "Check whether the SKU differs between systems or the product is missing from Shopify.",
    urgency: "medium",
  },
  supplier_missing_sku: {
    headline: (count) => `${count} shipment ${count === 1 ? "row has" : "rows have"} no SKU`,
    why: "Rows without an identifier cannot be matched to a product, so nothing about them can be checked.",
    action: "Ask your supplier to include a SKU column, or map the correct column and re-run.",
    urgency: "low",
  },
  supplier_duplicate_line: {
    headline: (count) =>
      `${count} shipment ${count === 1 ? "line looks" : "lines look"} repeated`,
    why: "The same SKU, tracking reference and quantity appear on more than one row, which may mean a line was entered twice.",
    action: "Confirm which of the repeated rows is the real one.",
    urgency: "low",
  },
  supplier_missing_tracking: {
    headline: (count) =>
      `${count} shipment ${count === 1 ? "line has" : "lines have"} no tracking reference`,
    why: "Other rows in the same file carry tracking, so these look incomplete rather than simply untracked.",
    action: "Ask the supplier for the missing tracking references.",
    urgency: "low",
  },
};

function copyFor(kind: string) {
  return (
    KIND_COPY[kind] ?? {
      headline: (count: number) => `${count} discrepancies of type ${kind}`,
      why: "VedaSuite found a difference between your Shopify data and the uploaded file.",
      action: "Review the rows listed below.",
      urgency: "medium" as Urgency,
    }
  );
}

/**
 * The certainty of a group is the WEAKEST of its members.
 *
 * A group containing one confirmed and six possible discrepancies is a possible
 * finding, not a confirmed one: the headline speaks for all seven.
 */
export function groupCertainty(discrepancies: Discrepancy[]): Certainty {
  if (discrepancies.some((item) => item.certainty === "insufficient_data")) {
    return "insufficient_data";
  }
  if (discrepancies.some((item) => item.certainty === "possible")) return "possible";
  return "confirmed";
}

/** Maps certainty onto the existing Confidence vocabulary. */
export function certaintyToConfidence(certainty: Certainty): Confidence {
  switch (certainty) {
    case "confirmed":
      return "high";
    case "possible":
      return "medium";
    case "insufficient_data":
      return "insufficient_data";
  }
}

/**
 * Totals the money a group can defend.
 *
 * ONLY quantified members contribute, and the basis says how many of the group
 * they were. A group of 12 discrepancies where 3 carry a cost produces a figure
 * covering 3 of them and says so — presenting it as the value of all 12 would
 * be the exact inflation this engine exists to avoid.
 */
export function sumImpact(discrepancies: Discrepancy[]): FinancialImpact {
  const quantified = discrepancies.filter(
    (item): item is Discrepancy & { impact: { status: "quantified"; amount: number; currency: string; basis: string } } =>
      item.impact.status === "quantified"
  );
  if (quantified.length === 0) {
    return {
      status: "impact_not_quantifiable",
      reason:
        discrepancies[0]?.impact.status === "not_quantified"
          ? discrepancies[0].impact.reason
          : "VedaSuite has no defensible cost or reference rate for these rows, so it does not put a value on them.",
    };
  }

  const currencies = Array.from(new Set(quantified.map((item) => item.impact.currency)));
  if (currencies.length > 1) {
    return {
      status: "impact_not_quantifiable",
      reason: `These rows are in ${currencies.length} different currencies (${currencies.join(
        ", "
      )}), so VedaSuite does not add them into a single figure.`,
    };
  }

  const total = quantified.reduce((sum, item) => sum + Math.abs(item.impact.amount), 0);
  return {
    status: "quantified",
    min: Math.round(total * 100) / 100,
    max: Math.round(total * 100) / 100,
    currency: currencies[0],
    period: "current_open_exposure",
    basis:
      quantified.length === discrepancies.length
        ? `Sum of the differences on all ${discrepancies.length} rows, using values supplied in your own data.`
        : `Sum of ${quantified.length} of ${discrepancies.length} rows — the others have no recorded cost or reference rate, so they are not included.`,
    isEstimate: true,
  };
}

/**
 * Builds one finding per (check type, discrepancy kind).
 *
 * The subjectKey deliberately contains NO count, amount or timestamp. Including
 * any of them would mint a new fingerprint whenever the numbers moved, which is
 * precisely the duplicate-spam this grouping exists to prevent.
 */
export function buildReconciliationFindings(input: {
  checkType: CheckType;
  discrepancies: Discrepancy[];
}): ReconciliationFinding[] {
  const byKind = new Map<string, Discrepancy[]>();
  for (const discrepancy of input.discrepancies) {
    const bucket = byKind.get(discrepancy.kind);
    if (bucket) bucket.push(discrepancy);
    else byKind.set(discrepancy.kind, [discrepancy]);
  }

  const findings: ReconciliationFinding[] = [];

  for (const [kind, group] of byKind) {
    const copy = copyFor(kind);
    const certainty = groupCertainty(group);
    const impact = sumImpact(group);

    // Ordered so the merchant sees the largest differences first.
    const ordered = [...group].sort(
      (a, b) => Math.abs(b.difference ?? 0) - Math.abs(a.difference ?? 0)
    );
    const shown = ordered.slice(0, MAX_EVIDENCE_ROWS);

    const evidence: DiscrepancyEvidence[] = [
      { label: "Check", value: CHECK_TYPE_LABEL[input.checkType] },
      { label: "Rows affected", value: String(group.length) },
      {
        label: "Certainty",
        value:
          certainty === "confirmed"
            ? "Confirmed — both sides state a value and they differ"
            : certainty === "possible"
            ? "Possible — the rows were matched, but not with full confidence"
            : "Insufficient data — one side has nothing to compare",
      },
      ...shown.map((item) => ({
        label: item.subjectKey,
        value: item.summary,
      })),
    ];

    if (ordered.length > shown.length) {
      evidence.push({
        label: "Not listed here",
        value: `${ordered.length - shown.length} further rows of the same kind. Open the Reconciliation workspace to see all of them.`,
      });
    }

    findings.push({
      subjectKey: `${input.checkType}:${kind}`,
      findingType: `${RECONCILIATION_FINDING_PREFIX}${kind}`,
      title: copy.headline(group.length),
      reasons: [
        copy.headline(group.length) + ".",
        copy.why,
        ...(certainty !== "confirmed"
          ? [
              certainty === "possible"
                ? "VedaSuite matched these rows but could not do so with full confidence, so treat this as something to check rather than something proven."
                : "VedaSuite could not compare one side of these rows, so this is reported as missing information rather than as a difference.",
            ]
          : []),
      ],
      evidence,
      financialImpact: impact,
      confidence: certaintyToConfidence(certainty),
      urgency: certainty === "insufficient_data" ? "low" : copy.urgency,
      recommendedAction: copy.action,
      certainty,
      discrepancies: group,
    });
  }

  // Most consequential first: confirmed before possible, then by size.
  return findings.sort((a, b) => {
    const rank = (certainty: Certainty) =>
      certainty === "confirmed" ? 3 : certainty === "possible" ? 2 : 1;
    const byCertainty = rank(b.certainty) - rank(a.certainty);
    if (byCertainty !== 0) return byCertainty;
    return b.discrepancies.length - a.discrepancies.length;
  });
}

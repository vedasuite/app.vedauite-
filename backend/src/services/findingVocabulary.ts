// SIGNAL, FINDING, REVIEW ITEM — and why they are three different things.
//
// PURE. Definitions and the merchant-facing words for them.
//
// THE CONTRADICTION THIS RESOLVES
// -------------------------------
// Customer Loss showed, on one screen:
//
//   "No open findings for this module"
//   "Actions that need attention now — 4 open"
//
// Both were TRUE, and the page was still incoherent. The four were individual
// orders carrying risk signals; the zero was IntelligenceFindings. A single
// risky order is deliberately NOT a finding — CUSTOMER_LOSS requires repeated
// behaviour across multiple orders before it will claim a pattern — so the
// detector was behaving correctly and the vocabulary was not.
//
// Calling both "things that need attention" while Action Center said nothing
// needed attention is the error. Action Center is the authoritative prioritised
// FINDING layer; it must never be contradicted by a page counting something
// else under the same word.

/**
 * The three levels, from rawest to most qualified.
 *
 * SIGNAL      A detector observed something. One risky order, one refund, one
 *             competitor price move. Not shown as a conclusion on its own.
 *
 * REVIEW ITEM A specific record — an order, a product — a merchant may want to
 *             look at. Visible in its workspace, countable, actionable by hand.
 *             It is NOT promoted to Action Center, because one record is not a
 *             pattern and Action Center is not a work queue.
 *
 * FINDING     An evidence-qualified issue that crossed its detector's
 *             threshold, carries its evidence, and is persisted as an
 *             IntelligenceFinding. ONLY findings appear in Action Center.
 */
export const EVIDENCE_LEVELS = ["signal", "review_item", "finding"] as const;
export type EvidenceLevel = (typeof EVIDENCE_LEVELS)[number];

/** Merchant-facing noun for each level. Singular and plural. */
export const EVIDENCE_LABEL: Record<
  EvidenceLevel,
  { one: string; many: string; heading: string }
> = {
  signal: {
    one: "signal",
    many: "signals",
    heading: "Signals detected",
  },
  review_item: {
    one: "order to review",
    many: "orders to review",
    heading: "Orders to review",
  },
  finding: {
    one: "finding",
    many: "findings",
    heading: "Open findings",
  },
};

/** Only findings reach Action Center. Stated as code so it is testable. */
export function appearsInActionCenter(level: EvidenceLevel): boolean {
  return level === "finding";
}

/**
 * The sentence that keeps the two counts from contradicting each other.
 *
 * Shown wherever review items are counted, so a merchant reading "4 orders to
 * review" and "0 open findings" understands they are different questions
 * rather than a bug.
 */
export function explainReviewItemsVersusFindings(input: {
  reviewItems: number;
  findings: number;
  /** e.g. "repeated refund behaviour across multiple orders" */
  findingThresholdDescription: string;
}): string {
  if (input.reviewItems === 0 && input.findings === 0) {
    return "No orders need review, and no findings have been raised.";
  }
  if (input.reviewItems > 0 && input.findings === 0) {
    return (
      `These ${input.reviewItems} ${
        input.reviewItems === 1 ? "order is" : "orders are"
      } worth a look, but none of them add up to a finding yet. ` +
      `VedaSuite raises a finding — and puts it in your Action Center — when it can show ${input.findingThresholdDescription}. ` +
      "That is why Action Center is empty while this list is not."
    );
  }
  if (input.reviewItems === 0 && input.findings > 0) {
    return `No individual order needs a decision right now, but ${input.findings} ${
      input.findings === 1 ? "finding is" : "findings are"
    } open in your Action Center.`;
  }
  return `${input.reviewItems} ${
    input.reviewItems === 1 ? "order needs" : "orders need"
  } a look, and ${input.findings} ${
    input.findings === 1 ? "finding is" : "findings are"
  } open in your Action Center. They are counted separately: a finding is a pattern, an order is one record.`;
}

/** What Customer Loss requires before a signal becomes a finding. */
export const CUSTOMER_LOSS_THRESHOLD_DESCRIPTION =
  "repeated refund or return behaviour across several of the same customer's orders";

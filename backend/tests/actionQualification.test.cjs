const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

/**
 * PHASE E — Action Center is a prioritized ACTION layer, not a raw event feed.
 *
 * The failure this prevents: a store with hundreds of refund-abusing customers
 * producing hundreds of findings, burying the operational and profit findings
 * that actually need a decision.
 *
 * Volume is bounded by AGGREGATION, never by discarding qualifying evidence or
 * by raising a confidence bar to thin the list.
 */

const q = require(path.resolve(__dirname, "../dist/services/actionQualification.js"));

const many = (n, value = 100) =>
  Array.from({ length: n }, (_, i) => ({ id: `c-${String(i).padStart(4, "0")}`, rankValue: value - i }));

// ===========================================================================
// Flood protection — the headline requirement
// ===========================================================================

test("FLOOD: 500 qualifying customers cannot become 500 findings", () => {
  const split = q.splitForActionCenter("customer_loss", many(500));
  const limit = q.INDIVIDUAL_FINDING_LIMIT.customer_loss;

  assert.equal(split.individual.length, limit, "only the limit is surfaced individually");
  assert.equal(split.aggregated.length, 500 - limit);
  assert.equal(split.needsAggregate, true, "the rest become ONE summary finding");

  // Total findings raised = limit + 1 summary, regardless of store size.
  assert.equal(split.individual.length + 1, limit + 1);
});

test("FLOOD: the bound holds at every scale", () => {
  for (const n of [10, 100, 1000, 5000]) {
    const split = q.splitForActionCenter("customer_loss", many(n));
    const findings = split.individual.length + (split.needsAggregate ? 1 : 0);
    assert.ok(
      findings <= q.INDIVIDUAL_FINDING_LIMIT.customer_loss + 1,
      `${n} qualifying items produced ${findings} findings`
    );
  }
});

test("FLOOD: every family is bounded, so the whole feed stays readable", () => {
  const families = ["operational", "customer_loss", "product_profit", "pricing", "competitor"];
  let worstCase = 0;
  for (const family of families) {
    const split = q.splitForActionCenter(family, many(1000));
    worstCase += split.individual.length + (split.needsAggregate ? 1 : 0);
  }
  assert.ok(worstCase <= 40, `worst-case feed size across all families was ${worstCase}`);
});

test("NOTHING IS DISCARDED: aggregated items are retained, not dropped", () => {
  const split = q.splitForActionCenter("customer_loss", many(500));
  assert.equal(
    split.individual.length + split.aggregated.length,
    500,
    "every qualifying item is accounted for"
  );
});

// ===========================================================================
// Determinism — fingerprints depend on this
// ===========================================================================

test("DETERMINISM: the same input always produces the same split", () => {
  const input = many(50);
  const a = q.splitForActionCenter("customer_loss", input);
  const b = q.splitForActionCenter("customer_loss", [...input].reverse());
  assert.deepEqual(
    a.individual.map((i) => i.id),
    b.individual.map((i) => i.id),
    "input order must not change which items are surfaced"
  );
});

test("DETERMINISM: highest impact first, ties broken by id", () => {
  const split = q.splitForActionCenter("customer_loss", [
    { id: "b", rankValue: 10 },
    { id: "a", rankValue: 10 },
    { id: "c", rankValue: 99 },
  ]);
  assert.deepEqual(split.individual.map((i) => i.id), ["c", "a", "b"]);
});

test("DETERMINISM: items with no monetary rank sort last but are not dropped", () => {
  const split = q.splitForActionCenter("customer_loss", [
    { id: "unranked", rankValue: null },
    { id: "ranked", rankValue: 5 },
  ]);
  assert.deepEqual(split.individual.map((i) => i.id), ["ranked", "unranked"]);
});

test("SINGLE LEFTOVER: one extra item is surfaced, not summarised", () => {
  const limit = q.INDIVIDUAL_FINDING_LIMIT.customer_loss;
  const split = q.splitForActionCenter("customer_loss", many(limit + 1));
  assert.equal(split.needsAggregate, false, "a group of one is not worth a summary");
});

// ===========================================================================
// Qualification is evidence-derived, not a volume filter
// ===========================================================================

test("QUALIFICATION: a low-confidence real pattern still qualifies", () => {
  // Raising the bar to high/medium would be an arbitrary threshold used to
  // control volume. Aggregation controls volume instead.
  assert.equal(
    q.qualifiesAsCustomerLossAction({ hasPattern: true, confidence: "low", observedLoss: null }),
    true
  );
});

test("QUALIFICATION: genuinely absent evidence does not qualify", () => {
  assert.equal(
    q.qualifiesAsCustomerLossAction({
      hasPattern: true,
      confidence: "insufficient_data",
      observedLoss: null,
    }),
    false
  );
  assert.equal(
    q.qualifiesAsCustomerLossAction({ hasPattern: false, confidence: "high", observedLoss: 999 }),
    false,
    "no pattern means no action, however large the number"
  );
});

test("QUALIFICATION: pricing requires a showable target and a material move", () => {
  // Ties to the same evidence gate the pricing card uses, so the two agree.
  assert.equal(
    q.qualifiesAsPricingAction({ showExactTarget: false, currentPrice: 100, recommendedPrice: 120 }),
    false,
    "if VedaSuite will not show a price, it is not an action"
  );
  assert.equal(
    q.qualifiesAsPricingAction({ showExactTarget: true, currentPrice: 100, recommendedPrice: 100.5 }),
    false,
    "a sub-1% move is noise"
  );
  assert.equal(
    q.qualifiesAsPricingAction({ showExactTarget: true, currentPrice: 100, recommendedPrice: 112 }),
    true
  );
  assert.equal(
    q.qualifiesAsPricingAction({ showExactTarget: true, currentPrice: 0, recommendedPrice: 10 }),
    false,
    "a zero price cannot yield a percentage"
  );
});

test("QUALIFICATION: competitor requires OBSERVED prices and current evidence", () => {
  const base = { competitorPrice: 90, ourPrice: 100, evidenceIsCurrent: true };
  assert.equal(q.qualifiesAsCompetitorAction(base), true);
  assert.equal(
    q.qualifiesAsCompetitorAction({ ...base, evidenceIsCurrent: false }),
    false,
    "stale competitor data is not an action"
  );
  assert.equal(
    q.qualifiesAsCompetitorAction({ ...base, competitorPrice: null }),
    false,
    "a competitor row without a price is workspace evidence, not an action"
  );
  assert.equal(
    q.qualifiesAsCompetitorAction({ ...base, competitorPrice: 100.5 }),
    false,
    "a sub-1% gap is noise"
  );
});

test("CONSISTENCY: pricing and competitor use the same materiality band", () => {
  // If they diverged, the same product could be 'material' on one screen and
  // not the other.
  assert.equal(
    q.qualifiesAsPricingAction({ showExactTarget: true, currentPrice: 100, recommendedPrice: 101 }),
    q.qualifiesAsCompetitorAction({ competitorPrice: 101, ourPrice: 100, evidenceIsCurrent: true })
  );
});

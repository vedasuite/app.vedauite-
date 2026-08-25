const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

/**
 * PHASE F — the Dashboard may not contradict the Action Center.
 *
 * Before this phase the two pages computed independently:
 *
 *   Dashboard KPI      <- module overview services (no lifecycle at all)
 *   Dashboard insights <- raw TimelineEvent rows (never retracted)
 *   Action Center      <- IntelligenceFinding (full lifecycle)
 *
 * So a merchant could resolve a finding, watch Action Center drop to zero, and
 * still see it counted and described on the Dashboard. These tests hold the
 * projection property: given the same cards, the Dashboard shows a strict
 * subset of what Action Center shows, and never a number Action Center cannot
 * defend.
 */

const calc = require(
  path.resolve(__dirname, "../dist/services/dashboardFindingsCalc.js")
);

function card(over = {}) {
  return {
    id: over.id ?? "f1",
    module: over.module ?? "pricing",
    status: over.status ?? "new",
    severity: over.severity ?? "medium",
    title: over.title ?? "A pricing finding",
    whatHappened: over.whatHappened ?? "Something measurable happened.",
    recommendedAction: over.recommendedAction ?? "Review it.",
    route: over.route ?? "/app/ai-pricing-engine",
    lastSeenAt: over.lastSeenAt ?? "2026-08-25T10:00:00.000Z",
    rank: { score: over.score ?? 50 },
  };
}

const OPEN = { persistenceEnabled: true };

// ===========================================================================
// Lifecycle: the defect this phase exists to remove
// ===========================================================================

test("REGRESSION: a resolved finding is not counted on the Dashboard", () => {
  const view = calc.buildDashboardFindingsView({
    cards: [
      card({ id: "a", module: "pricing", status: "resolved" }),
      card({ id: "b", module: "pricing", status: "dismissed" }),
    ],
    ...OPEN,
  });

  assert.equal(view.kpis.pricingOpportunities, 0);
  assert.equal(view.totalOpen, 0);
  assert.equal(view.recentInsights.length, 0);
  assert.match(view.attentionTitle, /Nothing needs your attention/i);
});

test("REGRESSION: a resolved finding is not described on the Dashboard either", () => {
  // The old path read TimelineEvents, which have no lifecycle, so a resolved
  // problem stayed in "Recent insights" permanently. The insight list is now
  // built from the same open cards as the counts, so it cannot outlive them.
  const view = calc.buildDashboardFindingsView({
    cards: [
      card({ id: "a", status: "resolved", title: "Shopify sync is unreliable" }),
      card({ id: "b", status: "new", title: "A real open finding" }),
    ],
    ...OPEN,
  });

  const titles = view.recentInsights.map((i) => i.title);
  assert.deepEqual(titles, ["A real open finding"]);
});

test("every open status counts, and only those", () => {
  for (const status of ["new", "seen", "in_review"]) {
    const view = calc.buildDashboardFindingsView({
      cards: [card({ status })],
      ...OPEN,
    });
    assert.equal(view.totalOpen, 1, `${status} must count as open`);
  }
  for (const status of ["resolved", "dismissed"]) {
    const view = calc.buildDashboardFindingsView({
      cards: [card({ status })],
      ...OPEN,
    });
    assert.equal(view.totalOpen, 0, `${status} must not count as open`);
  }
});

// ===========================================================================
// The tiles must add up to the total
// ===========================================================================

test("INVARIANT: tile counts never exceed the open total", () => {
  const view = calc.buildDashboardFindingsView({
    cards: [
      card({ id: "1", module: "fraud" }),
      card({ id: "2", module: "trust" }),
      card({ id: "3", module: "return_abuse" }),
      card({ id: "4", module: "competitor" }),
      card({ id: "5", module: "pricing" }),
      card({ id: "6", module: "profit" }),
      card({ id: "7", module: "operational" }),
    ],
    ...OPEN,
  });

  assert.equal(view.totalOpen, 7);
  // All three fraud-family modules land on one tile — that mapping is the
  // reason the tile total can be smaller than the sum of modules.
  assert.equal(view.kpis.fraudAlerts, 3);
  assert.equal(view.kpis.competitorChanges, 1);
  assert.equal(view.kpis.pricingOpportunities, 1);
  assert.equal(view.kpis.profitOpportunities, 1);
  assert.equal(view.kpis.storeHealth, 1);

  const tileSum = Object.values(view.kpis).reduce((a, b) => a + b, 0);
  assert.equal(tileSum, view.totalOpen);
});

test("INVARIANT: severity counts sum to the open total", () => {
  const view = calc.buildDashboardFindingsView({
    cards: [
      card({ id: "1", severity: "critical" }),
      card({ id: "2", severity: "high" }),
      card({ id: "3", severity: "medium" }),
      card({ id: "4", severity: "low", status: "resolved" }),
    ],
    ...OPEN,
  });

  const sum = Object.values(view.bySeverity).reduce((a, b) => a + b, 0);
  assert.equal(sum, view.totalOpen);
  assert.equal(sum, 3, "the resolved card must be excluded");
});

test("an unmapped module still counts in the total rather than vanishing", () => {
  // A future detector could emit a module with no tile. Dropping it entirely
  // would make the tiles and the headline disagree — the exact contradiction
  // this phase removes — so it counts in the total and severity breakdown.
  const view = calc.buildDashboardFindingsView({
    cards: [card({ module: "some_future_family" })],
    ...OPEN,
  });
  assert.equal(view.totalOpen, 1);
  assert.equal(view.bySeverity.medium, 1);
});

// ===========================================================================
// Store health leads
// ===========================================================================

test("a store health finding is surfaced ahead of the rest", () => {
  // If the connection is broken, advising on pricing first means advising from
  // data VedaSuite has already admitted it could not refresh.
  const view = calc.buildDashboardFindingsView({
    cards: [
      card({ id: "1", module: "operational", severity: "critical" }),
      card({ id: "2", module: "pricing", severity: "high" }),
    ],
    ...OPEN,
  });
  assert.match(view.attentionTitle, /store health/i);
  assert.match(view.attentionDetail, /Resolve these first/i);
});

test("without store health issues, critical/high leads", () => {
  const view = calc.buildDashboardFindingsView({
    cards: [
      card({ id: "1", severity: "critical" }),
      card({ id: "2", severity: "low" }),
    ],
    ...OPEN,
  });
  assert.match(view.attentionTitle, /1 finding needs attention/i);
  assert.match(view.attentionDetail, /Open findings: 2/);
});

test("only low/medium findings are not overstated as urgent", () => {
  const view = calc.buildDashboardFindingsView({
    cards: [card({ id: "1", severity: "low" }), card({ id: "2", severity: "medium" })],
    ...OPEN,
  });
  assert.match(view.attentionTitle, /2 open findings/);
  assert.match(view.attentionDetail, /None are critical or high/i);
});

// ===========================================================================
// Honest unavailability
// ===========================================================================

test("SAFETY: persistence off reports unavailable, never 'zero problems'", () => {
  const view = calc.buildDashboardFindingsView({
    cards: [card({ id: "1" })],
    persistenceEnabled: false,
  });

  assert.equal(view.available, false);
  assert.ok(view.unavailableReason);
  assert.match(view.unavailableReason, /not currently recording findings/i);
  // The counts are zero, but the flag is what the UI renders on, so a zero can
  // never be shown as if it were a measurement.
  assert.equal(view.totalOpen, 0);
  assert.doesNotMatch(view.attentionTitle, /Nothing needs your attention/i);
  assert.doesNotMatch(view.attentionDetail, /no open findings/i);
});

test("an honest zero is stated as a real result, not a loading state", () => {
  const view = calc.buildDashboardFindingsView({ cards: [], ...OPEN });
  assert.equal(view.available, true);
  assert.equal(view.unavailableReason, null);
  assert.match(view.attentionDetail, /real result, not a loading state/i);
});

// ===========================================================================
// The preview is the top of the same list
// ===========================================================================

test("insights are the highest-ranked open findings, in Action Center order", () => {
  const view = calc.buildDashboardFindingsView({
    cards: [
      card({ id: "low", score: 10 }),
      card({ id: "high", score: 90 }),
      card({ id: "mid", score: 50 }),
    ],
    ...OPEN,
  });
  assert.deepEqual(view.recentInsights.map((i) => i.id), ["high", "mid", "low"]);
});

test("the preview is capped and never claims to be the whole list", () => {
  const cards = Array.from({ length: 12 }, (_, i) =>
    card({ id: `f${i}`, score: 100 - i })
  );
  const view = calc.buildDashboardFindingsView({ cards, ...OPEN });
  assert.equal(view.recentInsights.length, calc.MAX_DASHBOARD_INSIGHTS);
  // The total still reports every open finding, so the capped preview cannot be
  // mistaken for the complete count.
  assert.equal(view.totalOpen, 12);
});

test("SAFETY: an insight repeats the card's own words, never a new claim", () => {
  const view = calc.buildDashboardFindingsView({
    cards: [
      card({
        title: "Verified title",
        whatHappened: "Verified explanation.",
        route: "/app/action-center",
      }),
    ],
    ...OPEN,
  });
  const insight = view.recentInsights[0];
  assert.equal(insight.title, "Verified title");
  assert.equal(insight.detail, "Verified explanation.");
  assert.equal(insight.route, "/app/action-center");
  assert.equal(insight.createdAt, "2026-08-25T10:00:00.000Z");
});

test("ordering is deterministic when ranks tie", () => {
  const build = () =>
    calc.buildDashboardFindingsView({
      cards: [
        card({ id: "b", score: 50, lastSeenAt: "2026-08-25T10:00:00.000Z" }),
        card({ id: "a", score: 50, lastSeenAt: "2026-08-25T10:00:00.000Z" }),
      ],
      ...OPEN,
    });
  assert.deepEqual(
    build().recentInsights.map((i) => i.id),
    build().recentInsights.map((i) => i.id)
  );
  assert.deepEqual(build().recentInsights.map((i) => i.id), ["a", "b"]);
});

// ===========================================================================
// The mapping itself
// ===========================================================================

test("every paid module family has a tile", () => {
  const mapped = new Set(Object.values(calc.KPI_MODULES).flat());
  for (const module of [
    "fraud",
    "trust",
    "return_abuse",
    "competitor",
    "pricing",
    "profit",
    "operational",
  ]) {
    assert.ok(mapped.has(module), `${module} must map to a Dashboard tile`);
  }
});

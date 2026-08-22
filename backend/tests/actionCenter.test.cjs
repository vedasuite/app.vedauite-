const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

process.env.SHOPIFY_API_KEY ||= "test-key";
process.env.SHOPIFY_API_SECRET ||= "test-secret";
process.env.SHOPIFY_APP_URL ||= "https://app.vedasuite.in";
process.env.DATABASE_URL ||= "postgresql://example:example@localhost:5432/example";

/**
 * PART 4 — Action Center.
 *
 * The properties that matter: ranking is deterministic and reproducible, the
 * summary can never double-count incompatible impact, entitlement is honoured
 * (while store-health stays visible on every plan), and the AI boundary refuses
 * anything ungrounded.
 */

function resetModule(p) {
  delete require.cache[require.resolve(p)];
}

const PRISMA = path.resolve(__dirname, "../dist/db/prismaClient.js");
const OBS = path.resolve(__dirname, "../dist/services/observabilityService.js");
const SERVICE = path.resolve(__dirname, "../dist/services/actionCenterService.js");
const BRIEF = path.resolve(__dirname, "../dist/services/intelligenceBriefService.js");

const NOW = new Date("2026-08-22T00:00:00.000Z");
const DAY = 86_400_000;
const daysAgo = (n) => new Date(NOW.getTime() - n * DAY);
const STORE = "store-1";

function snapshot(overrides = {}) {
  return {
    id: "insight-1",
    storeId: STORE,
    module: "return_abuse",
    title: "Repeated refund loss",
    reasons: ["3 of 5 orders refunded.", "Refunds are still accruing."],
    evidence: [{ label: "Refund count", value: "3" }],
    financialImpact: {
      status: "quantified",
      min: 0,
      max: 500,
      currency: "USD",
      period: "current_open_exposure",
      basis: "refunded order value",
      isEstimate: true,
    },
    confidence: "high",
    recency: NOW.toISOString(),
    urgency: "high",
    easeOfAction: "manual",
    recommendedAction: "Review this customer.",
    score: {},
    methodology: { summary: "s", assumptions: ["a"], caps: ["c"] },
    route: "/app/fraud-intelligence",
    dataQuality: "ok",
    ...overrides,
  };
}

function findingRow(overrides = {}) {
  const snap = overrides.snapshot ?? snapshot();
  return {
    id: overrides.id ?? "f-1",
    storeId: overrides.storeId ?? STORE,
    findingType: overrides.findingType ?? "customer_loss_repeated_refund",
    module: overrides.module ?? snap.module,
    status: overrides.status ?? "new",
    firstDetectedAt: overrides.firstDetectedAt ?? daysAgo(10),
    lastSeenAt: overrides.lastSeenAt ?? daysAgo(1),
    detectionCount: overrides.detectionCount ?? 2,
    statusChangedAt: null,
    resolvedAt: null,
    dismissedAt: null,
    snapshotJson: overrides.snapshotJson !== undefined ? overrides.snapshotJson : JSON.stringify(snap),
    updatedAt: daysAgo(1),
  };
}

function buildWorld(rows = []) {
  [PRISMA, OBS, SERVICE, BRIEF].forEach(resetModule);
  const prisma = require(PRISMA).prisma;
  const logged = [];
  require(OBS).logEvent = (l, e, d) => logged.push({ level: l, event: e, details: d });

  prisma.intelligenceFinding = {
    findMany: async ({ where }) =>
      rows.filter(
        (r) =>
          r.storeId === where.storeId &&
          (where.status === undefined || r.status === where.status) &&
          (where.module === undefined || r.module === where.module)
      ),
  };

  return { service: require(SERVICE), brief: require(BRIEF), logged };
}

const ALL_MODULES = ["fraud", "competitor", "pricing", "profit"];

const run = (w, opts = {}) =>
  w.service.getActionCenter({
    storeId: STORE,
    enabledModules: ALL_MODULES,
    now: NOW,
    ...opts,
  });

// ===========================================================================
// Normalization
// ===========================================================================

test("a stored finding is normalized into a complete action card", async () => {
  const w = buildWorld([findingRow()]);
  const { cards } = await run(w);

  assert.equal(cards.length, 1);
  const c = cards[0];
  assert.equal(c.title, "Repeated refund loss");
  assert.equal(c.whatHappened, "3 of 5 orders refunded.");
  assert.equal(c.whyItMatters, "Refunds are still accruing.");
  assert.equal(c.severity, "high");
  assert.equal(c.confidence, "high");
  assert.equal(c.dataComplete, true);
  assert.equal(c.impact.status, "quantified");
  assert.equal(c.impact.max, 500);
  assert.equal(c.recommendedAction, "Review this customer.");
  assert.equal(c.route, "/app/fraud-intelligence");
  assert.equal(c.detectionCount, 2);
  assert.ok(c.methodology);
});

test("a finding with an unreadable snapshot is SKIPPED, never rendered bare", async () => {
  const w = buildWorld([
    findingRow({ id: "good" }),
    findingRow({ id: "bad", snapshotJson: "{not json" }),
    findingRow({ id: "none", snapshotJson: null }),
  ]);
  const { cards } = await run(w);

  assert.equal(cards.length, 1, "only the readable finding is shown");
  assert.equal(cards[0].id, "good");
});

// ===========================================================================
// Deterministic ranking
// ===========================================================================

test("ranking is transparent: every card exposes its component breakdown", async () => {
  const w = buildWorld([findingRow()]);
  const { cards } = await run(w);
  const r = cards[0].rank;

  for (const k of ["severity", "confidence", "freshness", "impact", "completeness"]) {
    assert.equal(typeof r.components[k], "number", `${k} component must be reported`);
    assert.equal(typeof r.weights[k], "number", `${k} weight must be reported`);
  }
  // The score is reproducible from the published components and weights.
  const expected =
    (r.components.severity * r.weights.severity +
      r.components.confidence * r.weights.confidence +
      r.components.freshness * r.weights.freshness +
      r.components.impact * r.weights.impact +
      r.components.completeness * r.weights.completeness) /
    100;
  assert.equal(r.score, Math.round(expected * 100) / 100);
});

test("higher severity outranks lower severity, all else equal", async () => {
  const w = buildWorld([
    findingRow({ id: "low", snapshot: snapshot({ urgency: "low" }) }),
    findingRow({ id: "crit", snapshot: snapshot({ urgency: "critical" }) }),
    findingRow({ id: "med", snapshot: snapshot({ urgency: "medium" }) }),
  ]);
  const { cards } = await run(w);
  assert.deepEqual(cards.map((c) => c.id), ["crit", "med", "low"]);
});

test("lower confidence and staler data rank below their equals", async () => {
  const w = buildWorld([
    findingRow({ id: "stale", lastSeenAt: daysAgo(20) }),
    findingRow({ id: "fresh", lastSeenAt: daysAgo(0) }),
  ]);
  const { cards } = await run(w);
  assert.equal(cards[0].id, "fresh");

  const w2 = buildWorld([
    findingRow({ id: "lowconf", snapshot: snapshot({ confidence: "low" }) }),
    findingRow({ id: "highconf", snapshot: snapshot({ confidence: "high" }) }),
  ]);
  assert.equal((await run(w2)).cards[0].id, "highconf");
});

test("ordering is stable and reproducible across repeated calls", async () => {
  const rows = [
    findingRow({ id: "a" }),
    findingRow({ id: "b", snapshot: snapshot({ urgency: "critical" }) }),
    findingRow({ id: "c", snapshot: snapshot({ urgency: "low" }) }),
  ];
  const first = (await run(buildWorld(rows))).cards.map((c) => c.id);
  for (let i = 0; i < 3; i += 1) {
    assert.deepEqual((await run(buildWorld(rows))).cards.map((c) => c.id), first);
  }
});

test("an unquantifiable impact does not zero out a critical finding", async () => {
  const w = buildWorld([
    findingRow({
      id: "critical_no_money",
      snapshot: snapshot({
        urgency: "critical",
        financialImpact: { status: "impact_not_quantifiable", reason: "no monetary value" },
      }),
    }),
    findingRow({ id: "medium_with_money", snapshot: snapshot({ urgency: "medium" }) }),
  ]);
  const { cards } = await run(w);
  assert.equal(cards[0].id, "critical_no_money", "severity still dominates");
});

test("stale findings are flagged", async () => {
  const w = buildWorld([
    findingRow({ id: "old", lastSeenAt: daysAgo(30) }),
    findingRow({ id: "new", lastSeenAt: daysAgo(1) }),
  ]);
  const { cards } = await run(w);
  assert.equal(cards.find((c) => c.id === "old").isStale, true);
  assert.equal(cards.find((c) => c.id === "new").isStale, false);
});

// ===========================================================================
// Summary integrity — no double-counting
// ===========================================================================

test("impact is grouped by currency AND period, never summed across them", async () => {
  const w = buildWorld([
    findingRow({
      id: "usd30",
      snapshot: snapshot({
        financialImpact: { status: "quantified", min: 0, max: 100, currency: "USD", period: "last_30_days", basis: "b", isEstimate: true },
      }),
    }),
    findingRow({
      id: "usd30b",
      snapshot: snapshot({
        financialImpact: { status: "quantified", min: 0, max: 50, currency: "USD", period: "last_30_days", basis: "b", isEstimate: true },
      }),
    }),
    findingRow({
      id: "eur30",
      snapshot: snapshot({
        financialImpact: { status: "quantified", min: 0, max: 999, currency: "EUR", period: "last_30_days", basis: "b", isEstimate: true },
      }),
    }),
    findingRow({
      id: "usdunit",
      snapshot: snapshot({
        financialImpact: { status: "quantified", min: 0, max: 7, currency: "USD", period: "per_order", basis: "b", isEstimate: true },
      }),
    }),
  ]);

  const { summary } = await run(w);
  assert.equal(summary.quantifiedImpact.length, 3, "three distinct currency/period groups");

  const usd30 = summary.quantifiedImpact.find((g) => g.currency === "USD" && g.period === "last_30_days");
  assert.equal(usd30.max, 150, "only same-currency, same-period figures are added");
  assert.equal(usd30.findingCount, 2);

  const eur = summary.quantifiedImpact.find((g) => g.currency === "EUR");
  assert.equal(eur.max, 999, "EUR is never folded into USD");

  const perUnit = summary.quantifiedImpact.find((g) => g.period === "per_order");
  assert.equal(perUnit.max, 7, "per-unit is never folded into a period total");

  // There must be no single grand total anywhere in the summary.
  assert.equal("total" in summary, false);
  assert.equal("grandTotal" in summary, false);
});

test("unquantifiable findings are counted separately, never as zero in a total", async () => {
  const w = buildWorld([
    findingRow({ id: "money" }),
    findingRow({
      id: "nomoney",
      snapshot: snapshot({
        financialImpact: { status: "impact_not_quantifiable", reason: "no defensible value" },
      }),
    }),
  ]);

  const { summary } = await run(w);
  assert.equal(summary.notQuantifiedCount, 1);
  assert.equal(summary.quantifiedImpact.reduce((s, g) => s + g.findingCount, 0), 1);
});

test("summary counts severity, status, staleness and incompleteness", async () => {
  const w = buildWorld([
    findingRow({ id: "a", status: "new", snapshot: snapshot({ urgency: "critical" }) }),
    findingRow({ id: "b", status: "seen", snapshot: snapshot({ urgency: "high" }) }),
    findingRow({ id: "c", status: "resolved", snapshot: snapshot({ urgency: "low" }) }),
    findingRow({ id: "d", status: "new", lastSeenAt: daysAgo(30), snapshot: snapshot({ dataQuality: "insufficient_data" }) }),
  ]);

  const { summary } = await run(w);
  assert.equal(summary.bySeverity.critical, 1);
  assert.equal(summary.bySeverity.high, 2); // b plus the default-high card d
  assert.equal(summary.byStatus.new, 2);
  assert.equal(summary.byStatus.resolved, 1);
  assert.equal(summary.totalOpen, 3, "resolved is not open");
  assert.equal(summary.staleCount, 1);
  assert.equal(summary.incompleteDataCount, 1);
});

// ===========================================================================
// Entitlement
// ===========================================================================

test("findings for a module the plan lacks are hidden", async () => {
  const w = buildWorld([
    findingRow({ id: "fraudish", module: "return_abuse" }),
    findingRow({ id: "profitish", module: "profit", snapshot: snapshot({ module: "profit" }) }),
  ]);

  const { cards } = await run(w, { enabledModules: ["profit"] });
  assert.deepEqual(cards.map((c) => c.id), ["profitish"]);
});

test("OPERATIONAL findings stay visible on every plan, including none at all", async () => {
  const w = buildWorld([
    findingRow({
      id: "ops",
      module: "operational",
      findingType: "operational_sync_health_degraded",
      snapshot: snapshot({ module: "operational", title: "Store health" }),
    }),
  ]);

  for (const enabled of [[], ["profit"], ["fraud"], ALL_MODULES]) {
    const { cards } = await run(w, { enabledModules: enabled });
    assert.equal(cards.length, 1, `visible with modules=[${enabled}]`);
    assert.equal(cards[0].capability, null);
  }
});

test("store scoping: another store's findings are never returned", async () => {
  const w = buildWorld([
    findingRow({ id: "mine", storeId: STORE }),
    findingRow({ id: "theirs", storeId: "store-2" }),
  ]);
  const { cards } = await run(w);
  assert.deepEqual(cards.map((c) => c.id), ["mine"]);
});

test("an unknown status filter is rejected", async () => {
  const w = buildWorld([findingRow()]);
  await assert.rejects(() => run(w, { status: "archived" }), /Unknown status filter/);
});

test("severity filter narrows the feed", async () => {
  const w = buildWorld([
    findingRow({ id: "crit", snapshot: snapshot({ urgency: "critical" }) }),
    findingRow({ id: "low", snapshot: snapshot({ urgency: "low" }) }),
  ]);
  const { cards } = await run(w, { severity: "critical" });
  assert.deepEqual(cards.map((c) => c.id), ["crit"]);
});

test("an empty store yields an empty feed and a zeroed summary, not an error", async () => {
  const w = buildWorld([]);
  const { cards, summary } = await run(w);
  assert.deepEqual(cards, []);
  assert.equal(summary.totalOpen, 0);
  assert.deepEqual(summary.quantifiedImpact, []);
});

// ===========================================================================
// Intelligence brief + AI guardrails
// ===========================================================================

test("the brief is deterministic and never claims AI detection", async () => {
  const w = buildWorld([findingRow()]);
  const { cards, summary } = await run(w);
  const brief = w.brief.getIntelligenceBrief(cards, summary);

  assert.equal(brief.generatedBy, "deterministic");
  assert.ok(brief.headline.length > 0);
  assert.doesNotMatch(JSON.stringify(brief), /AI (detected|found|discovered|calculated)/i);
});

test("AI is not enabled — no provider exists in this repository", () => {
  const w = buildWorld([]);
  assert.equal(w.brief.isAiExplanationEnabled(), false);
});

test("the brief discloses unquantified and stale findings rather than hiding them", async () => {
  const w = buildWorld([
    findingRow({ id: "stale", lastSeenAt: daysAgo(30) }),
    findingRow({
      id: "nomoney",
      snapshot: snapshot({
        financialImpact: { status: "impact_not_quantifiable", reason: "no value" },
      }),
    }),
  ]);
  const { cards, summary } = await run(w);
  const text = w.brief.getIntelligenceBrief(cards, summary).bullets.join(" ");

  assert.match(text, /not included in any total/i);
  assert.match(text, /stale/i);
});

test("the empty-state brief is still useful", async () => {
  const w = buildWorld([]);
  const { cards, summary } = await run(w);
  const brief = w.brief.getIntelligenceBrief(cards, summary);
  assert.match(brief.headline, /Nothing needs your attention/i);
  assert.equal(brief.generatedBy, "deterministic");
});

test("the AI input payload carries NO identifiers or PII", async () => {
  const w = buildWorld([findingRow()]);
  const { cards, summary } = await run(w);
  const payload = JSON.stringify(w.brief.buildAiBriefInput(cards, summary));

  assert.doesNotMatch(payload, /@/, "no email");
  assert.doesNotMatch(payload, /customerId|orderId|shopifyOrderId|storeId/i);
  assert.doesNotMatch(payload, /snapshotJson/);
  // Money is pre-formatted so a model can only quote, never recompute.
  assert.match(payload, /"range":"0–500 USD"/);
});

test("AI guardrail: a response inventing a number is REJECTED", () => {
  const w = buildWorld([]);
  const allowed = ["0–500 USD", "3"];

  const bad = w.brief.validateAiBrief(
    { headline: "You lost 9999 USD", bullets: [] },
    ["f-1"],
    allowed
  );
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /unverified number: 9999/);

  const good = w.brief.validateAiBrief(
    { headline: "Up to 500 USD is exposed", bullets: ["3 refunds seen"] },
    ["f-1"],
    allowed
  );
  assert.equal(good.ok, true);
});

test("AI guardrail: malformed responses are rejected, not rendered", () => {
  const w = buildWorld([]);
  for (const bad of [null, "a string", 42, {}, { headline: "" }, { headline: "ok", bullets: "no" }]) {
    assert.equal(w.brief.validateAiBrief(bad, [], []).ok, false, `${JSON.stringify(bad)} must fail`);
  }
  assert.equal(
    w.brief.validateAiBrief({ headline: "ok", bullets: Array(20).fill("x") }, [], []).ok,
    false,
    "too many bullets"
  );
});

test("AI guardrail: a response claiming AI detection is rejected", () => {
  const w = buildWorld([]);
  const r = w.brief.validateAiBrief(
    { headline: "AI detected a refund problem", bullets: [] },
    [],
    []
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /claimed AI detection/i);
});

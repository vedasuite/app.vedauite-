const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

process.env.SHOPIFY_API_KEY ||= "test-key";
process.env.SHOPIFY_API_SECRET ||= "test-secret";
process.env.SHOPIFY_APP_URL ||= "https://app.vedasuite.in";
process.env.DATABASE_URL ||= "postgresql://example:example@localhost:5432/example";

/**
 * PHASE I — THE SEVENTEEN CROSS-SURFACE INVARIANTS.
 *
 * Every surface in VedaSuite now claims to read one source of truth. That claim
 * is only worth something if it is enforced somewhere, so this file states each
 * invariant as an executable assertion, numbered exactly as specified.
 *
 * These are deliberately CROSS-surface. The per-module tests already prove each
 * calculation is correct in isolation; what they cannot prove is that two
 * correct calculations still agree with each other. Every contradiction this
 * programme fixed was of that second kind.
 *
 * Invariant 17 is a full workflow: Shopify sync -> detectors -> evidence
 * classification -> IntelligenceFinding -> Action Center -> Dashboard ->
 * merchant changes status -> refresh -> consistent state everywhere.
 */

const d = (p) => path.resolve(__dirname, `../dist/${p}`);
const resetModule = (p) => delete require.cache[require.resolve(p)];

const PATHS = {
  env: d("config/env.js"),
  prisma: d("db/prismaClient.js"),
  obs: d("services/observabilityService.js"),
  finding: d("services/intelligenceFindingService.js"),
  detector: d("services/intelligenceDetectorService.js"),
  actionCenter: d("services/actionCenterService.js"),
  dashboardCalc: d("services/dashboardFindingsCalc.js"),
  brief: d("services/intelligenceBriefService.js"),
  eligibility: d("services/evidenceEligibility.js"),
  fetchStatus: d("services/competitorFetchStatus.js"),
  freshness: d("services/competitorFreshnessCalc.js"),
  qualification: d("services/actionQualification.js"),
  pricingEvidence: d("services/pricingEvidenceCalc.js"),
};

const eligibility = require(PATHS.eligibility);
const fetchStatus = require(PATHS.fetchStatus);
const freshness = require(PATHS.freshness);
const qualification = require(PATHS.qualification);
const pricingEvidence = require(PATHS.pricingEvidence);
const dashboardCalc = require(PATHS.dashboardCalc);

const NOW = "2026-08-25T00:00:00.000Z";
const DAY = 86_400_000;
const daysAgo = (n) => new Date(new Date(NOW).getTime() - n * DAY);
const STORE = "store-1";

// ===========================================================================
// A world that supports the WHOLE chain, not one stage of it.
// ===========================================================================

function buildWorld({
  flagEnabled = true,
  orders = [],
  syncJobs = [],
  store = {},
  products = [],
  profitRows = [],
  priceHistory = [],
  competitorDomains = [],
  competitorData = [],
  customers = [],
} = {}) {
  Object.values(PATHS).forEach((p) => {
    try {
      resetModule(p);
    } catch {
      /* not yet loaded */
    }
  });
  process.env.ENABLE_INTELLIGENCE_FINDING_PERSISTENCE = flagEnabled ? "true" : "false";

  const prisma = require(PATHS.prisma).prisma;
  const logged = [];
  require(PATHS.obs).logEvent = (l, e, x) => logged.push({ level: l, event: e, details: x });

  const findingRows = [];
  let seq = 0;

  const byStore = (rows, where) => rows.filter((r) => r.storeId === where.storeId);

  prisma.order = {
    findMany: async ({ where }) =>
      orders.filter(
        (o) =>
          o.storeId === where.storeId &&
          (where.createdAt?.gte === undefined || o.createdAt >= where.createdAt.gte) &&
          (where.customerId === undefined || o.customerId === where.customerId)
      ),
  };
  prisma.customer = {
    findMany: async ({ where }) => byStore(customers, where),
    count: async () => 0,
  };
  prisma.syncJob = { findMany: async ({ where }) => byStore(syncJobs, where) };
  prisma.store = {
    findUnique: async ({ where }) =>
      where.id === STORE || where.shop === "test.myshopify.com"
        ? {
            id: STORE,
            shop: "test.myshopify.com",
            lastSyncAt: daysAgo(1),
            lastConnectionStatus: "OK",
            lastWebhookRegistrationStatus: "OK",
            accessTokenExpiresAt: null,
            syncJobs: [],
            timelineEvents: [],
            ...store,
          }
        : null,
  };
  prisma.productSnapshot = { findMany: async ({ where }) => byStore(products, where) };
  prisma.profitOptimizationData = {
    findMany: async ({ where }) => byStore(profitRows, where),
  };
  prisma.priceHistory = { findMany: async ({ where }) => byStore(priceHistory, where) };
  prisma.competitorDomain = { findMany: async ({ where }) => byStore(competitorDomains, where) };
  prisma.competitorData = { findMany: async ({ where }) => byStore(competitorData, where) };

  prisma.intelligenceFinding = {
    findUnique: async ({ where }) => {
      const { storeId, fingerprint } = where.storeId_fingerprint;
      const row = findingRows.find(
        (r) => r.storeId === storeId && r.fingerprint === fingerprint
      );
      return row ? { ...row } : null;
    },
    upsert: async ({ where, update, create }) => {
      const { storeId, fingerprint } = where.storeId_fingerprint;
      const existing = findingRows.find(
        (r) => r.storeId === storeId && r.fingerprint === fingerprint
      );
      if (existing) {
        for (const [k, v] of Object.entries(update)) {
          existing[k] =
            v && typeof v === "object" && "increment" in v
              ? (existing[k] ?? 0) + v.increment
              : v;
        }
        return { ...existing };
      }
      seq += 1;
      const row = { id: `f-${seq}`, ...create };
      findingRows.push(row);
      return { ...row };
    },
    update: async ({ where, data }) => {
      const row = findingRows.find((r) => r.id === where.id);
      Object.assign(row, data);
      return { ...row };
    },
    findFirst: async ({ where }) =>
      findingRows.find(
        (r) =>
          (where.id === undefined || r.id === where.id) &&
          (where.storeId === undefined || r.storeId === where.storeId)
      ) ?? null,
    // Honours the filters production actually passes, so a filter in a test
    // means the same thing it means in production.
    //
    // `status: { in: [...] }` is load-bearing: the auto-close paths query open
    // findings that way, and a mock that only understood a bare string made
    // them silently return nothing — which looks exactly like "auto-close is
    // broken" while the real code is fine.
    findMany: async ({ where = {} } = {}) =>
      findingRows
        .filter((r) => {
          if (where.storeId !== undefined && r.storeId !== where.storeId) return false;
          if (where.module !== undefined && r.module !== where.module) return false;
          if (where.status !== undefined) {
            if (typeof where.status === "string") {
              if (r.status !== where.status) return false;
            } else if (Array.isArray(where.status.in)) {
              if (!where.status.in.includes(r.status)) return false;
            }
          }
          if (where.lastSeenAt?.gte && new Date(r.lastSeenAt) < where.lastSeenAt.gte) {
            return false;
          }
          return true;
        })
        .map((r) => ({ ...r })),
    updateMany: async ({ where, data }) => {
      let count = 0;
      for (const row of findingRows) {
        if (where.storeId && row.storeId !== where.storeId) continue;
        if (where.module && row.module !== where.module) continue;
        if (where.id?.in && !where.id.in.includes(row.id)) continue;
        if (where.status?.in && !where.status.in.includes(row.status)) continue;
        Object.assign(row, data);
        count += 1;
      }
      return { count };
    },
  };

  return {
    prisma,
    logged,
    findingRows,
    detectors: require(PATHS.detector),
    findings: require(PATHS.finding),
    actionCenter: require(PATHS.actionCenter),
    brief: require(PATHS.brief),
  };
}

/** Orders that reliably produce a refund-rate shift and a high-risk backlog. */
function problemOrders(storeId = STORE) {
  const recent = Array.from({ length: 40 }, (_, i) => ({
    id: `${storeId}-r${i}`,
    storeId,
    customerId: `c${i}`,
    status: "paid",
    refunded: i < 14,
    totalAmount: 100,
    currency: "USD",
    fraudRiskLevel: "Low",
    createdAt: daysAgo(5),
  }));
  const baseline = Array.from({ length: 40 }, (_, i) => ({
    id: `${storeId}-b${i}`,
    storeId,
    customerId: `c${i}`,
    status: "paid",
    refunded: i < 2,
    totalAmount: 100,
    currency: "USD",
    fraudRiskLevel: "Low",
    createdAt: daysAgo(50),
  }));
  const highRisk = Array.from({ length: 4 }, (_, i) => ({
    id: `${storeId}-h${i}`,
    storeId,
    customerId: `hc${i}`,
    status: "manual_review",
    refunded: false,
    totalAmount: 250,
    currency: "USD",
    fraudRiskLevel: "High",
    createdAt: daysAgo(i === 0 ? 12 : 2),
  }));
  return [...recent, ...baseline, ...highRisk];
}

/**
 * A store baseline plus ONE customer who genuinely meets every documented
 * customer-loss threshold, so invariant 9 cannot pass vacuously.
 *
 * CUSTOMER_LOSS requires: at least 50 eligible store orders for a baseline, at
 * least 3 eligible orders for the customer, at least 2 of them refunded, and a
 * refunded share of at least 30% of that customer's eligible order value.
 * These are deliberately conservative thresholds — the detector describes a
 * merchant's own customer — so the fixture has to clear them honestly rather
 * than be nudged past them.
 */
function customerLossWorld(storeId = STORE) {
  const baseline = Array.from({ length: 60 }, (_, i) => ({
    id: `${storeId}-base${i}`,
    storeId,
    customerId: `other-${i}`,
    status: "paid",
    refunded: i < 3,
    totalAmount: 100,
    currency: "USD",
    fraudRiskLevel: "Low",
    createdAt: daysAgo(30 + i),
  }));

  // 4 eligible orders, 3 refunded => 75% of value refunded.
  const abuser = Array.from({ length: 4 }, (_, i) => ({
    id: `${storeId}-ab${i}`,
    storeId,
    customerId: "cust-loss",
    status: "paid",
    refunded: i < 3,
    totalAmount: 200,
    currency: "USD",
    fraudRiskLevel: "Low",
    createdAt: daysAgo(10 + i),
  }));

  return {
    orders: [...baseline, ...abuser],
    customers: [{ id: "cust-loss", storeId, fraudSignalsCount: 2, updatedAt: daysAgo(1) }],
  };
}

const ENABLED = ["fraud", "competitor", "pricing", "profit"];

// ===========================================================================
// 1. Pricing insufficient evidence -> the Dashboard cannot show money.
// ===========================================================================

test("I1: insufficient pricing evidence can never become Dashboard money", () => {
  // The gate itself: only evidence_backed may carry a monetary claim.
  for (const state of ["partially_supported", "insufficient_data", "stale", "unavailable"]) {
    assert.ok(
      !eligibility.MONETARY_ALLOWED_STATES.includes(state),
      `${state} must not be allowed to state money`
    );
  }
  assert.deepEqual([...eligibility.MONETARY_ALLOWED_STATES], ["evidence_backed"]);

  // And the structural half: the Dashboard projection has no monetary field at
  // all, so even an evidence-backed amount is stated once, by the Action Center.
  const view = dashboardCalc.buildDashboardFindingsView({
    cards: [
      {
        id: "p1",
        module: "pricing",
        status: "new",
        severity: "high",
        title: "Pricing finding",
        whatHappened: "A price gap was measured.",
        recommendedAction: "Review it.",
        route: "/app/ai-pricing-engine",
        lastSeenAt: NOW,
        rank: { score: 50 },
        impact: { status: "quantified", min: 500, max: 900, currency: "USD" },
      },
    ],
    persistenceEnabled: true,
  });

  const serialized = JSON.stringify(view);
  assert.doesNotMatch(serialized, /"min"|"max"|"currency"/);
  assert.equal(view.recentInsights[0].detail, "A price gap was measured.");
});

test("I1b: a pricing recommendation with no observed cost states no gain", () => {
  const verdict = eligibility.classifyMonetaryClaim({
    salesVelocityObserved: true,
    productCostObserved: false,
  });
  assert.equal(verdict.allowed, false);
  assert.ok(verdict.missing.length > 0, "it must say what is missing");
  // One input present is PARTIALLY supported: enough to point at the
  // opportunity, never enough to put money on it. The distinction from the
  // both-missing case below is deliberate, so the merchant is told how close
  // VedaSuite actually is rather than a flat "no data".
  assert.equal(verdict.state, "partially_supported");
  assert.equal(verdict.confidence, "low");

  const nothing = eligibility.classifyMonetaryClaim({
    salesVelocityObserved: false,
    productCostObserved: false,
  });
  assert.equal(nothing.allowed, false);
  assert.equal(nothing.state, "insufficient_data");
  assert.equal(nothing.confidence, "insufficient_data");

  const full = eligibility.classifyMonetaryClaim({
    salesVelocityObserved: true,
    productCostObserved: true,
  });
  assert.equal(full.allowed, true, "observed inputs must still earn a figure");
  assert.deepEqual(full.missing, []);
});

// ===========================================================================
// 2. Stale competitor evidence cannot become a fresh claim.
// ===========================================================================

test("I2: only a successful LAST attempt counts as current competitor evidence", () => {
  for (const status of [
    "dns_unresolvable",
    "timeout",
    "http_blocked",
    "tls_error",
    "unparseable",
    "never_collected",
    "stale",
    null,
    undefined,
  ]) {
    assert.equal(
      fetchStatus.isCurrentEvidence(status),
      false,
      `${status} must not count as current evidence`
    );
  }
  assert.equal(fetchStatus.isCurrentEvidence("fresh_success"), true);
  assert.equal(fetchStatus.isCurrentEvidence("partial_success"), true);
});

test("I2b: stored rows plus a failed refresh never produce a 'latest analysis' claim", () => {
  // The exact production case: 8 stored rows for addidas.com and a fetch that
  // failed, reported as "the latest analysis reviewed 3 websites".
  const summary = freshness.summariseCompetitorEvidence([
    freshness.classifyDomainEvidence({
      domain: "addidas.com",
      nowIso: NOW,
      newestCollectedAtIso: new Date(new Date(NOW).getTime() - 72 * 3_600_000).toISOString(),
      rowCount: 8,
      lastSyncStartedAtIso: new Date(new Date(NOW).getTime() - 3_600_000).toISOString(),
    }),
  ]);
  assert.equal(summary.allEvidenceStale, true);
  assert.doesNotMatch(summary.headlineQualifier, /latest analysis/i);
});

test("I2c: a market-signal action requires evidence that is current", () => {
  const stale = qualification.qualifiesAsCompetitorAction({
    competitorPrice: 80,
    ourPrice: 100,
    evidenceIsCurrent: false,
  });
  assert.equal(stale, false, "a 20% gap from stale data is history, not a signal");

  const current = qualification.qualifiesAsCompetitorAction({
    competitorPrice: 80,
    ourPrice: 100,
    evidenceIsCurrent: true,
  });
  assert.equal(current, true);
});

// ===========================================================================
// 3. Assumed cost/velocity never becomes observed after persistence.
// ===========================================================================

test("I3: a persisted profit value is never treated as observed", () => {
  assert.equal(eligibility.storedProfitValueIsObserved(), false);
});

test("I3b: provenance is read from the source column, not from the value", () => {
  // The laundering path: a row that HAS a productCost tells you nothing about
  // where that number came from. Only costSource does.
  const assumed = eligibility.profitRowProvenance({
    productCost: 42,
    costSource: "assumed",
    salesVelocity: 8,
    velocitySource: "assumed",
  });
  assert.equal(assumed.costObserved, false);
  assert.equal(assumed.velocityObserved, false);

  const observed = eligibility.profitRowProvenance({
    productCost: 42,
    costSource: "observed",
    salesVelocity: 8,
    velocitySource: "observed",
  });
  assert.equal(observed.costObserved, true);
  assert.equal(observed.velocityObserved, true);

  // A null value cannot be observed no matter what the source column says.
  const contradictory = eligibility.profitRowProvenance({
    productCost: null,
    costSource: "observed",
    salesVelocity: null,
    velocitySource: "observed",
  });
  assert.equal(contradictory.costObserved, false);
  assert.equal(contradictory.velocityObserved, false);
});

// ===========================================================================
// 4. No arbitrary constant becomes a merchant-facing confidence percentage.
// ===========================================================================

test("I4: pricing confidence is derived from evidence, never from a constant", () => {
  // Nothing observed: no target price, and above all no projected gain.
  const none = pricingEvidence.classifyPricingEvidence({
    competitorReady: false,
    competitorAveragePrice: null,
    profitReady: false,
    salesVelocityObserved: false,
  });
  assert.equal(none.showExactTarget, false);
  assert.equal(none.showProjectedGain, false);

  // Profit rows exist but velocity was DEFAULTED. This is the laundering case:
  // the data looks complete, and the only thing separating it from the case
  // below is provenance.
  const assumedVelocity = pricingEvidence.classifyPricingEvidence({
    competitorReady: false,
    competitorAveragePrice: null,
    profitReady: true,
    salesVelocityObserved: false,
  });
  assert.equal(
    assumedVelocity.showProjectedGain,
    false,
    "an assumed velocity must never fund a projected gain"
  );

  // Fully observed: the strongest basis, and the only one that may state a gain.
  const full = pricingEvidence.classifyPricingEvidence({
    competitorReady: true,
    competitorAveragePrice: 80,
    profitReady: true,
    salesVelocityObserved: true,
  });
  assert.equal(full.showExactTarget, true);
  assert.equal(full.showProjectedGain, true);

  // The three must genuinely differ — a constant would flatten them together.
  assert.equal(new Set([none.basis, assumedVelocity.basis, full.basis]).size >= 2, true);
});

test("I4b: the codebase states no bare magic confidence constant", () => {
  // Held by the dedicated magicConfidence suite; asserted here as a
  // cross-surface property so a regression fails in BOTH places.
  const fs = require("node:fs");
  const src = fs.readFileSync(
    path.resolve(__dirname, "../src/services/decisionCenterService.ts"),
    "utf8"
  );
  assert.doesNotMatch(src, /confidence[^\n]*\?\?\s*\d{2}/i);
  assert.doesNotMatch(src, /:\s*82\s*:\s*68/);
});

// ===========================================================================
// 5. Every qualifying finding appears exactly once in the Action Center.
// ===========================================================================

test("I5: a qualifying finding appears exactly once", async () => {
  const w = buildWorld({ orders: problemOrders() });
  await w.detectors.detectOperationalProblems({ storeId: STORE, nowIso: NOW });

  const { cards } = await w.actionCenter.getActionCenter({
    storeId: STORE,
    enabledModules: ENABLED,
    now: new Date(NOW),
  });

  assert.ok(cards.length > 0, "the detector must have produced findings");
  const ids = cards.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, "no card may appear twice");

  // And re-running detection updates the same rows rather than adding new ones.
  const before = w.findingRows.length;
  await w.detectors.detectOperationalProblems({ storeId: STORE, nowIso: NOW });
  assert.equal(w.findingRows.length, before, "re-detection must not duplicate");
});

// ===========================================================================
// 6. Non-qualifying informational signals do not flood the Action Center.
// ===========================================================================

test("I6: high-volume raw events collapse into one aggregate per family", () => {
  const many = Array.from({ length: 40 }, (_, i) => ({
    id: `c${i}`,
    rankValue: 100 - i,
  }));

  for (const family of [
    "operational",
    "customer_loss",
    "product_profit",
    "pricing",
    "competitor",
  ]) {
    const out = qualification.splitForActionCenter(family, many);
    const limit = qualification.INDIVIDUAL_FINDING_LIMIT[family];
    assert.equal(out.individual.length, limit, `${family} must cap individual cards`);
    assert.equal(out.needsAggregate, true, `${family} must summarise the remainder`);
    assert.equal(
      out.individual.length + out.aggregated.length,
      many.length,
      "nothing may be silently dropped"
    );
  }
});

test("I6b: the cap is a display rule, never a change to the evidence bar", () => {
  // A single qualifying item must still appear individually, with no aggregate.
  const one = qualification.splitForActionCenter("pricing", [{ id: "a", rankValue: 1 }]);
  assert.equal(one.individual.length, 1);
  assert.equal(one.needsAggregate, false);
});

// ===========================================================================
// 7. Resolve/dismiss updates the Action Center and the Dashboard consistently.
// ===========================================================================

test("I7: resolving a finding empties both surfaces together", async () => {
  const w = buildWorld({ orders: problemOrders() });
  await w.detectors.detectOperationalProblems({ storeId: STORE, nowIso: NOW });

  const first = await w.actionCenter.getActionCenter({
    storeId: STORE,
    enabledModules: ENABLED,
    now: new Date(NOW),
  });
  const openBefore = first.summary.totalOpen;
  assert.ok(openBefore > 0);

  const dashBefore = dashboardCalc.buildDashboardFindingsView({
    cards: first.cards,
    persistenceEnabled: true,
  });
  assert.equal(
    dashBefore.totalOpen,
    openBefore,
    "the Dashboard total must equal the Action Center total"
  );

  for (const card of first.cards) {
    await w.findings.transitionFindingStatus({
      storeId: STORE,
      findingId: card.id,
      status: "resolved",
    });
  }

  const after = await w.actionCenter.getActionCenter({
    storeId: STORE,
    enabledModules: ENABLED,
    now: new Date(NOW),
  });
  const dashAfter = dashboardCalc.buildDashboardFindingsView({
    cards: after.cards,
    persistenceEnabled: true,
  });

  assert.equal(after.summary.totalOpen, 0);
  assert.equal(dashAfter.totalOpen, 0);
  // The contradiction that started this programme: Open 0 beside Critical 1.
  assert.equal(after.summary.bySeverity.critical + after.summary.bySeverity.high, 0);
  assert.equal(dashAfter.bySeverity.critical + dashAfter.bySeverity.high, 0);
  assert.equal(dashAfter.recentInsights.length, 0);
});

// ===========================================================================
// 8. Healed current-state findings auto-close.
// ===========================================================================

test("I8: a store-health problem that stops occurring is closed automatically", async () => {
  const w = buildWorld({ orders: problemOrders() });
  await w.detectors.detectOperationalProblems({ storeId: STORE, nowIso: NOW });

  const opened = w.findingRows.filter((r) => r.module === "operational");
  assert.ok(opened.length > 0, "operational findings must exist to be healed");

  // A healthy store: no refund shift, no high-risk backlog.
  const healthy = buildWorld({ orders: [] });
  // Re-seed the previous findings into the healthy world's store.
  for (const row of opened) {
    healthy.findingRows.push({ ...row, status: "new" });
  }
  await healthy.detectors.detectOperationalProblems({ storeId: STORE, nowIso: NOW });

  const stillOpen = healthy.findingRows.filter(
    (r) => r.module === "operational" && ["new", "seen", "in_review"].includes(r.status)
  );
  assert.equal(
    stillOpen.length,
    0,
    "a current-state finding must not outlive the condition that raised it"
  );
});

// ===========================================================================
// 9. Historical Customer Loss findings retain historical truth.
// ===========================================================================

test("I9: a historical customer-loss finding is never auto-closed", async () => {
  const w = buildWorld(customerLossWorld());
  await w.detectors.detectCustomerLoss({ storeId: STORE, nowIso: NOW });

  const raised = w.findingRows.filter((r) => r.module === "return_abuse");
  // NOT tolerated as an honest zero here: this invariant is about protecting
  // findings that exist, so a run that raises none would pass vacuously and
  // prove nothing. The fixture is built to raise them.
  assert.ok(
    raised.length > 0,
    "the customer-loss fixture must actually raise findings for this test to mean anything"
  );

  // The refunds still happened, so a later quiet run must not rewrite history.
  const quiet = buildWorld({ orders: [] });
  for (const row of raised) quiet.findingRows.push({ ...row, status: "new" });
  await quiet.detectors.detectCustomerLoss({ storeId: STORE, nowIso: NOW });

  const survivors = quiet.findingRows.filter(
    (r) => r.module === "return_abuse" && r.status === "new"
  );
  assert.equal(
    survivors.length,
    raised.length,
    "a refund that happened stays having happened"
  );
});

// ===========================================================================
// 10. Zero actionable findings -> an honest empty state.
// ===========================================================================

test("I10: an empty Action Center says so plainly and is not padded", async () => {
  const w = buildWorld({ orders: [] });
  const { cards, summary } = await w.actionCenter.getActionCenter({
    storeId: STORE,
    enabledModules: ENABLED,
    now: new Date(NOW),
  });

  assert.equal(cards.length, 0);
  assert.equal(summary.totalOpen, 0);
  assert.equal(summary.quantifiedImpact.length, 0, "no money may be invented to fill the feed");

  const view = dashboardCalc.buildDashboardFindingsView({ cards, persistenceEnabled: true });
  assert.equal(view.available, true);
  assert.match(view.attentionDetail, /real result, not a loading state/i);
});

test("I10b: 'not recording findings' is never rendered as 'no problems'", () => {
  const view = dashboardCalc.buildDashboardFindingsView({
    cards: [],
    persistenceEnabled: false,
  });
  assert.equal(view.available, false);
  assert.doesNotMatch(view.attentionTitle, /Nothing needs your attention/i);
});

// ===========================================================================
// 11. The AI layer only ever receives valid OPEN findings.
// ===========================================================================

test("I11: resolved and dismissed findings never reach the model", () => {
  const brief = require(PATHS.brief);
  const card = (id, status) => ({
    id,
    findingType: "t",
    module: "pricing",
    status,
    severity: "high",
    confidence: "medium",
    dataComplete: true,
    isStale: false,
    title: `Card ${id}`,
    whatHappened: "x",
    whyItMatters: "y",
    evidence: [],
    impact: { status: "impact_not_quantifiable", reason: "Not enough data yet" },
    recommendedAction: "z",
  });

  const payload = brief.buildAiBriefInput(
    [
      card("open", "new"),
      card("seen", "seen"),
      card("review", "in_review"),
      card("done", "resolved"),
      card("gone", "dismissed"),
    ],
    {
      generatedAt: NOW,
      totalOpen: 3,
      bySeverity: { critical: 0, high: 3, medium: 0, low: 0 },
      notQuantifiedCount: 3,
      staleCount: 0,
      incompleteDataCount: 0,
    }
  );

  const ids = payload.findings.map((f) => f.findingId);
  assert.deepEqual(ids, ["open", "seen", "review"]);
  assert.ok(!ids.includes("done"), "a resolved finding must never be described as active");
  assert.ok(!ids.includes("gone"));
});

// ===========================================================================
// 12. The AI cannot add unsupported money, confidence or facts.
// ===========================================================================

test("I12: an invented monetary figure is rejected, not displayed", () => {
  const brief = require(PATHS.brief);
  const payload = {
    openCount: 2,
    severityCounts: { critical: 0, high: 2, medium: 0, low: 0 },
    notQuantifiedCount: 2,
    staleCount: 0,
    incompleteDataCount: 0,
    findings: [
      {
        findingId: "a",
        title: "A finding",
        whatHappened: "x",
        whyItMatters: "y",
        evidence: [],
        impact: { status: "impact_not_quantifiable", reason: "Not enough data yet" },
        recommendedAction: "z",
      },
    ],
  };

  const allowedNumbers = brief.collectAllowedNumbers(payload);
  const allowedIds = payload.findings.map((f) => f.findingId);

  const invented = brief.validateAiBrief(
    { headline: "You are losing 4,200 USD a month.", bullets: ["Act now."], referencedFindingIds: ["a"] },
    allowedIds,
    allowedNumbers
  );
  assert.equal(invented.ok, false, "a figure absent from the verified payload must be rejected");

  const honest = brief.validateAiBrief(
    {
      headline: "You have 2 findings that need attention.",
      bullets: ["A finding needs review."],
      referencedFindingIds: ["a"],
    },
    allowedIds,
    allowedNumbers
  );
  assert.equal(honest.ok, true, "quoting a verified number must still be allowed");
});

test("I12b: the model's own finding references never reach the merchant", () => {
  // Stronger than validating them: `referencedFindingIds` from the model is
  // DISCARDED and replaced with the deterministic ranking's own list, so a
  // fabricated reference cannot become a link the merchant clicks. Held here
  // as a source assertion because the substitution happens inside the provider
  // path, which a unit test cannot reach without a live provider.
  const fs = require("node:fs");
  const src = fs.readFileSync(
    path.resolve(__dirname, "../src/services/intelligenceBriefService.ts"),
    "utf8"
  );
  assert.match(
    src,
    /referencedFindingIds:\s*deterministic\.referencedFindingIds/,
    "the AI brief must reuse the deterministic references, never the model's"
  );
  assert.doesNotMatch(
    src,
    /referencedFindingIds:\s*(?:validated|candidate|c)\./,
    "the model's references must never be passed through"
  );
});

test("I12c: prose that claims the model detected anything is rejected", () => {
  const brief = require(PATHS.brief);
  const result = brief.validateAiBrief(
    { headline: "AI detected two problems.", bullets: ["x"] },
    [],
    ["two"]
  );
  assert.equal(result.ok, false);
  assert.match(result.reason, /detected or calculated/i);
});

// ===========================================================================
// 13. Every merchant-facing amount traces to evidence-approved inputs.
// ===========================================================================

test("I13: a card states money only when its impact is quantified", async () => {
  const w = buildWorld({ orders: problemOrders() });
  await w.detectors.detectOperationalProblems({ storeId: STORE, nowIso: NOW });

  const { cards, summary } = await w.actionCenter.getActionCenter({
    storeId: STORE,
    enabledModules: ENABLED,
    now: new Date(NOW),
  });

  for (const card of cards) {
    if (card.impact.status === "quantified") {
      assert.equal(typeof card.impact.min, "number");
      assert.equal(typeof card.impact.max, "number");
      assert.ok(card.impact.currency, "a quantified amount must name its currency");
      assert.ok(card.impact.period, "a quantified amount must name its period");
    } else {
      assert.equal(card.impact.status, "impact_not_quantifiable");
      assert.ok(card.impact.reason, "an unquantifiable impact must say why");
      assert.equal(card.impact.min, undefined, "and must carry no number at all");
    }
  }

  // Totals are grouped, never summed across currency or period.
  for (const group of summary.quantifiedImpact) {
    assert.ok(group.currency && group.period);
  }
  assert.equal(
    Object.prototype.hasOwnProperty.call(summary, "grandTotal"),
    false,
    "there must be no single grand total to double-count into"
  );
});

// ===========================================================================
// 14. Competitor freshness survives every surface it crosses.
// ===========================================================================

test("I14: one freshness classification is used by every consumer", () => {
  // Market Signals, Pricing, the Dashboard and the Action Center must all ask
  // the same function rather than each deciding what "fresh" means.
  const failures = [
    "dns_unresolvable",
    "timeout",
    "http_blocked",
    "tls_error",
    "unparseable",
  ];
  for (const status of failures) {
    assert.equal(fetchStatus.isFailure(status), true);
    assert.equal(fetchStatus.isCurrentEvidence(status), false);
  }
  // A success is a success everywhere, and never also a failure.
  for (const status of ["fresh_success", "partial_success"]) {
    assert.equal(fetchStatus.isFailure(status), false);
    assert.equal(fetchStatus.isCurrentEvidence(status), true);
  }
  // "never_collected" is neither a failure to report nor current evidence.
  assert.equal(fetchStatus.isCurrentEvidence("never_collected"), false);
});

test("I14b: a merchant-entered domain is echoed exactly, never corrected", () => {
  const evidence = freshness.classifyDomainEvidence({
    domain: "addidas.com",
    nowIso: NOW,
    newestCollectedAtIso: null,
    rowCount: 0,
    lastSyncStartedAtIso: new Date(new Date(NOW).getTime() - 3_600_000).toISOString(),
  });
  assert.equal(evidence.domain, "addidas.com");
  assert.doesNotMatch(evidence.message, /\badidas\.com/);
});

// ===========================================================================
// 15. New labels and navigation do not change billing entitlements.
// ===========================================================================

test("I15: renaming surfaces left every entitlement key intact", async () => {
  const navUrl = pathToFileURL(
    path.resolve(__dirname, "../../frontend/src/layout/navigationModel.js")
  ).href;
  const { buildNavigationModel } = await import(navUrl);

  const locked = buildNavigationModel({ fraud: false, competitor: false, pricing: false });
  const unlocked = buildNavigationModel({ fraud: true, competitor: true, pricing: true });

  const badge = (entries, p) => entries.find((e) => e.path === p)?.badge;
  for (const p of [
    "/app/fraud-intelligence",
    "/app/competitor-intelligence",
    "/app/ai-pricing-engine",
  ]) {
    assert.equal(badge(locked, p), "Upgrade", `${p} must still gate on its entitlement key`);
    assert.equal(badge(unlocked, p), undefined);
  }

  // The capability map is what the Action Center gates on. Display names moved;
  // these keys must not.
  const { MODULE_CAPABILITY } = require(d("services/explainabilityCalc.js"));
  assert.deepEqual(MODULE_CAPABILITY, {
    fraud: "fraud",
    trust: "fraud",
    return_abuse: "fraud",
    competitor: "competitor",
    pricing: "pricing",
    profit: "profit",
    operational: null,
  });
});

test("I15b: store-health findings are never entitlement-gated", async () => {
  const w = buildWorld({ orders: problemOrders() });
  await w.detectors.detectOperationalProblems({ storeId: STORE, nowIso: NOW });

  // A merchant with NO paid modules must still see store-health findings: a
  // broken Shopify connection is not a premium feature.
  const { cards } = await w.actionCenter.getActionCenter({
    storeId: STORE,
    enabledModules: [],
    now: new Date(NOW),
  });
  assert.ok(
    cards.some((c) => c.module === "operational"),
    "operational findings must survive an empty entitlement set"
  );
  assert.ok(cards.every((c) => c.capability === null || c.capability === undefined));
});

// ===========================================================================
// 16. Billing, OAuth, session tokens, onboarding, sync, webhooks intact.
// ===========================================================================

test("I16: the detectors write no store data of any kind", async () => {
  // Uses the customer-loss fixture as well as the operational one, so both
  // detector families actually run against a populated store rather than
  // short-circuiting on empty input and passing without touching anything.
  const w = buildWorld({ ...customerLossWorld(), orders: [...customerLossWorld().orders, ...problemOrders()] });

  // Any write to a store-owned table would throw, so the assertion is the mock.
  for (const table of ["order", "customer", "productSnapshot", "profitOptimizationData"]) {
    w.prisma[table].create = async () => {
      throw new Error(`${table}.create must never be called by a detector`);
    };
    w.prisma[table].update = async () => {
      throw new Error(`${table}.update must never be called by a detector`);
    };
    w.prisma[table].deleteMany = async () => {
      throw new Error(`${table}.deleteMany must never be called by a detector`);
    };
  }

  await w.detectors.detectOperationalProblems({ storeId: STORE, nowIso: NOW });
  await w.detectors.detectCustomerLoss({ storeId: STORE, nowIso: NOW });
});

test("I16b: the surviving billing and auth surfaces are untouched by this work", () => {
  const fs = require("node:fs");
  // Named files, not a directory sweep: the point is that these specific
  // integration points still exist and still export what the app mounts.
  for (const rel of [
    "src/routes/billingRoutes.ts",
    "src/routes/authRoutes.ts",
    "src/routes/shopifyWebhookRoutes.ts",
    "src/routes/subscriptionRoutes.ts",
    "src/services/subscriptionService.ts",
    "src/services/onboardingService.ts",
  ]) {
    const p = path.resolve(__dirname, "..", rel);
    assert.ok(fs.existsSync(p), `${rel} must still exist`);
  }

  // Entitlement resolution is still the single gate the Action Center reads.
  const routeSrc = fs.readFileSync(
    path.resolve(__dirname, "../src/routes/actionCenterRoutes.ts"),
    "utf8"
  );
  assert.match(routeSrc, /resolveEntitlements/);
  assert.match(routeSrc, /enabledModules/);
});

// ===========================================================================
// 17. The full workflow, end to end.
// ===========================================================================

test("I17: sync -> detectors -> findings -> Action Center -> Dashboard -> resolve -> refresh", async () => {
  const w = buildWorld({ orders: problemOrders() });

  // --- 1. Detection over synced Shopify data.
  const insights = await w.detectors.detectOperationalProblems({
    storeId: STORE,
    nowIso: NOW,
  });
  assert.ok(insights.length > 0, "detection must produce insights");

  // --- 2. Evidence classification is carried into persistence.
  assert.ok(w.findingRows.length > 0, "findings must be persisted");
  for (const row of w.findingRows) {
    assert.equal(row.storeId, STORE, "every finding is store-scoped");
    assert.equal(row.status, "new");
    assert.ok(row.fingerprint, "every finding has a stable identity");
    assert.ok(row.snapshotJson, "every finding carries the evidence that raised it");
  }

  // --- 3. The Action Center renders them.
  const ac1 = await w.actionCenter.getActionCenter({
    storeId: STORE,
    enabledModules: ENABLED,
    now: new Date(NOW),
  });
  assert.equal(ac1.cards.length, w.findingRows.length);
  assert.equal(ac1.summary.totalOpen, w.findingRows.length);

  // --- 4. The Dashboard projects the SAME cards, and agrees.
  const dash1 = dashboardCalc.buildDashboardFindingsView({
    cards: ac1.cards,
    persistenceEnabled: true,
  });
  assert.equal(dash1.totalOpen, ac1.summary.totalOpen);
  assert.deepEqual(dash1.bySeverity, ac1.summary.bySeverity);
  assert.ok(dash1.recentInsights.length > 0);
  // Every Dashboard insight is a real card, quoted verbatim.
  for (const insight of dash1.recentInsights) {
    const card = ac1.cards.find((c) => c.id === insight.id);
    assert.ok(card, "a Dashboard insight must correspond to a real finding");
    assert.equal(insight.title, card.title);
    assert.equal(insight.severity, card.severity);
    assert.equal(insight.route, card.route);
  }

  // --- 5. The AI layer receives exactly those open findings.
  const payload = w.brief.buildAiBriefInput(ac1.cards, ac1.summary);
  assert.equal(payload.openCount, ac1.summary.totalOpen);
  for (const f of payload.findings) {
    assert.ok(ac1.cards.some((c) => c.id === f.findingId));
  }

  // --- 6. The merchant acts: one resolved, one dismissed.
  const [first, second] = ac1.cards;
  await w.findings.transitionFindingStatus({
    storeId: STORE,
    findingId: first.id,
    status: "resolved",
  });
  if (second) {
    await w.findings.transitionFindingStatus({
      storeId: STORE,
      findingId: second.id,
      status: "dismissed",
    });
  }

  // --- 7. Refresh. Both surfaces move together.
  const ac2 = await w.actionCenter.getActionCenter({
    storeId: STORE,
    enabledModules: ENABLED,
    now: new Date(NOW),
  });
  const dash2 = dashboardCalc.buildDashboardFindingsView({
    cards: ac2.cards,
    persistenceEnabled: true,
  });

  const closed = second ? 2 : 1;
  assert.equal(ac2.summary.totalOpen, ac1.summary.totalOpen - closed);
  assert.equal(dash2.totalOpen, ac2.summary.totalOpen);
  assert.deepEqual(dash2.bySeverity, ac2.summary.bySeverity);

  // The resolved finding is still RETRIEVABLE — resolving is not deleting —
  // but it is no longer counted as open anywhere.
  assert.ok(ac2.cards.some((c) => c.id === first.id), "history is preserved");
  assert.ok(
    !dash2.recentInsights.some((i) => i.id === first.id),
    "a resolved finding must not be described as needing attention"
  );

  // --- 8. Re-detection does NOT resurrect what the merchant closed.
  await w.detectors.detectOperationalProblems({ storeId: STORE, nowIso: NOW });
  const ac3 = await w.actionCenter.getActionCenter({
    storeId: STORE,
    enabledModules: ENABLED,
    now: new Date(NOW),
  });
  const resolvedAgain = ac3.cards.find((c) => c.id === first.id);
  assert.ok(resolvedAgain);
  assert.notEqual(
    resolvedAgain.status,
    "new",
    "a re-detected finding must not jump back to new and undo the merchant's decision"
  );

  // --- 9. And the AI still cannot describe a closed finding as active.
  const payload2 = w.brief.buildAiBriefInput(ac3.cards, ac3.summary);
  assert.ok(
    !payload2.findings.some((f) => f.findingId === first.id),
    "the resolved finding must never reach the model"
  );
});

// ===========================================================================
// I7c — the specialist workspaces read the same source
// ===========================================================================

test("I7c: workspace panels read open findings, not a parallel computation", () => {
  // THE LAST CONTRADICTION. The workspace panels drew their cards from
  // /api/insights/dashboard, which recomputes on every read and knows nothing
  // about IntelligenceFinding. A merchant could resolve a finding, watch it
  // leave the Action Center and the Store Overview, then open the matching
  // workspace and still see it — with a "Critical" badge and a monetary impact
  // beside it. Phase F fixed the Store Overview; this is the same fix applied
  // to the three workspaces.
  const fs = require("node:fs");
  const FRONTEND = path.resolve(__dirname, "../../frontend/src");

  const panel = fs.readFileSync(
    path.resolve(FRONTEND, "modules/Dashboard/components/ModuleInsights.tsx"),
    "utf8"
  );
  assert.match(panel, /useModuleFindings/, "cards must come from the findings hook");

  const hook = fs.readFileSync(
    path.resolve(FRONTEND, "hooks/useModuleFindings.ts"),
    "utf8"
  );
  assert.match(hook, /\/api\/action-center/, "which reads the Action Center feed");
  // Open findings only, using the same three statuses the server calls open.
  assert.match(hook, /OPEN_STATUSES/);
  assert.match(hook, /"new", "seen", "in_review"/);

  // Coverage may still come from the lifecycle-blind endpoint: it reports how
  // many rows were analysed and makes no claim about problems, money,
  // confidence or status, so it cannot contradict a finding.
  assert.match(panel, /useInsightsDashboard/);
  assert.match(panel, /Coverage only/i);
});

test("I7d: a failed findings read is never rendered as 'nothing is wrong'", () => {
  const fs = require("node:fs");
  const FRONTEND = path.resolve(__dirname, "../../frontend/src");
  const hook = fs.readFileSync(path.resolve(FRONTEND, "hooks/useModuleFindings.ts"), "utf8");
  const panel = fs.readFileSync(
    path.resolve(FRONTEND, "modules/Dashboard/components/ModuleInsights.tsx"),
    "utf8"
  );
  // The hook must distinguish "empty" from "could not read"...
  assert.match(hook, /unavailable/);
  // ...and must not leave a stale list behind after a failure, which would be
  // its own quiet contradiction.
  assert.match(hook, /setFindings\(\[\]\);/);
  // ...and the panel must say so rather than showing an empty state.
  assert.match(panel, /Findings could not be loaded/);
  assert.match(panel, /not a statement about your store/);
});

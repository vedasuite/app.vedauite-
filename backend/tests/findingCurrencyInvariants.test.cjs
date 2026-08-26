const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const Module = require("node:module");

process.env.SHOPIFY_API_KEY ||= "test-key";
process.env.SHOPIFY_API_SECRET ||= "test-secret";
process.env.SHOPIFY_APP_URL ||= "https://app.vedasuite.in";
process.env.DATABASE_URL ||= "postgresql://example:example@localhost:5432/example";

/**
 * STORE OVERVIEW MUST SHOW THE FINDINGS THAT EXIST NOW.
 *
 * THE OBSERVED STATE
 * ------------------
 *   Reconciliation .. 3 open findings (SKU-A mismatch, SKU-C missing, SKU-D external-only)
 *   Action Center ... 3 open findings
 *   Store Overview .. 1 open finding — an OLDER COMBINED finding
 *
 * Two separate causes, both real:
 *
 * 1. SUPERSEDED FINDINGS WERE NEVER CLOSED. `recordFinding` upserts on a
 *    fingerprint, so a re-run refreshes what it still produces and leaves
 *    everything else untouched. Detector-side healing exists but is called only
 *    for pricing and competitor, and keys on `findingType` alone. Reconciliation
 *    called nothing. So a fixed mismatch stayed open, and a finding written by
 *    an older grouping rule — whose fingerprint no run can produce again —
 *    stayed open permanently. That is the "older combined finding".
 *
 * 2. A CACHED COUNT LOOKS EXACTLY LIKE A CURRENT ONE. Store Overview seeded its
 *    first paint from a sessionStorage payload. A reconciliation run creates
 *    findings without a Shopify sync, so nothing invalidated that entry.
 *
 * These tests cover the parts that live in the backend: that the two surfaces
 * derive from ONE dataset, and that a re-run supersedes what it replaces.
 */

const d = (p) => path.resolve(__dirname, `../dist/${p}`);
const STORE_ID = "store-1";
const NOW = new Date("2026-08-26T12:00:00.000Z");
const EARLIER = new Date("2026-08-20T09:00:00.000Z");
const OPEN_STATUSES = ["new", "seen", "in_review"];

function findingRow(i, opts) {
  const {
    module = "reconciliation",
    findingType,
    title,
    status = "new",
    lastSeenAt = NOW,
    subject = "s",
    sourceInsightId = `reconciliation:inventory:${findingType}`,
  } = opts;
  const snapshot = {
    id: sourceInsightId,
    storeId: STORE_ID,
    module,
    title,
    reasons: ["r"],
    evidence: [{ label: "SKU", value: subject }],
    financialImpact: { status: "impact_not_quantifiable", reason: "no cost recorded" },
    confidence: "high",
    recency: lastSeenAt.toISOString(),
    urgency: "high",
    easeOfAction: "manual",
    recommendedAction: "act",
    score: {
      total: 50,
      components: { financialImpact: 0, urgency: 25, confidence: 20, easeOfAction: 5, recency: 10 },
      weights: { financialImpact: 0.35, urgency: 0.25, confidence: 0.2, easeOfAction: 0.1, recency: 0.1 },
      excludedFromMonetaryRanking: false,
    },
    methodology: { summary: "s", assumptions: [], caps: [] },
    route: "/app/reconciliation",
    dataQuality: "ok",
  };
  return {
    id: `f${i}`,
    storeId: STORE_ID,
    fingerprint: `fp${i}`,
    module,
    findingType,
    sourceInsightId,
    status,
    firstDetectedAt: lastSeenAt,
    lastSeenAt,
    detectionCount: 1,
    statusChangedAt: null,
    resolvedAt: null,
    dismissedAt: null,
    resolutionNote: null,
    statusChangedBy: null,
    snapshotJson: JSON.stringify(snapshot),
    createdAt: lastSeenAt,
    updatedAt: lastSeenAt,
  };
}

/** The three findings the latest inventory run produces. */
const LATEST_THREE = [
  findingRow(1, {
    findingType: "reconciliation_quantity_mismatch",
    subject: "SKU-A",
    title: "SKU-A quantity mismatch: Shopify 20 vs file 13",
  }),
  findingRow(2, {
    findingType: "reconciliation_missing_externally",
    subject: "SKU-C",
    title: "SKU-C is in Shopify but missing from your file",
  }),
  findingRow(3, {
    findingType: "reconciliation_external_only",
    subject: "SKU-D",
    title: "SKU-D is in your file but not in Shopify",
  }),
];

/** The finding an older grouping rule wrote. No current run can reproduce it. */
const OLDER_COMBINED = findingRow(9, {
  findingType: "reconciliation_inventory_combined",
  subject: "combined",
  title: "1 SKU has inventory mismatches between Shopify and your uploaded file",
  lastSeenAt: EARLIER,
});

function loadActionCenter(rows) {
  const source = d("services/actionCenterService.js");
  const code = fs.readFileSync(source, "utf8");
  const mod = new Module(source);
  mod.filename = source;
  mod.paths = Module._nodeModulePaths(path.dirname(source));
  const real = mod.require.bind(mod);
  mod.require = (r) =>
    r.endsWith("prismaClient")
      ? {
          prisma: {
            intelligenceFinding: {
              findMany: async (args) =>
                rows.filter((row) => row.storeId === args?.where?.storeId),
            },
          },
        }
      : real(r);
  mod._compile(code, source);
  return mod.exports;
}

/**
 * Both surfaces, from ONE dataset, through the REAL functions each one calls.
 * dashboardService projects Action Center's cards; this mirrors that exactly.
 */
async function bothSurfaces(rows, enabledModules = ["fraud", "competitor", "pricing", "profit"]) {
  const ac = loadActionCenter(rows);
  const calc = require(d("services/dashboardFindingsCalc.js"));
  const result = await ac.getActionCenter({ storeId: STORE_ID, enabledModules, now: NOW });
  const view = calc.buildDashboardFindingsView({
    cards: result.cards,
    persistenceEnabled: true,
    enabledModules,
  });
  return { actionCenter: result, storeOverview: view, calc };
}

const openCount = (rows) =>
  rows.filter((r) => r.storeId === STORE_ID && OPEN_STATUSES.includes(r.status)).length;

// ===========================================================================

test("the latest three findings read as 3 on all three surfaces", async () => {
  const rows = [...LATEST_THREE];
  const { actionCenter, storeOverview } = await bothSurfaces(rows);

  assert.equal(openCount(rows), 3, "Reconciliation workspace counts 3");
  assert.equal(actionCenter.summary.totalOpen, 3, "Action Center totals 3");
  assert.equal(storeOverview.totalOpen, 3, "Store Overview totals 3");
  assert.equal(storeOverview.kpis.reconciliation, 3, "Reconciliation tile shows 3");

  // Every one of the three cases is present, not just the count.
  const titles = actionCenter.cards.map((c) => c.title).join(" | ");
  for (const sku of ["SKU-A", "SKU-C", "SKU-D"]) {
    assert.match(titles, new RegExp(sku), `${sku} must be one of the three`);
  }
});

test("Store Overview totals derive from the SAME cards Action Center shows", async () => {
  // Property: for any mix of modules and statuses, the two must agree.
  const mixes = [
    [...LATEST_THREE],
    [...LATEST_THREE, OLDER_COMBINED],
    [LATEST_THREE[0]],
    [
      ...LATEST_THREE,
      findingRow(20, { module: "fraud", findingType: "refund_abuse", title: "Refund abuse", subject: "c1" }),
      findingRow(21, { module: "competitor", findingType: "market_signal", title: "Price move", subject: "d1" }),
    ],
    [{ ...LATEST_THREE[0], status: "resolved" }, LATEST_THREE[1], LATEST_THREE[2]],
    [{ ...LATEST_THREE[0], status: "dismissed" }, { ...LATEST_THREE[1], status: "resolved" }],
  ];

  for (const rows of mixes) {
    const { actionCenter, storeOverview, calc } = await bothSurfaces(rows);
    assert.equal(
      storeOverview.totalOpen,
      actionCenter.summary.totalOpen,
      `Store Overview total must equal Action Center's for ${JSON.stringify(rows.map((r) => `${r.module}:${r.status}`))}`
    );
    // ...and the tiles must decompose that same total, never a second count.
    const tileSum = calc.DASHBOARD_KPI_KEYS.reduce((n, k) => n + storeOverview.kpis[k], 0);
    assert.equal(tileSum, storeOverview.totalOpen, "tiles must sum to the total");
  }
});

test("resolved findings leave every surface together", async () => {
  const rows = LATEST_THREE.map((r) => ({ ...r, status: "resolved", resolvedAt: NOW }));
  const { actionCenter, storeOverview } = await bothSurfaces(rows);

  assert.equal(openCount(rows), 0);
  assert.equal(actionCenter.summary.totalOpen, 0);
  assert.equal(storeOverview.totalOpen, 0);
  assert.equal(storeOverview.kpis.reconciliation, 0);
  assert.deepEqual(storeOverview.recentInsights, [], "no top finding may survive");
});

test("REGRESSION: a superseded older finding does not linger as current", async () => {
  // Before: the older combined finding stayed open forever, so Store Overview
  // presented it as the current state of the store.
  const stale = [...LATEST_THREE, OLDER_COMBINED];
  const before = await bothSurfaces(stale);
  assert.equal(before.storeOverview.totalOpen, 4, "while it is open it counts — nothing hides it");

  // After the run closes what it no longer produces:
  const afterRows = [...LATEST_THREE, { ...OLDER_COMBINED, status: "resolved", resolvedAt: NOW }];
  const after = await bothSurfaces(afterRows);

  assert.equal(openCount(afterRows), 3);
  assert.equal(after.actionCenter.summary.totalOpen, 3);
  assert.equal(after.storeOverview.totalOpen, 3);
  assert.equal(after.storeOverview.kpis.reconciliation, 3);

  const topTitles = after.storeOverview.recentInsights.map((i) => i.title).join(" | ");
  assert.ok(
    !/older|combined|1 SKU has inventory mismatches/i.test(topTitles),
    `the superseded finding must not appear in Top findings: "${topTitles}"`
  );
});

test("closeSupersededFindings closes only what this run no longer produces", async () => {
  const svc = require(d("services/intelligenceFindingService.js"));
  const transitions = [];

  const rows = [...LATEST_THREE, OLDER_COMBINED];
  const prismaPath = d("db/prismaClient.js");
  const prisma = require(prismaPath).prisma;
  const originalFinding = prisma.intelligenceFinding;

  prisma.intelligenceFinding = {
    findMany: async ({ where }) =>
      rows.filter(
        (r) =>
          r.storeId === where.storeId &&
          r.module === where.module &&
          where.status.in.includes(r.status) &&
          r.sourceInsightId.startsWith(where.sourceInsightId.startsWith)
      ),
    findFirst: async ({ where }) =>
      rows.find((r) => r.id === where.id && r.storeId === where.storeId) ?? null,
    update: async ({ where, data }) => {
      transitions.push({ id: where.id, status: data.status });
      return { ...rows.find((r) => r.id === where.id), ...data };
    },
  };

  try {
    const closed = await svc.closeSupersededFindings({
      storeId: STORE_ID,
      module: "reconciliation",
      sourceInsightIdPrefix: "reconciliation:inventory:",
      // Exactly the three the latest run produced.
      stillDetected: new Set(["fp1", "fp2", "fp3"]),
      note: "superseded",
    });

    assert.equal(closed, 1, "only the older combined finding is superseded");
    assert.deepEqual(
      transitions.map((t) => t.id),
      ["f9"],
      "the three current findings must be left alone"
    );
  } finally {
    prisma.intelligenceFinding = originalFinding;
  }
});

test("a run never closes another check type's findings", async () => {
  const svc = require(d("services/intelligenceFindingService.js"));
  const transitions = [];

  // An open 3PL invoice finding, while an INVENTORY run completes.
  const invoiceFinding = findingRow(30, {
    findingType: "reconciliation_overcharge",
    title: "3PL overcharge",
    subject: "inv-1",
    sourceInsightId: "reconciliation:3pl_invoice:reconciliation_overcharge",
  });
  const rows = [...LATEST_THREE, invoiceFinding];

  const prismaPath = d("db/prismaClient.js");
  const prisma = require(prismaPath).prisma;
  const originalFinding = prisma.intelligenceFinding;
  prisma.intelligenceFinding = {
    findMany: async ({ where }) =>
      rows.filter(
        (r) =>
          r.storeId === where.storeId &&
          r.module === where.module &&
          where.status.in.includes(r.status) &&
          r.sourceInsightId.startsWith(where.sourceInsightId.startsWith)
      ),
    findFirst: async ({ where }) =>
      rows.find((r) => r.id === where.id && r.storeId === where.storeId) ?? null,
    update: async ({ where, data }) => {
      transitions.push(where.id);
      return { ...rows.find((r) => r.id === where.id), ...data };
    },
  };

  try {
    const closed = await svc.closeSupersededFindings({
      storeId: STORE_ID,
      module: "reconciliation",
      sourceInsightIdPrefix: "reconciliation:inventory:",
      stillDetected: new Set(["fp1", "fp2", "fp3"]),
      note: "superseded",
    });
    assert.equal(closed, 0);
    assert.ok(
      !transitions.includes("f30"),
      "an inventory run must never close a 3PL invoice finding"
    );
  } finally {
    prisma.intelligenceFinding = originalFinding;
  }
});

test("the reconciliation run supersedes by fingerprint, scoped to its check", () => {
  // Source-level: the wiring is the part that regressed by being absent, and it
  // is not reachable from a pure unit test.
  const src = fs.readFileSync(
    path.resolve(__dirname, "../src/services/reconciliationService.ts"),
    "utf8"
  );
  assert.match(src, /closeSupersededFindings\(/, "the run must close superseded findings");
  assert.match(
    src,
    /sourceInsightIdPrefix: `reconciliation:\$\{checkType\}:`/,
    "closing must be scoped to the check type that just ran"
  );
  assert.match(
    src,
    /stillDetected: producedFingerprints/,
    "identity must be the fingerprints this run produced"
  );
  // Truncation is a display cap. Deriving the set from persisted discrepancies
  // would close a finding whose rows merely fell outside the slice.
  assert.match(src, /producedFingerprints\.add\(fingerprint\)/);
});

test("Store Overview holds no count path of its own", () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, "../../frontend/src/modules/Dashboard/DashboardPage.tsx"),
    "utf8"
  );

  // The legacy `?? metrics?.x` fallbacks were a second source for the same
  // number. They agreed only because the backend copied them.
  for (const legacy of [
    "metrics?.fraudAlertsToday",
    "metrics?.competitorPriceChanges",
    "metrics?.aiPricingSuggestions",
    "metrics?.profitOptimizationOpportunities",
  ]) {
    assert.ok(
      !src.includes(legacy),
      `${legacy} is a competing count path and must not feed a tile`
    );
  }

  // A cache-seeded payload must not carry counts into the first paint.
  assert.match(src, /function withheldFindings\(/);
  assert.match(src, /withheldFindings\(readModuleCache/);
});

test("a reconciliation run invalidates the Store Overview cache", () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, "../../frontend/src/modules/Reconciliation/ReconciliationPage.tsx"),
    "utf8"
  );
  // A run creates findings with no Shopify sync, so nothing else clears it.
  assert.match(src, /clearModuleCache\("dashboard-overview"\)/);
});

test("AUDIT: every finding-producing module reaches both surfaces identically", async () => {
  // Requirement 6 as an executable check: this must not be able to recur for
  // Customer Loss, Market Signals, Pricing or Product Profit either.
  const MODULES = [
    { module: "fraud", kpi: "fraudAlerts" },
    { module: "trust", kpi: "fraudAlerts" },
    { module: "return_abuse", kpi: "fraudAlerts" },
    { module: "competitor", kpi: "competitorChanges" },
    { module: "pricing", kpi: "pricingOpportunities" },
    { module: "profit", kpi: "profitOpportunities" },
    { module: "reconciliation", kpi: "reconciliation" },
    { module: "operational", kpi: "storeHealth" },
  ];

  for (const { module, kpi } of MODULES) {
    const rows = [
      findingRow(50, { module, findingType: `${module}_a`, title: `${module} A`, subject: "x" }),
      findingRow(51, { module, findingType: `${module}_b`, title: `${module} B`, subject: "y" }),
    ];
    const { actionCenter, storeOverview } = await bothSurfaces(rows, [
      "fraud",
      "competitor",
      "pricing",
      "profit",
    ]);

    assert.equal(
      storeOverview.totalOpen,
      actionCenter.summary.totalOpen,
      `${module}: Store Overview and Action Center totals must match`
    );
    assert.equal(
      storeOverview.kpis[kpi],
      2,
      `${module}: its tile must carry both findings`
    );
  }
});

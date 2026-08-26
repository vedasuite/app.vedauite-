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
 * ONE RECONCILIATION FINDING MUST BE ONE EVERYWHERE.
 *
 * The bug this file exists to prevent: staging showed a Growth merchant
 *
 *   Reconciliation workspace ... 1 open reconciliation finding
 *   Action Center ............... 0 open findings
 *   Store Overview .............. 0 findings
 *
 * from a single database row. The root cause was not the counters and not the
 * copy: `KPI_MODULES` in dashboardFindingsCalc had no `reconciliation` entry,
 * so the finding was projected onto no Dashboard tile. It was counted in
 * `totalOpen`, but every tile a merchant actually reads summed to zero.
 *
 * These tests drive the REAL services — the same functions the three surfaces
 * call — from ONE row, and assert the three answers are the same number.
 */

const d = (p) => path.resolve(__dirname, `../dist/${p}`);

const STORE_ID = "store-recon-1";
const NOW = new Date("2026-08-26T12:00:00.000Z");

/** Statuses every surface agrees mean "still open". */
const OPEN_STATUSES = ["new", "seen", "in_review"];

/**
 * A finding shaped exactly as reconciliationService writes it for an inventory
 * quantity mismatch — including `impact_not_quantifiable`, which is the normal
 * case when the merchant has not supplied unit costs.
 */
function reconciliationFindingRow(overrides = {}) {
  const snapshot = {
    id: "reconciliation:inventory:quantity_mismatch",
    storeId: STORE_ID,
    module: "reconciliation",
    title: "1 SKU has inventory mismatches between Shopify and your uploaded file",
    reasons: [
      "SKU-A: Shopify says 20, your file says 13.",
      "Compared against the file you uploaded on 26 August.",
    ],
    evidence: [
      { label: "Check", value: "Inventory" },
      { label: "SKU", value: "SKU-A" },
    ],
    financialImpact: {
      status: "impact_not_quantifiable",
      reason: "No unit cost is recorded for this SKU.",
    },
    confidence: "high",
    recency: NOW.toISOString(),
    urgency: "high",
    easeOfAction: "manual",
    recommendedAction: "Open each SKU below and confirm the true stock level.",
    score: {
      total: 50,
      components: {
        financialImpact: 0,
        urgency: 25,
        confidence: 20,
        easeOfAction: 5,
        recency: 10,
      },
      weights: {
        financialImpact: 0.35,
        urgency: 0.25,
        confidence: 0.2,
        easeOfAction: 0.1,
        recency: 0.1,
      },
      excludedFromMonetaryRanking: false,
    },
    methodology: {
      summary: "Shopify inventory compared row by row against the uploaded file.",
      assumptions: [],
      caps: [],
    },
    route: "/app/reconciliation",
    dataQuality: "ok",
  };

  return {
    id: "finding-recon-1",
    storeId: STORE_ID,
    fingerprint: "fp-recon-1",
    module: "reconciliation",
    findingType: "reconciliation_inventory_quantity_mismatch",
    sourceInsightId: snapshot.id,
    status: "new",
    firstDetectedAt: NOW,
    lastSeenAt: NOW,
    detectionCount: 1,
    statusChangedAt: null,
    resolvedAt: null,
    dismissedAt: null,
    resolutionNote: null,
    statusChangedBy: null,
    snapshotJson: JSON.stringify(snapshot),
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

/**
 * Loads actionCenterService against a stubbed Prisma so the real filter chain
 * runs — entitlement mapping, snapshot parsing, ranking and summary included.
 */
function loadActionCenterWithRows(rows) {
  const source = d("services/actionCenterService.js");
  const code = fs.readFileSync(source, "utf8");
  const mod = new Module(source);
  mod.filename = source;
  mod.paths = Module._nodeModulePaths(path.dirname(source));
  const realRequire = mod.require.bind(mod);
  mod.require = (request) => {
    if (request.endsWith("prismaClient")) {
      return {
        prisma: {
          intelligenceFinding: {
            findMany: async (args) => {
              // The stub is only honest if it filters the way Prisma would.
              const wanted = args?.where?.status?.in ?? OPEN_STATUSES;
              return rows.filter(
                (r) => r.storeId === args?.where?.storeId && wanted.includes(r.status)
              );
            },
          },
        },
      };
    }
    return realRequire(request);
  };
  mod._compile(code, source);
  return mod.exports;
}

/** What the Reconciliation workspace counts, expressed as the same predicate. */
function reconciliationWorkspaceCount(rows) {
  return rows.filter(
    (r) =>
      r.storeId === STORE_ID &&
      r.module === "reconciliation" &&
      OPEN_STATUSES.includes(r.status)
  ).length;
}

test("every finding module has a Dashboard tile to land on", () => {
  const calc = require(d("services/dashboardFindingsCalc.js"));

  // These are the module values `recordFinding` is called with anywhere in the
  // product. A module missing from KPI_MODULES is an invisible finding.
  const producedModules = [
    "operational",
    "fraud",
    "trust",
    "return_abuse",
    "competitor",
    "pricing",
    "profit",
    "reconciliation",
  ];

  const mapped = new Set();
  for (const key of calc.DASHBOARD_KPI_KEYS) {
    for (const m of calc.KPI_MODULES[key]) mapped.add(m);
  }

  const orphans = producedModules.filter((m) => !mapped.has(m));
  assert.deepEqual(
    orphans,
    [],
    `These modules produce findings but appear on no Dashboard tile: ${orphans.join(", ")}`
  );
});

test("reconciliation has its own tile rather than borrowing another module's", () => {
  const calc = require(d("services/dashboardFindingsCalc.js"));
  assert.ok(
    calc.DASHBOARD_KPI_KEYS.includes("reconciliation"),
    "Dashboard must expose a reconciliation KPI"
  );
  assert.deepEqual(calc.KPI_MODULES.reconciliation, ["reconciliation"]);

  // Folding reconciliation into, say, fraudAlerts would make the total agree
  // while telling the merchant the wrong thing about which check fired.
  for (const key of calc.DASHBOARD_KPI_KEYS) {
    if (key === "reconciliation") continue;
    assert.ok(
      !calc.KPI_MODULES[key].includes("reconciliation"),
      `reconciliation must not also feed ${key}`
    );
  }
});

test("one reconciliation finding reads as 1 on all three surfaces", async () => {
  const rows = [reconciliationFindingRow()];

  // SURFACE 1 — Reconciliation workspace.
  const workspaceCount = reconciliationWorkspaceCount(rows);
  assert.equal(workspaceCount, 1, "Reconciliation workspace should count 1");

  // SURFACE 2 — Action Center. A Growth merchant entitled to Inventory
  // Reconciliation; the enabled-module list deliberately omits reconciliation
  // to prove the null-capability path really is unconditional.
  const actionCenter = loadActionCenterWithRows(rows);
  const ac = await actionCenter.getActionCenter({
    storeId: STORE_ID,
    enabledModules: ["fraud", "competitor", "pricing", "profit"],
    now: NOW,
  });
  assert.equal(ac.summary.totalOpen, 1, "Action Center total should be 1");
  assert.equal(ac.cards.length, 1, "Action Center should list the card");
  assert.equal(ac.cards[0].module, "reconciliation");

  // SURFACE 3 — Store Overview, projected from the very cards above.
  const calc = require(d("services/dashboardFindingsCalc.js"));
  const view = calc.buildDashboardFindingsView({
    cards: ac.cards,
    persistenceEnabled: true,
    enabledModules: ["fraud", "competitor", "pricing", "profit"],
  });

  assert.equal(view.totalOpen, 1, "Store Overview total should be 1");
  assert.equal(
    view.kpis.reconciliation,
    1,
    "Store Overview reconciliation tile should be 1 — this is the tile that read 0"
  );

  // The three numbers a merchant compares.
  assert.equal(workspaceCount, ac.summary.totalOpen);
  assert.equal(ac.summary.totalOpen, view.kpis.reconciliation);

  // And the tiles must sum to the total, or one screen is lying about the other.
  const tileSum = calc.DASHBOARD_KPI_KEYS.reduce((n, k) => n + view.kpis[k], 0);
  assert.equal(
    tileSum,
    view.totalOpen,
    "Dashboard tiles must sum to the Dashboard total"
  );
});

test("a resolved reconciliation finding reads as 0 on all three surfaces", async () => {
  const rows = [
    reconciliationFindingRow({ status: "resolved", resolvedAt: NOW }),
  ];

  assert.equal(reconciliationWorkspaceCount(rows), 0);

  const actionCenter = loadActionCenterWithRows(rows);
  const ac = await actionCenter.getActionCenter({
    storeId: STORE_ID,
    enabledModules: ["fraud", "competitor", "pricing", "profit"],
    now: NOW,
  });
  assert.equal(ac.summary.totalOpen, 0);

  const calc = require(d("services/dashboardFindingsCalc.js"));
  const view = calc.buildDashboardFindingsView({
    cards: ac.cards,
    persistenceEnabled: true,
    enabledModules: ["fraud", "competitor", "pricing", "profit"],
  });
  assert.equal(view.kpis.reconciliation, 0);
  assert.equal(view.totalOpen, 0);
});

test("reconciliation findings are never hidden by entitlement filtering", async () => {
  // Reconciliation maps to a null capability: operational-class findings are
  // visible regardless of which modules the plan enables. If this ever changes,
  // an entitled merchant's finding disappears from Action Center only.
  const explain = require(d("services/explainabilityCalc.js"));
  assert.equal(explain.MODULE_CAPABILITY.reconciliation, null);

  const rows = [reconciliationFindingRow()];
  const actionCenter = loadActionCenterWithRows(rows);

  for (const enabledModules of [[], ["fraud"], ["fraud", "competitor", "pricing", "profit"]]) {
    const ac = await actionCenter.getActionCenter({
      storeId: STORE_ID,
      enabledModules,
      now: NOW,
    });
    assert.equal(
      ac.summary.totalOpen,
      1,
      `Reconciliation finding vanished with enabledModules=${JSON.stringify(enabledModules)}`
    );
  }
});

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

process.env.SHOPIFY_API_KEY ||= "test-key";
process.env.SHOPIFY_API_SECRET ||= "test-secret";
process.env.SHOPIFY_APP_URL ||= "https://app.vedasuite.in";
process.env.DATABASE_URL ||= "postgresql://example:example@localhost:5432/example";

/**
 * THE REAL-DATA LIFECYCLE, END TO END.
 *
 * WHY THIS EXISTS SEPARATELY FROM I17
 * -----------------------------------
 * Every screenshot taken on staging so far was of an EMPTY store: zero
 * products, orders, customers, pricing rows, profit rows and competitor rows.
 * That proves the empty-data path and nothing else. Every interesting failure
 * in this programme — a resolved finding still counted, a dismissed problem
 * still described, a re-detection resurrecting closed work — needs a finding to
 * exist before it can happen at all.
 *
 * I17 walks the chain using the OPERATIONAL family, which is derived from sync
 * health. This walks it using CUSTOMER LOSS, which is derived from real order
 * and refund rows, and it drives the deterministic brief's actual PROSE rather
 * than just the payload handed to the model.
 *
 * NO EVIDENCE RULE IS WEAKENED TO MAKE THIS PASS. The fixture clears every
 * documented CUSTOMER_LOSS threshold honestly: 60 baseline orders for a store
 * baseline, and one customer with 4 eligible orders of which 3 are refunded.
 * If a threshold were ever tightened past this fixture, the right response is a
 * bigger fixture, never a smaller threshold.
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
};

const NOW = "2026-08-25T00:00:00.000Z";
const daysAgo = (n) => new Date(new Date(NOW).getTime() - n * 86_400_000);
const STORE = "store-1";
const ENABLED = ["fraud", "competitor", "pricing", "profit"];

/**
 * A store with genuine repeated customer loss.
 *
 * 60 baseline orders establish the store's normal refund rate; one customer has
 * 4 paid orders with 3 refunded, so 75% of their value came back. Both the
 * per-customer thresholds and the store-baseline minimum are cleared on merit.
 */
function realStore() {
  const baseline = Array.from({ length: 60 }, (_, i) => ({
    id: `base-${i}`,
    storeId: STORE,
    customerId: `other-${i}`,
    status: "paid",
    refunded: i < 3,
    totalAmount: 100,
    currency: "USD",
    fraudRiskLevel: "Low",
    createdAt: daysAgo(30 + i),
  }));
  const lossy = Array.from({ length: 4 }, (_, i) => ({
    id: `loss-${i}`,
    storeId: STORE,
    customerId: "cust-loss",
    status: "paid",
    refunded: i < 3,
    totalAmount: 200,
    currency: "USD",
    fraudRiskLevel: "Low",
    createdAt: daysAgo(10 + i),
  }));
  return {
    orders: [...baseline, ...lossy],
    customers: [
      { id: "cust-loss", storeId: STORE, fraudSignalsCount: 2, updatedAt: daysAgo(1) },
    ],
  };
}

function buildWorld({ orders = [], customers = [], seed = [] } = {}) {
  Object.values(PATHS).forEach((p) => {
    try {
      resetModule(p);
    } catch {
      /* not yet loaded */
    }
  });
  process.env.ENABLE_INTELLIGENCE_FINDING_PERSISTENCE = "true";

  const prisma = require(PATHS.prisma).prisma;
  require(PATHS.obs).logEvent = () => {};

  const rows = seed.map((r) => ({ ...r }));
  let seq = rows.length;
  const byStore = (list, where) => list.filter((r) => r.storeId === where.storeId);

  prisma.order = {
    findMany: async ({ where }) =>
      orders.filter(
        (o) =>
          o.storeId === where.storeId &&
          (where.createdAt?.gte === undefined || o.createdAt >= where.createdAt.gte) &&
          (where.customerId === undefined || o.customerId === where.customerId)
      ),
  };
  prisma.customer = { findMany: async ({ where }) => byStore(customers, where) };
  prisma.syncJob = { findMany: async () => [] };
  prisma.store = {
    findUnique: async () => ({
      id: STORE,
      shop: "test.myshopify.com",
      lastSyncAt: daysAgo(1),
      lastConnectionStatus: "OK",
      lastWebhookRegistrationStatus: "OK",
      accessTokenExpiresAt: null,
    }),
  };
  prisma.productSnapshot = { findMany: async () => [] };
  prisma.profitOptimizationData = { findMany: async () => [] };
  prisma.priceHistory = { findMany: async () => [] };
  prisma.competitorDomain = { findMany: async () => [] };
  prisma.competitorData = { findMany: async () => [] };

  prisma.intelligenceFinding = {
    findUnique: async ({ where }) => {
      const { storeId, fingerprint } = where.storeId_fingerprint;
      const row = rows.find((r) => r.storeId === storeId && r.fingerprint === fingerprint);
      return row ? { ...row } : null;
    },
    upsert: async ({ where, update, create }) => {
      const { storeId, fingerprint } = where.storeId_fingerprint;
      const existing = rows.find(
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
      rows.push(row);
      return { ...row };
    },
    update: async ({ where, data }) => {
      const row = rows.find((r) => r.id === where.id);
      Object.assign(row, data);
      return { ...row };
    },
    findFirst: async ({ where }) =>
      rows.find(
        (r) =>
          (where.id === undefined || r.id === where.id) &&
          (where.storeId === undefined || r.storeId === where.storeId)
      ) ?? null,
    findMany: async ({ where = {} } = {}) =>
      rows
        .filter((r) => {
          if (where.storeId !== undefined && r.storeId !== where.storeId) return false;
          if (where.module !== undefined && r.module !== where.module) return false;
          if (where.status !== undefined) {
            if (typeof where.status === "string") return r.status === where.status;
            if (Array.isArray(where.status.in)) return where.status.in.includes(r.status);
          }
          return true;
        })
        .map((r) => ({ ...r })),
    updateMany: async () => ({ count: 0 }),
  };

  return {
    rows,
    detectors: require(PATHS.detector),
    findings: require(PATHS.finding),
    actionCenter: require(PATHS.actionCenter),
    brief: require(PATHS.brief),
    dashboard: require(PATHS.dashboardCalc),
  };
}

const read = (w) =>
  w.actionCenter.getActionCenter({
    storeId: STORE,
    enabledModules: ENABLED,
    now: new Date(NOW),
  });

/** What the Customer Loss workspace panel would show, per useModuleFindings. */
const CUSTOMER_LOSS_MODULES = new Set(["fraud", "trust", "return_abuse"]);
const OPEN = new Set(["new", "seen", "in_review"]);
const workspaceCards = (cards) =>
  cards.filter((c) => CUSTOMER_LOSS_MODULES.has(c.module) && OPEN.has(c.status));

// ===========================================================================

test("REAL DATA: a qualifying finding is generated from actual orders and refunds", async () => {
  const w = buildWorld(realStore());
  await w.detectors.detectCustomerLoss({ storeId: STORE, nowIso: NOW });

  assert.ok(
    w.rows.length > 0,
    "the fixture must produce a real finding — an empty store proves nothing"
  );
  for (const row of w.rows) {
    assert.equal(row.storeId, STORE);
    assert.equal(row.status, "new");
    assert.ok(row.snapshotJson, "the evidence that raised it must be stored with it");
  }
});

test("REAL DATA: the full lifecycle stays consistent across every surface", async () => {
  const w = buildWorld(realStore());

  // --- sync -> detectors
  await w.detectors.detectCustomerLoss({ storeId: STORE, nowIso: NOW });
  assert.ok(w.rows.length > 0);

  // --- Action Center
  const ac1 = await read(w);
  assert.ok(ac1.cards.length > 0, "the finding must reach the Action Center");
  assert.equal(ac1.summary.totalOpen, ac1.cards.length);

  // --- Store Overview
  const dash1 = w.dashboard.buildDashboardFindingsView({
    cards: ac1.cards,
    persistenceEnabled: true,
  });
  assert.equal(dash1.totalOpen, ac1.summary.totalOpen);
  assert.ok(dash1.kpis.fraudAlerts > 0, "it must land on the Customer Loss tile");

  // --- the specialist workspace
  const ws1 = workspaceCards(ac1.cards);
  assert.equal(
    ws1.length,
    ac1.cards.filter((c) => CUSTOMER_LOSS_MODULES.has(c.module)).length,
    "every open customer-loss card is visible in its workspace"
  );

  // --- the summary a merchant reads
  const brief1 = w.brief.buildDeterministicBrief(ac1.cards, ac1.summary);
  const target = ac1.cards[0];
  assert.ok(
    brief1.referencedFindingIds.includes(target.id),
    "the summary must reference the finding while it is open"
  );

  // --- merchant resolves it
  await w.findings.transitionFindingStatus({
    storeId: STORE,
    findingId: target.id,
    status: "resolved",
  });

  // --- it disappears from every lifecycle surface at once
  const ac2 = await read(w);
  const dash2 = w.dashboard.buildDashboardFindingsView({
    cards: ac2.cards,
    persistenceEnabled: true,
  });
  const ws2 = workspaceCards(ac2.cards);

  assert.equal(ac2.summary.totalOpen, ac1.summary.totalOpen - 1);
  assert.equal(dash2.totalOpen, ac2.summary.totalOpen, "Store Overview follows immediately");
  assert.ok(!ws2.some((c) => c.id === target.id), "and so does the workspace");
  assert.ok(
    !dash2.recentInsights.some((i) => i.id === target.id),
    "a resolved finding is not described as needing attention"
  );
  // Resolving is not deleting: the record is still retrievable.
  assert.ok(ac2.cards.some((c) => c.id === target.id));

  // --- sync again
  await w.detectors.detectCustomerLoss({ storeId: STORE, nowIso: NOW });
  const ac3 = await read(w);
  const again = ac3.cards.find((c) => c.id === target.id);

  assert.ok(again, "re-detection must update the same row, not create a second one");
  assert.notEqual(
    again.status,
    "new",
    "a resolved finding must never return as NEW and undo the merchant's decision"
  );
  assert.equal(again.status, "resolved");
  assert.equal(w.rows.length, ac1.cards.length, "no duplicate row was created");

  // --- and the summary no longer mentions it
  const brief3 = w.brief.buildDeterministicBrief(ac3.cards, ac3.summary);
  assert.ok(
    !brief3.referencedFindingIds.includes(target.id),
    "the summary must not describe a resolved finding as active"
  );

  const payload = w.brief.buildAiBriefInput(ac3.cards, ac3.summary);
  assert.ok(
    !payload.findings.some((f) => f.findingId === target.id),
    "and the model must never be handed it either"
  );
});

test("REAL DATA: dismissing behaves the same way as resolving", async () => {
  const w = buildWorld(realStore());
  await w.detectors.detectCustomerLoss({ storeId: STORE, nowIso: NOW });

  const ac1 = await read(w);
  const target = ac1.cards[0];
  await w.findings.transitionFindingStatus({
    storeId: STORE,
    findingId: target.id,
    status: "dismissed",
  });

  await w.detectors.detectCustomerLoss({ storeId: STORE, nowIso: NOW });
  const ac2 = await read(w);
  const again = ac2.cards.find((c) => c.id === target.id);

  assert.equal(again.status, "dismissed", "re-detection must not resurrect dismissed work");
  const dash = w.dashboard.buildDashboardFindingsView({
    cards: ac2.cards,
    persistenceEnabled: true,
  });
  assert.equal(dash.totalOpen, ac2.summary.totalOpen);
  assert.ok(!workspaceCards(ac2.cards).some((c) => c.id === target.id));
});

test("REAL DATA: an unchanged finding is re-detected in place, not duplicated", async () => {
  const w = buildWorld(realStore());

  await w.detectors.detectCustomerLoss({ storeId: STORE, nowIso: NOW });
  const first = w.rows.length;
  const firstSeen = w.rows[0].detectionCount;

  await w.detectors.detectCustomerLoss({ storeId: STORE, nowIso: NOW });
  await w.detectors.detectCustomerLoss({ storeId: STORE, nowIso: NOW });

  assert.equal(w.rows.length, first, "three runs, one row");
  assert.ok(
    w.rows[0].detectionCount > firstSeen,
    "but each run is recorded, so the merchant can see it is still happening"
  );
  assert.equal(w.rows[0].status, "new", "and an untouched finding keeps its status");
});

test("SAFETY: the fixture proves loss patterns, and an empty store still yields nothing", async () => {
  // The empty path must remain honestly empty — this is the state every staging
  // screenshot so far has actually shown.
  const empty = buildWorld({ orders: [], customers: [] });
  await empty.detectors.detectCustomerLoss({ storeId: STORE, nowIso: NOW });
  assert.equal(empty.rows.length, 0, "no data must produce no findings, not a placeholder");

  const ac = await read(empty);
  assert.equal(ac.cards.length, 0);
  const dash = empty.dashboard.buildDashboardFindingsView({
    cards: ac.cards,
    persistenceEnabled: true,
  });
  assert.equal(dash.available, true, "persistence is on, so zero is a real measurement");
  assert.match(dash.attentionDetail, /real result, not a loading state/i);
});

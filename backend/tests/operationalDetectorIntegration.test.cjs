const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

process.env.SHOPIFY_API_KEY ||= "test-key";
process.env.SHOPIFY_API_SECRET ||= "test-secret";
process.env.SHOPIFY_APP_URL ||= "https://app.vedasuite.in";
process.env.DATABASE_URL ||= "postgresql://example:example@localhost:5432/example";

/**
 * PART 3 — operational detector integration: persistence through the Part 1
 * foundation, the cooldown safeguard, store scoping, and the guarantee that no
 * store data is written.
 */

function resetModule(p) {
  delete require.cache[require.resolve(p)];
}

const PRISMA = path.resolve(__dirname, "../dist/db/prismaClient.js");
const OBS = path.resolve(__dirname, "../dist/services/observabilityService.js");
const ENV = path.resolve(__dirname, "../dist/config/env.js");
const FINDING = path.resolve(__dirname, "../dist/services/intelligenceFindingService.js");
const DETECTOR = path.resolve(__dirname, "../dist/services/intelligenceDetectorService.js");

const NOW = "2026-08-22T00:00:00.000Z";
const DAY = 86_400_000;
const daysAgo = (n) => new Date(new Date(NOW).getTime() - n * DAY);
const STORE = "store-1";
const OTHER = "store-2";

function buildWorld({
  flagEnabled = true,
  orders = [],
  syncJobs = [],
  store = {},
  products = [],
  profitRows = [],
  seedFindings = [],
} = {}) {
  [PRISMA, OBS, ENV, FINDING, DETECTOR].forEach(resetModule);
  process.env.ENABLE_INTELLIGENCE_FINDING_PERSISTENCE = flagEnabled ? "true" : "false";

  const prisma = require(PRISMA).prisma;
  const logged = [];
  require(OBS).logEvent = (l, e, d) => logged.push({ level: l, event: e, details: d });

  const findingRows = [...seedFindings];
  const writes = [];
  let seq = findingRows.length;

  prisma.order = {
    findMany: async ({ where }) => {
      writes.push({ table: "order", op: "read" });
      return orders.filter(
        (o) =>
          o.storeId === where.storeId &&
          (where.createdAt?.gte === undefined || o.createdAt >= where.createdAt.gte) &&
          (where.customerId === undefined || o.customerId === where.customerId)
      );
    },
  };
  prisma.customer = { findMany: async () => [] };
  prisma.syncJob = {
    findMany: async ({ where }) => {
      writes.push({ table: "syncJob", op: "read" });
      return syncJobs.filter((j) => j.storeId === where.storeId);
    },
  };
  prisma.store = {
    findUnique: async ({ where }) => {
      writes.push({ table: "store", op: "read" });
      return where.id === STORE
        ? {
            lastSyncAt: daysAgo(1),
            lastConnectionStatus: "OK",
            lastWebhookRegistrationStatus: "OK",
            accessTokenExpiresAt: null,
            ...store,
          }
        : null;
    },
  };
  prisma.productSnapshot = {
    findMany: async ({ where }) => {
      writes.push({ table: "productSnapshot", op: "read" });
      return products.filter((p) => p.storeId === where.storeId);
    },
  };
  prisma.profitOptimizationData = {
    findMany: async ({ where }) => {
      writes.push({ table: "profitOptimizationData", op: "read" });
      return profitRows.filter((r) => r.storeId === where.storeId);
    },
  };

  prisma.intelligenceFinding = {
    findUnique: async ({ where }) => {
      const { storeId, fingerprint } = where.storeId_fingerprint;
      return (
        findingRows.find((r) => r.storeId === storeId && r.fingerprint === fingerprint) ?? null
      );
    },
    upsert: async ({ where, update, create }) => {
      writes.push({ table: "intelligenceFinding", op: "upsert" });
      const { storeId, fingerprint } = where.storeId_fingerprint;
      const existing = findingRows.find(
        (r) => r.storeId === storeId && r.fingerprint === fingerprint
      );
      if (existing) {
        for (const [k, v] of Object.entries(update)) {
          existing[k] =
            v && typeof v === "object" && "increment" in v ? (existing[k] ?? 0) + v.increment : v;
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
    findFirst: async () => null,
    findMany: async () => findingRows.map((r) => ({ ...r })),
  };

  const detectors = require(DETECTOR);
  const findings = require(FINDING);
  return { detectors, findings, findingRows, logged, writes };
}

/** Orders producing a clear refund-rate shift plus a high-risk backlog. */
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

// ===========================================================================
// Detection + persistence
// ===========================================================================

test("operational detectors persist findings through the Part 1 foundation", async () => {
  const w = buildWorld({ orders: problemOrders() });

  const insights = await w.detectors.detectOperationalProblems({ storeId: STORE, nowIso: NOW });

  assert.ok(insights.length >= 2, "refund shift and high-risk backlog both fire");
  for (const row of w.findingRows) {
    assert.match(row.findingType, /^operational_/);
    assert.equal(row.storeId, STORE);
    assert.equal(row.status, "new");
  }
  const types = w.findingRows.map((r) => r.findingType);
  assert.ok(types.includes("operational_refund_rate_shift"));
  assert.ok(types.includes("operational_high_risk_order_backlog"));
});

test("findings reuse an existing InsightModule so entitlements need no change", async () => {
  const w = buildWorld({ orders: problemOrders() });
  const insights = await w.detectors.detectOperationalProblems({ storeId: STORE, nowIso: NOW });

  for (const i of insights) {
    assert.equal(i.module, "fraud", "reuses an existing module value");
    assert.equal(i.easeOfAction, "manual");
    assert.match(i.recommendedAction, /No automatic action was taken/i);
  }
});

test("methodology states the window, completeness and the cooldown rule", async () => {
  const w = buildWorld({ orders: problemOrders() });
  const [insight] = await w.detectors.detectOperationalProblems({ storeId: STORE, nowIso: NOW });
  const assumptions = insight.methodology.assumptions.join(" ");

  assert.match(assumptions, /Window: \d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2}/);
  assert.match(assumptions, /Completeness:/);
  assert.match(assumptions, /Cooldown: .* not re-raised for 7 days/i);
});

test("every finding declares that no external-system signal is available", async () => {
  const w = buildWorld({ orders: problemOrders() });
  const insights = await w.detectors.detectOperationalProblems({ storeId: STORE, nowIso: NOW });

  for (const i of insights) {
    assert.match(
      i.methodology.caps.join(" "),
      /No supplier, carrier, advertising, marketplace, ERP or WMS signal is available/i
    );
  }
});

// ===========================================================================
// Cooldown safeguard
// ===========================================================================

test("COOLDOWN: a recently dismissed alert is NOT re-raised", async () => {
  const seedWorld = buildWorld({ orders: problemOrders() });
  await seedWorld.detectors.detectOperationalProblems({ storeId: STORE, nowIso: NOW });
  const refundFinding = seedWorld.findingRows.find(
    (r) => r.findingType === "operational_refund_rate_shift"
  );
  assert.ok(refundFinding);

  // Same condition, but the merchant dismissed it two days ago.
  const w = buildWorld({
    orders: problemOrders(),
    seedFindings: [
      {
        ...refundFinding,
        id: "seeded",
        status: "dismissed",
        statusChangedAt: daysAgo(2),
        updatedAt: daysAgo(2),
      },
    ],
  });

  const insights = await w.detectors.detectOperationalProblems({ storeId: STORE, nowIso: NOW });
  const types = insights.map((i) => i.title);
  assert.equal(
    types.some((t) => /Refund rate has risen/i.test(t)),
    false,
    "the dismissed alert is suppressed"
  );
  const event = w.logged.find((e) => e.event === "intelligence.operational_problems_detected");
  assert.equal(event.details.suppressedByCooldown, 1);
});

test("COOLDOWN expires: the alert returns after the window", async () => {
  const seedWorld = buildWorld({ orders: problemOrders() });
  await seedWorld.detectors.detectOperationalProblems({ storeId: STORE, nowIso: NOW });
  const refundFinding = seedWorld.findingRows.find(
    (r) => r.findingType === "operational_refund_rate_shift"
  );

  const w = buildWorld({
    orders: problemOrders(),
    seedFindings: [
      {
        ...refundFinding,
        id: "seeded",
        status: "dismissed",
        statusChangedAt: daysAgo(30),
        updatedAt: daysAgo(30),
      },
    ],
  });

  const insights = await w.detectors.detectOperationalProblems({ storeId: STORE, nowIso: NOW });
  assert.ok(
    insights.some((i) => /Refund rate has risen/i.test(i.title)),
    "past the cooldown, the still-true condition is raised again"
  );
});

test("COOLDOWN does not suppress an alert that is merely open", async () => {
  const seedWorld = buildWorld({ orders: problemOrders() });
  await seedWorld.detectors.detectOperationalProblems({ storeId: STORE, nowIso: NOW });
  const refundFinding = seedWorld.findingRows.find(
    (r) => r.findingType === "operational_refund_rate_shift"
  );

  for (const status of ["new", "seen", "in_review"]) {
    const w = buildWorld({
      orders: problemOrders(),
      seedFindings: [
        { ...refundFinding, id: "seeded", status, statusChangedAt: daysAgo(1), updatedAt: daysAgo(1) },
      ],
    });
    const insights = await w.detectors.detectOperationalProblems({ storeId: STORE, nowIso: NOW });
    assert.ok(
      insights.some((i) => /Refund rate has risen/i.test(i.title)),
      `status "${status}" must not trigger cooldown`
    );
  }
});

// ===========================================================================
// Idempotency, scoping, no-write
// ===========================================================================

test("re-running produces no duplicates and accumulates detectionCount", async () => {
  const w = buildWorld({ orders: problemOrders() });

  await w.detectors.detectOperationalProblems({ storeId: STORE, nowIso: NOW });
  const firstCount = w.findingRows.length;
  const ids = w.findingRows.map((r) => r.id).sort();

  for (let i = 0; i < 3; i += 1) {
    await w.detectors.detectOperationalProblems({ storeId: STORE, nowIso: NOW });
  }

  assert.equal(w.findingRows.length, firstCount, "no new rows across four runs");
  assert.deepEqual(w.findingRows.map((r) => r.id).sort(), ids);
  for (const row of w.findingRows) {
    assert.equal(row.detectionCount, 4);
  }
});

test("detectors are store-scoped", async () => {
  const w = buildWorld({ orders: [...problemOrders(STORE), ...problemOrders(OTHER)] });
  const insights = await w.detectors.detectOperationalProblems({ storeId: STORE, nowIso: NOW });

  for (const i of insights) assert.equal(i.storeId, STORE);
  for (const row of w.findingRows) assert.equal(row.storeId, STORE);
});

test("operational detectors write ONLY to IntelligenceFinding", async () => {
  const w = buildWorld({ orders: problemOrders() });
  await w.detectors.detectOperationalProblems({ storeId: STORE, nowIso: NOW });

  const writeOps = w.writes.filter((x) => x.op !== "read");
  assert.ok(writeOps.length > 0);
  for (const op of writeOps) {
    assert.equal(op.table, "intelligenceFinding", `must never write to ${op.table}`);
  }
});

test("the feature flag gates persistence but not detection", async () => {
  const w = buildWorld({ flagEnabled: false, orders: problemOrders() });
  const insights = await w.detectors.detectOperationalProblems({ storeId: STORE, nowIso: NOW });

  assert.ok(insights.length >= 2, "still computed");
  assert.equal(w.findingRows.length, 0, "nothing persisted");
});

test("an empty store produces no operational findings", async () => {
  const w = buildWorld({});
  const insights = await w.detectors.detectOperationalProblems({ storeId: STORE, nowIso: NOW });
  assert.deepEqual(insights, []);
  assert.equal(w.findingRows.length, 0);
});

test("a broken connection surfaces as a critical operational finding", async () => {
  const w = buildWorld({
    orders: [],
    store: { lastConnectionStatus: "SHOPIFY_RECONNECT_REQUIRED", lastSyncAt: null },
  });

  const insights = await w.detectors.detectOperationalProblems({ storeId: STORE, nowIso: NOW });
  const sync = insights.find((i) => /not receiving reliable Shopify data/i.test(i.title));
  assert.ok(sync, "connection problems fire even with no orders");
  assert.equal(sync.urgency, "critical");
  assert.equal(sync.financialImpact.status, "impact_not_quantifiable");
});

test("runIntelligenceDetectors now returns all three detector families", async () => {
  const w = buildWorld({ orders: problemOrders() });
  const result = await w.detectors.runIntelligenceDetectors({ storeId: STORE, nowIso: NOW });

  assert.ok(Array.isArray(result.customerLoss));
  assert.ok(Array.isArray(result.productProfit));
  assert.ok(Array.isArray(result.operational));
  assert.ok(result.operational.length >= 2);
});

test("getFindingByFingerprint is store-scoped and returns null for a miss", async () => {
  const w = buildWorld({ orders: problemOrders() });
  await w.detectors.detectOperationalProblems({ storeId: STORE, nowIso: NOW });
  const row = w.findingRows[0];

  assert.ok(await w.findings.getFindingByFingerprint(STORE, row.fingerprint));
  assert.equal(await w.findings.getFindingByFingerprint(OTHER, row.fingerprint), null);
  assert.equal(await w.findings.getFindingByFingerprint(STORE, "nope"), null);
});

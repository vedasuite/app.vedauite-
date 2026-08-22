const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

process.env.SHOPIFY_API_KEY ||= "test-key";
process.env.SHOPIFY_API_SECRET ||= "test-secret";
process.env.SHOPIFY_APP_URL ||= "https://app.vedasuite.in";
process.env.DATABASE_URL ||= "postgresql://example:example@localhost:5432/example";

/**
 * REGRESSION: the Action Center must survive the whole activation lifecycle.
 *
 * Reproduces install -> onboarding -> select GROWTH -> billing approval ->
 * subscription refresh -> onboarding 4/4, asserting at every step that
 * operational findings stay visible and the route stays reachable.
 *
 * The invariant under test: Action Center is NOT gated by any paid capability.
 * Operational findings map to a null capability, so no plan — including no plan
 * at all — may hide them.
 */

function resetModule(p) {
  delete require.cache[require.resolve(p)];
}

const PRISMA = path.resolve(__dirname, "../dist/db/prismaClient.js");
const OBS = path.resolve(__dirname, "../dist/services/observabilityService.js");
const SERVICE = path.resolve(__dirname, "../dist/services/actionCenterService.js");
const CALC = path.resolve(__dirname, "../dist/services/explainabilityCalc.js");

const NOW = new Date("2026-08-22T12:00:00.000Z");
const STORE = "store-1";

/**
 * Capability modules each plan enables, mirroring the existing entitlement
 * system. NONE is the pre-activation state the merchant starts in.
 */
const PLAN_MODULES = {
  NONE: [],
  STARTER_FRAUD: ["fraud"],
  STARTER_COMPETITOR: ["competitor"],
  GROWTH: ["fraud", "competitor", "pricing"],
  PRO: ["fraud", "competitor", "pricing", "profit"],
};

function snapshot(overrides = {}) {
  return {
    id: "insight-1",
    storeId: STORE,
    module: "operational",
    title: "VedaSuite is not receiving reliable Shopify data",
    reasons: ["2 consecutive sync failures.", "Insights go stale while this persists."],
    evidence: [{ label: "Consecutive sync failures", value: "2" }],
    financialImpact: {
      status: "impact_not_quantifiable",
      reason: "Data-delivery problems have no directly attributable monetary value",
    },
    confidence: "high",
    recency: NOW.toISOString(),
    urgency: "critical",
    easeOfAction: "manual",
    recommendedAction: "Run Sync Data. No automatic action was taken.",
    score: {},
    methodology: { summary: "s", assumptions: ["a"], caps: ["c"] },
    route: "/app/settings",
    dataQuality: "ok",
    ...overrides,
  };
}

function row(overrides = {}) {
  const snap = overrides.snapshot ?? snapshot();
  return {
    id: overrides.id ?? "f-ops",
    storeId: overrides.storeId ?? STORE,
    findingType: overrides.findingType ?? "operational_sync_health_degraded",
    module: overrides.module ?? snap.module,
    status: overrides.status ?? "new",
    firstDetectedAt: new Date(NOW.getTime() - 3 * 86_400_000),
    lastSeenAt: new Date(NOW.getTime() - 86_400_000),
    detectionCount: 2,
    statusChangedAt: null,
    resolvedAt: null,
    dismissedAt: null,
    snapshotJson: JSON.stringify(snap),
    updatedAt: new Date(NOW.getTime() - 86_400_000),
  };
}

function buildWorld(rows) {
  [PRISMA, OBS, SERVICE, CALC].forEach(resetModule);
  const prisma = require(PRISMA).prisma;
  require(OBS).logEvent = () => {};
  prisma.intelligenceFinding = {
    findMany: async ({ where, take }) => {
      const matched = rows.filter(
        (r) =>
          r.storeId === where.storeId &&
          (where.status === undefined || r.status === where.status) &&
          (where.module === undefined || r.module === where.module)
      );
      return take ? matched.slice(0, take) : matched;
    },
  };
  return { service: require(SERVICE), calc: require(CALC) };
}

const feed = (w, enabledModules) =>
  w.service.getActionCenter({ storeId: STORE, enabledModules, now: NOW });

// ===========================================================================
// The reported lifecycle, step by step
// ===========================================================================

test("LIFECYCLE: operational findings survive the full install -> GROWTH activation flow", async () => {
  const w = buildWorld([row()]);

  // 1. Installed, no plan chosen yet — the pre-activation state.
  const preActivation = await feed(w, PLAN_MODULES.NONE);
  assert.equal(preActivation.cards.length, 1, "visible before any plan is selected");

  // 2. GROWTH approved and the subscription refresh lands.
  const postActivation = await feed(w, PLAN_MODULES.GROWTH);
  assert.equal(
    postActivation.cards.length,
    1,
    "MUST remain visible after GROWTH activation — this is the reported regression"
  );

  // 3. The finding is unchanged by the plan transition.
  assert.equal(preActivation.cards[0].id, postActivation.cards[0].id);
  assert.equal(postActivation.cards[0].capability, null, "never capability-gated");
});

test("LIFECYCLE: operational findings are visible on EVERY plan, including none", async () => {
  const w = buildWorld([row()]);

  for (const [plan, modules] of Object.entries(PLAN_MODULES)) {
    const { cards } = await feed(w, modules);
    assert.equal(cards.length, 1, `operational finding must be visible on ${plan}`);
    assert.equal(cards[0].capability, null);
  }
});

test("LIFECYCLE: a plan DOWNGRADE cannot hide an operational finding", async () => {
  const w = buildWorld([row()]);
  const pro = await feed(w, PLAN_MODULES.PRO);
  const none = await feed(w, PLAN_MODULES.NONE);

  assert.equal(pro.cards.length, none.cards.length, "downgrade must not remove it");
});

test("LIFECYCLE: paid-module findings stay gated while operational stays visible", async () => {
  // Both present: one profit finding (gated) and one operational (never gated).
  const w = buildWorld([
    row({ id: "ops" }),
    row({
      id: "profit",
      module: "profit",
      findingType: "product_profit_weakened_retained_margin",
      snapshot: snapshot({ module: "profit", title: "Weakened retained economics" }),
    }),
  ]);

  const growth = await feed(w, PLAN_MODULES.GROWTH); // no profit module
  assert.deepEqual(growth.cards.map((c) => c.id).sort(), ["ops"], "profit gated out on GROWTH");

  const pro = await feed(w, PLAN_MODULES.PRO);
  assert.deepEqual(pro.cards.map((c) => c.id).sort(), ["ops", "profit"], "both on PRO");
});

// ===========================================================================
// Reload and fresh session
// ===========================================================================

test("RELOAD: repeated requests return an identical feed — the API holds no session state", async () => {
  const w = buildWorld([row()]);

  const first = await feed(w, PLAN_MODULES.GROWTH);
  const second = await feed(w, PLAN_MODULES.GROWTH);
  const third = await feed(w, PLAN_MODULES.GROWTH);

  // A page reload or a brand-new embedded session issues the same request; the
  // response must not depend on anything cached between calls.
  assert.deepEqual(
    first.cards.map((c) => c.id),
    second.cards.map((c) => c.id)
  );
  assert.deepEqual(
    second.cards.map((c) => c.id),
    third.cards.map((c) => c.id)
  );
  assert.equal(first.summary.totalOpen, third.summary.totalOpen);
});

test("FRESH SESSION: a newly built service instance returns the same feed", async () => {
  const rows = [row()];
  const a = await feed(buildWorld(rows), PLAN_MODULES.GROWTH);
  const b = await feed(buildWorld(rows), PLAN_MODULES.GROWTH); // fresh module registry
  assert.deepEqual(a.cards.map((c) => c.id), b.cards.map((c) => c.id));
});

test("LIFECYCLE: lifecycle status changes do not remove a finding from the feed", async () => {
  // After the merchant marks it seen / in review, it must still be listed.
  for (const status of ["new", "seen", "in_review"]) {
    const w = buildWorld([row({ status })]);
    const { cards, summary } = await feed(w, PLAN_MODULES.GROWTH);
    assert.equal(cards.length, 1, `status "${status}" stays in the feed`);
    assert.equal(summary.totalOpen, 1);
  }
  // Resolved/dismissed remain retrievable but are not counted as open.
  for (const status of ["resolved", "dismissed"]) {
    const w = buildWorld([row({ status })]);
    const { cards, summary } = await feed(w, PLAN_MODULES.GROWTH);
    assert.equal(cards.length, 1, `status "${status}" is still retrievable`);
    assert.equal(summary.totalOpen, 0, `status "${status}" is not open`);
  }
});

// ===========================================================================
// The capability map itself — the invariant's foundation
// ===========================================================================

test("INVARIANT: operational maps to a null capability and is never entitlement-filtered", () => {
  const w = buildWorld([]);
  assert.equal(
    w.calc.MODULE_CAPABILITY.operational,
    null,
    "operational must never map to a paid capability"
  );

  const opsInsight = { storeId: STORE, module: "operational" };
  for (const modules of Object.values(PLAN_MODULES)) {
    assert.equal(
      w.calc.filterInsightsByCapability([opsInsight], modules).length,
      1,
      `must survive filtering with modules=[${modules}]`
    );
  }
});

test("INVARIANT: fraud-gated modules are still genuinely gated", () => {
  // Guards against 'fix the symptom by ungating everything'.
  const w = buildWorld([]);
  const fraudInsight = { storeId: STORE, module: "return_abuse" };
  assert.equal(w.calc.filterInsightsByCapability([fraudInsight], []).length, 0);
  assert.equal(w.calc.filterInsightsByCapability([fraudInsight], ["fraud"]).length, 1);
});

// ===========================================================================
// Navigation is not derived from plan state
// ===========================================================================

test("NAV: the Action Center entry is not conditional on plan, entitlement or onboarding", () => {
  const frame = fs.readFileSync(
    path.resolve(__dirname, "../../frontend/src/layout/AppFrame.tsx"),
    "utf8"
  );

  const entry = frame.match(
    /createNavItem\(\s*"\/app\/action-center"\s*,\s*"Action Center"\s*(,[^)]*)?\)/
  );
  assert.ok(entry, "the Action Center nav entry must exist");
  assert.equal(
    entry[1] ?? "",
    "",
    "it must take no options — no badge, no gating, no plan condition"
  );

  // And it must not sit behind any conditional expression.
  const line = frame
    .split(/\r?\n/)
    .find((l) => l.includes('createNavItem("/app/action-center"'));
  assert.doesNotMatch(line, /\?|&&|\|\|/, "the entry must not be conditionally rendered");
});

test("NAV: onboarding completion cannot change the navigation array", () => {
  const frame = fs.readFileSync(
    path.resolve(__dirname, "../../frontend/src/layout/AppFrame.tsx"),
    "utf8"
  );

  // Check the DEPENDENCY ARRAY, not the memo body — the body legitimately
  // contains "/app/onboarding" and "/app/billing" as route paths. What must
  // never appear is onboarding, billing or subscription STATE as an input,
  // because that is what would let completing onboarding or activating a plan
  // rebuild a different navigation.
  const memo = frame.match(/const navigationItems = useMemo\(([\s\S]*?)\n\s*\);/);
  assert.ok(memo, "navigationItems useMemo must exist");

  const deps = memo[1].slice(memo[1].lastIndexOf("["));
  assert.ok(deps.includes("createNavItem"), "sanity: the deps array was located");

  for (const forbidden of [
    "onboarding",
    "billing",
    "subscription",
    "installState",
    "bootstrap",
  ]) {
    assert.equal(
      new RegExp(forbidden, "i").test(deps),
      false,
      `navigation must not be rebuilt from ${forbidden} state — deps were: ${deps.trim()}`
    );
  }

  // moduleStatus IS an allowed dependency: it drives the Upgrade badges only,
  // and the Action Center entry takes no options (asserted in the test above).
});

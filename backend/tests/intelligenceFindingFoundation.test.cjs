const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

process.env.SHOPIFY_API_KEY ||= "test-key";
process.env.SHOPIFY_API_SECRET ||= "test-secret";
process.env.SHOPIFY_APP_URL ||= "https://app.vedasuite.in";
process.env.DATABASE_URL ||= "postgresql://example:example@localhost:5432/example";

/**
 * PART 1 foundation — persisted intelligence-finding envelope.
 *
 * These tests pin the three things this layer exists to add (identity that
 * survives across runs, lifecycle, first/last-seen timestamps) and, just as
 * importantly, pin that it does NOT take ownership of any analytical semantics.
 * Severity/confidence/impact/evidence/methodology/recommendedAction/data
 * coverage must keep exactly one definition, in explainabilityCalc.ts.
 */

function resetModule(modulePath) {
  const resolved = require.resolve(modulePath);
  delete require.cache[resolved];
}

const PRISMA_PATH = path.resolve(__dirname, "../dist/db/prismaClient.js");
const OBSERVABILITY_PATH = path.resolve(__dirname, "../dist/services/observabilityService.js");
const ENV_PATH = path.resolve(__dirname, "../dist/config/env.js");
const SERVICE_PATH = path.resolve(__dirname, "../dist/services/intelligenceFindingService.js");

const STORE_A = "store-a";
const STORE_B = "store-b";

/**
 * In-memory stand-in for the IntelligenceFinding table that faithfully enforces
 * the real unique constraint on (storeId, fingerprint), including raising a
 * Prisma P2002 when a create would violate it.
 */
function buildHarness({ flagEnabled = true } = {}) {
  [PRISMA_PATH, OBSERVABILITY_PATH, ENV_PATH, SERVICE_PATH].forEach(resetModule);

  process.env.ENABLE_INTELLIGENCE_FINDING_PERSISTENCE = flagEnabled ? "true" : "false";

  const prisma = require(PRISMA_PATH).prisma;
  const loggedEvents = [];
  require(OBSERVABILITY_PATH).logEvent = (level, event, details) => {
    loggedEvents.push({ level, event, details });
  };

  const rows = [];
  let seq = 0;
  /** Set to a function to force the next create to raise P2002 (race sim). */
  let raceOnNextCreate = false;

  const key = (storeId, fingerprint) => `${storeId}::${fingerprint}`;
  const findByKey = (storeId, fingerprint) =>
    rows.find((r) => key(r.storeId, r.fingerprint) === key(storeId, fingerprint)) ?? null;

  function applyUpdate(row, data) {
    for (const [field, value] of Object.entries(data)) {
      if (value && typeof value === "object" && "increment" in value) {
        row[field] = (row[field] ?? 0) + value.increment;
      } else {
        row[field] = value;
      }
    }
    row.updatedAt = new Date();
    return { ...row };
  }

  prisma.intelligenceFinding = {
    upsert: async ({ where, update, create }) => {
      const { storeId, fingerprint } = where.storeId_fingerprint;
      const existing = findByKey(storeId, fingerprint);
      if (existing) {
        return applyUpdate(existing, update);
      }
      if (raceOnNextCreate) {
        raceOnNextCreate = false;
        // Simulate the competitor's row landing first.
        seq += 1;
        rows.push({
          id: `finding-${seq}`,
          resolutionNote: null,
          statusChangedAt: null,
          statusChangedBy: null,
          resolvedAt: null,
          dismissedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...create,
        });
        const err = new Error("Unique constraint failed");
        err.code = "P2002";
        err.name = "PrismaClientKnownRequestError";
        Object.setPrototypeOf(err, require("@prisma/client").Prisma.PrismaClientKnownRequestError.prototype);
        throw err;
      }
      seq += 1;
      const row = {
        id: `finding-${seq}`,
        resolutionNote: null,
        statusChangedAt: null,
        statusChangedBy: null,
        resolvedAt: null,
        dismissedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...create,
      };
      rows.push(row);
      return { ...row };
    },
    update: async ({ where, data }) => {
      const row = where.storeId_fingerprint
        ? findByKey(where.storeId_fingerprint.storeId, where.storeId_fingerprint.fingerprint)
        : rows.find((r) => r.id === where.id) ?? null;
      if (!row) throw new Error("record not found");
      return applyUpdate(row, data);
    },
    findFirst: async ({ where }) =>
      rows.find(
        (r) =>
          (where.id === undefined || r.id === where.id) &&
          (where.storeId === undefined || r.storeId === where.storeId)
      ) ?? null,
    findMany: async ({ where, take }) => {
      let out = rows.filter(
        (r) =>
          (where.storeId === undefined || r.storeId === where.storeId) &&
          (where.status === undefined || r.status === where.status) &&
          (where.module === undefined || r.module === where.module)
      );
      out = out.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
      return out.slice(0, take ?? 50).map((r) => ({ ...r }));
    },
  };

  const service = require(SERVICE_PATH);
  return {
    service,
    rows,
    loggedEvents,
    forceRaceOnNextCreate: () => {
      raceOnNextCreate = true;
    },
  };
}

const SNAPSHOT = {
  id: "insight-1",
  storeId: STORE_A,
  module: "fraud",
  title: "Refund abuse pattern detected",
  reasons: ["Refund rate 22.0% vs store baseline 4.0%"],
  evidence: [{ label: "Refunded orders", value: "11" }],
  financialImpact: {
    status: "quantified",
    min: 100,
    max: 400,
    currency: "USD",
    period: "monthly_estimate",
    basis: "refunded order value over trailing 30 days",
    isEstimate: true,
  },
  confidence: "medium",
  recency: "2026-08-04T00:00:00.000Z",
  urgency: "high",
  easeOfAction: "one_click_review",
  recommendedAction: "Review the flagged customers",
  score: { total: 70, components: {}, weights: {}, excludedFromMonetaryRanking: false },
  methodology: { summary: "s", assumptions: [], caps: [] },
  route: "/app/fraud-intelligence",
  dataQuality: "ok",
};

// ===========================================================================
// 1. Creation
// ===========================================================================

test("first detection creates one persisted finding with status new and matching timestamps", async () => {
  const h = buildHarness();
  const now = new Date("2026-08-04T10:00:00.000Z");

  const created = await h.service.recordFinding({
    storeId: STORE_A,
    module: "fraud",
    findingType: "refund_abuse",
    subjectKey: "customer-1",
    snapshot: SNAPSHOT,
    sourceInsightId: "insight-1",
    now,
  });

  assert.equal(h.rows.length, 1, "exactly one row");
  assert.equal(created.status, "new");
  assert.equal(created.detectionCount, 1);
  assert.equal(created.firstDetectedAt.toISOString(), now.toISOString());
  assert.equal(created.lastSeenAt.toISOString(), now.toISOString());
  assert.equal(created.module, "fraud");
  assert.equal(created.findingType, "refund_abuse");
  assert.equal(created.sourceInsightId, "insight-1");
  assert.ok(created.fingerprint && created.fingerprint.length === 64, "sha256 fingerprint");
});

test("the feature flag gates writes: disabled returns null and persists nothing", async () => {
  const h = buildHarness({ flagEnabled: false });

  const result = await h.service.recordFinding({
    storeId: STORE_A,
    module: "fraud",
    findingType: "refund_abuse",
    subjectKey: "customer-1",
  });

  assert.equal(result, null);
  assert.equal(h.rows.length, 0, "nothing is written while the flag is off");
});

test("missing required identity fields are rejected", async () => {
  const h = buildHarness();
  await assert.rejects(
    () => h.service.recordFinding({ storeId: "", module: "fraud", findingType: "x" }),
    /required/i
  );
});

// ===========================================================================
// 2. Deduplication / idempotency
// ===========================================================================

test("repeated detection reuses the SAME row — no duplicates, count increments, lastSeenAt advances", async () => {
  const h = buildHarness();
  const t1 = new Date("2026-08-04T10:00:00.000Z");
  const t2 = new Date("2026-08-04T14:00:00.000Z");
  const t3 = new Date("2026-08-05T09:00:00.000Z");

  const args = {
    storeId: STORE_A,
    module: "fraud",
    findingType: "refund_abuse",
    subjectKey: "customer-1",
    snapshot: SNAPSHOT,
  };

  const first = await h.service.recordFinding({ ...args, now: t1 });
  await h.service.recordFinding({ ...args, now: t2 });
  const third = await h.service.recordFinding({ ...args, now: t3 });

  assert.equal(h.rows.length, 1, "three detections, still one row");
  assert.equal(third.id, first.id, "same row identity");
  assert.equal(third.detectionCount, 3);
  assert.equal(
    third.firstDetectedAt.toISOString(),
    t1.toISOString(),
    "firstDetectedAt never moves"
  );
  assert.equal(third.lastSeenAt.toISOString(), t3.toISOString(), "lastSeenAt advances");
});

test("the fingerprint is stable across runs and excludes volatile values", async () => {
  const h = buildHarness();
  const base = { storeId: STORE_A, module: "fraud", findingType: "refund_abuse", subjectKey: "c-1" };

  const a = h.service.computeFindingFingerprint(base);
  const b = h.service.computeFindingFingerprint(base);
  assert.equal(a, b, "same inputs -> same fingerprint");

  // Different subject, module, or type must all separate.
  assert.notEqual(a, h.service.computeFindingFingerprint({ ...base, subjectKey: "c-2" }));
  assert.notEqual(a, h.service.computeFindingFingerprint({ ...base, module: "pricing" }));
  assert.notEqual(a, h.service.computeFindingFingerprint({ ...base, findingType: "other" }));
  // Same store/module/type/subject in a different store must separate.
  assert.notEqual(a, h.service.computeFindingFingerprint({ ...base, storeId: STORE_B }));
});

test("a differing financial impact does NOT mint a new finding", async () => {
  // The money moved but it is the same underlying problem — it must dedupe.
  const h = buildHarness();
  const args = {
    storeId: STORE_A,
    module: "fraud",
    findingType: "refund_abuse",
    subjectKey: "customer-1",
  };

  await h.service.recordFinding({
    ...args,
    snapshot: { ...SNAPSHOT, financialImpact: { ...SNAPSHOT.financialImpact, max: 400 } },
    now: new Date("2026-08-04T10:00:00.000Z"),
  });
  await h.service.recordFinding({
    ...args,
    snapshot: { ...SNAPSHOT, financialImpact: { ...SNAPSHOT.financialImpact, max: 9999 } },
    now: new Date("2026-08-04T11:00:00.000Z"),
  });

  assert.equal(h.rows.length, 1);
});

test("a concurrent first-detection race converges on one row, never two", async () => {
  const h = buildHarness();
  h.forceRaceOnNextCreate();

  const result = await h.service.recordFinding({
    storeId: STORE_A,
    module: "pricing",
    findingType: "underpriced_variant",
    subjectKey: "variant-9",
    now: new Date("2026-08-04T10:00:00.000Z"),
  });

  assert.equal(h.rows.length, 1, "the losing writer updated the winner's row");
  assert.equal(result.detectionCount, 2, "both detections counted against one row");
  assert.ok(
    h.loggedEvents.some((e) => e.event === "intelligence.finding_upsert_raced"),
    "the race is observable"
  );
});

test("a snapshot-less re-detection does not erase the last good snapshot", async () => {
  const h = buildHarness();
  const args = { storeId: STORE_A, module: "fraud", findingType: "refund_abuse", subjectKey: "c-1" };

  await h.service.recordFinding({ ...args, snapshot: SNAPSHOT, now: new Date("2026-08-04T10:00:00Z") });
  const after = await h.service.recordFinding({ ...args, now: new Date("2026-08-04T11:00:00Z") });

  assert.ok(after.snapshotJson, "snapshot preserved");
  const parsed = h.service.parseFindingSnapshot(after.snapshotJson);
  assert.equal(parsed.title, SNAPSHOT.title);
});

// ===========================================================================
// 3. Lifecycle transitions
// ===========================================================================

test("lifecycle: new -> seen -> in_review -> resolved records resolution metadata", async () => {
  const h = buildHarness();
  const created = await h.service.recordFinding({
    storeId: STORE_A, module: "fraud", findingType: "refund_abuse", subjectKey: "c-1",
    now: new Date("2026-08-04T10:00:00Z"),
  });

  let f = await h.service.transitionFindingStatus({ storeId: STORE_A, findingId: created.id, status: "seen" });
  assert.equal(f.status, "seen");

  f = await h.service.transitionFindingStatus({ storeId: STORE_A, findingId: created.id, status: "in_review" });
  assert.equal(f.status, "in_review");

  const resolvedAt = new Date("2026-08-05T12:00:00Z");
  f = await h.service.transitionFindingStatus({
    storeId: STORE_A, findingId: created.id, status: "resolved",
    note: "Refunds were legitimate", actor: "merchant", now: resolvedAt,
  });

  assert.equal(f.status, "resolved");
  assert.equal(f.resolvedAt.toISOString(), resolvedAt.toISOString());
  assert.equal(f.dismissedAt, null);
  assert.equal(f.resolutionNote, "Refunds were legitimate");
  assert.equal(f.statusChangedBy, "merchant");
  assert.equal(f.statusChangedAt.toISOString(), resolvedAt.toISOString());
});

test("lifecycle: dismissal records dismissedAt and can be reopened to in_review", async () => {
  const h = buildHarness();
  const created = await h.service.recordFinding({
    storeId: STORE_A, module: "competitor", findingType: "undercut", subjectKey: "p-1",
  });

  const dismissed = await h.service.transitionFindingStatus({
    storeId: STORE_A, findingId: created.id, status: "dismissed", note: "Not relevant",
  });
  assert.equal(dismissed.status, "dismissed");
  assert.ok(dismissed.dismissedAt);

  const reopened = await h.service.transitionFindingStatus({
    storeId: STORE_A, findingId: created.id, status: "in_review",
  });
  assert.equal(reopened.status, "in_review");
  assert.equal(reopened.dismissedAt, null, "reopening clears the dismissal stamp");
});

test("re-detection NEVER resurrects a resolved or dismissed finding to new", async () => {
  // The critical safety property: a detector re-running must not undo the
  // merchant's decision and refill their queue.
  for (const terminal of ["resolved", "dismissed"]) {
    const h = buildHarness();
    const args = { storeId: STORE_A, module: "fraud", findingType: "refund_abuse", subjectKey: "c-1" };
    const created = await h.service.recordFinding({ ...args, now: new Date("2026-08-04T10:00:00Z") });
    await h.service.transitionFindingStatus({ storeId: STORE_A, findingId: created.id, status: terminal });

    const redetected = await h.service.recordFinding({ ...args, now: new Date("2026-08-06T10:00:00Z") });

    assert.equal(redetected.status, terminal, `${terminal} must survive re-detection`);
    assert.equal(h.rows.length, 1);
    assert.equal(
      redetected.lastSeenAt.toISOString(),
      "2026-08-06T10:00:00.000Z",
      "lastSeenAt still advances so staleness stays visible"
    );
  }
});

test("transitioning to the same status is an accepted no-op (retry-safe)", async () => {
  const h = buildHarness();
  const created = await h.service.recordFinding({
    storeId: STORE_A, module: "fraud", findingType: "refund_abuse", subjectKey: "c-1",
  });
  const a = await h.service.transitionFindingStatus({ storeId: STORE_A, findingId: created.id, status: "seen" });
  const b = await h.service.transitionFindingStatus({ storeId: STORE_A, findingId: created.id, status: "seen" });
  assert.equal(a.status, "seen");
  assert.equal(b.status, "seen");
});

// ===========================================================================
// 4. Invalid status / action handling
// ===========================================================================

test("an unknown status is rejected with 400 and the whitelist", async () => {
  const h = buildHarness();
  const created = await h.service.recordFinding({
    storeId: STORE_A, module: "fraud", findingType: "refund_abuse", subjectKey: "c-1",
  });

  await assert.rejects(
    () => h.service.transitionFindingStatus({ storeId: STORE_A, findingId: created.id, status: "archived" }),
    (err) => {
      assert.equal(err.status ?? err.statusCode, 400);
      assert.match(err.message, /Unknown finding status/i);
      return true;
    }
  );
});

test("an illegal transition is rejected", async () => {
  const h = buildHarness();
  const created = await h.service.recordFinding({
    storeId: STORE_A, module: "fraud", findingType: "refund_abuse", subjectKey: "c-1",
  });
  await h.service.transitionFindingStatus({ storeId: STORE_A, findingId: created.id, status: "resolved" });

  // resolved -> seen is not an allowed edge (reopen goes via in_review).
  await assert.rejects(
    () => h.service.transitionFindingStatus({ storeId: STORE_A, findingId: created.id, status: "seen" }),
    /Cannot move a finding from "resolved" to "seen"/
  );
});

test("listFindings rejects an unknown status filter", async () => {
  const h = buildHarness();
  await assert.rejects(() => h.service.listFindings({ storeId: STORE_A, status: "nope" }), /Unknown finding status/i);
});

test("the exported status whitelist is exactly the documented lifecycle", async () => {
  const h = buildHarness();
  assert.deepEqual(h.service.FINDING_STATUSES, ["new", "seen", "in_review", "resolved", "dismissed"]);
  assert.equal(h.service.isFindingStatus("in_review"), true);
  assert.equal(h.service.isFindingStatus("archived"), false);
});

// ===========================================================================
// 5. Store isolation
// ===========================================================================

test("identical findings in two stores are separate rows", async () => {
  const h = buildHarness();
  const args = { module: "fraud", findingType: "refund_abuse", subjectKey: "customer-1" };

  await h.service.recordFinding({ ...args, storeId: STORE_A, now: new Date("2026-08-04T10:00:00Z") });
  await h.service.recordFinding({ ...args, storeId: STORE_B, now: new Date("2026-08-04T10:00:00Z") });

  assert.equal(h.rows.length, 2, "one row per store");
  assert.notEqual(h.rows[0].fingerprint, h.rows[1].fingerprint);
});

test("one store cannot transition another store's finding", async () => {
  const h = buildHarness();
  const created = await h.service.recordFinding({
    storeId: STORE_A, module: "fraud", findingType: "refund_abuse", subjectKey: "c-1",
  });

  await assert.rejects(
    () => h.service.transitionFindingStatus({ storeId: STORE_B, findingId: created.id, status: "resolved" }),
    (err) => {
      assert.equal(err.status ?? err.statusCode, 404, "reported as not-found, so ids are not enumerable");
      return true;
    }
  );

  // Store A's finding is untouched.
  const stillNew = await h.service.listFindings({ storeId: STORE_A });
  assert.equal(stillNew[0].status, "new");
});

test("listFindings only ever returns the requested store's rows", async () => {
  const h = buildHarness();
  await h.service.recordFinding({ storeId: STORE_A, module: "fraud", findingType: "t", subjectKey: "1" });
  await h.service.recordFinding({ storeId: STORE_B, module: "fraud", findingType: "t", subjectKey: "1" });

  const a = await h.service.listFindings({ storeId: STORE_A });
  assert.equal(a.length, 1);
  assert.equal(a[0].storeId, STORE_A);
});

// ===========================================================================
// 6. The foundation must NOT duplicate existing explainability semantics.
// ===========================================================================

const SERVICE_SRC = path.resolve(__dirname, "../src/services/intelligenceFindingService.ts");
const CALC_SRC = path.resolve(__dirname, "../src/services/explainabilityCalc.ts");
const EXPLAIN_SRC = path.resolve(__dirname, "../src/services/explainabilityService.ts");

test("the finding service declares no competing severity/confidence/impact/evidence types", () => {
  const src = fs.readFileSync(SERVICE_SRC, "utf8");
  for (const forbidden of [
    "export type Confidence",
    "export type Urgency",
    "export type FinancialImpact",
    "export interface AggregateEvidence",
    "export interface Methodology",
    "export interface ExplainableInsight",
    "export interface DataCoverage",
  ]) {
    assert.equal(
      src.includes(forbidden),
      false,
      `${forbidden} must stay defined only in explainabilityCalc.ts`
    );
  }
  // And it must import the canonical definitions instead.
  assert.match(src, /from "\.\/explainabilityCalc"/, "reuses the canonical types");
});

test("the persisted model stores no analytical semantics columns", () => {
  const schema = fs.readFileSync(
    path.resolve(__dirname, "../prisma/schema.prisma"),
    "utf8"
  );
  const model = schema.slice(
    schema.indexOf("model IntelligenceFinding"),
    schema.indexOf("}", schema.indexOf("model IntelligenceFinding")) + 1
  );
  assert.ok(model.length > 0);

  for (const forbidden of ["severity", "urgency", "confidence", "financialImpact", "evidence", "methodology", "recommendedAction", "dataQuality"]) {
    assert.equal(
      new RegExp(`^\\s+${forbidden}\\s`, "mi").test(model),
      false,
      `IntelligenceFinding must not own a "${forbidden}" column`
    );
  }
  // The envelope fields it SHOULD own.
  for (const required of ["fingerprint", "status", "firstDetectedAt", "lastSeenAt", "detectionCount"]) {
    assert.match(model, new RegExp(`\\b${required}\\b`), `missing envelope field ${required}`);
  }
});

test("existing explainability sources are unmodified by this change", () => {
  // Guard against silent edits: both files must remain write-free and must
  // still own the canonical type definitions.
  for (const file of [CALC_SRC, EXPLAIN_SRC]) {
    const src = fs.readFileSync(file, "utf8");
    assert.equal(
      /prisma\.[a-zA-Z]+\.(create|update|upsert|delete|createMany|updateMany)\b/.test(src),
      false,
      `${path.basename(file)} must remain read-only`
    );
  }
  const calc = fs.readFileSync(CALC_SRC, "utf8");
  assert.match(calc, /export type Confidence =/);
  assert.match(calc, /export type Urgency =/);
  assert.match(calc, /export type FinancialImpact =/);
  assert.match(calc, /export interface ExplainableInsight/);
});

test("the insights dashboard route surface is unchanged (single GET /dashboard)", () => {
  const routes = fs.readFileSync(
    path.resolve(__dirname, "../src/routes/insightsRoutes.ts"),
    "utf8"
  );
  const handlers = routes.match(/insightsRouter\.(get|post|put|patch|delete)\(/g) ?? [];
  assert.deepEqual(handlers, ["insightsRouter.get("], "no route added, removed or renamed");
  assert.match(routes, /"\/dashboard"/);
});

// ===========================================================================
// 7. snapshotJson privacy + size safeguards.
//
// The producer today (explainabilityService.ts) guarantees "No raw PII in
// output or logs". These tests defend against a FUTURE detector that does not.
// ===========================================================================

test("snapshot persistence allow-lists fields: unknown detector fields are dropped", async () => {
  const h = buildHarness();

  const created = await h.service.recordFinding({
    storeId: STORE_A,
    module: "fraud",
    findingType: "refund_abuse",
    subjectKey: "c-1",
    snapshot: {
      ...SNAPSHOT,
      // A careless detector bolting on raw customer data.
      customerEmail: "shopper@example.com",
      shippingAddress: "12 Example Street",
      rawShopifyOrder: { id: 123, email: "shopper@example.com" },
      accessToken: "shpat_SECRET",
    },
  });

  const parsed = JSON.parse(created.snapshotJson);
  for (const forbidden of ["customerEmail", "shippingAddress", "rawShopifyOrder", "accessToken"]) {
    assert.equal(forbidden in parsed, false, `${forbidden} must not persist`);
  }
  assert.equal(created.snapshotJson.includes("shpat_SECRET"), false, "no secret material");
  assert.equal(created.snapshotJson.includes("shopper@example.com"), false, "no raw email");
  // The legitimate fields survive so the finding still renders.
  assert.equal(parsed.title, SNAPSHOT.title);
  assert.equal(parsed.recommendedAction, SNAPSHOT.recommendedAction);
  assert.equal(parsed.financialImpact.currency, "USD");
});

test("the redundant storeId is not duplicated inside the snapshot", async () => {
  const h = buildHarness();
  const created = await h.service.recordFinding({
    storeId: STORE_A, module: "fraud", findingType: "t", subjectKey: "1", snapshot: SNAPSHOT,
  });
  const parsed = JSON.parse(created.snapshotJson);
  assert.equal("storeId" in parsed, false, "the row already carries storeId");
});

test("email and long digit runs are masked even inside allow-listed free text", async () => {
  const h = buildHarness();
  const created = await h.service.recordFinding({
    storeId: STORE_A,
    module: "fraud",
    findingType: "refund_abuse",
    subjectKey: "c-1",
    snapshot: {
      ...SNAPSHOT,
      title: "Refund abuse by shopper@example.com",
      reasons: ["Card 4111111111111111 reused", "Contact a.b+c@mail.co.uk"],
      evidence: [{ label: "Phone", value: "+1 5551234567" }],
      recommendedAction: "Email shopper@example.com to confirm",
    },
  });

  const json = created.snapshotJson;
  assert.equal(json.includes("shopper@example.com"), false);
  assert.equal(json.includes("a.b+c@mail.co.uk"), false);
  assert.equal(json.includes("4111111111111111"), false);
  assert.equal(json.includes("5551234567"), false);
  assert.match(json, /\[redacted-email\]/);
  assert.match(json, /\[redacted-number\]/);
});

test("an oversized snapshot is reduced to a renderable minimum, not stored truncated", async () => {
  const h = buildHarness();
  const created = await h.service.recordFinding({
    storeId: STORE_A,
    module: "fraud",
    findingType: "refund_abuse",
    subjectKey: "c-1",
    snapshot: {
      ...SNAPSHOT,
      // 500 evidence rows, each with a long value.
      evidence: Array.from({ length: 500 }, (_, i) => ({
        label: `label-${i}`,
        value: "x".repeat(2000),
      })),
      reasons: Array.from({ length: 500 }, (_, i) => `reason ${i} ` + "y".repeat(2000)),
    },
  });

  const bytes = Buffer.byteLength(created.snapshotJson, "utf8");
  assert.ok(
    bytes <= h.service.MAX_SNAPSHOT_BYTES,
    `stored ${bytes} bytes, budget ${h.service.MAX_SNAPSHOT_BYTES}`
  );
  // Still valid JSON — the whole point of reducing instead of truncating.
  const parsed = JSON.parse(created.snapshotJson);
  assert.ok(parsed, "remains parseable");
  assert.equal(parsed.title, SNAPSHOT.title, "still renderable");
});

test("array and string bounds are applied before the byte budget", () => {
  const h = buildHarness();
  const sanitized = h.service.sanitizeSnapshotForPersistence({
    ...SNAPSHOT,
    reasons: Array.from({ length: 100 }, (_, i) => `r${i}`),
    evidence: Array.from({ length: 100 }, (_, i) => ({ label: `l${i}`, value: "z".repeat(5000) })),
  });

  assert.ok(sanitized.reasons.length <= 20, "reasons capped");
  assert.ok(sanitized.evidence.length <= 20, "evidence capped");
  assert.ok(sanitized.evidence[0].value.length <= 500, "strings capped");
});

test("a null/undefined snapshot persists nothing, and a cyclic one cannot break persistence", async () => {
  const h = buildHarness();

  const noSnap = await h.service.recordFinding({
    storeId: STORE_A, module: "fraud", findingType: "t", subjectKey: "no-snap",
  });
  assert.equal(noSnap.snapshotJson, null);

  const cyclic = { ...SNAPSHOT };
  cyclic.self = cyclic; // cycle
  const withCycle = await h.service.recordFinding({
    storeId: STORE_A, module: "fraud", findingType: "t", subjectKey: "cyclic", snapshot: cyclic,
  });
  // The cycle sits in a non-allow-listed field, so it is dropped outright and
  // the row still persists.
  assert.ok(withCycle, "the finding is still recorded");
  assert.equal(JSON.parse(withCycle.snapshotJson).title, SNAPSHOT.title);
});

test("parseFindingSnapshot round-trips a sanitized snapshot and tolerates corruption", () => {
  const h = buildHarness();
  const json = JSON.stringify(h.service.sanitizeSnapshotForPersistence(SNAPSHOT));
  const parsed = h.service.parseFindingSnapshot(json);
  assert.equal(parsed.title, SNAPSHOT.title);
  assert.equal(h.service.parseFindingSnapshot("{not json"), null);
  assert.equal(h.service.parseFindingSnapshot(null), null);
});

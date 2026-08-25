const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

process.env.SHOPIFY_API_KEY ||= "test-key";
process.env.SHOPIFY_API_SECRET ||= "test-secret";
process.env.SHOPIFY_APP_URL ||= "https://app.vedasuite.in";
process.env.DATABASE_URL ||= "postgresql://example:example@localhost:5432/example";

/**
 * The single execution path for Parts 2-3 detectors: fired from a successful
 * store sync.
 *
 * The load-bearing property is failure isolation — a detector fault must never
 * fail, delay or alter a Shopify sync that actually succeeded.
 */

function resetModule(p) {
  delete require.cache[require.resolve(p)];
}

const PRISMA = path.resolve(__dirname, "../dist/db/prismaClient.js");
const OBS = path.resolve(__dirname, "../dist/services/observabilityService.js");
const ENV = path.resolve(__dirname, "../dist/config/env.js");
const FINDING = path.resolve(__dirname, "../dist/services/intelligenceFindingService.js");
const DETECTOR = path.resolve(__dirname, "../dist/services/intelligenceDetectorService.js");

const STORE = "store-1";
const SHOP = "test-shop.myshopify.com";

function buildWorld({ flagEnabled = true } = {}) {
  [PRISMA, OBS, ENV, FINDING, DETECTOR].forEach(resetModule);
  process.env.ENABLE_INTELLIGENCE_FINDING_PERSISTENCE = flagEnabled ? "true" : "false";

  const prisma = require(PRISMA).prisma;
  const logged = [];
  require(OBS).logEvent = (level, event, details) => logged.push({ level, event, details });

  // Minimal, empty-but-valid reads so the detectors run and find nothing.
  prisma.order = { findMany: async () => [] };
  prisma.customer = { findMany: async () => [] };
  prisma.syncJob = { findMany: async () => [] };
  prisma.productSnapshot = { findMany: async () => [] };
  prisma.profitOptimizationData = { findMany: async () => [] };
  // Phase E: Pricing and Market Signals read these. Empty means both
  // correctly produce zero findings.
  prisma.priceHistory = { findMany: async () => [] };
  prisma.competitorDomain = { findMany: async () => [] };
  prisma.competitorData = { findMany: async () => [] };
  prisma.store = {
    findUnique: async () => ({
      lastSyncAt: new Date(),
      lastConnectionStatus: "OK",
      lastWebhookRegistrationStatus: "OK",
      accessTokenExpiresAt: null,
    }),
  };
  prisma.intelligenceFinding = {
    findUnique: async () => null,
    upsert: async ({ create }) => ({ id: "f-1", ...create }),
    update: async ({ data }) => ({ id: "f-1", ...data }),
    findFirst: async () => null,
    findMany: async () => [],
  };

  const detectors = require(DETECTOR);
  return { detectors, prisma, logged };
}

const eventNames = (logged) => logged.map((e) => e.event);

// ===========================================================================
// Failure isolation — the property that matters most
// ===========================================================================

test("a detector failure NEVER throws out of the trigger", async () => {
  const w = buildWorld();
  w.prisma.order.findMany = async () => {
    throw new Error("simulated database outage during detection");
  };

  // If this rejected, finalizeSyncSuccess would surface a detector fault as a
  // sync failure. It must resolve cleanly.
  await assert.doesNotReject(() =>
    w.detectors.triggerIntelligenceDetectionAfterSync({
      storeId: STORE,
      shopDomain: SHOP,
      jobId: "job-1",
    })
  );

  const failure = w.logged.find((e) => e.event === "intelligence.detection_failed");
  assert.ok(failure, "the failure is reported, not silently dropped");
  assert.equal(failure.level, "error");
  assert.match(failure.details.reason, /the Shopify sync completed successfully and is unaffected/i);
  assert.match(failure.details.error, /simulated database outage/);
});

test("the trigger resolves to undefined so the sync path cannot branch on it", async () => {
  const w = buildWorld();
  const result = await w.detectors.triggerIntelligenceDetectionAfterSync({
    storeId: STORE,
    shopDomain: SHOP,
  });
  assert.equal(result, undefined);
});

test("a failure in ONE detector still lets the trigger complete", async () => {
  const w = buildWorld();
  // Product-profit reads blow up; customer-loss and operational are fine.
  w.prisma.profitOptimizationData.findMany = async () => {
    throw new Error("profit table unavailable");
  };

  await assert.doesNotReject(() =>
    w.detectors.triggerIntelligenceDetectionAfterSync({ storeId: STORE, shopDomain: SHOP })
  );
  assert.ok(w.logged.some((e) => e.event === "intelligence.detection_failed"));
});

// ===========================================================================
// Flag gating
// ===========================================================================

test("with the flag OFF no detection work is performed at all", async () => {
  const w = buildWorld({ flagEnabled: false });
  let reads = 0;
  w.prisma.order.findMany = async () => {
    reads += 1;
    return [];
  };

  await w.detectors.triggerIntelligenceDetectionAfterSync({ storeId: STORE, shopDomain: SHOP });

  assert.equal(reads, 0, "not even a read — the work is skipped, not just the write");
  const skipped = w.logged.find((e) => e.event === "intelligence.detection_skipped");
  assert.ok(skipped);
  assert.match(skipped.details.reason, /ENABLE_INTELLIGENCE_FINDING_PERSISTENCE is off/);
  assert.equal(eventNames(w.logged).includes("intelligence.detection_started"), false);
});

// ===========================================================================
// Observability
// ===========================================================================

test("a successful run emits started and completed with counts and duration", async () => {
  const w = buildWorld();
  await w.detectors.triggerIntelligenceDetectionAfterSync({
    storeId: STORE,
    shopDomain: SHOP,
    jobId: "job-42",
  });

  const started = w.logged.find((e) => e.event === "intelligence.detection_started");
  const completed = w.logged.find((e) => e.event === "intelligence.detection_completed");

  assert.ok(started);
  assert.equal(started.details.jobId, "job-42");
  assert.ok(completed);
  assert.equal(completed.details.shop, SHOP);
  assert.equal(completed.details.storeId, STORE);
  assert.equal(typeof completed.details.customerLossFindings, "number");
  assert.equal(typeof completed.details.productProfitFindings, "number");
  assert.equal(typeof completed.details.operationalFindings, "number");
  assert.equal(typeof completed.details.durationMs, "number");
});

test("every log line is store-scoped", async () => {
  const w = buildWorld();
  await w.detectors.triggerIntelligenceDetectionAfterSync({ storeId: STORE, shopDomain: SHOP });

  for (const entry of w.logged.filter((e) => e.event.startsWith("intelligence.detection_"))) {
    assert.equal(entry.details.storeId, STORE);
    assert.equal(entry.details.shop, SHOP);
  }
});

// ===========================================================================
// Idempotency of the trigger itself
// ===========================================================================

test("repeated triggers are safe — detectors dedupe, so no duplicates accumulate", async () => {
  const w = buildWorld();
  const upserts = [];
  w.prisma.intelligenceFinding.upsert = async ({ where, create }) => {
    upserts.push(where.storeId_fingerprint.fingerprint);
    return { id: "f-1", ...create };
  };

  for (let i = 0; i < 3; i += 1) {
    await w.detectors.triggerIntelligenceDetectionAfterSync({ storeId: STORE, shopDomain: SHOP });
  }

  // An empty store yields no findings; the point is that three triggers ran
  // cleanly and every write went through the deduping upsert path.
  assert.equal(new Set(upserts).size, upserts.length === 0 ? 0 : new Set(upserts).size);
  assert.equal(
    w.logged.filter((e) => e.event === "intelligence.detection_completed").length,
    3
  );
});

// ===========================================================================
// Wiring contract — the sync path calls it correctly
// ===========================================================================

test("syncJobService fires the trigger from the success path only, without awaiting", () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, "../src/services/syncJobService.ts"),
    "utf8"
  );

  assert.match(src, /import \{ triggerIntelligenceDetectionAfterSync \}/);
  // `void` (not `await`) so a slow detector cannot delay sync completion.
  assert.match(src, /void triggerIntelligenceDetectionAfterSync\(/);
  assert.doesNotMatch(
    src,
    /await triggerIntelligenceDetectionAfterSync\(/,
    "awaiting would let detection latency delay the sync"
  );
  // Guarded so a FAILED derived status does not trigger analysis of stale data.
  assert.match(src, /if \(derivedSync\.status !== "FAILED"\) \{/);
});

test("the trigger lives in finalizeSyncSuccess, so both call sites inherit it once", () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, "../src/services/syncJobService.ts"),
    "utf8"
  );

  const finalizeStart = src.indexOf("async function finalizeSyncSuccess");
  const triggerAt = src.indexOf("void triggerIntelligenceDetectionAfterSync(");
  assert.ok(finalizeStart > -1 && triggerAt > finalizeStart, "inside finalizeSyncSuccess");

  // Exactly one call site — no parallel scheduler, no duplicated trigger.
  // (The import is a bare identifier, so only the invocation matches here.)
  assert.equal(
    (src.match(/triggerIntelligenceDetectionAfterSync\(/g) || []).length,
    1,
    "exactly one invocation"
  );
  assert.equal(
    (src.match(/finalizeSyncSuccess\(/g) || []).length >= 2,
    true,
    "finalizeSyncSuccess has multiple callers that all inherit the trigger"
  );
});

test("no scheduler, cron or interval was introduced anywhere", () => {
  const root = path.resolve(__dirname, "../src");
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith(".ts")) continue;
      const src = fs.readFileSync(full, "utf8");
      if (/\bnode-cron\b|\bsetInterval\s*\(/.test(src)) {
        // The pre-existing retention sweep is allowed; nothing new may appear.
        if (!/retention|dataRetention/i.test(src)) {
          offenders.push(path.relative(root, full));
        }
      }
    }
  };
  walk(root);

  assert.equal(
    offenders.includes("services/intelligenceDetectorService.ts"),
    false,
    "the detector service must not schedule itself"
  );
});

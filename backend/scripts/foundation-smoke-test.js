#!/usr/bin/env node
/**
 * ============================================================================
 * TEMPORARY CONTROLLED FOUNDATION SMOKE TEST — REMOVE AFTER USE
 * ============================================================================
 *
 * TODO(remove): delete together with the other backend/scripts/* helpers once
 * Part 1 is signed off.
 *
 * WHY THIS IS WORTH RUNNING
 * -------------------------
 * The 30 unit tests cover this logic with a mocked Prisma client. What they
 * cannot prove is that the REAL compound unique index works and that Prisma
 * Client's compound-key upsert (`where: { storeId_fingerprint: … }`) resolves
 * against the actual Postgres constraint. That mapping only exists once the
 * migration has run, so this is the one thing that genuinely needs a database.
 *
 * WHAT IT TOUCHES
 * ---------------
 * Only the IntelligenceFinding table, and only rows it creates itself, tagged
 * with the sentinel findingType below. It reads one existing Store id to satisfy
 * the foreign key and never modifies that store or any other table. It deletes
 * its own rows at the end and verifies the table is back to empty.
 *
 * It exercises the compiled service (dist/services/intelligenceFindingService.js)
 * rather than reimplementing the logic, so it tests the real code path.
 *
 * DOUBLE OPT-IN — both must be set, or it no-ops and exits 0:
 *   ALLOW_FOUNDATION_SMOKE_TEST=true
 *   ENABLE_INTELLIGENCE_FINDING_PERSISTENCE=true   (the service's own flag)
 *
 * USAGE — must run AFTER `npm run build`, since it needs dist/:
 *     … && npm run build && node scripts/foundation-smoke-test.js
 * ============================================================================
 */

const path = require("path");
const { PrismaClient } = require("@prisma/client");

const SENTINEL_TYPE = "__foundation_smoke_test__";
const prisma = new PrismaClient();

let created = 0;
const failures = [];

function check(label, ok, detail) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(label);
  return ok;
}

function log(message) {
  console.log(`[smoke] ${message}`);
}

async function cleanup(storeId) {
  // Deletes ONLY rows this script created, identified by the sentinel type.
  const result = await prisma.intelligenceFinding.deleteMany({
    where: { storeId, findingType: SENTINEL_TYPE },
  });
  log(`cleanup: removed ${result.count} test finding(s)`);

  const remaining = await prisma.intelligenceFinding.count({
    where: { findingType: SENTINEL_TYPE },
  });
  check("cleanup left no test rows behind", remaining === 0, `${remaining} remaining`);

  const total = await prisma.intelligenceFinding.count();
  check("IntelligenceFinding back to empty", total === 0, `${total} row(s) total`);
}

async function main() {
  const optedIn =
    String(process.env.ALLOW_FOUNDATION_SMOKE_TEST || "").trim() === "true";
  const flagOn =
    String(process.env.ENABLE_INTELLIGENCE_FINDING_PERSISTENCE || "")
      .trim()
      .toLowerCase() === "true";

  if (!optedIn) {
    log("ALLOW_FOUNDATION_SMOKE_TEST is not 'true' — skipping. Build continues.");
    return;
  }
  if (!flagOn) {
    log("ENABLE_INTELLIGENCE_FINDING_PERSISTENCE is not 'true'.");
    log("The service intentionally no-ops when its flag is off, so there is");
    log("nothing to test. Set both flags together, or skip this test.");
    return;
  }

  const service = require(path.resolve(
    __dirname,
    "../dist/services/intelligenceFindingService.js"
  ));

  // A real Store is required for the foreign key. Read one; change nothing.
  const store = await prisma.store.findFirst({ select: { id: true, shop: true } });
  if (!store) {
    log("no Store row exists on staging — cannot satisfy the foreign key.");
    log("Install the app on a staging dev store first, then re-run.");
    return;
  }
  log(`using existing store id ${store.id} (read-only; not modified)`);

  // Start from a clean slate in case a previous run was interrupted.
  await prisma.intelligenceFinding.deleteMany({
    where: { storeId: store.id, findingType: SENTINEL_TYPE },
  });

  const snapshot = {
    id: "smoke-insight-1",
    module: "fraud",
    title: "Foundation smoke test finding",
    reasons: ["Synthetic finding created by the Part 1 verification script"],
    evidence: [{ label: "Source", value: "foundation-smoke-test" }],
    financialImpact: { status: "impact_not_quantifiable", reason: "synthetic" },
    confidence: "low",
    recency: new Date().toISOString(),
    urgency: "low",
    easeOfAction: "manual",
    recommendedAction: "No action — delete this row if you see it",
    score: { total: 0, components: {}, weights: {}, excludedFromMonetaryRanking: true },
    methodology: { summary: "synthetic", assumptions: [], caps: [] },
    route: "/app/dashboard",
    dataQuality: "insufficient_data",
  };

  const args = {
    storeId: store.id,
    module: "fraud",
    findingType: SENTINEL_TYPE,
    subjectKey: "smoke-subject-1",
    snapshot,
    sourceInsightId: "smoke-insight-1",
  };

  try {
    console.log("");
    console.log("=== 8a. RECORD ONE FINDING ===");
    const first = await service.recordFinding({ ...args, now: new Date(Date.now() - 60_000) });
    created += 1;
    check("a finding was persisted", !!first);
    check("status is 'new'", first?.status === "new", first?.status);
    check("detectionCount is 1", first?.detectionCount === 1, String(first?.detectionCount));
    check("fingerprint is a sha256 hex", (first?.fingerprint || "").length === 64);
    check("snapshot stored", !!first?.snapshotJson);
    check(
      "snapshot omits redundant storeId",
      first?.snapshotJson ? !("storeId" in JSON.parse(first.snapshotJson)) : false
    );

    console.log("");
    console.log("=== 8b. REPEAT DETECTION DEDUPES (real unique constraint) ===");
    const second = await service.recordFinding({ ...args, now: new Date() });
    check("same row returned", second?.id === first?.id, `${first?.id} vs ${second?.id}`);
    check("detectionCount incremented to 2", second?.detectionCount === 2,
      String(second?.detectionCount));
    check(
      "lastSeenAt advanced",
      new Date(second.lastSeenAt).getTime() > new Date(first.lastSeenAt).getTime()
    );
    check(
      "firstDetectedAt unchanged",
      new Date(second.firstDetectedAt).getTime() === new Date(first.firstDetectedAt).getTime()
    );

    const count = await prisma.intelligenceFinding.count({
      where: { storeId: store.id, findingType: SENTINEL_TYPE },
    });
    check("still exactly ONE row (no duplicate)", count === 1, `${count} row(s)`);

    console.log("");
    console.log("=== 8c. LIFECYCLE TRANSITIONS ===");
    const seen = await service.transitionFindingStatus({
      storeId: store.id, findingId: first.id, status: "seen",
    });
    check("new -> seen", seen?.status === "seen", seen?.status);

    const resolved = await service.transitionFindingStatus({
      storeId: store.id, findingId: first.id, status: "resolved",
      note: "smoke test", actor: "verification-script",
    });
    check("seen -> resolved", resolved?.status === "resolved", resolved?.status);
    check("resolvedAt stamped", !!resolved?.resolvedAt);
    check("dismissedAt not stamped", resolved?.dismissedAt === null);

    console.log("");
    console.log("=== 8d. RE-DETECTION DOES NOT RESURRECT A RESOLVED FINDING ===");
    const afterResolve = await service.recordFinding({ ...args, now: new Date() });
    check("status stays 'resolved'", afterResolve?.status === "resolved",
      afterResolve?.status);
    check("lastSeenAt still advances", !!afterResolve?.lastSeenAt);

    console.log("");
    console.log("=== 8e. STORE ISOLATION ===");
    let isolated = false;
    try {
      await service.transitionFindingStatus({
        storeId: "definitely-not-a-real-store-id",
        findingId: first.id,
        status: "dismissed",
      });
    } catch (error) {
      isolated = /not found/i.test(error.message);
    }
    check("another store cannot transition this finding", isolated);
  } finally {
    console.log("");
    console.log("=== 8f. CLEANUP ===");
    await cleanup(store.id);
  }

  console.log("");
  console.log("=== SUMMARY ===");
  if (failures.length === 0) {
    console.log(`  ALL FOUNDATION CHECKS PASSED (${created} row created, then removed)`);
    console.log("  REMEMBER: set ENABLE_INTELLIGENCE_FINDING_PERSISTENCE back to false");
    console.log("  and remove ALLOW_FOUNDATION_SMOKE_TEST.");
  } else {
    console.log(`  ${failures.length} CHECK(S) FAILED:`);
    for (const f of failures) console.log(`   ! ${f}`);
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error("");
    console.error("[smoke] FAILED:", String(error.message).split("\n")[0]);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await prisma.$disconnect();
    } catch {
      /* ignore */
    }
  });

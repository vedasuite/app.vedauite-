const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

process.env.SHOPIFY_API_KEY ||= "test-key";
process.env.SHOPIFY_API_SECRET ||= "test-secret";
process.env.SHOPIFY_APP_URL ||= "https://app.vedasuite.in";
process.env.DATABASE_URL ||= "postgresql://example:example@localhost:5432/example";

function resetModule(modulePath) {
  const resolved = require.resolve(modulePath);
  delete require.cache[resolved];
}

const trialStatePath = path.resolve(__dirname, "../dist/billing/trialState.js");
const { computeTrialState, addDaysUtc, MS_PER_DAY } = require(trialStatePath);

// ---------------------------------------------------------------------------
// computeTrialState — the single canonical, pure, UTC-safe predicate.
// ---------------------------------------------------------------------------

test("computeTrialState: open trial reports trialActive=true with days remaining", () => {
  const now = new Date("2026-08-03T00:00:00.000Z").getTime();
  const state = computeTrialState(
    {
      trialStartedAt: new Date("2026-08-01T00:00:00.000Z"),
      trialEndsAt: new Date("2026-08-08T00:00:00.000Z"),
    },
    now
  );

  assert.equal(state.trialActive, true);
  assert.equal(state.trialDaysRemaining, 5);
  assert.equal(state.trialDatesIncomplete, false);
});

test("computeTrialState: expired trial reports trialActive=false and 0 days remaining", () => {
  const now = new Date("2026-08-10T00:00:00.000Z").getTime();
  const state = computeTrialState(
    {
      trialStartedAt: new Date("2026-08-01T00:00:00.000Z"),
      trialEndsAt: new Date("2026-08-08T00:00:00.000Z"),
    },
    now
  );

  assert.equal(state.trialActive, false);
  assert.equal(state.trialDaysRemaining, 0);
});

test("computeTrialState: missing dates report an explicit incomplete state, never invented dates", () => {
  const withNullStart = computeTrialState({
    trialStartedAt: null,
    trialEndsAt: new Date("2026-08-08T00:00:00.000Z"),
  });
  const withNullEnd = computeTrialState({
    trialStartedAt: new Date("2026-08-01T00:00:00.000Z"),
    trialEndsAt: null,
  });
  const withBothNull = computeTrialState({ trialStartedAt: null, trialEndsAt: null });

  for (const state of [withNullStart, withNullEnd, withBothNull]) {
    assert.equal(state.trialActive, false);
    assert.equal(state.trialDatesIncomplete, true);
    assert.equal(state.trialDaysRemaining, 0);
  }
});

test("computeTrialState: is independent of planName, subscription state, and showTrialDate — the function accepts neither", () => {
  // The type signature of computeTrialState only accepts trialStartedAt/
  // trialEndsAt — this test documents that guarantee by construction: there
  // is no way to pass a planName or accessActive flag that could influence
  // the result.
  const state = computeTrialState({
    trialStartedAt: new Date("2026-08-01T00:00:00.000Z"),
    trialEndsAt: new Date("2026-08-08T00:00:00.000Z"),
  });
  assert.equal(typeof state.trialActive, "boolean");
  assert.equal(Object.keys(state).sort().join(","),
    "trialActive,trialDatesIncomplete,trialDaysRemaining,trialEndsAt,trialStartedAt");
});

test("addDaysUtc: deterministic across a DST boundary and a month boundary", () => {
  // Fixed millisecond offset — must not shift by an hour around a DST
  // transition, and must land exactly 7*MS_PER_DAY later regardless of
  // calendar month length.
  const beforeSpringForwardUS = new Date("2026-03-06T12:00:00.000Z"); // ~1 week before US DST 2026
  const sevenDaysLater = addDaysUtc(beforeSpringForwardUS, 7);
  assert.equal(
    sevenDaysLater.getTime() - beforeSpringForwardUS.getTime(),
    7 * MS_PER_DAY,
    "must be exactly 7*MS_PER_DAY regardless of any local DST transition"
  );

  const endOfMonth = new Date("2026-01-28T00:00:00.000Z");
  const acrossMonthBoundary = addDaysUtc(endOfMonth, 7);
  assert.equal(acrossMonthBoundary.toISOString(), "2026-02-04T00:00:00.000Z");
});

test("computeTrialState days-remaining is consistent with the exact persisted end timestamp, not recomputed from trialDays", () => {
  const trialEndsAt = new Date("2026-08-08T13:30:00.000Z");
  const now = new Date("2026-08-08T13:29:00.000Z").getTime(); // 1 minute before expiry
  const state = computeTrialState({ trialStartedAt: new Date("2026-08-01T00:00:00.000Z"), trialEndsAt }, now);

  assert.equal(state.trialActive, true);
  // Ceil of ~1 minute remaining is 1 day, not 0 — rounds up so "last day" still reads as 1.
  assert.equal(state.trialDaysRemaining, 1);
});

// ---------------------------------------------------------------------------
// resolveTrialWindowForInstall — the durable one-trial-per-shop gate.
// ---------------------------------------------------------------------------

function freshTrialEligibilityService() {
  const prismaPath = path.resolve(__dirname, "../dist/db/prismaClient.js");
  const observabilityPath = path.resolve(__dirname, "../dist/services/observabilityService.js");
  const servicePath = path.resolve(__dirname, "../dist/services/trialEligibilityService.js");

  resetModule(prismaPath);
  resetModule(observabilityPath);
  resetModule(servicePath);

  const prisma = require(prismaPath).prisma;
  require(observabilityPath).logEvent = () => {};
  const service = require(servicePath);
  return { prisma, service };
}

test("first-ever installation grants exactly one trial, recorded durably", async () => {
  const { prisma, service } = freshTrialEligibilityService();
  const created = [];

  prisma.shopTrialHistory.findUnique = async () => null;
  prisma.shopTrialHistory.create = async ({ data }) => {
    created.push(data);
    return { ...data };
  };

  const installMoment = new Date("2026-08-01T00:00:00.000Z");
  const result = await service.resolveTrialWindowForInstall(
    "new-shop.myshopify.com",
    installMoment,
    null
  );

  assert.equal(created.length, 1, "history is created exactly once");
  assert.equal(result.trialStartedAt.toISOString(), "2026-08-01T00:00:00.000Z");
  assert.equal(result.trialEndsAt.toISOString(), "2026-08-08T00:00:00.000Z");
});

test("existing durable history is reused — uninstall/reinstall never extends or resets it", async () => {
  const { prisma, service } = freshTrialEligibilityService();
  const history = {
    shop: "returning-shop.myshopify.com",
    firstInstalledAt: new Date("2026-01-01T00:00:00.000Z"),
    trialStartedAt: new Date("2026-01-01T00:00:00.000Z"),
    trialEndsAt: new Date("2026-01-08T00:00:00.000Z"),
  };

  prisma.shopTrialHistory.findUnique = async () => history;
  prisma.shopTrialHistory.create = async () => {
    throw new Error("must never create a new history row when one already exists");
  };

  // Simulate reinstalling long after the original trial window, and even
  // across multiple uninstall/reinstall cycles — the result must always be
  // the original window, never a new one.
  for (const reinstallMoment of [
    new Date("2026-02-01T00:00:00.000Z"),
    new Date("2026-06-01T00:00:00.000Z"),
    new Date("2027-01-01T00:00:00.000Z"),
  ]) {
    const result = await service.resolveTrialWindowForInstall(
      "returning-shop.myshopify.com",
      reinstallMoment,
      null
    );
    assert.equal(result.trialStartedAt.toISOString(), "2026-01-01T00:00:00.000Z");
    assert.equal(result.trialEndsAt.toISOString(), "2026-01-08T00:00:00.000Z");
  }
});

test("Store row missing/purged but durable history still present: reinstall does not grant a second trial", async () => {
  // Models exactly the shop/redact-then-reinstall scenario: the Store row is
  // gone (candidateStoreWindow is null, as it would be for a freshly
  // recreated row), but ShopTrialHistory survived the purge.
  const { prisma, service } = freshTrialEligibilityService();
  const history = {
    shop: "purged-then-reinstalled.myshopify.com",
    firstInstalledAt: new Date("2026-01-01T00:00:00.000Z"),
    trialStartedAt: new Date("2026-01-01T00:00:00.000Z"),
    trialEndsAt: new Date("2026-01-08T00:00:00.000Z"),
  };
  prisma.shopTrialHistory.findUnique = async () => history;
  prisma.shopTrialHistory.create = async () => {
    throw new Error("must not grant a new trial merely because the Store row is missing");
  };

  const result = await service.resolveTrialWindowForInstall(
    "purged-then-reinstalled.myshopify.com",
    new Date("2027-03-01T00:00:00.000Z"),
    null // no Store row exists — this is exactly the "row deleted" scenario
  );

  assert.equal(result.trialEndsAt.toISOString(), "2026-01-08T00:00:00.000Z");
  assert.equal(computeTrialState(result, new Date("2027-03-01T00:00:00.000Z").getTime()).trialActive, false);
});

test("Store row has trial dates but no durable history yet: backfills history instead of granting a new trial", async () => {
  const { prisma, service } = freshTrialEligibilityService();
  const created = [];
  prisma.shopTrialHistory.findUnique = async () => null;
  prisma.shopTrialHistory.create = async ({ data }) => {
    created.push(data);
    return { ...data };
  };

  const existingStoreWindow = {
    trialStartedAt: new Date("2026-01-01T00:00:00.000Z"),
    trialEndsAt: new Date("2026-01-08T00:00:00.000Z"),
  };

  const result = await service.resolveTrialWindowForInstall(
    "legacy-shop.myshopify.com",
    new Date("2026-08-01T00:00:00.000Z"), // reauth moment, much later than the original trial
    existingStoreWindow
  );

  assert.equal(created.length, 1);
  // Backfilled from the EXISTING window, not from the reauth moment.
  assert.equal(result.trialStartedAt.toISOString(), "2026-01-01T00:00:00.000Z");
  assert.equal(result.trialEndsAt.toISOString(), "2026-01-08T00:00:00.000Z");
});

test("concurrent first-install race converges on one winner, never two different windows", async () => {
  const { prisma, service } = freshTrialEligibilityService();
  let created = false;
  let winningWindow = null;

  prisma.shopTrialHistory.findUnique = async () => (created ? winningWindow : null);
  prisma.shopTrialHistory.create = async ({ data }) => {
    if (created) {
      const err = new Error("unique constraint");
      err.code = "P2002";
      throw err;
    }
    created = true;
    winningWindow = { ...data };
    return winningWindow;
  };

  const [a, b] = await Promise.all([
    service.resolveTrialWindowForInstall(
      "race-shop.myshopify.com",
      new Date("2026-08-01T00:00:00.000Z"),
      null
    ),
    service.resolveTrialWindowForInstall(
      "race-shop.myshopify.com",
      new Date("2026-08-01T00:00:00.010Z"),
      null
    ),
  ]);

  assert.equal(a.trialEndsAt.toISOString(), b.trialEndsAt.toISOString());
});

test("a database failure fails closed: returns null rather than guessing a trial window", async () => {
  const { prisma, service } = freshTrialEligibilityService();
  prisma.shopTrialHistory.findUnique = async () => {
    throw new Error("Can't reach database server");
  };

  const result = await service.resolveTrialWindowForInstall(
    "unreachable-db-shop.myshopify.com",
    new Date("2026-08-01T00:00:00.000Z"),
    null
  );

  assert.equal(result, null, "must fail closed, never fabricate now+N days");
});

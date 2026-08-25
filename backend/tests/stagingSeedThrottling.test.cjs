const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

process.env.SHOPIFY_API_KEY ||= "test-key";
process.env.SHOPIFY_API_SECRET ||= "test-secret";
process.env.SHOPIFY_APP_URL ||= "https://vedasuite-staging.onrender.com";
process.env.SHOPIFY_ADMIN_API_VERSION ||= "2026-01";
process.env.DATABASE_URL ||= "postgresql://example:example@localhost:5432/example";

/**
 * STAGING SEED — THROTTLING, RESUME AND IDEMPOTENCY.
 *
 * WHAT WENT WRONG
 * ---------------
 * The first real run created 10 orders and failed 54 with "Too many attempts.
 * Please try again later." The loop fired orderCreate as fast as the event loop
 * allowed, with no pacing and no retry, so it emptied Shopify's bucket in
 * seconds and then burned every remaining order against a closed door. Worse,
 * each failure was lost: there was no way to create only the missing ones.
 *
 * These tests drive the REAL service against a fake Shopify that throttles on
 * demand, so each of those three faults is held closed by an executable
 * assertion rather than by a comment.
 */

const d = (p) => path.resolve(__dirname, `../dist/${p}`);
const resetModule = (p) => delete require.cache[require.resolve(p)];

const SHOP = "veda-dev.myshopify.com";

/**
 * A fake Shopify that stores orders by their identity tag.
 *
 * `throttleFor` makes the next N create attempts fail the way Shopify does, so
 * the retry and resume paths are exercised for real rather than simulated.
 */
function fakeShopify({ throttleFor = 0, throttleMode = "graphql", retryAfter = null } = {}) {
  const created = new Map(); // label -> order
  let remainingThrottles = throttleFor;
  const attempts = { create: 0, read: 0 };

  const handler = async (_url, init) => {
    const body = JSON.parse(init.body);
    const isCreate = /SeedOrderCreate/.test(body.query);

    if (!isCreate) {
      attempts.read += 1;
      const edges = [...created.values()].map((o) => ({ node: o }));
      return jsonResponse({
        data: { orders: { pageInfo: { hasNextPage: false, endCursor: null }, edges } },
      });
    }

    attempts.create += 1;

    if (remainingThrottles > 0) {
      remainingThrottles -= 1;
      if (throttleMode === "http429") {
        return {
          ok: false,
          status: 429,
          headers: new Map([["retry-after", retryAfter ?? "1"]]),
          text: async () => "Too many attempts. Please try again later.",
        };
      }
      // Shopify's GraphQL throttle: HTTP 200 with a THROTTLED extension.
      return jsonResponse({
        errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }],
      });
    }

    const tags = body.variables.order.tags;
    const label = tags
      .find((t) => t.startsWith("vedasuite-seed-"))
      .slice("vedasuite-seed-".length);

    // The fake refuses to store the same label twice, so a duplicate would be
    // visible as a count, not merely as an overwrite.
    if (created.has(label)) {
      throw new Error(`DUPLICATE: ${label} was created twice`);
    }
    created.set(label, {
      id: `gid://shopify/Order/${created.size + 1}`,
      name: `#${1000 + created.size}`,
      displayFinancialStatus: body.variables.order.financialStatus,
      tags,
    });

    return jsonResponse({
      data: {
        orderCreate: { order: created.get(label), userErrors: [] },
      },
    });
  };

  return { handler, created, attempts, setThrottles: (n) => (remainingThrottles = n) };
}

function jsonResponse(payload) {
  const text = JSON.stringify(payload);
  return {
    ok: true,
    status: 200,
    headers: new Map(),
    text: async () => text,
  };
}

/** Loads the real service with Shopify and the token lookup faked. */
function loadService(shopify) {
  const connectionPath = d("services/shopifyConnectionService.js");
  const servicePath = d("services/stagingSeedService.js");
  const obsPath = d("services/observabilityService.js");

  [connectionPath, servicePath, obsPath].forEach((p) => {
    try {
      resetModule(p);
    } catch {
      /* not yet loaded */
    }
  });

  require.cache[connectionPath] = {
    id: connectionPath,
    filename: connectionPath,
    loaded: true,
    exports: {
      resolveOfflineInstallation: async () => ({ shop: SHOP, accessToken: "token" }),
      normalizeShopDomain: (s) => s,
    },
  };

  const original = global.fetch;
  global.fetch = shopify.handler;
  const service = require(servicePath);
  require(obsPath).logEvent = () => {};

  return { service, restore: () => (global.fetch = original) };
}

// ===========================================================================
// Throttle detection — the judgement everything else rests on
// ===========================================================================

test("throttle messages are recognised in every shape Shopify sends", () => {
  const { service, restore } = loadService(fakeShopify());
  try {
    for (const message of [
      "Too many attempts. Please try again later.",
      "Throttled",
      "THROTTLED",
      "Exceeded 2 calls per second",
      "rate limit reached",
      "HTTP 429",
    ]) {
      assert.equal(service.isThrottleMessage(message), true, `"${message}" is a throttle`);
    }
    // And a hard failure must NOT be mistaken for one — retrying an access
    // denial five times just buries the real message under a timeout.
    for (const message of [
      "Access denied for orderCreate field",
      "Field 'processedAt' doesn't exist",
      "Order total must be positive",
    ]) {
      assert.equal(service.isThrottleMessage(message), false, `"${message}" is NOT a throttle`);
    }
  } finally {
    restore();
  }
});

test("Retry-After is honoured, and a hostile value cannot park the run", () => {
  const { service, restore } = loadService(fakeShopify());
  try {
    assert.equal(service.parseRetryAfterMs("2"), 2000);
    assert.equal(service.parseRetryAfterMs(null), null);
    assert.equal(service.parseRetryAfterMs("not-a-number"), null);
    assert.equal(service.parseRetryAfterMs("-5"), null);
    // Bounded: a malformed or hostile header must not stall the batch for an hour.
    assert.equal(service.parseRetryAfterMs("99999"), service.SEED_BACKOFF_CAP_MS);
  } finally {
    restore();
  }
});

test("backoff grows and is capped, with jitter", () => {
  const { service, restore } = loadService(fakeShopify());
  try {
    const noJitter = () => 0.5; // -> exactly the exponential value
    const a1 = service.backoffMs(1, noJitter);
    const a2 = service.backoffMs(2, noJitter);
    const a3 = service.backoffMs(3, noJitter);
    assert.ok(a2 > a1 && a3 > a2, "each attempt must wait longer");
    assert.ok(
      service.backoffMs(20, noJitter) <= service.SEED_BACKOFF_CAP_MS,
      "and it must never exceed the cap"
    );
    // Jitter: two different randoms must give different waits, so parallel
    // operators do not retry in lockstep.
    assert.notEqual(service.backoffMs(3, () => 0), service.backoffMs(3, () => 0.99));
  } finally {
    restore();
  }
});

// ===========================================================================
// Retry — a throttled order is not lost
// ===========================================================================

test("REGRESSION: a throttled order is retried, not counted as failed", async () => {
  // Two throttles then success. Under the old code this order was simply lost.
  const shopify = fakeShopify({ throttleFor: 2 });
  const { service, restore } = loadService(shopify);
  try {
    const result = await service.runSeedBatch({ shop: SHOP, batchSize: 1 });
    assert.equal(result.createdThisBatch, 1, "the order must survive two throttles");
    assert.equal(result.failedThisBatch, 0);
    assert.equal(shopify.attempts.create, 3, "one success after two throttled attempts");
  } finally {
    restore();
  }
});

test("an HTTP 429 with Retry-After is handled the same as a GraphQL throttle", async () => {
  const shopify = fakeShopify({ throttleFor: 1, throttleMode: "http429", retryAfter: "0" });
  const { service, restore } = loadService(shopify);
  try {
    const result = await service.runSeedBatch({ shop: SHOP, batchSize: 1 });
    assert.equal(result.createdThisBatch, 1);
    assert.equal(result.failedThisBatch, 0);
  } finally {
    restore();
  }
});

test("REGRESSION: a persistent throttle stops the batch instead of burning it", async () => {
  // The exact first-run failure: 54 orders destroyed against a closed door.
  // Once an order exhausts its retries the batch must stop, not continue.
  const shopify = fakeShopify({ throttleFor: 10_000 });
  const { service, restore } = loadService(shopify);
  try {
    const result = await service.runSeedBatch({ shop: SHOP, batchSize: 12, timing: { delayMs: 0, backoffMs: 0 } });
    assert.equal(result.createdThisBatch, 0);
    assert.equal(
      result.failedThisBatch,
      1,
      "exactly ONE order should be recorded failed — the batch stops rather than " +
        "throwing the other 11 at a rate limiter that is still closed"
    );
    assert.ok(
      shopify.attempts.create <= service.SEED_MAX_ATTEMPTS,
      `attempted ${shopify.attempts.create} times; the cap is ${service.SEED_MAX_ATTEMPTS}`
    );
    assert.equal(result.moreToDo, false, "the page must not loop into another batch");
    assert.match(result.errors[0], /throttl/i);
  } finally {
    restore();
  }
});

test("a hard error is not retried as though it were a throttle", async () => {
  const shopify = fakeShopify();
  const { service, restore } = loadService(shopify);
  const originalHandler = shopify.handler;
  try {
    global.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      if (/SeedOrderCreate/.test(body.query)) {
        shopify.attempts.create += 1;
        return jsonResponse({ errors: [{ message: "Access denied for orderCreate field" }] });
      }
      return originalHandler(url, init);
    };
    const result = await service.runSeedBatch({ shop: SHOP, batchSize: 3, timing: { delayMs: 0, backoffMs: 0 } });
    assert.equal(
      shopify.attempts.create,
      3,
      "one attempt per order — retrying an access denial just buries the message"
    );
    assert.equal(result.failedThisBatch, 3);
    assert.match(result.errors[0], /Access denied/);
  } finally {
    restore();
  }
});

// ===========================================================================
// Resume and idempotency — the whole point
// ===========================================================================

test("REGRESSION: resuming creates ONLY the missing orders", async () => {
  const shopify = fakeShopify();
  const { service, restore } = loadService(shopify);
  try {
    const first = await service.runSeedBatch({ shop: SHOP, batchSize: 10, timing: { delayMs: 0, backoffMs: 0 } });
    assert.equal(first.createdThisBatch, 10);

    const afterFirst = shopify.created.size;
    const second = await service.runSeedBatch({ shop: SHOP, batchSize: 10, timing: { delayMs: 0, backoffMs: 0 } });

    assert.equal(second.createdThisBatch, 10);
    assert.equal(
      shopify.created.size,
      afterFirst + 10,
      "the second batch must ADD ten, not repeat the first ten"
    );
    // The fake throws on a duplicate label, so reaching here already proves it.
    assert.equal(new Set(shopify.created.keys()).size, 20);
  } finally {
    restore();
  }
});

test("REGRESSION: repeated clicks cannot duplicate anything", async () => {
  const shopify = fakeShopify();
  const { service, restore } = loadService(shopify);
  try {
    // Seed everything, then hammer it as an impatient operator would.
    for (let i = 0; i < 10; i += 1) {
      const r = await service.runSeedBatch({ shop: SHOP, batchSize: 12, timing: { delayMs: 0, backoffMs: 0 } });
      if (r.state.remaining === 0) break;
    }
    const total = shopify.created.size;

    for (let i = 0; i < 3; i += 1) {
      const extra = await service.runSeedBatch({ shop: SHOP, batchSize: 12, timing: { delayMs: 0, backoffMs: 0 } });
      assert.equal(extra.createdThisBatch, 0, "nothing left to create");
      assert.equal(extra.state.remaining, 0);
    }
    assert.equal(shopify.created.size, total, "and no duplicate was created");
  } finally {
    restore();
  }
});

test("the completed fixture matches the intended 64 orders and refund split", async () => {
  const shopify = fakeShopify();
  const { service, restore } = loadService(shopify);
  const plan = require(d("services/stagingSeedPlan.js"));
  try {
    for (let i = 0; i < 10; i += 1) {
      const r = await service.runSeedBatch({ shop: SHOP, batchSize: 12, timing: { delayMs: 0, backoffMs: 0 } });
      if (r.state.remaining === 0) break;
    }

    const expected = plan.buildStagingSeedPlan();
    const summary = plan.summariseStagingSeedPlan(expected);

    assert.equal(shopify.created.size, expected.length, "every planned order exists");
    assert.equal(expected.length, 64, "the fixture is still 64 orders");
    assert.equal(summary.shoppers.length, 9, "across 9 shoppers");

    const refunded = [...shopify.created.values()].filter(
      (o) => o.displayFinancialStatus === "REFUNDED"
    ).length;
    assert.equal(
      refunded,
      summary.totalRefunds,
      "the refund distribution is preserved, not approximated"
    );
    assert.equal(summary.qualifyingShoppers, 1, "and exactly one shopper still qualifies");
  } finally {
    restore();
  }
});

// ===========================================================================
// The readiness message
// ===========================================================================

test("REGRESSION: 'click Sync Data' is withheld until the fixture is actually usable", async () => {
  // The first run finished with 10 of 64 orders and still told the operator to
  // go and sync — which would have sent them to an empty Action Center with no
  // way to tell whether the FIXTURE or the PRODUCT was at fault.
  const shopify = fakeShopify();
  const { service, restore } = loadService(shopify);
  try {
    const partial = await service.runSeedBatch({ shop: SHOP, batchSize: 10, timing: { delayMs: 0, backoffMs: 0 } });
    assert.equal(partial.state.taggedOrderCount, 10);
    assert.equal(partial.state.readyToSync, false);
    assert.doesNotMatch(partial.state.readyReason, /Sync Data/i);
    assert.match(partial.state.readyReason, /50/, "it must say what the shortfall is");

    for (let i = 0; i < 10; i += 1) {
      const r = await service.runSeedBatch({ shop: SHOP, batchSize: 12, timing: { delayMs: 0, backoffMs: 0 } });
      if (r.state.remaining === 0) {
        assert.equal(r.state.readyToSync, true);
        assert.match(r.state.readyReason, /Sync Data/i);
        break;
      }
    }
  } finally {
    restore();
  }
});

test("50+ orders without the repeat-refund shopper is still NOT ready", () => {
  // A store with a big baseline and no lossy shopper has nothing to find, so
  // sending the operator to sync would waste the run.
  const { service, restore } = loadService(fakeShopify());
  const plan = require(d("services/stagingSeedPlan.js"));
  try {
    const orders = plan.buildStagingSeedPlan();
    const baselineOnly = new Set(
      orders.filter((o) => o.label.startsWith("baseline-")).map((o) => o.label)
    );

    const verdict = service.assessReadiness(orders, baselineOnly, baselineOnly.size);
    assert.ok(baselineOnly.size >= 50, "the baseline alone clears the order count");
    assert.equal(verdict.readyToSync, false, "but the finding itself is missing");
    assert.match(verdict.readyReason, /repeat-refund/i);
    assert.doesNotMatch(verdict.readyReason, /click Sync Data/i);
  } finally {
    restore();
  }
});

// ===========================================================================
// Progress reporting
// ===========================================================================

test("progress reports existing, created, refunded, remaining and failed", async () => {
  const shopify = fakeShopify();
  const { service, restore } = loadService(shopify);
  try {
    const r = await service.runSeedBatch({ shop: SHOP, batchSize: 5, timing: { delayMs: 0, backoffMs: 0 } });
    for (const key of ["createdThisBatch", "refundedThisBatch", "failedThisBatch"]) {
      assert.equal(typeof r[key], "number", `${key} must be reported`);
    }
    for (const key of ["taggedOrderCount", "remaining", "refundedExisting", "totalPlanned"]) {
      assert.equal(typeof r.state[key], "number", `state.${key} must be reported`);
    }
    assert.equal(r.state.taggedOrderCount, 5);
    assert.equal(r.state.remaining, r.state.totalPlanned - 5);
  } finally {
    restore();
  }
});

test("SAFETY: a non-development store is refused before any request is made", async () => {
  const shopify = fakeShopify();
  const { service, restore } = loadService(shopify);
  try {
    for (const bad of ["app.vedasuite.in", "example.com", ""]) {
      await assert.rejects(
        () => service.runSeedBatch({ shop: bad, batchSize: 1 }),
        /not a Shopify development store/
      );
    }
    assert.equal(shopify.attempts.create, 0, "nothing may be created for a refused store");
  } finally {
    restore();
  }
});

// ===========================================================================
// The shipped defaults
// ===========================================================================

test("PRODUCTION DEFAULTS: pacing and retry are real, not test-only fictions", () => {
  // Most tests above inject zero delays, because a regression test that takes
  // 40 real seconds gets deleted or skipped, and a test nobody runs protects
  // nothing. That trade is only honest if the DEFAULTS are asserted separately.
  const { service, restore } = loadService(fakeShopify());
  try {
    assert.equal(service.DEFAULT_TIMING.delayMs, service.SEED_DELAY_MS);
    assert.equal(service.DEFAULT_TIMING.maxAttempts, service.SEED_MAX_ATTEMPTS);
    assert.equal(service.DEFAULT_TIMING.backoffMs, service.SEED_BACKOFF_CAP_MS);

    // Pacing must actually exist — zero would recreate the original failure.
    assert.ok(service.SEED_DELAY_MS >= 500, "pacing must be meaningful, not token");
    assert.ok(service.SEED_MAX_ATTEMPTS >= 3, "one retry is not a retry policy");
    assert.ok(service.SEED_BACKOFF_BASE_MS >= 1000);
    // A batch must stay well inside any proxy timeout: 12 x 700ms is ~8s.
    assert.ok(
      service.SEED_BATCH_SIZE * service.SEED_DELAY_MS < 30_000,
      "a batch must not risk an HTTP timeout"
    );
  } finally {
    restore();
  }
});

test("PRODUCTION DEFAULTS: a real batch actually paces itself", async () => {
  // One deliberately slow test, proving the default path sleeps between
  // creations rather than firing as fast as the event loop allows.
  const shopify = fakeShopify();
  const { service, restore } = loadService(shopify);
  try {
    const startedAt = Date.now();
    const result = await service.runSeedBatch({ shop: SHOP, batchSize: 3 });
    const elapsed = Date.now() - startedAt;

    assert.equal(result.createdThisBatch, 3);
    // Three creations = two gaps. Allow slack for the read round-trips.
    assert.ok(
      elapsed >= service.SEED_DELAY_MS * 2 * 0.8,
      `batch finished in ${elapsed}ms; pacing should make it at least ` +
        `${Math.round(service.SEED_DELAY_MS * 2 * 0.8)}ms`
    );
  } finally {
    restore();
  }
});

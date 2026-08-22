const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

/**
 * EMBEDDED SESSION TOKEN ACQUISITION.
 *
 * REPRODUCES: intermittent 401s during onboarding, seen as repeated
 * "[vedasuite.auth] 401_received" for /api/dashboard/onboarding/view-insight
 * and a red "Shopify connection needs attention" banner that a refresh cleared.
 *
 * Root cause: getEmbeddedSessionToken() returned null the instant
 * window.shopify was undefined, so a request issued before the App Bridge CDN
 * script finished loading went out with NO Authorization header. The backend
 * answered 401. The auth-retry budget (AUTH_RETRIES=2, backoff 250ms then
 * 500ms) re-polled the same instant-null, exhausting every attempt in roughly
 * 750ms - far less than a cold App Bridge load.
 *
 * These tests execute the real waiter with injected time, so they are
 * deterministic and instant.
 */

const FRONTEND = path.resolve(__dirname, "../../frontend/src");
const READY_URL = pathToFileURL(path.join(FRONTEND, "lib/appBridgeReady.js")).href;
const BRIDGE_SRC = path.join(FRONTEND, "shopifyAppBridge.ts");
const REQUEST_SRC = path.join(FRONTEND, "lib/embeddedShopRequest.ts");

let waitForAppBridge;
let APP_BRIDGE_READY_TIMEOUT_MS;
let APP_BRIDGE_POLL_INTERVAL_MS;

test.before(async () => {
  const mod = await import(READY_URL);
  ({
    waitForAppBridge,
    APP_BRIDGE_READY_TIMEOUT_MS,
    APP_BRIDGE_POLL_INTERVAL_MS,
  } = mod);
});

/**
 * A virtual clock. sleep() advances time instantly, so a 5000ms timeout costs
 * nothing to test and the assertions are exact rather than flaky.
 */
function fakeClock() {
  let current = 0;
  return {
    now: () => current,
    sleep: async (ms) => {
      current += ms;
    },
    elapsed: () => current,
  };
}

/** App Bridge that appears after `readyAt` virtual milliseconds. */
function bridgeArrivingAt(clock, readyAt) {
  const bridge = { idToken: async () => "token" };
  return () => (clock.now() >= readyAt ? bridge : null);
}

// ===========================================================================
// The reported failure
// ===========================================================================

test("REPRO: a cold App Bridge load no longer yields an instant null", async () => {
  const clock = fakeClock();
  // The CDN script lands at 1200ms - past the old ~750ms retry budget, which is
  // exactly why every attempt failed and the merchant saw an auth error.
  const result = await waitForAppBridge({
    getBridge: bridgeArrivingAt(clock, 1200),
    sleep: clock.sleep,
    now: clock.now,
  });

  assert.notEqual(result, null, "must wait for App Bridge instead of returning null");
  assert.ok(clock.elapsed() >= 1200, "must have waited until App Bridge arrived");
  assert.ok(clock.elapsed() < 1200 + APP_BRIDGE_POLL_INTERVAL_MS * 2, "must not overshoot");
});

test("REPRO: App Bridge arriving beyond the old retry budget is still caught", async () => {
  // Anything under the timeout must succeed, including a slow cold start.
  for (const readyAt of [800, 1500, 3000, 4900]) {
    const clock = fakeClock();
    const result = await waitForAppBridge({
      getBridge: bridgeArrivingAt(clock, readyAt),
      sleep: clock.sleep,
      now: clock.now,
    });
    assert.notEqual(result, null, `App Bridge ready at ${readyAt}ms must be picked up`);
  }
});

// ===========================================================================
// The fast path must stay free
// ===========================================================================

test("FAST PATH: an already-initialised App Bridge returns without sleeping", async () => {
  const clock = fakeClock();
  const bridge = { idToken: async () => "token" };

  const result = await waitForAppBridge({
    getBridge: () => bridge,
    sleep: clock.sleep,
    now: clock.now,
  });

  assert.equal(result, bridge);
  assert.equal(clock.elapsed(), 0, "the steady state must add no latency at all");
});

test("FAST PATH: getBridge is called once when App Bridge is already present", async () => {
  let calls = 0;
  const clock = fakeClock();
  await waitForAppBridge({
    getBridge: () => {
      calls += 1;
      return { idToken: async () => "t" };
    },
    sleep: clock.sleep,
    now: clock.now,
  });
  assert.equal(calls, 1);
});

// ===========================================================================
// Failure is bounded
// ===========================================================================

test("BOUNDED: an App Bridge that never arrives gives up at the timeout", async () => {
  const clock = fakeClock();
  const result = await waitForAppBridge({
    getBridge: () => null,
    sleep: clock.sleep,
    now: clock.now,
  });

  assert.equal(result, null, "must give up rather than hang");
  assert.ok(
    clock.elapsed() >= APP_BRIDGE_READY_TIMEOUT_MS,
    "must wait the full timeout before declaring failure"
  );
  assert.ok(
    clock.elapsed() < APP_BRIDGE_READY_TIMEOUT_MS + APP_BRIDGE_POLL_INTERVAL_MS * 2,
    "must not wait meaningfully past the timeout"
  );
});

test("BOUNDED: the wait stays inside the request timeout budget", () => {
  // embeddedShopRequest defaults to 30s; the wait must not consume it.
  assert.ok(
    APP_BRIDGE_READY_TIMEOUT_MS < 30000,
    "the readiness wait must be well inside the request timeout"
  );
  assert.ok(APP_BRIDGE_POLL_INTERVAL_MS > 0, "polling must actually advance time");
});

test("BOUNDED: a custom timeout is honoured", async () => {
  const clock = fakeClock();
  const result = await waitForAppBridge({
    getBridge: () => null,
    sleep: clock.sleep,
    now: clock.now,
    timeoutMs: 300,
    pollIntervalMs: 50,
  });
  assert.equal(result, null);
  assert.ok(clock.elapsed() >= 300 && clock.elapsed() < 400);
});

// ===========================================================================
// Wiring — the fix must be on the path the 401s came from
// ===========================================================================

test("WIRING: getEmbeddedSessionToken waits for App Bridge before giving up", () => {
  const src = fs.readFileSync(BRIDGE_SRC, "utf8");

  assert.match(
    src,
    /from "\.\/lib\/appBridgeReady"/,
    "shopifyAppBridge must use the shared waiter"
  );

  const fn = src.match(
    /export async function getEmbeddedSessionToken[\s\S]*?\n\}/
  );
  assert.ok(fn, "getEmbeddedSessionToken must exist");
  assert.match(
    fn[0],
    /await ensureAppBridgeReady\(\)/,
    "it must await App Bridge readiness rather than returning null immediately"
  );

  // The old instant-bail must be gone.
  assert.doesNotMatch(
    fn[0],
    /if \(typeof window === "undefined" \|\| !window\.shopify\) \{\s*return null;/,
    "the instant null-return on a missing App Bridge must not come back"
  );
});

test("WIRING: the readiness wait is shared, not repeated per request", () => {
  // Without memoisation a failed load would cost the full timeout on every
  // single request, turning one slow start into a stalled app.
  const src = fs.readFileSync(BRIDGE_SRC, "utf8");
  assert.match(src, /appBridgeReadyPromise/, "the wait must be memoised");
  assert.match(
    src,
    /if \(window\.shopify\) \{\s*return Promise\.resolve\(window\.shopify\);/,
    "a late arrival must still be picked up without re-polling"
  );
});

test("WIRING: both request paths go through getEmbeddedSessionToken", () => {
  // embeddedShopRequest (onboarding, billing) and the axios client (modules)
  // must share the fix; view-insight uses the former.
  const request = fs.readFileSync(REQUEST_SRC, "utf8");
  assert.match(request, /getEmbeddedSessionToken/, "embeddedShopRequest must use it");

  const client = fs.readFileSync(path.join(FRONTEND, "api/client.ts"), "utf8");
  assert.match(client, /getEmbeddedSessionToken/, "the axios client must use it too");
});

test("WIRING: view-insight is dispatched through the fixed path", () => {
  // The endpoint that produced the reported 401s.
  const provider = fs.readFileSync(
    path.join(FRONTEND, "providers/OnboardingProvider.tsx"),
    "utf8"
  );
  assert.match(provider, /onboarding\/view-insight/, "the endpoint must still exist");
  assert.match(
    provider,
    /embeddedShopRequest/,
    "onboarding mutations must use the request path that acquires a session token"
  );
});

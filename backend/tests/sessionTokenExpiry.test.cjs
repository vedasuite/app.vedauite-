const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const Module = require("node:module");

/**
 * SESSION TOKEN EXPIRY — THE SHARED AUTHENTICATED REQUEST FLOW.
 *
 * WHAT FAILED
 * -----------
 * The real-data smoke test hit intermittent 401s on /api/action-center with
 * "TokenExpiredError / jwt expired". Only a manual page refresh cleared it.
 *
 * ROOT CAUSE, and it was not Action Center.
 *
 * getEmbeddedSessionToken returned whatever App Bridge handed back, and the
 * cached path trusted `expiresAt` — a value WE computed when storing it.
 * Neither path ever asked the token itself whether it was still alive. So a
 * dead JWT could be sent: App Bridge can return a token from its own cache that
 * is already most of the way through its ~60s life, and a backgrounded tab or
 * clock skew puts our bookkeeping out of step with the JWT's `exp`.
 *
 * Recovery then failed too. The 401 retry fired only when the SERVER set
 * `x-shopify-retry-invalid-session-request`, and busting OUR cache did not force
 * App Bridge to mint a new token — so the retry could send the same dead token,
 * exhaust its attempts, and surface the raw error to the merchant.
 *
 * These tests execute the REAL frontend modules with an injected clock and a
 * fake App Bridge, so every assertion is about shipped behaviour.
 */

const FRONTEND = path.resolve(__dirname, "../../frontend/src");

/** Transpiles and executes a frontend TS module with its imports stubbed. */
function loadModule(relPath, stubs = {}) {
  const source = path.join(FRONTEND, relPath);
  const js = ts.transpileModule(fs.readFileSync(source, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;

  const mod = new Module(source);
  mod.paths = Module._nodeModulePaths(path.dirname(source));
  const originalRequire = mod.require.bind(mod);
  mod.require = (request) => {
    if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
    return originalRequire(request);
  };
  mod._compile(js, source);
  return mod.exports;
}

/** Builds a JWT whose `exp` is `secondsFromNow` away. Signature is irrelevant. */
function makeToken(secondsFromNow, marker = "t") {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      exp: Math.floor((Date.now() + secondsFromNow * 1000) / 1000),
      dest: "https://veda-dev.myshopify.com",
      marker,
    })
  ).toString("base64url");
  return `${header}.${payload}.sig-${marker}`;
}

/**
 * Loads shopifyAppBridge with a controllable App Bridge.
 *
 * `tokens` is the queue idToken() serves; the last value repeats, which is how
 * a real App Bridge behaves when it keeps returning its own cached token.
 */
function loadBridge({ tokens, shop = "veda-dev.myshopify.com" }) {
  const queue = [...tokens];
  const calls = { idToken: 0 };

  global.window = {
    shopify: {
      idToken: async () => {
        calls.idToken += 1;
        return queue.length > 1 ? queue.shift() : queue[0];
      },
    },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
  };
  global.atob = (b64) => Buffer.from(b64, "base64").toString("binary");

  const bridge = loadModule("shopifyAppBridge.ts", {
    "./lib/shopifyEmbeddedContext": { getEmbeddedContext: () => ({ shop, host: "h" }) },
    "./lib/requestTimeout": { withRequestTimeout: (p) => p },
    "./lib/appBridgeReady": { waitForAppBridge: async () => global.window.shopify },
  });

  return { bridge, calls };
}

// ===========================================================================
// The token layer: never hand back a dead token
// ===========================================================================

test("a token is judged by its OWN exp, not by our bookkeeping", () => {
  const { bridge } = loadBridge({ tokens: [makeToken(60)] });

  assert.equal(bridge.isTokenUsable(makeToken(60)), true, "a fresh token is usable");
  assert.equal(bridge.isTokenUsable(makeToken(-1)), false, "an expired token is not");
  assert.equal(bridge.isTokenUsable(makeToken(1)), false, "nor is one inside the margin");
  assert.equal(bridge.isTokenUsable(null), false);
  assert.equal(bridge.isTokenUsable(""), false);

  // A token with no readable exp stays usable: refusing it would break the
  // request for a reason we cannot demonstrate. The server remains authority.
  assert.equal(bridge.isTokenUsable("not-a-jwt"), true);
});

test("the use margin is tighter than the cache margin, and deliberately so", () => {
  const { bridge } = loadBridge({ tokens: [makeToken(60)] });
  assert.ok(
    bridge.TOKEN_USABLE_MARGIN_MS < bridge.TOKEN_EXPIRY_SAFETY_MS,
    "using the 25s cache margin at send time would re-mint perfectly good tokens"
  );
  // A token with 20s left is fine to SEND even though it will not be re-served
  // from cache.
  assert.equal(bridge.isTokenUsable(makeToken(20)), true);
});

test("REGRESSION: an already-expired token from App Bridge is never returned", async () => {
  // App Bridge serving its own stale cached token — the reported cause.
  const { bridge, calls } = loadBridge({ tokens: [makeToken(-5), makeToken(60, "fresh")] });

  const token = await bridge.getEmbeddedSessionToken();
  assert.ok(bridge.isTokenUsable(token), "the dead token must not be handed out");
  assert.equal(calls.idToken, 2, "it must re-mint exactly once");
});

test("SAFETY: a persistently dead App Bridge fails loudly, and only once", async () => {
  // If every mint is dead the cause is real — a skewed clock or an App Bridge
  // that needs the page reloaded. Say so, rather than sending a dud and letting
  // it arrive as a generic 401.
  const { bridge, calls } = loadBridge({ tokens: [makeToken(-30)] });

  await assert.rejects(
    () => bridge.getEmbeddedSessionToken(),
    /already-expired session token twice/
  );
  assert.equal(calls.idToken, 2, "bounded: two attempts, never a loop");
});

test("REGRESSION: no stale token is reused after expiry", async () => {
  const { bridge, calls } = loadBridge({
    tokens: [makeToken(60, "first"), makeToken(60, "second")],
  });

  const first = await bridge.getEmbeddedSessionToken();
  assert.equal(calls.idToken, 1);

  // Immediately after, the cache serves the same token — no wasted mint.
  assert.equal(await bridge.getEmbeddedSessionToken(), first);
  assert.equal(calls.idToken, 1, "a live cached token must not trigger a mint");

  // Now the cached token dies. Even though OUR expiresAt may still look fine,
  // the JWT's own exp is checked, so the dead token cannot be served.
  bridge.bustSessionTokenCache();
  const { bridge: b2, calls: c2 } = loadBridge({
    tokens: [makeToken(-1, "dead"), makeToken(60, "replacement")],
  });
  const replacement = await b2.getEmbeddedSessionToken();
  assert.ok(b2.isTokenUsable(replacement));
  assert.equal(c2.idToken, 2);
});

test("forceFresh drops the cached entry before anything reads it", async () => {
  const { bridge, calls } = loadBridge({
    tokens: [makeToken(60, "one"), makeToken(60, "two")],
  });

  const first = await bridge.getEmbeddedSessionToken();
  const second = await bridge.getEmbeddedSessionToken({ forceFresh: true });

  assert.notEqual(second, first, "a rejected token must never be served again");
  assert.equal(calls.idToken, 2);
});

// ===========================================================================
// The request layer: recover once, then tell the truth
// ===========================================================================

/** Loads embeddedShopRequest against a scripted fetch and a scripted bridge. */
function loadRequest({ responses, tokens }) {
  const queue = [...tokens];
  const state = { fetches: [], idTokenCalls: 0, busts: 0 };

  const bridgeStub = {
    getEmbeddedSessionToken: async () => {
      state.idTokenCalls += 1;
      return queue.length > 1 ? queue.shift() : queue[0];
    },
    bustSessionTokenCache: () => {
      state.busts += 1;
      if (queue.length > 1) queue.shift();
    },
    isTokenUsable: (token) => {
      if (!token) return false;
      try {
        const payload = JSON.parse(
          Buffer.from(token.split(".")[1], "base64").toString("utf8")
        );
        return payload.exp * 1000 - Date.now() > 5000;
      } catch {
        return true;
      }
    },
  };

  global.window = { location: { origin: "https://app.test" }, setTimeout };
  global.fetch = async (url, init) => {
    const scripted = responses[Math.min(state.fetches.length, responses.length - 1)];
    state.fetches.push({
      url,
      authorization: init.headers.Authorization ?? null,
    });
    return {
      status: scripted.status,
      ok: scripted.status >= 200 && scripted.status < 300,
      headers: new Map(Object.entries(scripted.headers ?? {})),
      json: async () => scripted.body ?? {},
    };
  };

  const mod = loadModule("lib/embeddedShopRequest.ts", {
    "../shopifyAppBridge": bridgeStub,
    "./requestTimeout": { withRequestTimeout: (p) => p },
    "./shopifyEmbeddedContext": { getEmbeddedContext: () => ({ shop: "s", host: "h" }) },
  });

  return { request: mod.embeddedShopRequest, state };
}

const RETRY_HEADER = { "x-shopify-retry-invalid-session-request": "1" };

test("REGRESSION: expired token -> fresh token acquired -> request succeeds", async () => {
  const { request, state } = loadRequest({
    tokens: [makeToken(-5, "stale"), makeToken(60, "fresh")],
    responses: [
      { status: 401, headers: RETRY_HEADER, body: { error: { message: "jwt expired" } } },
      { status: 200, body: { ok: true } },
    ],
  });

  const result = await request("/api/action-center");
  assert.deepEqual(result, { ok: true }, "the merchant must never see this failure");
  assert.equal(state.fetches.length, 2, "one retry");
  assert.notEqual(
    state.fetches[0].authorization,
    state.fetches[1].authorization,
    "the retry must carry a DIFFERENT token, or it is not a recovery"
  );
});

test("REGRESSION: retry happens at most once", async () => {
  const { request, state } = loadRequest({
    tokens: [makeToken(-5, "a"), makeToken(-5, "b"), makeToken(-5, "c")],
    responses: [{ status: 401, headers: RETRY_HEADER, body: { error: { message: "jwt expired" } } }],
  });

  await assert.rejects(() => request("/api/action-center"));
  assert.equal(
    state.fetches.length,
    2,
    "the original plus exactly one retry — never a loop against a closed door"
  );
});

test("REGRESSION: a 401 WITHOUT Shopify's retry header still recovers", async () => {
  // Recovery must not depend on a header a proxy could strip, or on which
  // middleware happened to raise the 401. The client can see for itself that
  // the token it sent had expired.
  const { request, state } = loadRequest({
    tokens: [makeToken(-5, "stale"), makeToken(60, "fresh")],
    responses: [
      { status: 401, headers: {}, body: { error: { message: "jwt expired" } } },
      { status: 200, body: { ok: true } },
    ],
  });

  const result = await request("/api/action-center");
  assert.deepEqual(result, { ok: true });
  assert.equal(state.fetches.length, 2);
});

test("SAFETY: a genuine authorization failure is NOT retried away", async () => {
  // The token was perfectly valid and the server still said no. That is a real
  // answer and the merchant must get it, not a silent retry loop.
  const { request, state } = loadRequest({
    tokens: [makeToken(60, "valid")],
    responses: [
      { status: 401, headers: {}, body: { error: { message: "Shop not installed" } } },
    ],
  });

  await assert.rejects(() => request("/api/action-center"), /Shop not installed/);
  assert.equal(state.fetches.length, 1, "no retry when our token was demonstrably fine");
});

test("SAFETY: 403 is never treated as an auth-expiry problem", async () => {
  const { request, state } = loadRequest({
    tokens: [makeToken(60)],
    responses: [
      { status: 403, body: { error: { message: "This feature is not included in your plan." } } },
    ],
  });

  await assert.rejects(() => request("/api/action-center"), /not included in your plan/);
  assert.equal(state.fetches.length, 1);
});

test("a successful first attempt mints one token and does not retry", async () => {
  const { request, state } = loadRequest({
    tokens: [makeToken(60)],
    responses: [{ status: 200, body: { ok: true } }],
  });

  await request("/api/action-center");
  assert.equal(state.fetches.length, 1);
  assert.equal(state.busts, 0, "no cache bust on a healthy request");
});

// ===========================================================================
// Every page uses the shared mechanism
// ===========================================================================

test("REGRESSION: no page can bypass the shared authenticated request layer", () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(tsx?|jsx?)$/.test(entry.name)) continue;
      // The request layer itself is the one place allowed to call fetch.
      if (full.endsWith(path.join("lib", "embeddedShopRequest.ts"))) continue;

      const rel = path.relative(FRONTEND, full);
      fs.readFileSync(full, "utf8")
        .split(/\r?\n/)
        .forEach((line, i) => {
          const t = line.trim();
          if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return;
          if (/(^|[^.\w])fetch\s*\(/.test(line) || /\baxios\b/.test(line)) {
            offenders.push(`${rel}:${i + 1}  ${t.slice(0, 70)}`);
          }
        });
    }
  };
  walk(FRONTEND);

  assert.deepEqual(
    offenders,
    [],
    "these call the network directly and so skip token refresh and the 401 " +
      `retry:\n${offenders.join("\n")}`
  );
});

test("REGRESSION: the axios client that bypassed all of this is gone", () => {
  // It had no 401 retry whatsoever. Nothing imported it, but it was a working
  // template for reintroducing exactly the failure this file exists to prevent.
  assert.equal(
    fs.existsSync(path.join(FRONTEND, "api/client.ts")),
    false,
    "the bypass client must not come back"
  );
});

test("every merchant-facing page reaches the API through embeddedShopRequest", () => {
  // Named explicitly, so a new page that forgets is a failing test rather than
  // an intermittent 401 discovered in a smoke test.
  for (const page of [
    "modules/Dashboard/DashboardPage.tsx",
    "modules/ActionCenter/ActionCenterPage.tsx",
    "modules/TrustAbuse/TrustAbusePage.tsx",
    "modules/PricingProfit/PricingProfitPage.tsx",
    "modules/CompetitorIntelligence/CompetitorPage.tsx",
    "modules/SubscriptionPlans/PricingPage.tsx",
    "modules/Settings/SettingsPage.tsx",
    "modules/Support/SupportPage.tsx",
    "modules/Onboarding/OnboardingPage.tsx",
    "providers/AppStateProvider.tsx",
    "providers/SubscriptionProvider.tsx",
    "providers/OnboardingProvider.tsx",
    "hooks/useInsightsDashboard.ts",
    "hooks/useModuleFindings.ts",
  ]) {
    const src = fs.readFileSync(path.join(FRONTEND, page), "utf8");
    assert.match(
      src,
      /embeddedShopRequest/,
      `${page} must use the shared authenticated request layer`
    );
  }
});

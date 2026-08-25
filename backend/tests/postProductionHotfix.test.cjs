const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const Module = require("node:module");

process.env.SHOPIFY_API_KEY ||= "test-key";
process.env.SHOPIFY_API_SECRET ||= "test-secret";
process.env.SHOPIFY_APP_URL ||= "https://vedasuite-staging.onrender.com";
process.env.SHOPIFY_ADMIN_API_VERSION ||= "2026-01";
process.env.DATABASE_URL ||= "postgresql://example:example@localhost:5432/example";

/**
 * POST-PRODUCTION HOTFIX — the four defects the production smoke test found.
 *
 *   1. "Invalid Shopify session token" on the FIRST screen opened.
 *   2. "Projected monthly gain of $100" on competitor-informed cards while the
 *      page header correctly said "Projected gain — Not enough data yet".
 *   3. Billing/Settings describing the same entitlement in contradictory ways,
 *      and advertising features that do not exist.
 *   4. A TLS failure classified `retriable:false` that was still attempted twice.
 */

const d = (p) => path.resolve(__dirname, `../dist/${p}`);
const SRC = path.resolve(__dirname, "../src");
const FRONTEND = path.resolve(__dirname, "../../frontend/src");
const read = (p) => fs.readFileSync(p, "utf8");

// ===========================================================================
// 1. SESSION TOKEN — a protected request is never sent without one
// ===========================================================================

function loadRequestLayer({ tokens, responses }) {
  const source = path.join(FRONTEND, "lib/embeddedShopRequest.ts");
  const js = ts.transpileModule(read(source), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;

  const queue = [...tokens];
  const state = { fetches: [], tokenCalls: 0 };

  const bridgeStub = {
    getEmbeddedSessionToken: async () => {
      state.tokenCalls += 1;
      return queue.length > 1 ? queue.shift() : queue[0];
    },
    bustSessionTokenCache: () => {},
    isTokenUsable: (t) => {
      if (!t) return false;
      try {
        const p = JSON.parse(Buffer.from(t.split(".")[1], "base64").toString("utf8"));
        return p.exp * 1000 - Date.now() > 5000;
      } catch {
        return true;
      }
    },
  };

  global.window = { location: { origin: "https://app.test" }, setTimeout };
  global.fetch = async (url, init) => {
    const scripted = responses[Math.min(state.fetches.length, responses.length - 1)];
    state.fetches.push({ url, authorization: init.headers.Authorization ?? null });
    return {
      status: scripted.status,
      ok: scripted.status >= 200 && scripted.status < 300,
      headers: new Map(Object.entries(scripted.headers ?? {})),
      json: async () => scripted.body ?? {},
    };
  };

  const mod = new Module(source);
  mod.paths = Module._nodeModulePaths(path.dirname(source));
  const orig = mod.require.bind(mod);
  mod.require = (r) => {
    if (r === "../shopifyAppBridge") return bridgeStub;
    if (r === "./requestTimeout") return { withRequestTimeout: (p) => p };
    if (r === "./shopifyEmbeddedContext") {
      return { getEmbeddedContext: () => ({ shop: "s", host: "h" }) };
    }
    return orig(r);
  };
  mod._compile(js, source);
  return { request: mod.exports.embeddedShopRequest, state };
}

function token(secondsFromNow, marker = "t") {
  const h = Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url");
  const p = Buffer.from(
    JSON.stringify({ exp: Math.floor((Date.now() + secondsFromNow * 1000) / 1000), marker })
  ).toString("base64url");
  return `${h}.${p}.sig-${marker}`;
}

test("REGRESSION: cold start — App Bridge not ready yet, then ready, never errors", async () => {
  // THE REPORTED BUG. On the first screen opened, App Bridge had not finished
  // initialising, getEmbeddedSessionToken returned null, and the request went
  // out with NO Authorization header — a guaranteed 401 that surfaced as
  // "Invalid Shopify session token". Navigating away and back worked because
  // App Bridge had become ready in the meantime.
  const { request, state } = loadRequestLayer({
    tokens: [null, null, token(60, "ready")],
    responses: [{ status: 200, body: { ok: true } }],
  });

  const result = await request("/api/action-center");
  assert.deepEqual(result, { ok: true }, "the merchant must never see this");
  assert.equal(state.fetches.length, 1, "and no doomed request should have been sent");
  assert.ok(
    state.fetches[0].authorization,
    "the single request must carry a token, not go out bare"
  );
  assert.equal(state.tokenCalls, 3, "it waited for App Bridge instead of failing");
});

test("REGRESSION: a protected request is NEVER sent without a token", async () => {
  // If App Bridge truly never arrives, we must not fire a request we know will
  // 401 and then report it as an authorization problem.
  const { request, state } = loadRequestLayer({
    tokens: [null],
    responses: [{ status: 200, body: { ok: true } }],
  });

  await assert.rejects(
    () => request("/api/action-center"),
    /could not reach Shopify to establish this session/i,
    "the error must name the real cause, not blame the session token"
  );
  assert.equal(state.fetches.length, 0, "nothing may be sent without a token");
});

test("idle/background resume: a stale cached token is replaced, request succeeds", async () => {
  const { request, state } = loadRequestLayer({
    tokens: [token(-30, "stale"), token(60, "fresh")],
    responses: [
      { status: 401, headers: {}, body: { error: { message: "jwt expired" } } },
      { status: 200, body: { ok: true } },
    ],
  });

  const result = await request("/api/action-center");
  assert.deepEqual(result, { ok: true });
  assert.equal(state.fetches.length, 2, "exactly one retry");
  assert.notEqual(
    state.fetches[0].authorization,
    state.fetches[1].authorization,
    "the retry must carry a different token"
  );
});

test("SAFETY: token waiting is bounded and the HTTP retry stays at one", () => {
  const src = read(path.join(FRONTEND, "lib/embeddedShopRequest.ts"));
  assert.match(src, /const AUTH_RETRIES = 1;/, "HTTP retry must remain exactly one");
  assert.match(src, /const TOKEN_ACQUIRE_ATTEMPTS = 3;/, "token waiting must be bounded");
  // No unbounded loop or page reload.
  assert.doesNotMatch(src, /while\s*\(\s*true\s*\)/);
  assert.doesNotMatch(src, /location\.reload/);
});

test("SAFETY: a genuine authorization failure still surfaces", async () => {
  const { request, state } = loadRequestLayer({
    tokens: [token(60, "valid")],
    responses: [{ status: 401, headers: {}, body: { error: { message: "Shop not installed" } } }],
  });
  await assert.rejects(() => request("/api/action-center"), /Shop not installed/);
  assert.equal(state.fetches.length, 1, "a valid token that is rejected is not retried");
});

test("no active frontend caller bypasses the shared request layer", () => {
  const offenders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!/\.(tsx?|jsx?)$/.test(e.name)) continue;
      if (full.endsWith(path.join("lib", "embeddedShopRequest.ts"))) continue;
      read(full).split(/\r?\n/).forEach((line, i) => {
        const t = line.trim();
        if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return;
        if (/(^|[^.\w])fetch\s*\(/.test(line) || /\baxios\b/.test(line)) {
          offenders.push(`${path.relative(FRONTEND, full)}:${i + 1}`);
        }
      });
    }
  };
  walk(FRONTEND);
  assert.deepEqual(offenders, [], `direct network calls found:\n${offenders.join("\n")}`);
});

// ===========================================================================
// 2. PRICING — no monetary projection without observed velocity
// ===========================================================================

const pricingSrc = read(path.join(SRC, "services/pricingProfitService.ts"));

test("REGRESSION: competitor evidence WITHOUT observed velocity allows a target price but NO money", () => {
  const { classifyPricingEvidence } = require(d("services/pricingEvidenceCalc.js"));
  const evidence = classifyPricingEvidence({
    competitorReady: true,
    competitorAveragePrice: 80,
    hasProductCompetitorSignal: true,
    profitReady: false,
    salesVelocityObserved: false,
  });

  assert.equal(evidence.basis, "competitor_informed");
  assert.equal(evidence.showExactTarget, true, "rule B: a target price may be shown");
  assert.equal(evidence.showProjectedGain, false, "rule B: monetary gain may NOT be shown");
  assert.ok(evidence.missingInputs.includes("observed sales velocity"));
});

test("observed qualifying inputs DO allow a monetary projection", () => {
  const { classifyPricingEvidence } = require(d("services/pricingEvidenceCalc.js"));
  const evidence = classifyPricingEvidence({
    competitorReady: true,
    competitorAveragePrice: 80,
    hasProductCompetitorSignal: true,
    profitReady: true,
    salesVelocityObserved: true,
  });
  assert.equal(evidence.basis, "profit_informed");
  assert.equal(evidence.showProjectedGain, true, "rule A: money is allowed");
});

test("REGRESSION: every merchant-facing gain on this page shares ONE gate", () => {
  // The page header used the evidence classifier while two action cards tested
  // only whether a stored number was truthy — so one surface said "Not enough
  // data yet" while another quoted $100 from the same store.
  const moneyLines = pricingSrc
    .split(/\r?\n/)
    .map((line, i) => ({ line, i: i + 1 }))
    .filter(({ line }) => /gain of \$|gain \$\{/.test(line) && !line.trim().startsWith("//"));

  assert.ok(moneyLines.length >= 2, "the money-producing lines must still exist");
  for (const { line, i } of moneyLines) {
    // Each must be reachable only through observed-velocity provenance.
    const context = pricingSrc.split(/\r?\n/).slice(Math.max(0, i - 12), i + 2).join("\n");
    assert.match(
      context,
      /velocityObservedByHandle|showProjectedGain/,
      `line ${i} states money without an evidence gate: ${line.trim()}`
    );
  }
});

test("REGRESSION: unknown is never rendered as $0", () => {
  // "Projected gain $0" reads as a measured result of zero rather than an
  // absence of evidence.
  //
  // The ban is on `?? 0` reaching a RENDERED string, not on `?? 0` existing.
  // A numeric zero behind a status flag that already says "not_available" is
  // never displayed, and banning it outright would only teach the next author
  // to rename the variable.
  assert.doesNotMatch(pricingSrc, /expectedProfitGain \?\?\s*\n?\s*0\s*\n?\s*\)\}`/);
  assert.match(pricingSrc, /Projected gain: \$\{NOT_ENOUGH_DATA\}/);

  // The one store-level numeric fallback that survives must be neutralised by
  // a status flag before anything can print it.
  assert.match(
    pricingSrc,
    /projectedGainStatus =\s*\n?\s*projectedGainValue > 0 && profitReady \? "available" : "not_available"/,
    "the store-level projected gain must collapse to not_available at zero"
  );
  const page = read(
    path.join(FRONTEND, "modules/PricingProfit/PricingProfitPage.tsx")
  );
  assert.match(
    page,
    /projectedGainStatus === "not_available"[\s\S]{0,120}NOT_ENOUGH_DATA|projectedGainStatus === "not_available"[\s\S]{0,120}Not enough data/,
    "and the page must honour that flag instead of printing the number"
  );

  // Payload fields nothing renders yet must still carry null, not 0, so wiring
  // one up later cannot silently resurrect "$0".
  assert.doesNotMatch(
    pricingSrc,
    /projectedMonthlyGain:\s*\n?\s*topProfitOpportunity/,
    "marginAtRisk.projectedMonthlyGain must be evidence-gated, not a raw fallback"
  );
});

test("SAFETY: missing provenance defaults to NOT observed", () => {
  // A row with no velocitySource recorded must never license a claim.
  assert.match(pricingSrc, /velocityObservedByHandle\.get\([^)]*\) \?\? false/);
  // And a provenance read failure must fail the same way.
  assert.match(pricingSrc, /no monetary projection will be shown, which is the safe default/);
});

test("Action Center repeats no unsupported monetary projection", () => {
  // Its impact comes from the stored finding snapshot, which is only
  // `quantified` when the detector could defend it — never re-derived here.
  const acSrc = read(path.join(SRC, "services/actionCenterService.ts"));
  assert.match(acSrc, /impact\.status === "quantified"/);
  assert.doesNotMatch(acSrc, /Projected monthly gain/);
  assert.doesNotMatch(acSrc, /\?\?\s*0\s*\)\}`/);
});

// ===========================================================================
// 3. BILLING / SETTINGS — one vocabulary, and only real features
// ===========================================================================

const billingSrc = read(path.join(FRONTEND, "modules/SubscriptionPlans/PricingPage.tsx"));
const settingsSrc = read(path.join(FRONTEND, "modules/Settings/SettingsPage.tsx"));

test("REGRESSION: no unimplemented feature is advertised", () => {
  // "Multi-store insights" and "Priority processing" had ZERO implementation
  // anywhere in the codebase — no capability key, no gate, no code.
  for (const claim of [/multi-store/i, /priority processing/i]) {
    assert.doesNotMatch(billingSrc, claim, `Billing must not advertise ${claim}`);
  }
  // And nothing else in the app implements them either, so the removal is
  // correct rather than merely hidden.
  const walk = (dir, hits) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full, hits); continue; }
      if (!/\.(tsx?|js)$/.test(e.name)) continue;
      if (/multi-store|priority processing/i.test(read(full))) hits.push(full);
    }
    return hits;
  };
  assert.deepEqual(walk(SRC, []), []);
  assert.deepEqual(walk(FRONTEND, []), []);
});

test("REGRESSION: Product Profit is described as Pro-only everywhere", () => {
  // capabilities.ts: `const profitModule = isPro;` — Growth does NOT have it.
  const caps = read(path.join(SRC, "billing/capabilities.ts"));
  assert.match(caps, /const profitModule = isPro;/, "the entitlement fact this wording describes");

  // Billing must never present it as included on Growth.
  assert.doesNotMatch(billingSrc, /Pricing & Product Profit \(limited\)/);
  assert.doesNotMatch(billingSrc, /Pricing & Product Profit \(complete\)/);
  assert.match(billingSrc, /Product Profit intelligence — requires Pro/);
  assert.match(billingSrc, /Product Profit intelligence — included/);
});

test("REGRESSION: Settings uses the same vocabulary as Billing", () => {
  // Previously: Settings said "Available on Pro" while Billing said "limited",
  // and both called the same thing different names.
  assert.doesNotMatch(settingsSrc, /Available on Pro/);
  assert.doesNotMatch(settingsSrc, /Enabled on current plan/);
  assert.match(settingsSrc, /Product Profit controls/);
  assert.match(settingsSrc, /Requires Pro/);
  assert.match(settingsSrc, /Included on your plan/);
  assert.match(settingsSrc, /Market Signals controls/);
});

test("no ambiguous capability language remains", () => {
  for (const vague of [/\(limited\)/, /baseline guidance/i, /full depth/i, /Available on Pro/]) {
    assert.doesNotMatch(billingSrc, vague);
    assert.doesNotMatch(settingsSrc, vague);
  }
});

test("SAFETY: entitlement KEYS and prices are untouched", () => {
  const caps = read(path.join(SRC, "billing/capabilities.ts"));
  assert.match(caps, /STARTER: 19/);
  assert.match(caps, /GROWTH: 49/);
  assert.match(caps, /PRO: 99/);
  // The gates themselves must be unchanged — only wording moved.
  assert.match(caps, /const fraudModule = isStarterTrust \|\| isGrowth \|\| isPro;/);
  assert.match(caps, /const competitorModule = isStarterCompetitor \|\| isGrowth \|\| isPro;/);
  assert.match(caps, /const pricingModule = isStarterPricing \|\| isGrowth \|\| isPro;/);
});

// ===========================================================================
// 4. COMPETITOR FETCH — permanent failures cost exactly one attempt
// ===========================================================================

test("REGRESSION: a TLS/certificate failure is not retried", async () => {
  const { withRetry } = require(d("services/observabilityService.js"));
  const { classifyFetchError } = require(d("services/competitorFetchStatus.js"));

  let attempts = 0;
  const expiredCert = Object.assign(new TypeError("fetch failed"), {
    cause: { code: "CERT_HAS_EXPIRED" },
  });

  await assert.rejects(() =>
    withRetry(
      async () => {
        attempts += 1;
        throw expiredCert;
      },
      {
        attempts: 2,
        operationName: "competitor.fetch_snapshot",
        shouldRetry: (e) => classifyFetchError("addidas.com", e).retryable,
      }
    )
  );

  assert.equal(
    attempts,
    1,
    "an expired certificate is still expired 200ms later — one attempt only"
  );
});

test("REGRESSION: DNS failures are not retried either", async () => {
  const { withRetry } = require(d("services/observabilityService.js"));
  const { classifyFetchError } = require(d("services/competitorFetchStatus.js"));

  let attempts = 0;
  const dnsFail = Object.assign(new TypeError("fetch failed"), {
    cause: { code: "ENOTFOUND" },
  });

  await assert.rejects(() =>
    withRetry(
      async () => { attempts += 1; throw dnsFail; },
      {
        attempts: 3,
        operationName: "competitor.fetch_snapshot",
        shouldRetry: (e) => classifyFetchError("addidas.com", e).retryable,
      }
    )
  );
  assert.equal(attempts, 1, "a hostname that does not resolve will not resolve on attempt two");
});

test("a genuinely transient failure IS still retried", async () => {
  const { withRetry } = require(d("services/observabilityService.js"));
  const { classifyFetchError } = require(d("services/competitorFetchStatus.js"));

  let attempts = 0;
  const timeout = Object.assign(new TypeError("fetch failed"), {
    cause: { code: "ETIMEDOUT" },
  });

  const result = await withRetry(
    async () => {
      attempts += 1;
      if (attempts === 1) throw timeout;
      return "ok";
    },
    {
      attempts: 2,
      operationName: "competitor.fetch_snapshot",
      shouldRetry: (e) => classifyFetchError("slow.example", e).retryable,
    }
  );
  assert.equal(result, "ok");
  assert.equal(attempts, 2, "a slow site deserves a second chance");
});

test("withRetry without a predicate keeps its original behaviour", async () => {
  // Every existing caller must be unaffected.
  const { withRetry } = require(d("services/observabilityService.js"));
  let attempts = 0;
  await assert.rejects(() =>
    withRetry(
      async () => { attempts += 1; throw new Error("boom"); },
      { attempts: 3, operationName: "legacy.caller" }
    )
  );
  assert.equal(attempts, 3, "no predicate means retry everything, as before");
});

test("WIRING: the competitor fetch classifies BEFORE deciding to retry", () => {
  const adminSrc = read(path.join(SRC, "services/shopifyAdminService.ts"));
  assert.match(
    adminSrc,
    /shouldRetry: \(error\) => classifyFetchError\(domain, error\)\.retryable/,
    "the same classifier must drive both the log line and the retry decision"
  );
});

test("the merchant sees a plain-language certificate message, never a Node code", () => {
  const { classifyFetchError } = require(d("services/competitorFetchStatus.js"));
  const outcome = classifyFetchError(
    "addidas.com",
    Object.assign(new TypeError("fetch failed"), { cause: { code: "CERT_HAS_EXPIRED" } })
  );

  assert.equal(outcome.status, "tls_error");
  assert.equal(outcome.retryable, false);
  assert.match(outcome.merchantMessage, /security certificate problem/i);
  // No raw Node error codes in front of a merchant.
  assert.doesNotMatch(outcome.merchantMessage, /CERT_HAS_EXPIRED|fetch failed|ENOTFOUND/);
  // The merchant's own spelling is preserved — never auto-corrected.
  assert.match(outcome.merchantMessage, /addidas\.com/);
  assert.doesNotMatch(outcome.merchantMessage, /\badidas\.com/);
  // The technical detail is kept, but for logs only.
  assert.match(outcome.technicalDetail, /CERT_HAS_EXPIRED/);
});

test("a domain whose last attempt failed is NOT treated as fresh evidence", () => {
  const { isCurrentEvidence, isFailure } = require(d("services/competitorFetchStatus.js"));
  assert.equal(isCurrentEvidence("tls_error"), false, "stale stored data is not current");
  assert.equal(isFailure("tls_error"), true);
});

// ===========================================================================
// 5. REFRESH ACTIVITY — every reported figure must be a real measurement
//
// PRODUCTION OBSERVATION. A Store Overview refresh said:
//
//   "Analysis completed. Pricing opportunities changed from 0 to 6."
//   - 0 orders processed
//   - 0 customers evaluated
//   - 0 competitor pages reviewed
//   - 33 pricing records analyzed
//
// Recomputing 33 already-persisted pricing records without fetching new orders
// is legitimate: the recompute pass runs over stored products, and a store with
// no new orders correctly reports zero processed. That part is accurate and is
// deliberately left alone.
//
// Three statements around it were not measurements at all.
// ===========================================================================

const syncJobSrc = read(path.join(SRC, "services/syncJobService.ts"));
const dashboardSrc = read(path.join(FRONTEND, "modules/Dashboard/DashboardPage.tsx"));

const { buildSyncActivitySummary } = require(d("services/syncJobService.js"));

const activity = (over = {}) =>
  buildSyncActivitySummary({
    syncResult: { ordersSynced: 0, ...over.syncResult },
    recomputeResult: {
      customersRecomputed: 0,
      productOutputsUpdated: 0,
      fraudSignalsGenerated: 0,
      timelineEventsCreated: 0,
      ...over.recomputeResult,
    },
    operational: { counts: { competitorRows: 0, ...over.counts } },
  });

test("PRODUCTION CASE: 33 pricing records recomputed is NOT reported as stable", () => {
  // The exact production run: no new orders, 33 pricing outputs rewritten.
  const summary = activity({ recomputeResult: { productOutputsUpdated: 33 } });

  assert.equal(summary.pricingRecordsAnalyzed, 33, "the real figure is preserved");
  assert.equal(summary.ordersProcessed, 0, "zero new orders is a true measurement");
  assert.ok(
    !summary.noChangeReasons.includes("pricing signals remained stable"),
    `pricing changed, so it cannot be reported as stable: ${JSON.stringify(
      summary.noChangeReasons
    )}`
  );
  assert.equal(
    summary.moduleProcessing.pricing.status,
    "updated",
    "and the module status must agree with the reason list"
  );
});

test("REGRESSION: a fraud run that produced signals is not reported as producing none", () => {
  const summary = activity({ recomputeResult: { fraudSignalsGenerated: 4 } });
  assert.ok(!summary.noChangeReasons.includes("no new order-risk signals were produced"));
  assert.equal(summary.moduleProcessing.fraud.status, "updated");
});

test("a genuinely quiet run still explains itself", () => {
  const summary = activity();
  assert.deepEqual(summary.noChangeReasons, [
    "no new order-risk signals were produced",
    "no competitor analysis ran during this update",
    "pricing signals remained stable",
  ]);
});

test("reasons and module statuses can never contradict each other", () => {
  for (const fraudSignalsGenerated of [0, 3]) {
    for (const productOutputsUpdated of [0, 33]) {
      const summary = activity({
        recomputeResult: { fraudSignalsGenerated, productOutputsUpdated },
      });
      const claimsFraudQuiet = summary.noChangeReasons.includes(
        "no new order-risk signals were produced"
      );
      const claimsPricingStable = summary.noChangeReasons.includes(
        "pricing signals remained stable"
      );
      assert.equal(
        claimsFraudQuiet,
        summary.moduleProcessing.fraud.status !== "updated",
        `fraud=${fraudSignalsGenerated}: reason list disagrees with module status`
      );
      assert.equal(
        claimsPricingStable,
        summary.moduleProcessing.pricing.status !== "updated",
        `pricing=${productOutputsUpdated}: reason list disagrees with module status`
      );
    }
  }
});

test("competitor work that never ran is not reported as a count of zero", () => {
  const summary = activity();
  // The backend still carries the field, but it is explicitly not-processed...
  assert.equal(summary.moduleProcessing.competitor.processed, false);
  assert.equal(summary.competitorPagesChecked, 0);
  // ...and the UI must branch on that flag rather than printing the zero.
  assert.match(
    dashboardSrc,
    /moduleProcessing\?\.competitor\s*\n?\s*\?\.processed[\s\S]{0,200}not part of this update/,
    "'0 competitor pages reviewed' claims a search that never happened"
  );
  // The bare JSX interpolation (no `$` prefix) is the unconditional render.
  // The `${...}` form inside the gated template literal is the allowed one.
  assert.doesNotMatch(
    dashboardSrc,
    /[^$]\{refreshResult\.activitySummary\.competitorPagesChecked\} competitor pages reviewed/,
    "the unconditional count must be gone"
  );
});

test("a first reading is never described as a change from zero", () => {
  // `previousSnapshot?.kpis.X ?? 0` invented a baseline nobody measured.
  assert.doesNotMatch(
    dashboardSrc,
    /previousSnapshot\?\.kpis\.\w+ \?\? 0/,
    "an unknown prior value must not be printed as 0"
  );
  assert.match(
    dashboardSrc,
    /previous === undefined\s*\n?\s*\? `\$\{label\}: \$\{next\}`/,
    "with no prior reading it must state the value, not a transition"
  );
  assert.match(
    dashboardSrc,
    /: `\$\{label\} changed from \$\{previous\} to \$\{next\}`/,
    "and only a real before/after may be called a change"
  );
});

test("the insight counter is labelled for what it actually counts", () => {
  // updatedInsightsCount is hardcoded 0 — only creations are measured.
  assert.match(syncJobSrc, /updatedInsightsCount: 0/);
  assert.match(dashboardSrc, /insights added/);
  assert.doesNotMatch(dashboardSrc, /\}\s*insights updated/);
});

// ===========================================================================
// 6. ONE VOCABULARY — no surface may call a module by a name another surface
//    does not use, and no badge may state an entitlement path that is false.
// ===========================================================================

test("no merchant-facing surface uses a pre-VedaSuite module name", () => {
  const surfaces = [
    "modules/Settings/SettingsPage.tsx",
    "modules/SubscriptionPlans/PricingPage.tsx",
    "modules/Dashboard/DashboardPage.tsx",
  ];
  for (const file of surfaces) {
    const src = read(path.join(FRONTEND, file));
    // Strip comments — the explanations of WHY a name was retired legitimately
    // quote the retired name.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(code, /Trust & Abuse/, `${file} still says "Trust & Abuse"`);
    assert.doesNotMatch(
      code,
      /"Pricing & Profit\b/,
      `${file} uses "Pricing & Profit" instead of "Pricing & Product Profit"`
    );
  }
  // Backend-authored merchant copy too.
  assert.doesNotMatch(read(path.join(SRC, "services/decisionCenterService.ts")), /"Pricing & Profit"/);
  assert.doesNotMatch(read(path.join(SRC, "services/reportsService.ts")), /Pricing & Profit engine/);
});

test("a granted Starter module is never labelled 'Not selected'", () => {
  // capabilities.ts grants pricingModule for starterModule === "pricing", so
  // that value can exist in data even though the selector does not sell it.
  const src = read(path.join(FRONTEND, "modules/SubscriptionPlans/PricingPage.tsx"));
  const fn = src.match(/function starterLabel[\s\S]*?\n\}/);
  assert.ok(fn, "starterLabel must exist");
  assert.match(fn[0], /moduleKey === "pricing"/, "every StarterModule value must be named");
  const capabilities = read(path.join(SRC, "billing/capabilities.ts"));
  const union = capabilities.match(/export type StarterModule = ([^;]+);/);
  assert.ok(union);
  for (const value of union[1].match(/"(\w+)"/g)) {
    assert.match(
      fn[0],
      new RegExp(`moduleKey === ${value.replace(/"/g, '"')}`),
      `starterLabel does not name the ${value} module`
    );
  }
});

test("Market Signals on Starter is not described as requiring Growth", () => {
  // Starter reaches Market Signals by switching its selected module.
  const src = read(path.join(FRONTEND, "modules/Settings/SettingsPage.tsx"));
  const badge = src.match(/competitorEnabled[\s\S]{0,400}?<\/Badge>/);
  assert.ok(badge, "the Market Signals badge must exist");
  assert.match(
    badge[0],
    /activePlanLabel === "STARTER"/,
    "the badge must distinguish Starter from a plan with no route to the module"
  );
  assert.match(badge[0], /Switch your Starter module/);
});

test("Product Profit really is Pro-only, so 'Requires Pro' stands", () => {
  const capabilities = read(path.join(SRC, "billing/capabilities.ts"));
  assert.match(
    capabilities,
    /const profitModule = isPro;/,
    "if this ever changes, the Settings badge must change with it"
  );
  const src = read(path.join(FRONTEND, "modules/Settings/SettingsPage.tsx"));
  assert.match(src, /fullProfitEngineEnabled \? "Included on your plan" : "Requires Pro"/);
});

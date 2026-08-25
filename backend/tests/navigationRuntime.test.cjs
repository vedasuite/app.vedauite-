const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

/**
 * NAVIGATION RUNTIME LIFECYCLE.
 *
 * The existing navigation tests inspect AppFrame.tsx as text. That catches a
 * deleted entry, but it cannot catch an entry that vanishes because of RUNTIME
 * STATE — which is what was reported: Action Center present before plan
 * confirmation, gone immediately after the GROWTH approval / onboarding-4/4
 * transition.
 *
 * These tests import and EXECUTE the real navigation model that AppFrame ships,
 * driving it through the exact reported sequence and through every degraded
 * state the app-state fetch can produce.
 *
 * If any state permutation can drop an entry, it fails here.
 */

const MODEL_URL = pathToFileURL(
  path.resolve(__dirname, "../../frontend/src/layout/navigationModel.js")
).href;

let buildNavigationModel;
let NAV_PATHS;
let UNGATED_PATHS;

test.before(async () => {
  const mod = await import(MODEL_URL);
  ({ buildNavigationModel, NAV_PATHS, UNGATED_PATHS } = mod);
});

const labels = (status) => buildNavigationModel(status).map((e) => e.label);
const paths = (status) => buildNavigationModel(status).map((e) => e.path);
const has = (status, p) => paths(status).includes(p);

/**
 * What resolveBackendEnabledModules() actually returns at each stage of the
 * reported journey. Before activation the backend reports every module false;
 * after GROWTH approval fraud/competitor/pricing flip true.
 */
const NO_MODULES = { fraud: false, competitor: false, pricing: false };
const GROWTH_MODULES = { fraud: true, competitor: true, pricing: true };

// ===========================================================================
// The exact reported sequence
// ===========================================================================

test("REPRO: Action Center survives the install -> GROWTH approval -> onboarding 4/4 transition", () => {
  // Step 1-3: installed, trial/no plan yet. Merchant confirms it is visible.
  assert.ok(has(NO_MODULES, "/app/action-center"), "visible before plan confirmation");

  // Step 4: GROWTH approved, subscription refresh lands, onboarding hits 4/4.
  // This is the moment the entry was reported to disappear.
  assert.ok(
    has(GROWTH_MODULES, "/app/action-center"),
    "MUST still be present after plan confirmation — the reported regression"
  );

  // The whole list must be identical in length and order across the transition.
  assert.deepEqual(
    paths(NO_MODULES),
    paths(GROWTH_MODULES),
    "the plan transition must not add, remove or reorder any entry"
  );
});

test("REPRO: only badges may differ across the plan transition", () => {
  const before = buildNavigationModel(NO_MODULES);
  const after = buildNavigationModel(GROWTH_MODULES);

  before.forEach((entry, i) => {
    assert.equal(entry.path, after[i].path);
    assert.equal(entry.label, after[i].label);
  });

  // Upgrade badges clearing is the ONLY legitimate visible change.
  assert.equal(before.find((e) => e.path === "/app/fraud-intelligence").badge, "Upgrade");
  assert.equal(after.find((e) => e.path === "/app/fraud-intelligence").badge, undefined);
});

// ===========================================================================
// Degraded and transitional state — what a mid-flight refresh can produce
// ===========================================================================

test("DEGRADED: every entry survives null, undefined and empty module status", () => {
  // During the post-billing refresh, appState is briefly null and
  // resolveBackendEnabledModules can return a partial object.
  for (const status of [null, undefined, {}, { fraud: undefined }]) {
    assert.deepEqual(
      paths(status),
      NAV_PATHS,
      `navigation must be complete for status=${JSON.stringify(status)}`
    );
  }
});

test("DEGRADED: malformed module status cannot remove an entry", () => {
  // Defensive: non-boolean values must degrade to an Upgrade badge, not removal.
  for (const status of [
    { fraud: "true", competitor: 0, pricing: null },
    { fraud: 1, competitor: [], pricing: {} },
  ]) {
    assert.deepEqual(paths(status), NAV_PATHS);
    assert.ok(has(status, "/app/action-center"));
  }
});

test("EXHAUSTIVE: no combination of the three gated modules can drop an entry", () => {
  // 2^3 = every reachable entitlement combination the backend can report.
  for (let mask = 0; mask < 8; mask += 1) {
    const status = {
      fraud: Boolean(mask & 1),
      competitor: Boolean(mask & 2),
      pricing: Boolean(mask & 4),
    };
    assert.deepEqual(
      paths(status),
      NAV_PATHS,
      `entitlement combination ${JSON.stringify(status)} changed the navigation`
    );
  }
});

// ===========================================================================
// The gating rule itself
// ===========================================================================

test("INVARIANT: ungated entries never carry a badge under any state", () => {
  const states = [null, undefined, {}, NO_MODULES, GROWTH_MODULES];

  for (const status of states) {
    for (const entry of buildNavigationModel(status)) {
      if (UNGATED_PATHS.includes(entry.path)) {
        assert.equal(
          entry.badge,
          undefined,
          `${entry.path} must never be badged or gated (state=${JSON.stringify(status)})`
        );
      }
    }
  }
});

test("INVARIANT: paid modules are still genuinely badged when locked", () => {
  // Guards against 'fix the symptom by ungating everything'.
  const locked = buildNavigationModel(NO_MODULES);
  for (const p of [
    "/app/fraud-intelligence",
    "/app/competitor-intelligence",
    "/app/ai-pricing-engine",
  ]) {
    assert.equal(locked.find((e) => e.path === p).badge, "Upgrade", `${p} must show Upgrade`);
  }
});

test("PURITY: the model holds no state between calls", () => {
  // A memoised or module-level cache is exactly how an entry could disappear
  // only on the SECOND render after a state change.
  const first = buildNavigationModel(NO_MODULES);
  buildNavigationModel(GROWTH_MODULES);
  const third = buildNavigationModel(NO_MODULES);

  assert.deepEqual(first, third, "repeated calls must be identical");
  assert.notEqual(first, third, "must return a fresh array, never a shared reference");

  // Mutating a returned entry must not corrupt the next call.
  // Looked up by path, not by index: this test is about purity, and pinning it
  // to a position made it fail when Phase G/H reordered the menu — which is a
  // false alarm, not a purity violation.
  const actionCenterOf = (entries) =>
    entries.find((e) => e.path === "/app/action-center");
  actionCenterOf(first).label = "MUTATED";
  assert.equal(actionCenterOf(buildNavigationModel(NO_MODULES)).label, "Action Center");
});

test("SANITY: the model and AppFrame agree on the Action Center entry", () => {
  const entry = buildNavigationModel(GROWTH_MODULES).find(
    (e) => e.path === "/app/action-center"
  );
  assert.ok(entry, "the Action Center entry must exist");
  assert.equal(entry.label, "Action Center");
  assert.equal(entry.badge, undefined);
  assert.equal(labels(GROWTH_MODULES).length, NAV_PATHS.length);
});

// ===========================================================================
// PHASE G/H — positioning
// ===========================================================================

test("G/H: the Action Center is the first working surface in the menu", () => {
  // Onboarding comes first only while there is setup to do. Of the surfaces a
  // merchant works in, the Action Center must lead: it is the only one that
  // knows what needs doing, in what order, with evidence and a lifecycle.
  const entries = buildNavigationModel(GROWTH_MODULES);
  const paths = entries.map((e) => e.path);
  assert.equal(paths[0], "/app/onboarding");
  assert.equal(paths[1], "/app/action-center");
  assert.ok(
    paths.indexOf("/app/action-center") < paths.indexOf("/app/dashboard"),
    "the Action Center must precede the Store Overview"
  );
});

test("G/H: no merchant-facing label claims AI", () => {
  // The pricing and profit engines are arithmetic over cost, price and
  // observed velocity with an explicit evidence gate. No model is involved, so
  // "AI Pricing Engine" was a capability claim VedaSuite could not defend.
  // The one genuine AI surface is the Action Center brief, which labels itself
  // at the point of use rather than in the navigation.
  for (const entry of buildNavigationModel(GROWTH_MODULES)) {
    assert.doesNotMatch(
      entry.label,
      /\bAI\b/i,
      `"${entry.label}" must not claim AI in the navigation`
    );
  }
});

test("G/H: labels use the engine family vocabulary", () => {
  const byPath = Object.fromEntries(
    buildNavigationModel(GROWTH_MODULES).map((e) => [e.path, e.label])
  );
  assert.equal(byPath["/app/action-center"], "Action Center");
  assert.equal(byPath["/app/dashboard"], "Store Overview");
  assert.equal(byPath["/app/fraud-intelligence"], "Customer Loss");
  assert.equal(byPath["/app/ai-pricing-engine"], "Pricing & Product Profit");
  assert.equal(byPath["/app/competitor-intelligence"], "Market Signals");
});

test("SAFETY: renaming labels did not rename any route", () => {
  // Stored finding snapshots carry a `route` pointing at these exact URLs, and
  // those rows are merchant data written by past syncs. A renamed path would
  // silently break the Open button on every historical finding.
  const paths = new Set(buildNavigationModel(null).map((e) => e.path));
  for (const required of [
    "/app/onboarding",
    "/app/dashboard",
    "/app/action-center",
    "/app/fraud-intelligence",
    "/app/competitor-intelligence",
    "/app/ai-pricing-engine",
    "/app/billing",
    "/app/settings",
    "/app/support",
  ]) {
    assert.ok(paths.has(required), `${required} must still exist`);
  }
});

test("SAFETY: renaming labels did not change any entitlement key", () => {
  // Display names changed; the badge still keys off fraud / pricing /
  // competitor exactly as the billing system expects.
  const gated = buildNavigationModel({
    fraud: false,
    competitor: false,
    pricing: false,
  });
  const badgeFor = (p) => gated.find((e) => e.path === p)?.badge;
  assert.equal(badgeFor("/app/fraud-intelligence"), "Upgrade");
  assert.equal(badgeFor("/app/ai-pricing-engine"), "Upgrade");
  assert.equal(badgeFor("/app/competitor-intelligence"), "Upgrade");

  const enabled = buildNavigationModel({
    fraud: true,
    competitor: true,
    pricing: true,
  });
  for (const p of [
    "/app/fraud-intelligence",
    "/app/ai-pricing-engine",
    "/app/competitor-intelligence",
  ]) {
    assert.equal(enabled.find((e) => e.path === p)?.badge, undefined);
  }
});

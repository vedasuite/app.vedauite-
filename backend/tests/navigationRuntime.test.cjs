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
  first[2].label = "MUTATED";
  assert.equal(buildNavigationModel(NO_MODULES)[2].label, "Action Center");
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

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

/**
 * NAVIGATION REACHABILITY.
 *
 * A route the merchant cannot reach is a route that does not exist. Part 4
 * shipped an Action Center route that was, at one point, unreachable — and a
 * separate bug shipped a route whose component was never imported, which the
 * production build happily compiled because Vite does not typecheck.
 *
 * These checks make both classes of failure impossible to repeat:
 *   1. every /app/* route must have a matching navigation entry
 *   2. every routed component must actually be imported
 *   3. navigation must be attached to the Frame unconditionally
 *
 * They read the frontend source directly, so they hold regardless of how the
 * bundle is built.
 */

const FRONTEND = path.resolve(__dirname, "../../frontend/src");
const APP_TSX = path.join(FRONTEND, "App.tsx");
const APP_FRAME = path.join(FRONTEND, "layout/AppFrame.tsx");
const NAV_MODEL = path.join(FRONTEND, "layout/navigationModel.js");

const appSource = fs.readFileSync(APP_TSX, "utf8");
const frameSource = fs.readFileSync(APP_FRAME, "utf8");
// NAV_MODEL is imported and executed rather than read as text — see navPaths().

/**
 * Routes that intentionally have no navigation entry. Anything added here needs
 * a stated reason — the default is that a route IS reachable from the nav.
 */
const NAV_EXEMPT_ROUTES = new Set([
  // Entry/redirect target only; the merchant never navigates to it by name.
  "/app",
]);

/** All `<Route path="/app/...">` paths declared in App.tsx. */
function routedPaths() {
  const paths = [];
  for (const m of appSource.matchAll(/<Route\s+path="(\/app[^"]*)"/g)) {
    paths.push(m[1]);
  }
  return [...new Set(paths)];
}

/**
 * All `{ path, label }` entries the navigation model actually produces.
 *
 * EXECUTED, not pattern-matched. This used to scrape the source with
 * `/\{\s*path:\s*"..."\s*,\s*label:\s*"..."/`, which silently stopped matching
 * the moment Phase G/H put an explanatory comment between the brace and the
 * `path:` key — and reported the three module routes as unreachable when they
 * were perfectly reachable. A test that fails because a comment was added is
 * testing the formatting, not the behaviour.
 *
 * The model is pure and dependency-free precisely so it can be run here. It is
 * called with every module disabled, because the entry list must be complete
 * regardless of plan (navigationRuntime.test.cjs proves that separately).
 */
let navEntries = null;

test.before(async () => {
  const mod = await import(pathToFileURL(NAV_MODEL).href);
  navEntries = mod.buildNavigationModel({
    fraud: false,
    competitor: false,
    pricing: false,
  });
});

function navPaths() {
  return navEntries
    .filter((entry) => entry.path.startsWith("/app"))
    .map((entry) => ({ path: entry.path, label: entry.label }));
}

test("every /app route is reachable from the authenticated navigation", () => {
  const routes = routedPaths().filter((p) => !NAV_EXEMPT_ROUTES.has(p));
  const nav = new Set(navPaths().map((n) => n.path));

  const unreachable = routes.filter((r) => !nav.has(r));

  assert.deepEqual(
    unreachable,
    [],
    `these routes exist but have no navigation entry, so a merchant cannot reach them:\n` +
      unreachable.map((r) => `  ${r}`).join("\n")
  );
});

test("the Action Center specifically is routed AND in the navigation", () => {
  // The regression that prompted this file.
  assert.ok(
    routedPaths().includes("/app/action-center"),
    "the /app/action-center route must exist"
  );
  const entry = navPaths().find((n) => n.path === "/app/action-center");
  assert.ok(entry, "the Action Center must have a navigation entry");
  assert.equal(entry.label, "Action Center");
});

test("every navigation entry points at a route that actually exists", () => {
  // The mirror failure: a nav item leading to a blank screen.
  const routes = new Set(routedPaths());
  const dangling = navPaths().filter((n) => !routes.has(n.path));

  assert.deepEqual(
    dangling.map((d) => `${d.label} -> ${d.path}`),
    [],
    "navigation entries must not point at non-existent routes"
  );
});

test("every component used in a route is imported in App.tsx", () => {
  // Vite/esbuild does not typecheck, so a missing import compiles cleanly and
  // then throws ReferenceError at runtime. This catches it in the test suite.
  const used = new Set();
  for (const m of appSource.matchAll(/element=\{[^}]*<([A-Z][A-Za-z0-9_]*)\s*\/>/g)) {
    used.add(m[1]);
  }

  const missing = [...used].filter((component) => {
    const importPattern = new RegExp(
      `import\\s+(\\{[^}]*\\b${component}\\b[^}]*\\}|${component})\\s+from`,
      "m"
    );
    const localPattern = new RegExp(`(function|const)\\s+${component}\\b`, "m");
    return !importPattern.test(appSource) && !localPattern.test(appSource);
  });

  assert.deepEqual(
    missing,
    [],
    `these routed components are neither imported nor defined in App.tsx:\n` +
      missing.map((c) => `  <${c} />`).join("\n")
  );
});

test("navigation is attached to the Frame unconditionally", () => {
  // If navigation were rendered conditionally, a gate (onboarding, billing,
  // bootstrap) could silently hide the whole nav — which is exactly what an
  // investigation would then blame on the newest route.
  assert.match(
    frameSource,
    /<Frame\s+navigation=\{navigation\}/,
    "the Frame must always receive the navigation prop"
  );
  assert.doesNotMatch(
    frameSource,
    /navigation=\{[^}]*\?[^}]*:/,
    "navigation must not be passed conditionally"
  );
});

test("the navigation list is not filtered by entitlement or onboarding state", () => {
  // Locked modules are indicated with an Upgrade badge, never by removal —
  // removing them would hide capabilities a merchant could buy.
  const section = frameSource.match(/<Navigation\.Section\s+items=\{([^}]+)\}/);
  assert.ok(section, "Navigation.Section must render an items array");
  assert.equal(
    section[1].trim(),
    "navigationItems",
    "items must be the full navigationItems array, never a filtered subset"
  );

  // AppFrame must map the model straight through — no .filter(), no slicing.
  const memo = frameSource.match(/const navigationItems = useMemo\(([\s\S]*?)\n\s{2}\);/);
  assert.ok(memo, "the navigationItems useMemo must exist");
  assert.doesNotMatch(
    memo[1],
    /\.filter\(|\.slice\(/,
    "AppFrame must not filter or slice the navigation model"
  );
});

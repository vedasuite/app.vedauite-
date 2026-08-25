/**
 * Types for backendModuleAccess.js.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The implementation is plain ESM JavaScript so the backend test runner can
 * import and execute the exact shipped module — the same arrangement as
 * navigationModel.js. Without a declaration file TypeScript treated every
 * import of it as `any` (TS7016), which meant the ENTITLEMENT path — the code
 * deciding whether a merchant can see a paid workspace — carried no type
 * checking at all in five separate files.
 *
 * That is not a style problem. `isBackendModuleEnabled(appState, "pricing")`
 * and `isBackendModuleEnabled(appState, "pricng")` were equally acceptable to
 * the compiler, and the second silently locks a merchant out of something they
 * paid for.
 *
 * The KEYS below are entitlement keys and are deliberately unchanged.
 */

/** The four paid capability modules, plus the two always-available surfaces. */
export type BackendModuleKey = "fraud" | "competitor" | "pricing" | "profit";

export type BackendEnabledModules = {
  fraud: boolean;
  competitor: boolean;
  pricing: boolean;
  profit: boolean;
  reports: boolean;
  settings: boolean;
};

/**
 * Deliberately loose: `appState` is whatever /api/app-state returned, and this
 * module's entire job is to read it defensively — every field it touches is
 * optional-chained and coerced with an explicit `=== true`, so a partial or
 * degraded payload yields `false` rather than throwing.
 */
export type BackendAppStateLike = unknown;

/**
 * Resolves which modules the merchant's plan enables.
 *
 * Prefers `storeReadiness.billing.enabledModules` and falls back to the older
 * `entitlements` shape, so a client holding a stale payload still resolves.
 * Never throws: a missing or malformed appState resolves every module to false.
 */
export function resolveBackendEnabledModules(
  appState: BackendAppStateLike
): BackendEnabledModules;

/** The paid modules the current plan does NOT enable. */
export function resolveBackendLockedModules(
  appState: BackendAppStateLike
): BackendModuleKey[];

/** Whether one specific module is enabled. */
export function isBackendModuleEnabled(
  appState: BackendAppStateLike,
  moduleKey: BackendModuleKey
): boolean;

/** The plan name, or "NONE" when no plan is resolvable. */
export function resolveBackendPlan(appState: BackendAppStateLike): string;

/** The module a Starter plan selected, or null. */
export function resolveBackendStarterModule(
  appState: BackendAppStateLike
): string | null;

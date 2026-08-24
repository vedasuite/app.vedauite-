/**
 * The navigation model — pure, dependency-free, and executable outside the
 * browser, so the navigation invariant can be tested by RUNNING it against real
 * state permutations rather than by regex-matching AppFrame.tsx.
 *
 * Kept as plain ESM JavaScript (not .ts) deliberately: the backend test runner
 * imports this exact file, so the tests exercise the code that actually ships
 * instead of a re-implementation.
 *
 * THE RULE: module status may only ever set a `badge`. It must never add,
 * remove, reorder or hide an entry. A feature the merchant cannot see in the
 * navigation is a feature they cannot reach.
 */

/**
 * @typedef {{fraud?: boolean, competitor?: boolean, pricing?: boolean} | null | undefined} NavModuleStatus
 * @typedef {{path: string, label: string, badge?: string}} NavEntry
 */

/** Every route reachable from the authenticated shell, in display order. */
export const NAV_PATHS = [
  "/app/onboarding",
  "/app/dashboard",
  "/app/action-center",
  "/app/fraud-intelligence",
  "/app/competitor-intelligence",
  "/app/ai-pricing-engine",
  "/app/billing",
  "/app/settings",
  "/app/support",
];

/**
 * Entries that must never carry a badge or any gating whatsoever.
 * The Action Center surfaces operational findings, which map to a null
 * capability — no plan, including no plan at all, may hide it.
 */
export const UNGATED_PATHS = [
  "/app/onboarding",
  "/app/dashboard",
  "/app/action-center",
  "/app/billing",
  "/app/settings",
  "/app/support",
];

/**
 * Builds the navigation entries.
 *
 * Deliberately total: it accepts null, undefined or partial module status and
 * always returns the complete list. Degraded or missing app state may make an
 * Upgrade badge appear; it can never make an entry disappear.
 *
 * @param {NavModuleStatus} moduleStatus
 * @returns {NavEntry[]}
 */
export function buildNavigationModel(moduleStatus) {
  const upgrade = (enabled) => (enabled === true ? undefined : "Upgrade");

  return [
    { path: "/app/onboarding", label: "Onboarding" },
    { path: "/app/dashboard", label: "Dashboard" },
    { path: "/app/action-center", label: "Action Center" },
    {
      path: "/app/fraud-intelligence",
      label: "Fraud Intelligence",
      badge: upgrade(moduleStatus?.fraud),
    },
    {
      path: "/app/competitor-intelligence",
      label: "Competitor Intelligence",
      badge: upgrade(moduleStatus?.competitor),
    },
    {
      path: "/app/ai-pricing-engine",
      label: "AI Pricing Engine",
      badge: upgrade(moduleStatus?.pricing),
    },
    { path: "/app/billing", label: "Billing" },
    { path: "/app/settings", label: "Settings" },
    { path: "/app/support", label: "Support & Feedback" },
  ];
}

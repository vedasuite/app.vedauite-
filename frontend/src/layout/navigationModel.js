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

/**
 * Every route reachable from the authenticated shell, in display order.
 *
 * PHASE G/H — Action Center leads.
 *
 * The order used to be Dashboard, then Action Center, then the module pages,
 * which said the Dashboard was the product and the Action Center was a feature.
 * It is the other way round: the Action Center is the one surface that knows
 * what needs doing, in what order, with the evidence attached and a lifecycle
 * behind it. Everything else is either a summary of it (Dashboard) or a place
 * to go deep on one family.
 *
 * THE PATHS ARE DELIBERATELY UNCHANGED. Stored finding snapshots carry a
 * `route` field pointing at these exact URLs, and those rows are merchant data
 * written by past syncs. Renaming a path would silently break the "Open" button
 * on every historical finding, so this phase renames LABELS only.
 */
export const NAV_PATHS = [
  "/app/onboarding",
  "/app/action-center",
  "/app/dashboard",
  "/app/fraud-intelligence",
  "/app/ai-pricing-engine",
  "/app/competitor-intelligence",
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
    // The primary surface: everything that needs doing, prioritized, with
    // evidence and a lifecycle. Never gated — it carries store-health findings.
    { path: "/app/action-center", label: "Action Center" },
    // The summary of the above, plus store health and setup state.
    { path: "/app/dashboard", label: "Store Overview" },
    {
      // Renamed from "Fraud Intelligence". The engine family is customer loss:
      // refunds, return abuse and risky orders are all money leaving through
      // the customer, and "fraud" oversold a detector that mostly finds
      // ordinary loss patterns rather than criminal activity.
      path: "/app/fraud-intelligence",
      label: "Customer Loss",
      badge: upgrade(moduleStatus?.fraud),
    },
    {
      // Renamed from "AI Pricing Engine". Nothing about the pricing or profit
      // calculation involves a model: it is arithmetic over cost, price and
      // observed velocity, with an explicit evidence gate. Calling it AI was a
      // capability claim VedaSuite could not defend.
      path: "/app/ai-pricing-engine",
      label: "Pricing & Product Profit",
      badge: upgrade(moduleStatus?.pricing),
    },
    {
      // Renamed from "Competitor Intelligence". Phase D established that what
      // this family produces is a signal read from a competitor's public page,
      // which frequently cannot be refreshed at all. "Intelligence" implied a
      // reliability the collection layer does not have.
      path: "/app/competitor-intelligence",
      label: "Market Signals",
      badge: upgrade(moduleStatus?.competitor),
    },
    { path: "/app/billing", label: "Billing" },
    { path: "/app/settings", label: "Settings" },
    { path: "/app/support", label: "Support & Feedback" },
  ];
}

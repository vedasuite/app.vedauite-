/**
 * Decides which empty/populated story a module intelligence panel tells.
 *
 * Background: the explainability engine drops an insight from BOTH output
 * lists when it cannot be quantified — `opportunities` filters on
 * `!excludedFromMonetaryRanking`, and `criticalAttention` requires
 * `urgency === "critical"` (competitor findings are "medium"). A store with
 * real competitor activity therefore received zero items, and the UI said
 * "No explainable findings", contradicting the activity counts shown beside
 * it.
 *
 * This distinguishes "nothing analysed" from "analysed, nothing met the bar"
 * using the coverage figure the engine already reports. It does not change any
 * threshold, invent a recommendation, or re-derive confidence.
 */

export type ModuleInsightState =
  /** Nothing has been analysed for this module yet. */
  | "NO_DATA"
  /** Data was analysed, but nothing cleared the evidence bar. */
  | "ACTIVITY_NO_RECOMMENDATIONS"
  /** Real, explainable findings exist. */
  | "HAS_FINDINGS";

export function resolveModuleInsightState(
  findingCount: number,
  monitoredRows: number
): ModuleInsightState {
  if (findingCount > 0) return "HAS_FINDINGS";
  return monitoredRows > 0 ? "ACTIVITY_NO_RECOMMENDATIONS" : "NO_DATA";
}

/**
 * Sum of records the engine analysed for the requested modules. The synthetic
 * "all" coverage row is excluded so it cannot double-count.
 */
export function countMonitoredRows(
  coverage: Array<{ module: string; rowsAvailable: number }>
): number {
  return coverage
    .filter((entry) => entry.module !== "all")
    .reduce((total, entry) => total + Math.max(0, entry.rowsAvailable), 0);
}

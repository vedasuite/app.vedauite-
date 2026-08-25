/**
 * Truthful presentation of Customer Loss readiness.
 *
 * The backend already distinguishes these situations and ships an accurate
 * `reason` with each one. The page previously collapsed every non-ready state
 * into a single hardcoded "still preparing data" banner and fired an
 * unconditional "data is up to date" toast, which told a merchant two
 * contradictory things at once. This maps the backend's own state onto honest
 * copy instead of re-deriving anything in the UI.
 *
 * WHY THE IDENTIFIERS STILL SAY "FRAUD"
 * ------------------------------------
 * The exported names (FraudUiState, fraudBannerFor, resolveFraudUiState, the
 * `fraud` entitlement key they ultimately serve) are INTERNAL identifiers and
 * are deliberately unchanged. Renaming them would touch the entitlement path
 * for no merchant-visible benefit. Only the strings a merchant reads changed.
 *
 * WHAT CHANGED IN THE COPY, AND WHY
 * ---------------------------------
 * This module is Customer Loss: money leaving through refunds, returns,
 * chargebacks and repeat customer behaviour. Fraud detection is one of the
 * ENGINES underneath it, not the subject. The old copy inverted that — "no
 * urgent fraud reviews are open", "fraud data refreshed" — which told a
 * merchant with ordinary refund leakage that the module had nothing for them,
 * because they were reading a fraud verdict rather than a loss verdict.
 *
 * Nothing here changes scoring, thresholds or readiness rules — it only
 * decides what to *say* about a state the backend already determined.
 */

/** Backend `readiness.readinessState` values, from storeOperationalStateService. */
export type FraudReadinessCode =
  | "READY_WITH_DATA"
  | "SYNC_IN_PROGRESS"
  | "SYNC_COMPLETED_PROCESSING_PENDING"
  | "EMPTY_STORE_DATA"
  | "SYNC_REQUIRED"
  | "NOT_CONNECTED"
  | "FAILED";

export type FraudUiState =
  /** A — sync/processing genuinely running. */
  | "PROCESSING"
  /** B — sync finished, not enough store activity to analyse. */
  | "INSUFFICIENT_ACTIVITY"
  /** C — enough data, analysis current, nothing risky found. */
  | "READY_NO_FINDINGS"
  /** D — analysis current, findings need attention. */
  | "READY_WITH_FINDINGS"
  /** E — something is wrong (failed / disconnected). */
  | "ERROR";

export type FraudBanner = {
  title: string;
  body: string;
  tone: "critical" | "warning" | "info" | "success";
} | null;

export type FraudFindingCounts = {
  returnAbuseProfiles: number;
  highRiskOrders: number;
  manualReviewCount: number;
};

/** Total items a merchant would actually need to act on. */
export function countFraudFindings(counts: FraudFindingCounts): number {
  return (
    Math.max(0, counts.returnAbuseProfiles) +
    Math.max(0, counts.highRiskOrders) +
    Math.max(0, counts.manualReviewCount)
  );
}

/**
 * Resolve the UI state from the backend's readiness code.
 *
 * Critically, zero findings only ever means "no risk found" when the backend
 * reports READY_WITH_DATA. In every other state zero means "not enough
 * evidence yet", and the UI must not present it as a clean bill of health.
 */
export function resolveFraudUiState(
  readinessState: string | undefined,
  counts: FraudFindingCounts,
  requestFailed = false
): FraudUiState {
  if (requestFailed) return "ERROR";

  switch (readinessState) {
    case "FAILED":
    case "NOT_CONNECTED":
      return "ERROR";
    case "SYNC_IN_PROGRESS":
      return "PROCESSING";
    case "SYNC_REQUIRED":
    case "EMPTY_STORE_DATA":
    case "SYNC_COMPLETED_PROCESSING_PENDING":
      return "INSUFFICIENT_ACTIVITY";
    case "READY_WITH_DATA":
      return countFraudFindings(counts) > 0 ? "READY_WITH_FINDINGS" : "READY_NO_FINDINGS";
    default:
      // An unrecognised state must never be optimistically treated as ready.
      return "INSUFFICIENT_ACTIVITY";
  }
}

/**
 * Banner for a state. `backendReason` is preferred as the body wherever the
 * backend supplied one, so the merchant sees the real requirement rather than
 * a guess made in the frontend.
 */
export function fraudBannerFor(
  state: FraudUiState,
  backendReason?: string | null
): FraudBanner {
  switch (state) {
    case "ERROR":
      return {
        title: "Customer loss analysis needs attention",
        body:
          backendReason ??
          "The latest customer loss analysis could not be completed. Your previous results are unchanged.",
        tone: "critical",
      };
    case "PROCESSING":
      return {
        title: "Customer loss analysis is running",
        body:
          backendReason ??
          "VedaSuite is analysing your synced orders, refunds and customers. This usually finishes within a few minutes.",
        tone: "info",
      };
    case "INSUFFICIENT_ACTIVITY":
      // Names what is missing and why it matters. "More store activity is
      // needed" told the merchant nothing they could act on: they could not
      // tell whether VedaSuite wanted more orders, more refunds, or more time.
      return {
        title: "Not enough history to establish a loss pattern yet",
        body:
          backendReason ??
          "VedaSuite checked your synced orders, refunds and customer records. Repeated loss is only reported once there is enough order and refund history to tell a pattern from a one-off return — a single refund is not evidence of one.",
        tone: "warning",
      };
    case "READY_NO_FINDINGS":
      return {
        title: "No repeated customer loss found",
        body:
          "VedaSuite analysed your refunds, returns and order-risk signals and found no repeating loss pattern that meets its evidence bar. Individual orders and customers are still listed below.",
        tone: "success",
      };
    case "READY_WITH_FINDINGS":
      // Findings render in the page body; no separate banner is needed.
      return null;
  }
}

/**
 * Toast shown after a *successful* refresh. Never claims data is up to date
 * when the module still lacks the evidence to analyse.
 */
export function fraudRefreshToast(
  state: FraudUiState,
  counts: FraudFindingCounts
): string {
  switch (state) {
    case "PROCESSING":
      return "Refresh requested. Customer loss analysis is still running.";
    case "INSUFFICIENT_ACTIVITY":
      return "Refreshed. Still not enough order and refund history to establish a loss pattern.";
    case "READY_NO_FINDINGS":
      return "Refreshed — no repeated customer loss pattern was found.";
    case "READY_WITH_FINDINGS": {
      const total = countFraudFindings(counts);
      return `Refreshed — ${total} customer loss item${total === 1 ? "" : "s"} need${
        total === 1 ? "s" : ""
      } attention.`;
    }
    case "ERROR":
      // Callers must not show a success toast on failure; this is a guard.
      return "Customer loss analysis could not be refreshed.";
  }
}

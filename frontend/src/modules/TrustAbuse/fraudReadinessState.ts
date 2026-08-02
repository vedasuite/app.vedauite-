/**
 * Truthful presentation of Fraud Intelligence readiness.
 *
 * The backend already distinguishes these situations and ships an accurate
 * `reason` with each one. The page previously collapsed every non-ready state
 * into a single hardcoded "still preparing data" banner and fired an
 * unconditional "data is up to date" toast, which told a merchant two
 * contradictory things at once. This maps the backend's own state onto honest
 * copy instead of re-deriving anything in the UI.
 *
 * Nothing here changes fraud scoring, thresholds or readiness rules — it only
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
        title: "Fraud intelligence needs attention",
        body:
          backendReason ??
          "The latest fraud analysis could not be completed. Your previous results are unchanged.",
        tone: "critical",
      };
    case "PROCESSING":
      return {
        title: "Fraud data is being prepared",
        body:
          backendReason ??
          "VedaSuite is analysing your synced orders and customers. This usually finishes within a few minutes.",
        tone: "info",
      };
    case "INSUFFICIENT_ACTIVITY":
      return {
        title: "More store activity is needed",
        body:
          backendReason ??
          "Your store data is synced, but there is not yet enough order, customer or return history to generate reliable fraud intelligence.",
        tone: "warning",
      };
    case "READY_NO_FINDINGS":
      return {
        title: "Fraud analysis is up to date",
        body: "No high-risk orders or urgent fraud reviews were detected.",
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
      return "Fraud data refresh requested. Processing is still in progress.";
    case "INSUFFICIENT_ACTIVITY":
      return "Fraud data refreshed. More store activity is still needed before insights are available.";
    case "READY_NO_FINDINGS":
      return "Fraud intelligence refreshed — no urgent risks were detected.";
    case "READY_WITH_FINDINGS": {
      const total = countFraudFindings(counts);
      return `Fraud intelligence refreshed — ${total} item${total === 1 ? "" : "s"} need${
        total === 1 ? "s" : ""
      } attention.`;
    }
    case "ERROR":
      // Callers must not show a success toast on failure; this is a guard.
      return "Fraud intelligence could not be refreshed.";
  }
}

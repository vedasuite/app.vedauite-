# Competitor Intelligence State Refactor Report

## Old behavior

- The page used a generic readiness banner that collapsed too many situations into vague copy like `stale or limited`.
- Merchant toasts exposed pipeline-style wording such as competitor pages being fetched without snapshots being captured.
- Setup gaps, stale data, partial coverage, healthy no-change refreshes, and true failures were not separated cleanly.
- The page showed counts, but not a single operational summary explaining what happened in the latest refresh and what the merchant should do next.

## Root cause

- Competitor page UX was still driven mostly by broad module readiness plus loose freshness checks.
- The backend overview response did not expose a dedicated operational state model for competitor monitoring.
- The frontend banner and toast logic inferred outcomes from generic readiness and row counts instead of explicit competitor monitoring statuses.

## New state model

The competitor module now derives page state from explicit operational fields:

- `setupStatus`
- `syncStatus`
- `crawlStatus`
- `snapshotStatus`
- `freshnessStatus`
- `lastSuccessAt`
- `lastAttemptAt`
- `checkedDomainsCount`
- `monitoredProductsCount`
- `matchedProductsCount`
- `detectedPriceChangesCount`
- `detectedPromotionChangesCount`

The page derives one merchant-facing module state:

- `success`
- `partial`
- `setup_incomplete`
- `empty_healthy`
- `failure`
- `stale`

## Banner logic

- `success`
  - success banner
  - shows last update time, domains checked, products matched, and change counts
  - CTA: `View changes`
- `partial`
  - warning banner
  - explains whether matching failed completely or coverage is incomplete
  - CTAs: `Review tracked products` or `Re-run sync`, plus `Update domains`
- `setup_incomplete`
  - setup banner
  - explains exactly what is missing
  - CTAs: `Complete setup`, `Update domains`
- `empty_healthy`
  - neutral info banner
  - clearly says monitoring is active and no changes were detected
  - CTAs: `Refresh again`, `Update domains`
- `failure`
  - critical banner
  - shows merchant-safe failure copy
  - CTA: `Retry refresh`
- `stale`
  - warning banner
  - used only when freshness specifically fails
  - CTA: `Re-run sync`

## Toast logic

Technical ingestion text was replaced with merchant-safe copy:

- Success: `Competitor monitoring refreshed successfully.`
- Partial: `Refresh completed, but some products could not be matched to competitor snapshots.`
- Empty healthy: `Refresh completed. No competitor changes detected.`
- Failure: `Competitor refresh failed. Please try again.`

The backend ingest result now also returns `merchantMessage` so the frontend can keep customer-facing copy stable without exposing pipeline internals.

## UI changes

- Added a compact `Monitoring status` section with:
  - last successful refresh
  - last refresh attempt
  - domains checked
  - products matched
  - coverage status
  - refresh result summary
- Replaced vague readiness-only messaging with state-derived banners and CTAs.
- Domain updates now refresh competitor overview/connectors immediately so setup-state messaging updates without waiting for a full page reload.

## QA scenarios tested

1. Setup incomplete
   - no domains configured
   - banner instructs merchant to complete setup
2. Partial refresh
   - no product matches or incomplete snapshot coverage
   - page shows warning with recommended next action
3. Empty but healthy
   - refresh succeeds with no changes detected
   - page shows neutral info, not an error
4. Success
   - snapshots exist and price or promotion changes are available
   - page shows success state and `View changes`
5. Failure
   - latest refresh fails
   - page shows critical banner and retry path
6. Stale
   - refresh data exists but freshness threshold is exceeded
   - page shows stale-specific guidance rather than generic limitation wording

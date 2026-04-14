# Competitor Intelligence Refactor Report

## Old state conflicts found
- Freshness used `lastIngestedAt` while success banners often used the newer job completion time, so the page could show a recent successful refresh and still call the module stale.
- The frontend derived its own fallback states (`success`, `partial`, `empty_healthy`, `stale`) from `moduleState`, while the backend also emitted `monitoringStatus`, `coverageSummary`, `weeklyReport`, and connector readiness independently.
- `Healthy with no changes` was shown for both `no matches` and `matched but unchanged`, which blurred two very different merchant actions.
- Toasts could use ingest response copy while the page banner used derived page logic, so refresh feedback diverged immediately after a run.

## New unified state model
- Backend now derives one `competitorState` object with:
  - `primaryState`
  - `freshnessLabel`
  - `lastSuccessfulRunAt`
  - `lastAttemptAt`
  - `checkedDomainsCount`
  - `matchedProductsCount`
  - `activePromotionsCount`
  - `stockAlertsCount`
  - `coverageStatus`
  - `title`
  - `description`
  - `nextAction`
  - `toastMessage`
- Allowed primary states now drive the page:
  - `SETUP_INCOMPLETE`
  - `AWAITING_FIRST_RUN`
  - `NO_MATCHES`
  - `NO_CHANGES`
  - `CHANGES_DETECTED`
  - `STALE`
  - `FAILURE`

## Freshness logic
- Freshness now derives from the last successful competitor run timestamp, not from the last captured competitor row.
- `Stale` is used only when the last successful run is older than the freshness threshold.
- `No matches` no longer implies stale.

## Banner / toast / card alignment rules
- Banner title and body come directly from `competitorState`.
- Toast after refresh now prefers the refreshed `competitorState.toastMessage`.
- KPI cards use only `competitorState` counts and labels.
- Coverage status is now the same string across banner support copy, KPI card, and monitoring status summary.

## Page hierarchy changes
1. Header with one primary refresh action and one secondary domain action
2. One primary monitoring banner
3. Core summary cards
4. What to do next + monitoring status
5. Live monitoring output tabs
6. Channel and connector status
7. Weekly brief only when monitoring is actually usable

## Channel card logic changes
- Website crawler now resolves to `Live`, `Configured`, or `Not enabled` based on configured domains plus pulled data.
- Google Shopping and Meta Ads remain clearly labeled as `Preview`.
- Each connector card now includes a concrete action hint instead of vague readiness text.

## QA scenarios to run
- No domains configured
- Domains configured, no successful run yet
- Successful run, no comparable matches found
- Successful run, matched products with no detected changes
- Successful run, matched products with detected changes
- Successful run older than freshness threshold
- Website live while Google Shopping and Meta Ads remain preview
- Refresh feedback where banner, toast, cards, and tabs all match the same state

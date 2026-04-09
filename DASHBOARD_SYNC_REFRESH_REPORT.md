# Dashboard Sync Refresh Report

## Root cause

- The dashboard sync button waited for a background sync job and then showed a toast, but the page did not keep an explicit refresh lifecycle for merchants.
- Dashboard data was reloaded, but the UI had no visible `last refreshed` row, no section-level refresh summary, and no distinction between:
  - refresh succeeded with changes
  - refresh succeeded with no changes
  - refresh completed partially
  - refresh failed
- The dashboard relied too heavily on transient toast copy instead of making refreshed state visible on the page itself.

## Hard fixes implemented

### Backend

- Added `lastRefreshedAt` to dashboard metrics in:
  - `backend/src/services/dashboardService.ts`
- This now persists a server-derived refresh timestamp from the latest processing, competitor, or sync activity so direct reloads reflect the latest settled dashboard state.

### Frontend

- Refactored dashboard sync flow in:
  - `frontend/src/modules/Dashboard/DashboardPage.tsx`
- Added a structured dashboard refresh result model:
  - `startedAt`
  - `finishedAt`
  - `refreshStatus`
  - `dashboardDataChanged`
  - `changedSections`
  - `unchangedSections`
  - `lastRefreshedAt`
  - `moduleRefreshResults`
- Sync now:
  - disables the button while in flight
  - shows loading on the button
  - applies loading treatment to KPI cards and recent insights
  - refetches dashboard metrics and diagnostics after sync settles
  - compares previous and refreshed data
  - surfaces whether KPI cards, recent insights, quick access readiness, or sync health changed
  - shows an on-page refresh summary instead of relying only on a toast

## Merchant-visible behavior now

- A dashboard header status row shows:
  - last refreshed
  - sync health
  - refresh result summary
- When sync succeeds with changes:
  - the page says which sections updated
- When sync succeeds without changes:
  - the page says:
    - `Store data refreshed successfully. No new alerts or metric changes were detected.`
- When sync partially succeeds:
  - the page shows a partial-update banner and module-level update results
- When sync fails:
  - the page shows failure state and keeps a visible dashboard summary instead of only a disappearing toast

## QA scenarios covered

1. Sync in flight
   - Sync button disables and shows loading
   - KPI cards and insights show loading treatment
2. Sync success with changed data
   - dashboard cards and insights refresh
   - header summary identifies updated sections
3. Sync success with no material change
   - page explicitly says no new alerts or metric changes were detected
4. Partial sync result
   - page shows partial-update banner and per-module refresh summary
5. Failure
   - page shows visible failure summary and retry path
6. Direct reload
   - last refreshed timestamp is returned from persisted backend state

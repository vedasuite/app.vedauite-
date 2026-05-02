# Dashboard Sync Refresh Report

## Root causes found

- The dashboard was rendering from multiple adjacent state sources at once:
  - raw metrics fields
  - module readiness fields
  - module state fields
  - diagnostics sync health
  - mutation-time refresh summaries
- Sync completion was being treated as evidence that dashboard-visible data changed.
- Quick access freshness and top sync health were derived independently, so the page could say the store was ready while a module silently degraded to a different state without explanation.
- The frontend snapshot comparison was diffing mixed inputs instead of one canonical post-sync dashboard model.

## Old inconsistent data flow

- Backend returned KPI values, module readiness, module states, and summary strings separately.
- Frontend header, cards, quick access, banner, and toast each picked from different fields.
- Post-sync summary logic could report sections as updated even when the merchant-visible dashboard values stayed the same.
- Module freshness labels could change based on stale module timestamps without that reason being reflected in the top dashboard summary.

## New unified dashboard state model

`/api/dashboard/metrics` now includes a normalized `dashboardState` payload built from persisted backend data:

```ts
{
  refreshedAt,
  syncHealth: {
    status,
    title,
    reason,
  },
  kpis: {
    fraudAlerts,
    competitorChanges,
    pricingOpportunities,
    profitOpportunities,
  },
  recentInsights,
  quickAccess: {
    fraud: { status, freshnessAt, reason },
    competitor: { status, freshnessAt, reason },
    pricing: { status, freshnessAt, reason },
  },
}
```

All major dashboard surfaces now render from this model first:

- header last refreshed
- sync health row
- KPI cards
- recent insights
- quick access cards
- post-sync refresh summary

## Snapshot comparison logic

The frontend now compares normalized pre-sync and post-sync snapshots using only merchant-visible fields:

- KPI values
- recent insight ids/timestamps
- quick access statuses
- sync health state
- last refreshed timestamp

The refresh summary only reports a section as changed when the visible snapshot changed.

Examples now supported:

- `Refresh completed. No visible dashboard changes were detected.`
- `Refresh completed. Recent insights were updated. KPI values were unchanged.`
- `Refresh completed. Module readiness statuses were re-evaluated after refresh. KPI values were unchanged.`
- `Refresh completed. Pricing opportunities changed from 38 to 41.`

## Quick access status derivation logic

A shared backend helper now converts unified module state into dashboard quick access status:

- `Ready`
- `Partial`
- `Needs setup`
- `Refreshing`
- `Stale`
- `Error`

Rules now enforced:

- `Stale` only comes from a module state that is actually stale.
- `Needs setup` comes from incomplete module setup, not from missing data alone.
- healthy empty module outcomes are shown as `Ready` with a reason, not as an error.
- when the store is overall `Ready with data` but a module is stale, the sync-health reason now explains that module freshness is lagging instead of silently contradicting the quick access cards.

## Cache and revalidation changes

- After sync reaches a terminal job state, the frontend does not trust the mutation response alone.
- It re-fetches persisted dashboard data and waits for:
  - a newer backend refresh timestamp, or
  - a real visible snapshot change
- The dashboard only re-renders its refresh result from that verified post-sync payload.
- This closes the gap where the page could claim updates before the persisted dashboard state had actually caught up.

## Files changed

- `backend/src/services/unifiedModuleStateService.ts`
  - added shared quick access status derivation
- `backend/src/services/dashboardService.ts`
  - added normalized `dashboardState`
  - unified timestamps
  - aligned sync-health reasoning with module freshness
- `frontend/src/modules/Dashboard/DashboardPage.tsx`
  - switched rendering to `dashboardState`
  - rewrote snapshot comparison
  - made refresh summary depend on visible post-sync data truth

## QA scenarios

1. Sync completes and nothing visible changes
   - result: refresh summary reports no visible dashboard changes
2. Sync completes and KPI values change
   - result: summary names the exact KPI deltas
3. Sync completes and only recent insights change
   - result: summary reports recent insights updated while KPI values were unchanged
4. Sync completes and quick access statuses change
   - result: summary reports readiness re-evaluation instead of falsely claiming KPI updates
5. One module remains stale while overall sync health is ready
   - result: quick access shows module-specific stale state and sync-health reason explains the freshness gap
6. Browser reload after sync
   - result: dashboard renders from persisted backend `dashboardState`, preserving the same post-sync truth

## Verification

- `npm run build` passed in `backend`
- `npm run build` passed in `frontend`

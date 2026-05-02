# Competitor Intelligence Route Crash Fix Report

## Exact root cause found

The crash was caused by a real JavaScript temporal-dead-zone initialization bug inside:

- `frontend/src/modules/CompetitorIntelligence/CompetitorPage.tsx`

Inside the component render path, `monitoringStatusRows` was created before `banner` had been initialized:

- `monitoringStatusRows` referenced `banner.summary`
- `banner` was declared later with `const banner = deriveCompetitorBanner(overview)`

That produces a runtime error in JavaScript when the component evaluates, and in the production bundle it surfaced as:

- `Cannot access 'K' before initialization`

This was not an error-boundary problem. It was a declaration-order bug in the page component itself.

## Type of issue

- declaration order / const referenced before initialization

It was **not** caused by:

- circular import
- barrel export loop
- route module back-reference
- lazy import issue
- nav config import cycle

## Files involved

- `frontend/src/modules/CompetitorIntelligence/CompetitorPage.tsx`

## What was refactored

- Moved `monitoringStatusRows` below the `banner` initialization so all render-time values are declared in safe order.
- Kept route ownership unchanged because the route mapping itself was already correct:
  - `App.tsx` imports `CompetitorPage` directly
  - no barrel export chain is involved in this route

## Imports audited

Checked the competitor route dependency path:

- `frontend/src/App.tsx`
- `frontend/src/layout/AppFrame.tsx`
- `frontend/src/modules/CompetitorIntelligence/CompetitorPage.tsx`

Findings:

- direct import from route map to page component
- no `index.ts` competitor barrel involved
- no reverse import from nav config back into the page
- no circular dependency found in the competitor route path

## QA results

1. Competitor route render path
   - fixed declaration-order crash
2. Direct route ownership
   - `/app/competitor-intelligence` still maps directly to `CompetitorPage`
3. Bundled production build
   - frontend build passed after the fix
4. Crash condition
   - the specific `Cannot access 'K' before initialization` source is removed

## Remaining note

This fix addresses the actual runtime initialization bug that was crashing the page. Normal page loading, empty state, partial state, stale state, and action buttons can now execute without tripping that render-time reference error.

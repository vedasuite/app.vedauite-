# Unified Data State Report

## Old vs new state logic

### Old

- Dashboard, Competitor Intelligence, and AI Pricing Engine each derived state independently.
- `stale` could appear for reasons other than age, including no matches or incomplete downstream outputs.
- `updated` on the dashboard could reflect job completion or broad readiness changes instead of visible merchant-facing changes.
- Pricing could say `awaiting competitor data` as a primary state even while pricing recommendations were already visible.
- Empty results and partial coverage could look like failures.

### New

A shared backend state model now drives the module truth layer:

- `setupStatus`: `complete` | `incomplete`
- `syncStatus`: `idle` | `running` | `completed` | `failed`
- `dataStatus`: `ready` | `partial` | `empty` | `stale` | `failed` | `processing`
- `lastSuccessfulSyncAt`
- `lastAttemptAt`
- `dataChanged`
- `coverage`: `full` | `partial` | `none`
- `dependencies`:
  - `competitor`
  - `pricing`
  - `fraud`

This state model is implemented in:

- `backend/src/services/unifiedModuleStateService.ts`

## How each module now derives its state

### Dashboard

Dashboard now returns shared module states for:

- fraud
- competitor
- pricing

Dashboard refresh truth uses a normalized before/after snapshot of merchant-visible fields only:

- fraud alerts count
- competitor changes count
- pricing opportunities count
- profit opportunities count
- recent insights ids/timestamps
- quick access readiness states
- sync health metadata
- last refreshed timestamp

`updated` is now shown only if those visible outputs actually changed.

### Competitor Intelligence

Competitor state now follows these rules:

- `setup incomplete`
  - no competitor domains configured
- `processing`
  - refresh is currently running
- `failed`
  - latest refresh failed
- `stale`
  - last successful competitor refresh is older than 24 hours
- `empty`
  - monitoring is configured but no matched competitor products were found
  - or monitoring is healthy but no price/promotion changes were found
- `partial`
  - some competitor data exists, but coverage is incomplete
- `ready`
  - matched competitor data and usable changes are available

Important fix:

- no competitor matches found is now `empty`, not `stale` and not `failed`

### AI Pricing Engine

Pricing state now follows these rules:

- `processing`
  - sync or pricing preparation is still running
- `failed`
  - latest pricing refresh failed
- `stale`
  - pricing outputs are older than 24 hours
- `empty`
  - pricing engine is healthy but no visible pricing/profit opportunities were found
- `partial`
  - pricing insights exist, but competitor dependency is still missing
- `ready`
  - pricing and supporting dependencies are fully available

Important fix:

- if pricing works but competitor data is missing, the module is now `partial`
- primary message becomes:
  - `Pricing insights are available. Competitor data is still being processed.`

## Example UI messages by state

### Ready

- `Competitor data is ready`
- `Pricing insights are ready`

### Partial

- `Competitor data is available with partial coverage`
- `Pricing insights are available. Competitor data is still being processed.`

### Empty

- `Monitoring is active, but no competitor matches were found`
- `Pricing is ready, but no opportunities were found yet`

### Stale

- `Competitor data is out of date`
- `Pricing data is out of date`

### Failed

- `Competitor refresh failed`
- `Pricing data needs attention`

### Processing

- `Competitor monitoring is refreshing`
- `Pricing data is still being processed`

## QA scenarios covered

1. Fresh sync, no visible dashboard changes
   - dashboard says no visible metric changes were detected
2. Fresh sync with pricing changes
   - dashboard marks pricing as updated only if visible pricing fields changed
3. Competitor domains exist but no matches
   - competitor shows `empty`, not `stale` or `failed`
4. Competitor not configured
   - competitor shows setup incomplete with next action
5. Pricing works but competitor missing
   - pricing shows `partial`
6. Sync fails
   - dashboard/module states show `failed`
7. Sync running
   - dashboard/module states show `processing`
8. Data older than threshold
   - `stale` is used only when last successful sync is older than 24 hours

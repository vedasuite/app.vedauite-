# Sync Activity Visibility Report

## Sync result data structure

The latest sync job now exposes a parsed activity summary under `/api/shopify/sync-jobs/latest`:

```ts
{
  activitySummary: {
    ordersProcessed,
    customersEvaluated,
    competitorPagesChecked,
    pricingRecordsAnalyzed,
    fraudSignalsGenerated,
    newInsightsCount,
    updatedInsightsCount,
    errorsCount,
    noChangeReasons,
    moduleProcessing: {
      fraud: { processed, status, reason },
      competitor: { processed, status, reason },
      pricing: { processed, status, reason },
    },
  }
}
```

## UI integration

- Dashboard refresh banner now shows a real processing summary after sync.
- The no-change path now explains why KPI values stayed unchanged.
- Quick access cards now derive their post-sync labels and explanations from the same sync activity object.
- Competitor post-sync messaging is now explicit:
  - module not refreshed
  - ran with no matches
  - stale due to age

## Example output

```json
{
  "ordersProcessed": 124,
  "customersEvaluated": 98,
  "competitorPagesChecked": 0,
  "pricingRecordsAnalyzed": 41,
  "fraudSignalsGenerated": 3,
  "newInsightsCount": 8,
  "updatedInsightsCount": 0,
  "errorsCount": 0,
  "noChangeReasons": [
    "no new fraud signals were triggered",
    "competitor module was not refreshed in this sync",
    "pricing signals remained stable"
  ]
}
```

## QA validation

1. Sync with no new data
   - activity counts visible
   - no-change explanation rendered
2. Sync with fraud processing
   - fraud processing shows work completed
   - quick access reflects fraud update or no-change result
3. Sync with pricing processing
   - pricing analyzed count visible
   - summary explains whether visible KPI changed
4. Sync where competitor is skipped
   - competitor quick access shows `Not refreshed`
   - reason explicitly states competitor module did not run in this sync
5. Header, banner, toast, and quick access alignment
   - all derive from the same post-sync result object

## Verification

- `npm run build` passed in `backend`
- `npm run build` passed in `frontend`

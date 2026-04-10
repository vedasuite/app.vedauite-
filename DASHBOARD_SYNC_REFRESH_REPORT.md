# Dashboard Sync Refresh Report

## Root cause of false update reporting

- The dashboard treated sync job completion as if it proved visible dashboard changes.
- The page re-fetched after the job finished, but it did not verify that the refreshed payload was actually newer than the previous dashboard state.
- Module labels such as `Fraud: updated` or `Pricing: updated` could therefore be inferred from job outcome or broad readiness movement instead of confirmed merchant-visible output changes.
- This created false confidence when:
  - the pipeline ran
  - persisted dashboard payload had not fully caught up yet
  - KPI cards and recent insights stayed the same

## How dashboard truth is now computed

- The dashboard now builds a normalized before/after snapshot using only merchant-visible fields:
  - fraud alerts count
  - competitor changes count
  - pricing opportunities count
  - profit opportunities count
  - recent insight ids and timestamps
  - quick access readiness states
  - sync health fields
  - last refreshed timestamp
- After sync reaches a terminal state, the frontend waits for a newer persisted dashboard payload before comparing snapshots.
- `updated` is now shown only when the relevant visible dashboard output actually changed.
- `unchanged` is shown when sync completed but the visible dashboard output for that module stayed the same.
- `failed` is shown only when the refresh truly failed.

## Snapshot comparison added

The refresh model now tracks:

- `startedAt`
- `finishedAt`
- `refreshStatus`
- `visibleDataChanged`
- `changedSections`
- `unchangedSections`
- `lastRefreshedAt`
- `moduleRefreshResults`
- `previousSnapshot`
- `nextSnapshot`

This comparison is used to decide:

- whether KPI cards changed
- whether recent insights changed
- whether quick access readiness changed
- whether sync health changed
- whether only the timestamp changed with no visible metric movement

## Cache and revalidation fix

- The dashboard no longer trusts the first post-job response blindly.
- After the sync job reaches a terminal state, the page polls for a verified dashboard payload that is newer than the previous refresh timestamp or visibly different from the previous snapshot.
- The dashboard state is updated only from that verified post-sync payload.
- This closes the race where the job had finished but the immediately fetched dashboard payload had not fully caught up yet.

## Merchant-visible behavior now

- Sync button disables and shows loading while in flight.
- KPI cards and recent insights show loading treatment during refresh.
- The dashboard shows:
  - last refreshed timestamp
  - sync health
  - refresh result summary
- If nothing visible changed, the page now says:
  - `Refresh completed. No visible metric changes were detected.`
- If only some visible sections changed, the page says exactly which sections changed.
- Module summaries no longer say `updated` unless their visible dashboard output actually changed.

## QA scenarios and results

1. Sync in flight
   - button loading and disabled state confirmed
   - KPI and recent insights loading treatment confirmed
2. Sync success with visible changes
   - changed sections reported from snapshot diff
   - updated values render from refreshed payload
3. Sync success with no visible changes
   - page explicitly reports no visible metric changes
   - module results stay `unchanged`
4. Partial sync result
   - page remains partial overall
   - only actually changed module outputs are marked `updated`
5. Sync failure
   - page shows visible failure summary
   - module results show `failed`
6. Direct reload
   - dashboard reads persisted `lastRefreshedAt` from backend state

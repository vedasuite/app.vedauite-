# Fraud Intelligence Refactor Report

## Old structure problems found

- The page was too long and gave nearly every section the same visual weight.
- Review queue, recommendations, evidence, configuration, and advanced tools were mixed together without a clear operational order.
- Several two-column sections created an unbalanced feel because one card was dense while the paired card was sparse.
- The page used too many overlapping status vocabularies, including trust tiers, readiness states, automation posture, and risk wording.
- Advanced features like the simulator and support guidance appeared too early, competing with immediate fraud review work.

## New section order

1. Page header with a real `Refresh` action
2. Compact KPI summary row
3. Actions that need attention now
4. Recommended policy actions
5. Customer and order evidence
6. Policy and configuration summary
7. Advanced tools

## Components removed, merged, or renamed

- Merged the old review queue and scattered action messaging into one primary `Actions that need attention now` block.
- Renamed policy-heavy sections into the clearer `Recommended policy actions`.
- Merged return abuse, network, chargeback, timeline, and evidence export content into a single `Customer and order evidence` section with tabs.
- Moved trust tiers, score bands, and automation rules into a lower-priority `Policy and configuration summary`.
- Moved refund simulator and support workflow helpers into `Advanced tools`.
- Removed the old equal-weight layout pattern where every section competed at the same level.

## Layout bugs fixed

- Removed the broken feeling caused by mismatched side-by-side section density.
- Replaced the long sequence of competing two-column sections with a clearer stacked hierarchy.
- Kept the main operational surface near the top and grouped lower-priority detail further down.
- Reduced the chance of large blank-feeling panels by using full-width sections where content needs more vertical depth.

## Status system simplifications

The page now favors one smaller operational vocabulary:

- `Ready`
- `Needs review`
- `Monitor`
- `High risk`
- `Informational`

This replaces the older pattern of mixing multiple badge systems in the same viewport.

## QA checklist

Desktop:

- Header loads with working `Refresh` action
- Summary row shows only the 4 required KPI cards
- Review queue appears above recommendations and evidence
- Evidence tabs switch cleanly
- Policy/config content sits below evidence
- Advanced tools render last
- Modal review actions still open and submit

Embedded app review:

- Page compiles and loads inside the embedded app route
- Layout remains scannable without giant empty panels
- Primary workflow is obvious within one screenful
- Status badges are more consistent and merchant-readable
- Upgrade state still routes merchants to billing

## Verification

- `npm run build` passed in `frontend`

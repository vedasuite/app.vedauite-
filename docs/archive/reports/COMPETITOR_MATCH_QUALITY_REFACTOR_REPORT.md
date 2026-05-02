# Competitor Match Quality Refactor Report

## Root causes

- The ingestion flow could store weak competitor rows by falling back to the merchant's own product price when live page evidence was thin.
- Competitor monitoring used almost every stored row for overview counts and tables, so low-value matches could appear after a "no comparable products found" style message.
- Draft, archived, gift-card-like, and price-missing products were not being excluded from the monitored source catalog.
- The module had no dedicated low-confidence state, so weak matches were blurred into either "no matches" or apparently valid monitoring coverage.
- The page did not explain clearly why a product was matched, excluded, or withheld from the main tables.

## Implemented solution

- Added source-product filtering so competitor monitoring now excludes:
  - archived products
  - draft products
  - gift-card-like products
  - products without usable pricing
- Tightened live competitor snapshot capture:
  - weak pages with no meaningful pricing, promotion, or stock signal are dropped
  - captured snapshots now carry confidence metadata and match reasons
- Added confidence-aware comparable-row filtering:
  - low-confidence matches are excluded from the main tracked-products table
  - duplicate rows are removed from the main comparable set
- Added a dedicated `LOW_CONFIDENCE` primary state
- Added merchant-facing explanations for:
  - why monitoring found no matches
  - why possible matches were withheld as low confidence
  - which products were excluded from monitoring and why
- Improved the action panel so merchants get direct next steps based on the current monitoring state

## Files changed

- `backend/src/services/shopifyAdminService.ts`
- `backend/src/services/competitorService.ts`
- `frontend/src/modules/CompetitorIntelligence/CompetitorPage.tsx`
- `backend/tests/competitorService.test.cjs`

## Tests added

- source-product filtering excludes archived, draft, gift-card-like, and price-missing products
- competitor state derives correctly for:
  - no domains configured
  - awaiting first run
  - low-confidence matches only
  - no matches
  - valid comparable matches with changes

## Verification

- Backend build passed
- Frontend build passed
- `node tests\\competitorService.test.cjs` passed
- existing readiness and pricing tests still passed

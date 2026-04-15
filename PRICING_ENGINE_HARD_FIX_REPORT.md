# AI Pricing Engine Hard Fix Report

## Root Causes Found

- The frontend page inferred readiness from recommendation counts instead of obeying a single canonical module state, so loading, refreshing, empty, and ready could blur together.
- Manual refresh had no bounded failure path. If the request failed during a refresh, the page could remain in a loading-looking state with no deterministic clear.
- The pricing overview route had no hard response timeout, so slow backend work could leave the frontend waiting until the client timeout.
- Backend timeouts inside pricing overview were being swallowed into fallback data, which hid timeout failures instead of surfacing a bounded failed state.
- The pricing module had no explicit handling for malformed recommendation payloads, so corrupted records could make the module unusable without a clear error state.
- Dashboard and pricing page readiness were not derived from one dedicated pricing-engine state model.

## Implemented Fix

- Added a shared backend pricing-engine state helper at `backend/src/services/pricingEngineStateService.ts`.
- The pricing engine now resolves into exactly one state:
  - `initializing`
  - `syncing_data`
  - `empty`
  - `ready`
  - `failed`
- Added backend route timeout handling in `backend/src/routes/pricingProfitRoutes.ts`.
- Added backend instrumentation and timing in `backend/src/services/pricingProfitService.ts`.
- Added malformed recommendation validation and explicit timeout reporting in `backend/src/services/pricingProfitService.ts`.
- Refactored the frontend page state machine in `frontend/src/modules/PricingProfit/PricingProfitPage.tsx` so:
  - only one primary state renders at a time
  - refresh cannot stay indefinite
  - duplicate refreshes are blocked
  - stale cache cannot override the new canonical view state
  - refresh badge/button only reflects a live in-flight request
- Added pricing-engine scenario tests in `backend/tests/pricingEngineStateService.test.cjs`.

## Files Changed

- `backend/src/services/pricingEngineStateService.ts`
- `backend/src/services/pricingProfitService.ts`
- `backend/src/routes/pricingProfitRoutes.ts`
- `backend/tests/pricingEngineStateService.test.cjs`
- `frontend/src/modules/PricingProfit/PricingProfitPage.tsx`

## Validation

- Backend build passed
- Frontend build passed
- Pricing engine state tests passed for:
  - no catalog data
  - no sales history
  - no competitor input
  - async job still processing
  - recommendations available
  - backend timeout
  - malformed recommendation payload

## Merchant-Facing Result

- The pricing page can no longer sit in an indefinite spinner.
- If pricing data is still syncing, merchants now see a bounded syncing state.
- If pricing recommendations are not ready, merchants now see a real empty state with:
  - what data was processed
  - what is missing
  - what to do next
- If pricing data fails or times out, the page now lands in a retryable failed state instead of an endless loading state.

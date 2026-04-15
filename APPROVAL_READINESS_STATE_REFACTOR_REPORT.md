# VedaSuite App State Refactor Report

## Root Causes Found

- The app shell had no canonical boot-state contract, so route entry, billing state, onboarding state, and page loaders could disagree during hydration.
- Initial HTML rendered as a near-blank page while React booted, which made install and navigation feel broken during slower loads.
- Billing, onboarding, and module gating each derived status differently, allowing contradictory copy such as inactive plans next to active entitlements.
- Route crashes were only guarded globally, so a bad module render could still break a major workflow without a route-local fallback.
- Frontend requests failed hard on transient timeouts with no retry path for safe GET requests, increasing white-screen and “stuck loading” behavior.
- Onboarding could briefly receive a summary-shaped state object instead of the full onboarding payload, creating a route decision and rendering race.
- Merchant UI still exposed internal phrasing around backend truth and confirmation semantics.

## Architecture Changes

- Added a canonical backend app-state service at `backend/src/services/appStateService.ts`.
- Added `/api/app-state` at `backend/src/routes/appStateRoutes.ts` and mounted it in `backend/src/routes/index.ts`.
- Added a frontend app-state provider at `frontend/src/providers/AppStateProvider.tsx` with cache-backed refresh and stale-request protection.
- Added `frontend/src/hooks/useAppState.ts` and mounted the provider in `frontend/src/main.tsx`.
- Updated entry routing in `frontend/src/App.tsx` so route selection now comes from canonical onboarding access state instead of page-local assumptions.
- Added `frontend/src/components/RouteErrorBoundary.tsx` and wrapped all primary app routes.
- Updated `frontend/src/layout/AppFrame.tsx` to show deterministic Polaris loading, install, connection, and billing-confirmation states instead of blank transitions.
- Improved GET request resilience in `frontend/src/lib/embeddedShopRequest.ts` with timeout-aware retry behavior.
- Replaced the blank boot screen in `frontend/index.html` with a deterministic loading shell.

## State Model

The canonical app state now resolves these concerns in one payload:

- install status
- connection status
- sync summary
- billing summary
- onboarding state
- module entitlements
- module readiness summaries

Every major screen can now anchor itself to one of these merchant-facing outcomes:

- loading
- action required
- ready with data
- empty but valid
- failed with retry

## Merchant-Facing Copy Fixes

- Removed “backend confirmation” phrasing from billing and app-shell messaging.
- Billing summary copy now speaks in merchant-safe plan language instead of internal truth-source wording.

## Files Changed

- `backend/src/routes/index.ts`
- `backend/src/routes/appStateRoutes.ts`
- `backend/src/services/appStateService.ts`
- `backend/tests/appStateService.test.cjs`
- `frontend/index.html`
- `frontend/src/App.tsx`
- `frontend/src/components/RouteErrorBoundary.tsx`
- `frontend/src/hooks/useAppState.ts`
- `frontend/src/layout/AppFrame.tsx`
- `frontend/src/lib/embeddedShopRequest.ts`
- `frontend/src/main.tsx`
- `frontend/src/modules/SubscriptionPlans/PricingPage.tsx`
- `frontend/src/providers/AppStateProvider.tsx`
- `frontend/src/providers/OnboardingProvider.tsx`

## Validation Plan

- Build backend
- Run backend smoke tests for canonical selectors
- Build frontend
- Manually verify embedded routes and billing return behavior in Shopify admin

## Remaining Manual QA

- Fresh install with no paid plan
- Reauthorization-required install
- Billing approval return to `/app/billing`
- Dashboard open before and after onboarding completion
- AI Pricing Engine with no data and with ready data
- Competitor Intelligence with configured-no-match state

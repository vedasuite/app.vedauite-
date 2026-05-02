# Readiness Engine Refactor Report

## Root causes found

- Onboarding, dashboard, and app shell were each deriving "ready" from different signals.
- Onboarding could mark the store complete from timestamps and plan confirmation even when the selected module still was not actually usable.
- Dashboard quick access was derived from module-specific heuristics that did not match onboarding or app-shell state.
- Billing entitlement, sync completion, and module output readiness were not being combined into one deterministic setup decision.
- Merchant copy was reusing technical sync states and overclaiming readiness before the selected workflow was truly available.

## What changed

- Added a canonical backend readiness engine in `backend/src/services/readinessEngineService.ts`.
- The readiness engine now computes one truth model for:
  - Shopify connection health
  - initial sync completion
  - billing readiness
  - fraud module readiness
  - competitor module readiness
  - pricing module readiness
  - setup completion and next recommended action
- Refactored onboarding to use the readiness engine for:
  - setup progress
  - step completion
  - setup summary
  - dashboard access eligibility
- Refactored dashboard to use the readiness engine for:
  - sync health summary
  - module states
  - quick access status
- Refactored app-state payload so shell/navigation consumers can read the same readiness model.

## Status model

- Quick access and onboarding now align on these merchant-facing states:
  - `Locked`
  - `Setup needed`
  - `Collecting data`
  - `Ready`
  - `Error`

## Files changed

- `backend/src/services/readinessEngineService.ts`
- `backend/src/services/storeOperationalStateService.ts`
- `backend/src/services/dashboardService.ts`
- `backend/src/services/onboardingService.ts`
- `backend/src/services/appStateService.ts`
- `frontend/src/providers/AppStateProvider.tsx`
- `frontend/src/providers/OnboardingProvider.tsx`
- `frontend/src/modules/Dashboard/DashboardPage.tsx`
- `backend/tests/readinessEngineService.test.cjs`

## QA checklist

- Build backend successfully
- Build frontend successfully
- Readiness unit tests cover:
  - locked module
  - setup needed
  - collecting data
  - error
  - ready

## Remaining risk

- Module-specific pages still own their detailed empty/partial/ready messaging, but onboarding, dashboard, quick access, and shell-level readiness now share one canonical readiness source.

# UX Approval Readiness Report

Date: 2026-04-09

## Root UX problems found

1. Billing return flow was split between page-level logic and provider refreshes, which caused repeated refresh behavior and visible plan flicker.
2. The pricing page was functional but still felt like internal billing controls instead of a clear plan-comparison experience.
3. Onboarding lived mostly as a dashboard modal plus generic banner messaging, so first-time merchants could still miss the intended first action.
4. Dashboard entry state was informative but not cohesive; first-run, syncing, limited-data, and ready states were not presented as a single guided system.
5. Frontend billing and onboarding surfaces were still too easy to let drift from backend truth if a page loaded mid-transition.

## Files changed

### Backend
- `backend/prisma/schema.prisma`
- `backend/prisma/migrations/20260409_onboarding_state/migration.sql`
- `backend/src/services/onboardingService.ts`
- `backend/src/services/dashboardService.ts`
- `backend/src/routes/dashboardRoutes.ts`

### Frontend
- `frontend/src/providers/SubscriptionProvider.tsx`
- `frontend/src/hooks/useSubscriptionPlan.ts`
- `frontend/src/layout/AppFrame.tsx`
- `frontend/src/modules/SubscriptionPlans/PricingPage.tsx`
- `frontend/src/modules/SubscriptionPlans/SubscriptionPage.tsx`
- `frontend/src/modules/Onboarding/OnboardingPage.tsx`
- `frontend/src/modules/Dashboard/DashboardPage.tsx`
- `frontend/src/components/ModuleGate.tsx`
- `frontend/src/App.tsx`

## Billing flow fixes

1. Introduced explicit billing transition states:
   - `IDLE`
   - `REDIRECTING_TO_SHOPIFY`
   - `RETURNED_FROM_SHOPIFY`
   - `CONFIRMING_BACKEND_STATE`
   - `CONFIRMED`
   - `FAILED`
2. Moved billing confirmation handling into the `SubscriptionProvider` so the app has one transition orchestrator.
3. Removed stale optimistic preservation of old paid plans.
4. Blocked unstable app rendering during billing confirmation with a full-page transition surface.
5. Added bounded backend confirmation polling against `/api/subscription/plan`.
6. Rewrote the subscription cache only after backend confirmation.
7. Disabled pricing actions while a billing transition is active.

## Pricing page improvements

1. Rebuilt the billing screen into a clearer pricing-and-billing page.
2. Added:
   - value-focused header
   - current subscription summary
   - Starter / Growth / Pro plan cards
   - Growth recommendation highlight
   - Starter module selection explanation
   - comparison matrix
   - FAQ / explanatory section
3. Preserved truthful plan CTAs from backend state and pending intent state.
4. Kept cancellation explicit and confirmed.

## Onboarding flow design

Backend now derives onboarding from real store state with stages:
- `WELCOME`
- `CONNECTION_CHECK`
- `FIRST_SYNC`
- `PLAN_SELECTION_OR_SKIP`
- `FIRST_VALUE_GUIDE`
- `COMPLETE`

The onboarding summary uses:
- connection health
- webhook registration status
- sync status
- raw and processed data presence
- billing plan
- persisted onboarding completion / dismissal

Frontend changes:
- added dedicated `/onboarding` page
- added step-by-step guided setup
- added contextual primary action based on current backend state
- added completion and dismissal persistence
- added “How VedaSuite works” explanation for first-time merchants

## Dashboard entry logic changes

1. Replaced the old top onboarding banner + modal entry with a backend-driven hero section.
2. Dashboard now surfaces:
   - current stage title
   - honest description
   - next recommended action
   - current plan
   - explanation of why some insights may still be limited
3. Added setup progress card driven by backend onboarding steps.
4. Kept existing sync/readiness truth intact and aligned the entry messaging to it.

## Remaining risks

1. Existing stores with older data may need one deploy cycle plus Prisma migration before onboarding persistence fields are available everywhere.
2. The dashboard still contains a lot of rich content, so future cleanup could further reduce visual density for first-time merchants.
3. No dedicated automated tests were added yet for the new onboarding routes in this pass, so runtime verification remains important after deploy.

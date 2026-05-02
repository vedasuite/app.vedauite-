# Billing System Rebuild Report

## Root Causes

- Billing truth was split across `resolveBillingState`, `getCurrentSubscription`, billing-management payloads, and frontend cache normalization.
- Lifecycle state and access state were conflated, which made cancelled subscriptions, pending approvals, and no-plan installs render contradictory UI.
- Frontend screens were still willing to render cached subscription data while backend confirmation was unresolved.
- Several merchant surfaces were reading plan/module access from different payload shapes, so billing page, sidebar badges, onboarding, and gates could drift.
- Merchant UI still exposed internal language instead of a canonical merchant-safe billing state.

## Implemented Solution

- Introduced a canonical billing lifecycle model in `backend/src/services/subscriptionService.ts`:
  - `no_subscription`
  - `pending_approval`
  - `active`
  - `cancelled`
  - `frozen`
  - `test_charge`
  - `uninstalled`
  - `unknown_error`
- Added a canonical entitlement model in the same service with:
  - plan tier
  - verified/access-active flags
  - module access
  - feature access
  - starter module handling
- Rebuilt `resolveBillingState()` so it now distinguishes:
  - billing lifecycle
  - current access-active state
  - date visibility
  - pending approval intent
  - merchant-safe title/description
- Rebuilt `getCurrentSubscription()` so module gating is derived from canonical entitlements instead of partial billing assumptions.
- Refactored `/api/subscription/plan` to return:
  - canonical subscription snapshot
  - canonical billing state
  - canonical entitlements
- Updated app-state and diagnostics routes to use the canonical lifecycle and merchant-safe summaries.
- Updated frontend subscription provider to store:
  - `subscription`
  - `billingState`
  - `entitlements`
- Updated billing page, app shell, onboarding summary, and module gate copy/logic to use canonical lifecycle and access-active semantics.

## Files Changed

- `backend/src/services/subscriptionService.ts`
- `backend/src/services/billingManagementService.ts`
- `backend/src/services/appStateService.ts`
- `backend/src/services/onboardingService.ts`
- `backend/src/routes/subscriptionRoutes.ts`
- `backend/src/routes/shopifyRoutes.ts`
- `backend/tests/billingLifecycle.test.cjs`
- `frontend/src/lib/billingCapabilities.ts`
- `frontend/src/hooks/useSubscriptionPlan.ts`
- `frontend/src/providers/SubscriptionProvider.tsx`
- `frontend/src/layout/AppFrame.tsx`
- `frontend/src/components/ModuleGate.tsx`
- `frontend/src/modules/SubscriptionPlans/PricingPage.tsx`

## Notes On Behavior

- Pending approval is now a first-class lifecycle instead of being inferred from stale page state.
- Cancelled billing can still preserve access when Shopify keeps the subscription active until the period end.
- Renewal and trial dates are only surfaced when the canonical resolver marks them valid to show.
- Sidebar upgrade badges and module access now derive from the same entitlement model as the billing page.

## Validation

- Backend build passes
- Frontend build passes
- Canonical lifecycle unit tests cover:
  - install with no plan
  - starter active
  - growth active
  - pro active
  - cancelled
  - billing approval pending
  - uninstalled
  - frozen
  - test charge

## Remaining Manual QA

- Fresh install with no subscription in embedded Shopify admin
- Paid-plan approval redirect back to `/app/billing`
- Failed billing approval return
- Cancelled subscription with end-of-period access
- Starter module switch flow
- Plan change followed by module entitlement refresh on dashboard and gated routes

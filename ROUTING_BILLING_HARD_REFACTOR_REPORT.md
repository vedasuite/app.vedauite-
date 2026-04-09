# VedaSuite Route, Onboarding, And Billing Hard Refactor Report

## Root causes found

### 1. Dashboard route ownership was still tied to onboarding state

- `frontend/src/App.tsx` used a `DashboardRoute` wrapper that redirected `/app/dashboard` back to onboarding whenever `onboarding.canAccessDashboard` was false.
- That meant the router did not truly own the dashboard page. The route could resolve to `/app/dashboard` while page intent still depended on onboarding state.
- This was the core reason the dashboard path could feel like it was rendering onboarding instead of a dedicated dashboard experience.

### 2. Billing confirmation was relying too heavily on one frontend polling path

- `frontend/src/providers/SubscriptionProvider.tsx` was re-reading cached subscription state from module cache on every render and using that value in the effect dependency chain.
- That created unstable refresh behavior and increased the chance of repeated billing confirmation cycles.
- The provider also did not explicitly use the backend confirmation endpoint when Shopify returned from billing approval, so the frontend could stay in confirmation mode longer than necessary.
- On failure, billing-return query params were being cleared too early, which made retry behavior brittle.

### 3. Onboarding module cards looked actionable but were not explicit

- The onboarding module section used `vs-action-card` styling that looked interactive but did not provide a real action button.
- This created the exact dead-control ambiguity the user reported.

### 4. The black gradient patch was global layout decoration, not purposeful UI

- `frontend/src/layout/app-frame.css` had a `.vs-content::before` gradient block injected above every page.
- On onboarding this rendered as a large empty dark block with no setup purpose.

### 5. Onboarding page still carried too much product-surface weight

- Even after earlier cleanup, onboarding still needed clearer setup-only ownership and more explicit separation from operational module surfaces.

## Exact route bugs fixed

- Removed route-level redirect ownership from `/app/dashboard`.
  - File: `frontend/src/App.tsx`
  - Before: `/app/dashboard` mounted a guard wrapper that redirected to onboarding.
  - After: `/app/dashboard` mounts `DashboardPage` directly.

- Preserved onboarding guidance without hijacking route rendering.
  - File: `frontend/src/modules/Dashboard/DashboardPage.tsx`
  - Added a setup banner when onboarding is incomplete, instead of redirecting the route away from the dashboard component.

- Preserved canonical route-first rendering for:
  - `/app/onboarding`
  - `/app/dashboard`
  - `/app/fraud-intelligence`
  - `/app/competitor-intelligence`
  - `/app/ai-pricing-engine`
  - `/app/billing`
  - `/app/settings`

## Exact billing bugs fixed

- Stabilized subscription provider initialization.
  - File: `frontend/src/providers/SubscriptionProvider.tsx`
  - Changed cached subscription bootstrapping to use a stable initial value instead of re-reading cache every render.

- Added explicit backend billing return confirmation.
  - File: `frontend/src/providers/SubscriptionProvider.tsx`
  - The provider now calls `/api/billing/confirm-return` when Shopify returns with a confirmed billing result and an intent id.

- Rebuilt billing confirmation flow as a bounded state machine using backend-confirmed truth.
  - States preserved:
    - `IDLE`
    - `REDIRECTING_TO_SHOPIFY`
    - `RETURNED_FROM_SHOPIFY`
    - `CONFIRMING_BACKEND_STATE`
    - `CONFIRMED`
    - `FAILED`

- Fixed retry behavior.
  - Failed confirmed-billing attempts no longer wipe the billing return context immediately.
  - Added retry action support on the billing page.

- Preserved correct billing return paths.
  - Existing `/app/billing` return flow remains the canonical destination.

## Components removed or behavior replaced

- Removed the empty top decorative gradient patch from:
  - `frontend/src/layout/app-frame.css`
  - Specifically removed `.vs-content::before`

- Replaced dashboard route guard rendering with route-first component mounting:
  - `frontend/src/App.tsx`

- Replaced ambiguous onboarding module cards with explicit actions:
  - `frontend/src/modules/Onboarding/OnboardingPage.tsx`
  - Each module card now has a real CTA:
    - `Open module page`
    - or `Manage plan` when locked

## Navigation logic changes

- Sidebar active state continues to come from actual pathname.
  - File: `frontend/src/layout/AppFrame.tsx`

- Primary navigation remains:
  - Onboarding
  - Dashboard
  - Fraud Intelligence
  - Competitor Intelligence
  - AI Pricing Engine
  - Billing
  - Settings

- No local selected-tab state is used to fake primary route selection.

## Onboarding interaction changes

- The onboarding page remains setup-only.
- Module cards are no longer ambiguous.
- The page no longer contains the decorative dark header block.
- Dashboard access is no longer implemented by redirecting the dashboard route away from itself.
- Billing summary stays lightweight and points to billing rather than embedding management UI.

## QA checklist

### Route-by-route expectations

1. `/app/onboarding`
   - Shows onboarding page only
   - No top dark gradient block
   - Module cards have working explicit actions

2. `/app/dashboard`
   - Shows dashboard page component directly
   - Does not route-switch back to onboarding component
   - If onboarding is incomplete, shows a dashboard banner rather than route hijacking

3. `/app/fraud-intelligence`
   - Shows fraud-focused page only

4. `/app/competitor-intelligence`
   - Shows competitor-focused page only

5. `/app/ai-pricing-engine`
   - Shows pricing-focused page only

6. `/app/billing`
   - Shows billing page only
   - Confirmation failure now shows recoverable UI

7. `/app/settings`
   - Shows settings page only

### Billing flow checks

1. Start a plan change from billing.
2. Approve in Shopify.
3. Return to app.
4. Confirm app shows billing confirmation state.
5. Confirm it transitions out of confirmation once backend truth settles.
6. If confirmation fails, confirm retry action appears.

### Onboarding interaction checks

1. Open onboarding.
2. Click each module card CTA.
3. Confirm navigation goes to:
   - `/app/fraud-intelligence`
   - `/app/competitor-intelligence`
   - `/app/ai-pricing-engine`

## Test results completed locally

- Frontend production build passed.
- Backend TypeScript build passed.

## Remaining risks or blockers

- Final billing verification still requires a live Shopify approval round-trip in production or a billing-enabled dev store because the confirmation flow depends on Shopify returning with real approval state.
- If a store is intentionally not ready, the dashboard will now render its own guarded state instead of redirecting away, which is the intended route-first behavior for this refactor.

# VedaSuite Navigation And Page Architecture Refactor

## Old structure problems found

- The onboarding page had become a mixed-purpose surface that combined setup guidance, dashboard-style summaries, module previews, billing visibility, and operational content.
- The app used multiple route conventions at the same time:
  - `/dashboard`
  - `/onboarding`
  - `/modules/*`
  - `/subscription`
- Sidebar navigation did not match the intended app information architecture and hid or regrouped first-class workflows inconsistently.
- Backend-issued routes from onboarding and dashboard services still pointed to older module and billing paths, which increased the chance of route drift and dead-end navigation.
- Dashboard and onboarding ownership were blurred, making the app feel less reviewer-safe and less like a focused Shopify embedded product.

## Routes created and updated

Primary embedded routes now enforced:

- `/app/onboarding`
- `/app/dashboard`
- `/app/fraud-intelligence`
- `/app/competitor-intelligence`
- `/app/ai-pricing-engine`
- `/app/billing`
- `/app/settings`

Legacy routes are still redirected to the new paths for stability:

- `/onboarding` -> `/app/onboarding`
- `/dashboard` -> `/app/dashboard`
- `/modules/fraud` -> `/app/fraud-intelligence`
- `/modules/competitor` -> `/app/competitor-intelligence`
- `/modules/pricing` -> `/app/ai-pricing-engine`
- `/subscription` -> `/app/billing`
- `/settings` -> `/app/settings`

## Components moved and responsibilities clarified

### Onboarding

- `frontend/src/modules/Onboarding/OnboardingPage.tsx`
  - Rebuilt as a setup-only page.
  - Keeps onboarding-specific sections only:
    - hero
    - setup checklist
    - module explanation
    - module selection
    - setup health
    - permissions
    - short billing summary
    - data requirements
  - Removes dashboard-style KPIs, recent insight feeds, and embedded module dashboards.

### Dashboard

- `frontend/src/modules/Dashboard/DashboardPage.tsx`
  - Re-centered as the operational home.
  - Owns:
    - KPI cards
    - sync/readiness summary
    - recent real insights
    - quick access into modules
  - No longer embeds onboarding flow content.

### Navigation and layout

- `frontend/src/layout/AppFrame.tsx`
  - Sidebar now matches the required primary order:
    - Onboarding
    - Dashboard
    - Fraud Intelligence
    - Competitor Intelligence
    - AI Pricing Engine
    - Billing
    - Settings
  - Removed mixed navigation logic that changed primary structure based on onboarding completion.

### App routing

- `frontend/src/App.tsx`
  - Uses `/app/...` as canonical route structure.
  - Keeps direct-entry handling and dashboard gating separate from page composition.
  - Keeps legacy route redirects without using them as the app’s primary information architecture.

## Backend route and state changes

- `backend/src/app.ts`
  - Updated embedded route allowlist to serve the new `/app/...` routes directly in production.

- `backend/src/services/onboardingService.ts`
  - Updated onboarding-issued routes to point to canonical page boundaries:
    - `/app/onboarding`
    - `/app/dashboard`
    - `/app/fraud-intelligence`
    - `/app/competitor-intelligence`
    - `/app/ai-pricing-engine`
    - `/app/billing`
  - Preserves onboarding progress logic but stops leaking old route structure back into the frontend.

- `backend/src/services/dashboardService.ts`
  - Updated recent insight deep links to the new module routes.

- `backend/src/routes/billingRoutes.ts`
- `backend/src/services/billingManagementService.ts`
  - Updated billing return paths and fallback paths to `/app/billing`.

## Billing logic preserved and adjusted

- Existing billing truth resolution and Shopify billing flow were preserved.
- The refactor did not replace the subscription source of truth.
- Billing UI now stays isolated on `/app/billing`.
- Billing redirects and return paths now align with the new primary route structure instead of `/subscription`.

## Navigation changes made

- Primary sidebar order is now fixed and reviewer-friendly.
- All three major modules are first-class navigation items.
- Billing and Settings stay isolated from onboarding.
- Dashboard is now the clean operational home rather than a mixed setup surface.

## Assumptions

- Legacy routes should continue to work as redirects during transition so old links and stored paths do not break immediately.
- Reports can remain in the codebase for now, but it is no longer treated as a required primary sidebar destination for this architecture.
- Existing billing and sync APIs remain the canonical backend truth and should not be reworked further during this navigation refactor.

## Manual QA checklist

1. Open the embedded app at `/`.
   - Confirm unfinished stores go to `/app/onboarding`.
   - Confirm completed stores go to `/app/dashboard`.

2. Open each primary route directly:
   - `/app/onboarding`
   - `/app/dashboard`
   - `/app/fraud-intelligence`
   - `/app/competitor-intelligence`
   - `/app/ai-pricing-engine`
   - `/app/billing`
   - `/app/settings`

3. Confirm the sidebar shows exactly:
   - Onboarding
   - Dashboard
   - Fraud Intelligence
   - Competitor Intelligence
   - AI Pricing Engine
   - Billing
   - Settings

4. Confirm onboarding contains only setup-focused sections.
   - No KPI dashboard cards
   - No recent real insights feed
   - No embedded operational module widgets

5. Confirm dashboard contains:
   - KPI cards
   - sync/readiness status
   - recent insight highlights
   - quick links to the three module pages

6. Confirm module buttons and quick actions land on:
   - `/app/fraud-intelligence`
   - `/app/competitor-intelligence`
   - `/app/ai-pricing-engine`

7. Confirm billing actions still return to `/app/billing`.

8. Confirm legacy links redirect correctly:
   - `/subscription`
   - `/dashboard`
   - `/onboarding`
   - `/modules/fraud`
   - `/modules/competitor`
   - `/modules/pricing`

9. Confirm browser refresh works on each `/app/...` route without `Cannot GET`.

10. Confirm frontend and backend builds stay green after deployment.

## Remaining blockers or follow-up items

- The Prisma client in the local environment was not regenerated during this session because the local Prisma engine file was locked. The code was kept build-safe locally, but Render should still run `prisma generate` and the migration normally during deployment.
- Some older non-primary pages and components still exist in the repository, but they are no longer part of the main app information architecture for this flow.

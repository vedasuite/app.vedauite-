# Approval Readiness Fix Report

Final verification timestamp: `2026-05-02T18:54:15.0043902+05:30`

## Active app source of truth

- Active Shopify app codebase: `app-repo/`
- Production Shopify config source: `app-repo/shopify.app.toml`
- Archived historical patch reports: `app-repo/docs/archive/reports/`
- Archived outer legacy duplicate app tree: `docs/archive/legacy-root-app/`

## Root causes found

1. Billing, onboarding, dashboard, and module pages were still deriving readiness and access from overlapping state models.
2. Starter access used mixed internal names like `trustAbuse` and `pricingProfit`, which created plan/gating drift across backend, frontend, and onboarding.
3. Dashboard KPI values were still calculated independently from module-page data, which caused visible contradictions.
4. AI Pricing Engine could show gain numbers when live profit data was not actually ready.
5. Fraud review UI still leaked internal fallback order identifiers and could show queue counts that did not align with the review summary.
6. Competitor monitoring still allowed preview-only connector data to appear like live monitoring data.
7. Onboarding and dashboard could imply different readiness states for the same store.
8. Prisma verification/deploy safety still needed explicit production-safe validation rather than unsafe `db push` assumptions.

## Structural fixes applied

### Canonical readiness and access

- Added `backend/src/services/storeReadinessService.ts` as the backend readiness summary used to normalize:
  - billing plan and enabled modules
  - onboarding completion and remaining steps
  - raw data presence
  - module readiness flags
  - sample mode state
- Extended `backend/src/services/appStateService.ts` so bootstrap/app-shell consumers now receive:
  - canonical fraud / competitor / pricing / profit entitlements
  - canonical `storeReadiness`

### Starter plan and feature-key stabilization

- Standardized Starter module normalization to canonical values:
  - `fraud`
  - `competitor`
- Preserved legacy compatibility by still accepting old persisted values like `trustAbuse`.
- Hardened this in:
  - `backend/src/billing/capabilities.ts`
  - `frontend/src/lib/billingCapabilities.ts`
  - `backend/src/services/subscriptionService.ts`
  - `backend/src/routes/subscriptionRoutes.ts`
- Frontend gating and navigation now prefer canonical module keys instead of mixed aliases.

### Server-side feature gating

- Kept backend route protection authoritative through `backend/src/middleware/requireFeature.ts`.
- Confirmed competitor routes continue to use `requireFeature("competitor")`.
- Verified Starter gating with regression coverage for:
  - Starter fraud only
  - Starter competitor only

### Billing refresh and reconciliation

- `backend/src/services/billingManagementService.ts` now forces billing reconciliation through `reconcileBillingState(shop)` before returning billing management state and after billing confirmation/cancellation paths.
- This removes stale post-approval and post-cancel billing drift between local DB state and Shopify-backed truth.

### Dashboard and module consistency

- Refactored `backend/src/services/dashboardService.ts` so dashboard counts now come from module-backed services instead of separate raw count logic:
  - fraud count from `getTrustAbuseOverview`
  - competitor changes from `getCompetitorOverview`
  - pricing count from `getPricingProfitOverview`
  - profit count from `getPricingProfitOverview`
- This removes the earlier contradiction where dashboard and module pages showed different pricing/profit counts.

### AI Pricing Engine truthfulness

- Refactored `backend/src/services/pricingProfitService.ts` so projected gain is only exposed when real profit-ready data exists.
- When profit data is missing, projected gain is suppressed instead of showing inflated or directional values as if they were confirmed.
- Updated `frontend/src/modules/PricingProfit/PricingProfitPage.tsx` to render:
  - `Not enough data yet`
  instead of a misleading projected gain number.

### Fraud merchant-safety fixes

- Refactored `backend/src/services/trustAbuseService.ts` so the fraud queue:
  - only includes action-needed orders
  - aligns manual-review summary with the visible queue
  - never shows internal fallback IDs like `vedasuite-ai.myshopify.com-order-1002`
- Refactored `backend/src/services/fraudService.ts` so chargeback/queue order labels also use merchant-safe order naming.
- Merchant fallback label is now:
  - `Order pending sync`

### Competitor monitoring truthfulness

- Refactored `backend/src/services/competitorService.ts` so only live website competitor sources are treated as production monitoring data.
- Preview-only sources like Google Shopping and Meta preview rows no longer appear as if live connectors are active.
- This aligns connector cards with the actual tracked data shown in the module.

### Onboarding and app-shell consistency

- Refactored onboarding module keys to canonical values in:
  - `backend/src/services/onboardingService.ts`
  - `frontend/src/providers/OnboardingProvider.tsx`
  - `frontend/src/modules/Onboarding/OnboardingPage.tsx`
  - `frontend/src/App.tsx`
- Updated dashboard preview messaging so onboarding-incomplete stores are clearly shown as preview state instead of implicitly looking fully complete.
- Navigation badges in `frontend/src/layout/AppFrame.tsx` now derive from canonical backend-enabled modules.

## Files changed in this stabilization pass

### Backend

- `backend/src/billing/capabilities.ts`
- `backend/src/routes/subscriptionRoutes.ts`
- `backend/src/services/appStateService.ts`
- `backend/src/services/billingManagementService.ts`
- `backend/src/services/competitorService.ts`
- `backend/src/services/dashboardService.ts`
- `backend/src/services/fraudService.ts`
- `backend/src/services/onboardingService.ts`
- `backend/src/services/pricingProfitService.ts`
- `backend/src/services/profitService.ts`
- `backend/src/services/readinessEngineService.ts`
- `backend/src/services/storeReadinessService.ts`
- `backend/src/services/subscriptionService.ts`
- `backend/src/services/trustAbuseService.ts`

### Frontend

- `frontend/src/App.tsx`
- `frontend/src/components/ModuleGate.tsx`
- `frontend/src/layout/AppFrame.tsx`
- `frontend/src/lib/billingCapabilities.ts`
- `frontend/src/modules/Dashboard/DashboardPage.tsx`
- `frontend/src/modules/Onboarding/OnboardingPage.tsx`
- `frontend/src/modules/PricingProfit/PricingProfitPage.tsx`
- `frontend/src/modules/Settings/SettingsPage.tsx`
- `frontend/src/modules/SubscriptionPlans/PricingPage.tsx`
- `frontend/src/modules/TrustAbuse/TrustAbusePage.tsx`
- `frontend/src/providers/AppStateProvider.tsx`
- `frontend/src/providers/OnboardingProvider.tsx`

### Tests

- `backend/tests/billing-capabilities.test.cjs`
- `backend/tests/dashboardConsistency.test.cjs`
- `backend/tests/pricingProfitOverview.test.cjs`
- `backend/tests/trustAbuseOverview.test.cjs`

## Verification run

Verification window:

- Started: `2026-05-02T18:54:15.0043902+05:30`
- Completed: `2026-05-02T18:54:15.0043902+05:30`

Command results summary:

### Backend

1. `npm.cmd run build`
   - PASS
   - Summary: `tsc -p tsconfig.json` completed successfully.

2. `$env:DATABASE_URL='postgresql://postgres:postgres@localhost:5432/vedasuite'; .\\node_modules\\.bin\\prisma.cmd validate`
   - PASS
   - Summary: `The schema at prisma/schema.prisma is valid`

3. `$env:DATABASE_URL='postgresql://postgres:postgres@localhost:5432/vedasuite'; .\\node_modules\\.bin\\prisma.cmd generate`
   - PASS
   - Summary: `Generated Prisma Client (v5.22.0)`
   - Note: this required running outside the sandbox because Prisma client generation hit `spawn EPERM` inside the sandbox.

4. `node tests\\billing-capabilities.test.cjs`
   - PASS
   - Summary: `3 tests passed, 0 failed`

5. `node tests\\feature-gating.test.cjs`
   - PASS
   - Summary: `4 tests passed, 0 failed`

6. `node tests\\dashboardConsistency.test.cjs`
   - PASS
   - Summary: dashboard KPI counts now follow module-backed overviews.

7. `node tests\\pricingProfitOverview.test.cjs`
   - PASS
   - Summary: projected gain is suppressed when real profit data is not ready.

8. `node tests\\trustAbuseOverview.test.cjs`
   - PASS
   - Summary: fraud queue no longer exposes internal fallback order IDs.

9. `node tests\\competitorService.test.cjs`
   - PASS
   - Summary: competitor setup/no-match/change state derivation remains correct.

10. `node tests\\pricingEngineStateService.test.cjs`
    - PASS
    - Summary: pricing engine empty/processing/timeout/error/ready states remain deterministic.

11. `node tests\\readinessEngineService.test.cjs`
    - PASS
    - Summary: readiness engine still enforces locked/setup/collecting/ready/error correctly.

12. `node tests\\appStateService.test.cjs`
    - PASS
    - Summary: install and connection state derivation remains stable.

13. `node tests\\bootstrapService.test.cjs`
    - PASS
    - Summary: bootstrap service does not seed demo subscriptions or fake merchant data.

14. `node tests\\billingLifecycle.test.cjs`
    - PASS
    - Summary: canonical billing lifecycle and entitlement reconciliation paths remain correct.

### Frontend

1. `npm.cmd run build`
   - PASS
   - Summary: Vite production build completed successfully.

## Production scope review

Current production scopes in `shopify.app.toml`:

- `read_products`
- `read_orders`
- `write_orders`
- `read_customers`
- `write_own_subscription`

Assessment:

- `write_orders` is still justified because live fraud actions can tag/update Shopify orders when a valid Shopify order identity exists.
- `write_own_subscription` is required for live Shopify app subscription management.
- `write_products` is intentionally not requested because direct Shopify price publishing remains disabled in the current approval-safe flow.

## Remaining blockers

1. Live manual dev-store QA is still required before marking the app submission-ready:
   - install flow
   - embedded reopen / reconnect flow
   - Starter fraud selection
   - Starter competitor selection
   - billing approval return
   - uninstall webhook cleanup
   - privacy webhooks
2. There is still no full browser-automated UI regression suite for blank-screen detection, so final confidence on zero-white-screen behavior still depends on manual embedded-store QA.

## Final readiness call

Ready for Shopify submission right now: **NO**

Reason:

- The codebase now passes local build, Prisma, and the new regression checks for Starter gating, dashboard/module consistency, pricing no-data behavior, fraud order labeling, and competitor state derivation.
- The remaining blocker is live Shopify manual QA, not unresolved local code contradictions.

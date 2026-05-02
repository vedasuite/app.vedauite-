# Approval Readiness Fix Report

## Active app source of truth

- Active Shopify app codebase: `app-repo/`
- Archived historical patch reports: `docs/archive/reports/`
- Production Shopify config source: `shopify.app.toml`
- Archived outer legacy duplicate app tree: `../docs/archive/legacy-root-app/`

## Root causes found

1. Billing and entitlement truth was split across frontend mirrors, route-level capability checks, and stale UI assumptions.
2. Module access was not enforced consistently on the server for fraud, competitor, pricing, reports, credit score, and profit routes.
3. Trial and Starter capability behavior was too permissive and could imply paid access that was not truly earned.
4. Competitor monitoring copy mixed freshness, no-match, and setup states, which created reviewer-visible contradictions.
5. Fraud action flows still exposed backend-flavored Shopify sync language to merchants.
6. Order identity storage was incomplete, which made Shopify tagging brittle for partially synced orders.
7. Onboarding could still expose sample-preview insights even when production sample mode was not explicitly enabled.
8. Dashboard access still depended on report gating, which could block the app home experience for stores that should still see setup and readiness.
9. Repo surface quality was poor because many interim report files remained at the top level and made the codebase look patch-driven.

## Structural fixes applied

### Repo cleanup

- Archived historical markdown fix reports into `docs/archive/reports/`.
- Archived the outer legacy duplicate root app tree (`frontend/`, `backend/`, and old `shopify.app.toml`) into `../docs/archive/legacy-root-app/` so deploy/build paths no longer compete with the real app.
- Rewrote `README.md` so the active app structure, production scopes, and approval docs point to the real source of truth.

### Billing and entitlement

- Hardened backend plan capability mapping in `backend/src/billing/capabilities.ts`.
- Matched the same capability model in `frontend/src/lib/billingCapabilities.ts`.
- `TRIAL` is now preview-only.
- `STARTER` now unlocks exactly one module path: fraud or competitor.
- `GROWTH` unlocks fraud, competitor, pricing, reports, and credit-score workflows.
- `PRO` remains the only tier with full profit optimization access.
- Added `reconcileBillingState(shop)` in `backend/src/services/subscriptionService.ts` so billing state, subscription payload, and entitlements can be refreshed from one backend call path.
- Updated `shopify.app.toml` production scopes to include `write_own_subscription` because live billing uses Shopify app subscriptions.

### Server-side feature gating

- Added `backend/src/middleware/requireFeature.ts`.
- Migrated protected routes to explicit feature gates:
  - fraud
  - competitor
  - pricing
  - credit score
  - profit optimization
  - reports
- Locked responses now return merchant-safe `FEATURE_LOCKED` JSON with required plan and upgrade path.

### Dashboard and readiness consistency

- Removed `reports.view` gating from dashboard metrics and decision-center routes so the app home can still render setup/readiness states without false plan blockage.
- Kept backend readiness as the source of truth for dashboard and onboarding consumers.
- Added a deterministic dashboard regression test to verify pricing/profit/dashboard KPI consistency from persisted backend data.

### Sample/demo data controls

- Added `ENABLE_SAMPLE_DATA` config flag in `backend/src/config/env.ts`.
- Onboarding sample insights now render only when sample mode is explicitly enabled.
- Competitor UI no longer defaults to fake `.example` domains.
- Demo bootstrap remains non-seeding and only logs that sample seeding is intentionally ignored.

### Fraud action safety

- Added richer Shopify order identity handling in Prisma schema and sync writes:
  - `shopifyOrderGid`
  - `shopifyLegacyOrderId`
  - `orderName`
- Fraud actions now:
  - update local VedaSuite status
  - attempt Shopify tagging only when a valid Shopify identity exists
  - return merchant-safe fallback copy instead of technical sync errors
- Merchant message now says:
  - `Review status saved in VedaSuite. Shopify tagging will be available after the order is fully synced.`

### Competitor consistency

- Competitor freshness labeling now uses merchant-readable time descriptions instead of raw extreme hour counts.
- Stale-state failure copy now reuses the same normalized freshness helper instead of exposing raw ingestion phrasing.

### Merchant-safe request handling

- Added merchant-safe response interception in:
  - `frontend/src/api/client.ts`
  - `frontend/src/lib/embeddedShopRequest.ts`
- Normalized handling for:
  - `401` reauthorize required
  - `403` feature locked
  - `500+` server errors with request ID support

## Files changed

### Backend

- `backend/prisma/schema.prisma`
- `backend/prisma/migrations/20260502_order_identity_fields/migration.sql`
- `backend/src/billing/capabilities.ts`
- `backend/src/config/env.ts`
- `backend/src/middleware/requireFeature.ts`
- `backend/src/routes/competitorRoutes.ts`
- `backend/src/routes/creditScoreRoutes.ts`
- `backend/src/routes/dashboardRoutes.ts`
- `backend/src/routes/fraudRoutes.ts`
- `backend/src/routes/pricingProfitRoutes.ts`
- `backend/src/routes/pricingRoutes.ts`
- `backend/src/routes/profitRoutes.ts`
- `backend/src/routes/reportsRoutes.ts`
- `backend/src/routes/trustAbuseRoutes.ts`
- `backend/src/services/competitorService.ts`
- `backend/src/services/fraudService.ts`
- `backend/src/services/onboardingService.ts`
- `backend/src/services/shopifyAdminService.ts`
- `backend/src/services/subscriptionService.ts`
- `backend/tests/bootstrapService.test.cjs`
- `backend/tests/feature-gating.test.cjs`

### Frontend

- `frontend/src/api/client.ts`
- `frontend/src/lib/billingCapabilities.ts`
- `frontend/src/lib/embeddedShopRequest.ts`
- `frontend/src/modules/CompetitorIntelligence/CompetitorPage.tsx`
- `frontend/src/modules/FraudIntelligence/FraudPage.tsx`
- `frontend/src/modules/TrustAbuse/TrustAbusePage.tsx`

### Repo/docs

- `README.md`
- `docs/archive/reports/*`

## Tests and validation run

Verification window:

- Backend sequence started: `2026-05-02T10:31:06.3713084+05:30`
- Frontend sequence started: `2026-05-02T10:31:50.0832289+05:30`
- Final verification timestamp: `2026-05-02T10:32:43.9895761+05:30`

Command results:

1. `cd app-repo/backend`
   - Result: passed
2. `npm install`
   - Result: passed after elevated rerun
   - Output summary: `up to date, audited 205 packages in 2s`
   - Note: `5 vulnerabilities (3 moderate, 2 high)` reported by npm audit output, not blocking build/test completion.
3. `npx prisma generate`
   - Result: passed after elevated rerun
   - Output summary: `Generated Prisma Client (v5.22.0)`
4. `npx prisma validate`
   - Result: passed
   - Output summary: `The schema at prisma/schema.prisma is valid`
5. `npm run build`
   - Result: passed
   - Output summary: `tsc -p tsconfig.json` completed successfully
6. `node tests/feature-gating.test.cjs`
   - Result: passed
   - Output summary: `4 tests passed, 0 failed`
7. `node tests/bootstrapService.test.cjs`
   - Result: passed
   - Output summary: `1 test passed, 0 failed`
8. Additional backend verification: `node tests/dashboardConsistency.test.cjs`
   - Result: passed
   - Output summary: dashboard pricing/profit KPI consistency verified against persisted counts
9. Additional backend verification: `node tests/billingLifecycle.test.cjs`
   - Result: passed
   - Output summary: `9 tests passed, 0 failed`
10. Additional backend verification: `node tests/pricingEngineStateService.test.cjs`
    - Result: passed
    - Output summary: `7 tests passed, 0 failed`
11. Additional backend verification: `node tests/readinessEngineService.test.cjs`
    - Result: passed
    - Output summary: `5 tests passed, 0 failed`
12. `cd ../frontend`
    - Result: passed
13. `npm install`
    - Result: passed after elevated rerun
    - Output summary: `up to date, audited 72 packages in 2s`
    - Note: `5 moderate severity vulnerabilities` reported by npm audit output.
14. `npm run build`
    - Result: passed
    - Output summary: Vite production build completed successfully in `21.20s`

## Remaining risks

1. Local verification is complete, but live Shopify reviewer-path checks still require manual validation in a real dev or staging store:
   - install flow
   - OAuth reconnect
   - billing approval return
   - uninstall webhook cleanup
   - privacy webhook processing
2. npm audit still reports dependency vulnerabilities in backend and frontend trees; these are ecosystem-level package issues and were not remediated in this pass because they need a controlled dependency upgrade review.
3. Production scope minimization is now aligned with the current live code path, but if direct Shopify product price publishing is re-enabled later, `write_products` must be added back intentionally and re-reviewed.

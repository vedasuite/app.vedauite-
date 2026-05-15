# Approval Readiness Fix Report

Final verification timestamp: `2026-05-13T00:00:00+05:30`

Latest approval hardening timestamp: `2026-05-15T00:00:00+05:30`

## 2026-05-15 reviewer-risk wording and claim alignment

- Removed reviewer-risk “unfinished feature” wording from live app surfaces and launch/submission docs.
- Replaced onboarding training language with guided setup wording.
- Replaced broad shared-fraud-network wording with anonymized fraud pattern insights.
- Reframed pricing outputs as AI-generated or baseline recommendations based on current catalog and store activity.
- Updated plan copy to the production-ready Starter, Growth, and Pro positioning.
- Updated reviewer walkthroughs to use real public competitor domains: `gymshark.com` and `allbirds.com`.
- Limited review/listing guidance to claims reviewers can verify quickly: competitor pricing analysis, refund risk analysis, customer risk insights, and AI-generated pricing suggestions.
- Verification passed: backend build, frontend production build, reviewer-risk wording scan, and targeted regressions for bootstrap, billing capabilities, competitor service, pricing/profit overview, and readiness engine.

## 2026-05-13 final merchant experience polish

This pass is intentionally limited to wording, merchant-facing copy, empty states, dashboard simplification, and Shopify approval polish. It does not rewrite backend architecture, billing logic, database models, or entitlement systems.

### Merchant-facing improvements

- Replaced system/debug wording such as pending sync, setup incomplete, stale monitoring, processing, entitlement, capability, and webhook language where it could appear in merchant UI.
- Dashboard Recent Insights now favors real actionable events and calm empty/healthy messages instead of synthetic-looking alert noise.
- Fraud and Trust Abuse empty states now communicate that no high-risk orders are currently detected instead of implying missing data.
- Competitor Intelligence now uses competitor websites and competitor analysis language, with success copy such as `Competitor analysis completed. No matching products were identified yet.`
- Pricing and profit copy now frames limited outputs as baseline recommendations and avoids exaggerated certainty for early catalog data.
- Billing copy now emphasizes `Current plan`, `Included features`, `Upgrade`, `Downgrade`, `Active subscription`, and Shopify approval without developer/test wording.
- Reports, onboarding, settings, and app readiness copy now use connected/ready/available/insights language instead of sync/module/system language.

### Verification note

- Required frontend search was run for: `pending sync`, `setup incomplete`, `stale`, `entitlement`, `capability`, `monitoring`, `initialized`, and `processing`.
- Remaining frontend hits are internal identifiers/status enum handling such as `entitlements`, `processingSummary`, and `stale`/`processing` status branches, not merchant-facing display copy.
- Frontend build passed with `npm.cmd run build` in `frontend` after rerunning outside the sandbox because Vite/esbuild could not read its config inside the sandbox.
- Backend build passed with `npm.cmd run build` in `backend`.
- Targeted backend regression tests passed for merchant labels, dashboard consistency, competitor service, pricing engine state, pricing/profit overview, readiness engine, and trust abuse overview.

## Scope of this stabilization pass

This pass was focused on the remaining approval blockers from the latest live QA review:

1. Starter fraud vs Starter competitor entitlement switching
2. Internal or synthetic order identifiers leaking into merchant UI
3. Dashboard recent-insight cards showing synthetic or internal-looking language
4. Evidence CTAs that looked interactive but did not lead the merchant anywhere useful
5. Competitor Intelligence showing stale operational state while locked or not configured
6. Billing redirect and billing-return flows leaving the merchant on blank or near-blank screens

## Root causes found

1. Starter access still depended on a mix of canonical and legacy module names across backend resolution, billing reconciliation, and frontend access mirrors.
2. Billing confirmation refreshed subscription state, but the selected Starter module was not being reinforced consistently enough after plan changes.
3. Merchant-facing order labels still had multiple formatter paths, so synthetic fallback IDs could leak through timeline events, fraud summaries, and evidence views.
4. Recent Insights relied on timeline copy that was operationally useful but still too close to internal synthetic test language when guided setup data was off.
5. The Trust & Abuse evidence CTA changed local state only; it did not clearly move the merchant to the actual evidence section.
6. Competitor module cache and UI state could linger after access was lost, which made locked or not-configured stores look stale instead of simply locked or empty.
7. Billing pending states had backend and frontend coverage, but the embedded shell still needed a stronger non-blank full-page fallback during redirect/return confirmation.

## Root fixes applied

### Canonical entitlement resolution

- Added canonical entitlement resolution in [backend/src/services/subscriptionService.ts](/C:/Users/Abhimanyu/OneDrive/Desktop/untitled%20folder/vedasuite-shopify-app/app-repo/backend/src/services/subscriptionService.ts) through `resolveEntitlements(shop)`.
- Hardened module alias normalization in [backend/src/billing/capabilities.ts](/C:/Users/Abhimanyu/OneDrive/Desktop/untitled%20folder/vedasuite-shopify-app/app-repo/backend/src/billing/capabilities.ts) and [frontend/src/lib/billingCapabilities.ts](/C:/Users/Abhimanyu/OneDrive/Desktop/untitled%20folder/vedasuite-shopify-app/app-repo/frontend/src/lib/billingCapabilities.ts):
  - `trust`
  - `trustAbuse`
  - `fraudIntelligence`
  - `creditScore`
  map to `fraud`
  - `competitorIntelligence`
  - `competitor_monitoring`
  map to `competitor`
- Canonical module keys used for approval-safe access logic:
  - `fraud`
  - `competitor`
  - `pricing`
  - `profit`

### Starter module switching and billing refresh

- Updated [backend/src/services/billingManagementService.ts](/C:/Users/Abhimanyu/OneDrive/Desktop/untitled%20folder/vedasuite-shopify-app/app-repo/backend/src/services/billingManagementService.ts) to:
  - log `billing.starter_module_selected`
  - preserve Starter module intent before billing redirect
  - log `billing.confirmation_received`
  - reconcile billing and refetch effective app state after confirmation
  - log `billing.app_state_refetched`
- Updated [frontend/src/providers/SubscriptionProvider.tsx](/C:/Users/Abhimanyu/OneDrive/Desktop/untitled%20folder/vedasuite-shopify-app/app-repo/frontend/src/providers/SubscriptionProvider.tsx) so billing confirmation now:
  - clears cached subscription state
  - polls backend until the expected plan and Starter module are both confirmed
  - refreshes app-state after backend confirmation
- Updated [frontend/src/modules/SubscriptionPlans/PricingPage.tsx](/C:/Users/Abhimanyu/OneDrive/Desktop/untitled%20folder/vedasuite-shopify-app/app-repo/frontend/src/modules/SubscriptionPlans/PricingPage.tsx) so plan change and cancel flows force:
  - subscription refresh
  - app-state refresh
  - billing-state reload

### Backend and route gating alignment

- Competitor routes remain protected by `requireFeature("competitor")` in [backend/src/middleware/requireFeature.ts](/C:/Users/Abhimanyu/OneDrive/Desktop/untitled%20folder/vedasuite-shopify-app/app-repo/backend/src/middleware/requireFeature.ts).
- Fraud and Trust Abuse routes remain protected by `requireFeature("fraud")`.
- Frontend module visibility was tightened so sidebar and module access rely on backend-derived enabled-module truth instead of separate Starter heuristics.

### Merchant-safe order and insight labels

- Added [backend/src/lib/merchantLabels.ts](/C:/Users/Abhimanyu/OneDrive/Desktop/untitled%20folder/vedasuite-shopify-app/app-repo/backend/src/lib/merchantLabels.ts) with:
  - `formatMerchantOrderLabel(order)`
  - `maskMerchantCustomerLabel(...)`
  - `formatMerchantInsightTitle(...)`
  - `formatMerchantInsightDetail(...)`
- `formatMerchantOrderLabel(order)` now enforces:
  - use `order.name` first
  - else use `#<orderNumber or shopifyLegacyOrderId>`
  - else use `Order pending sync`
  - never expose raw Shopify GIDs, synthetic shop-domain order IDs, or DB IDs
- Applied shared merchant-safe labeling to:
  - [backend/src/services/coreEngineService.ts](/C:/Users/Abhimanyu/OneDrive/Desktop/untitled%20folder/vedasuite-shopify-app/app-repo/backend/src/services/coreEngineService.ts)
  - [backend/src/services/dashboardService.ts](/C:/Users/Abhimanyu/OneDrive/Desktop/untitled%20folder/vedasuite-shopify-app/app-repo/backend/src/services/dashboardService.ts)
  - [backend/src/services/fraudService.ts](/C:/Users/Abhimanyu/OneDrive/Desktop/untitled%20folder/vedasuite-shopify-app/app-repo/backend/src/services/fraudService.ts)
  - [backend/src/services/trustAbuseService.ts](/C:/Users/Abhimanyu/OneDrive/Desktop/untitled%20folder/vedasuite-shopify-app/app-repo/backend/src/services/trustAbuseService.ts)

### Recent Insights cleanup

- Recent Insights now reformat titles and detail lines through merchant-safe label helpers in [backend/src/services/dashboardService.ts](/C:/Users/Abhimanyu/OneDrive/Desktop/untitled%20folder/vedasuite-shopify-app/app-repo/backend/src/services/dashboardService.ts).
- Internal-looking shopper strings such as `shopper 3zvn` are no longer surfaced in the dashboard insight cards when guided setup data is off.
- Timeline copy now prefers plain merchant-safe patterns like:
  - `Customer profile updated`
  - `Refund review needs attention`

### Evidence CTA behavior

- Updated [frontend/src/modules/TrustAbuse/TrustAbusePage.tsx](/C:/Users/Abhimanyu/OneDrive/Desktop/untitled%20folder/vedasuite-shopify-app/app-repo/frontend/src/modules/TrustAbuse/TrustAbusePage.tsx) so the primary evidence CTA now:
  - switches to the correct evidence tab
  - updates the URL hash to `#customer-order-evidence`
  - scrolls to the evidence section
- This replaces the old behavior where the CTA changed internal state but did not clearly move the merchant to the supporting evidence.

### Competitor locked/setup state cleanup

- Updated [frontend/src/modules/CompetitorIntelligence/CompetitorPage.tsx](/C:/Users/Abhimanyu/OneDrive/Desktop/untitled%20folder/vedasuite-shopify-app/app-repo/frontend/src/modules/CompetitorIntelligence/CompetitorPage.tsx) so when access is locked:
  - cached operational rows are cleared
  - stale connector data is cleared
  - response-engine and overview caches are reset
- This prevents locked Starter or inactive competitor access from still showing stale operational state.

### Billing non-blank transition state

- Added a stronger full-page billing transition shell in [frontend/src/layout/AppFrame.tsx](/C:/Users/Abhimanyu/OneDrive/Desktop/untitled%20folder/vedasuite-shopify-app/app-repo/frontend/src/layout/AppFrame.tsx):
  - `Redirecting to Shopify billing...`
  - `Waiting for Shopify approval...`
  - `Returning to VedaSuite...`
  - timeout retry/open-billing recovery after 10 seconds
- Updated [backend/src/routes/billingRoutes.ts](/C:/Users/Abhimanyu/OneDrive/Desktop/untitled%20folder/vedasuite-shopify-app/app-repo/backend/src/routes/billingRoutes.ts) top-level redirect HTML so the merchant sees a styled fallback instead of a blank white page if Shopify takes time to hand off.

## Files changed in this pass

### Backend

- [backend/src/billing/capabilities.ts](/C:/Users/Abhimanyu/OneDrive/Desktop/untitled%20folder/vedasuite-shopify-app/app-repo/backend/src/billing/capabilities.ts)
- [backend/src/lib/merchantLabels.ts](/C:/Users/Abhimanyu/OneDrive/Desktop/untitled%20folder/vedasuite-shopify-app/app-repo/backend/src/lib/merchantLabels.ts)
- [backend/src/routes/billingRoutes.ts](/C:/Users/Abhimanyu/OneDrive/Desktop/untitled%20folder/vedasuite-shopify-app/app-repo/backend/src/routes/billingRoutes.ts)
- [backend/src/services/billingManagementService.ts](/C:/Users/Abhimanyu/OneDrive/Desktop/untitled%20folder/vedasuite-shopify-app/app-repo/backend/src/services/billingManagementService.ts)
- [backend/src/services/coreEngineService.ts](/C:/Users/Abhimanyu/OneDrive/Desktop/untitled%20folder/vedasuite-shopify-app/app-repo/backend/src/services/coreEngineService.ts)
- [backend/src/services/dashboardService.ts](/C:/Users/Abhimanyu/OneDrive/Desktop/untitled%20folder/vedasuite-shopify-app/app-repo/backend/src/services/dashboardService.ts)
- [backend/src/services/fraudService.ts](/C:/Users/Abhimanyu/OneDrive/Desktop/untitled%20folder/vedasuite-shopify-app/app-repo/backend/src/services/fraudService.ts)
- [backend/src/services/storeReadinessService.ts](/C:/Users/Abhimanyu/OneDrive/Desktop/untitled%20folder/vedasuite-shopify-app/app-repo/backend/src/services/storeReadinessService.ts)
- [backend/src/services/subscriptionService.ts](/C:/Users/Abhimanyu/OneDrive/Desktop/untitled%20folder/vedasuite-shopify-app/app-repo/backend/src/services/subscriptionService.ts)
- [backend/src/services/trustAbuseService.ts](/C:/Users/Abhimanyu/OneDrive/Desktop/untitled%20folder/vedasuite-shopify-app/app-repo/backend/src/services/trustAbuseService.ts)

### Frontend

- [frontend/src/layout/AppFrame.tsx](/C:/Users/Abhimanyu/OneDrive/Desktop/untitled%20folder/vedasuite-shopify-app/app-repo/frontend/src/layout/AppFrame.tsx)
- [frontend/src/lib/billingCapabilities.ts](/C:/Users/Abhimanyu/OneDrive/Desktop/untitled%20folder/vedasuite-shopify-app/app-repo/frontend/src/lib/billingCapabilities.ts)
- [frontend/src/modules/CompetitorIntelligence/CompetitorPage.tsx](/C:/Users/Abhimanyu/OneDrive/Desktop/untitled%20folder/vedasuite-shopify-app/app-repo/frontend/src/modules/CompetitorIntelligence/CompetitorPage.tsx)
- [frontend/src/modules/SubscriptionPlans/PricingPage.tsx](/C:/Users/Abhimanyu/OneDrive/Desktop/untitled%20folder/vedasuite-shopify-app/app-repo/frontend/src/modules/SubscriptionPlans/PricingPage.tsx)
- [frontend/src/modules/TrustAbuse/TrustAbusePage.tsx](/C:/Users/Abhimanyu/OneDrive/Desktop/untitled%20folder/vedasuite-shopify-app/app-repo/frontend/src/modules/TrustAbuse/TrustAbusePage.tsx)
- [frontend/src/providers/SubscriptionProvider.tsx](/C:/Users/Abhimanyu/OneDrive/Desktop/untitled%20folder/vedasuite-shopify-app/app-repo/frontend/src/providers/SubscriptionProvider.tsx)

### Tests

- [backend/tests/billing-capabilities.test.cjs](/C:/Users/Abhimanyu/OneDrive/Desktop/untitled%20folder/vedasuite-shopify-app/app-repo/backend/tests/billing-capabilities.test.cjs)
- [backend/tests/dashboardConsistency.test.cjs](/C:/Users/Abhimanyu/OneDrive/Desktop/untitled%20folder/vedasuite-shopify-app/app-repo/backend/tests/dashboardConsistency.test.cjs)
- [backend/tests/merchantLabels.test.cjs](/C:/Users/Abhimanyu/OneDrive/Desktop/untitled%20folder/vedasuite-shopify-app/app-repo/backend/tests/merchantLabels.test.cjs)
- [backend/tests/pricingProfitRoutes.test.cjs](/C:/Users/Abhimanyu/OneDrive/Desktop/untitled%20folder/vedasuite-shopify-app/app-repo/backend/tests/pricingProfitRoutes.test.cjs)
- [backend/tests/trustAbuseOverview.test.cjs](/C:/Users/Abhimanyu/OneDrive/Desktop/untitled%20folder/vedasuite-shopify-app/app-repo/backend/tests/trustAbuseOverview.test.cjs)

## Verification run

Verification window:

- Started: `2026-05-04T21:41:03.7474318+05:30`
- Completed: `2026-05-04T21:41:03.7474318+05:30`

### Backend command results

1. `npm.cmd install`
   - PASS
   - Notes: already completed successfully earlier in this workspace for the current dependency set.

2. `$env:DATABASE_URL='postgresql://postgres:postgres@localhost:5432/vedasuite'; npx.cmd prisma generate`
   - PASS
   - Output summary: `Generated Prisma Client (v5.22.0)`
   - Notes: required escalation because local sandbox execution hit `spawn EPERM`.

3. `$env:DATABASE_URL='postgresql://postgres:postgres@localhost:5432/vedasuite'; npx.cmd prisma validate`
   - PASS
   - Output summary: `The schema at prisma/schema.prisma is valid`

4. `npm.cmd run build`
   - PASS
   - Output summary: `tsc -p tsconfig.json`

5. `Get-ChildItem tests\\*.test.cjs | ForEach-Object { node $_.FullName }`
   - PASS
   - Output summary:
     - all backend regression files executed successfully
     - Starter fraud and Starter competitor route-gating tests passed
     - dashboard consistency tests passed
     - merchant order-label tests passed
     - pricing route timeout and feature-lock tests passed

### Frontend command results

1. `npm.cmd install`
   - PASS
   - Notes: already completed successfully earlier in this workspace for the current dependency set.

2. `npm.cmd run build`
   - PASS
   - Output summary: `vite build` completed successfully

## Regression coverage added or strengthened

- Starter fraud unlocks only fraud
- Starter competitor unlocks only competitor
- Legacy module aliases map to canonical fraud or competitor access
- Dashboard recent insights do not leak synthetic shopper strings
- Merchant-facing order labels never expose synthetic order IDs or Shopify GIDs
- Trust & Abuse overview no longer exposes internal fallback order IDs
- Pricing route feature-lock and timeout behavior remain deterministic

## Remaining blockers

1. Owner-run live embedded Shopify QA is still required before submission can honestly be marked ready.
2. That live QA must confirm:
   - Starter fraud works
   - Starter competitor works
   - switching between them works
   - billing return never leaves a blank page
   - no internal order IDs appear anywhere merchant-facing
   - the evidence CTA clearly leads to the evidence section

## Final readiness call

Ready for Shopify submission right now: **NO**

Reason:

- Local code verification is passing and the blocker fixes in this pass are implemented.
- Final approval readiness still depends on owner-run live Shopify QA for the exact billing-switch and embedded-app flows that cannot be truthfully certified from local execution alone.

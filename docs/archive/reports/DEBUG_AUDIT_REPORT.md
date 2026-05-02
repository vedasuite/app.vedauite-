## VedaSuite Debug Audit Report

Date: 2026-04-06

### Scope audited

- Sync endpoints, Shopify Admin sync services, webhook registration, webhook handlers, and async job execution
- Billing and subscription resolution, Shopify billing routes, DB-backed subscription state, and frontend subscription fallbacks
- Dashboard and module data sources for:
  - Dashboard
  - Trust & Abuse
  - Competitor Intelligence
  - Pricing & Profit
  - Settings
  - Reports
- Fake, fallback, misleading, or disconnected runtime behavior

---

## 1. Broken Components

### A. Protected module routes are disconnected from embedded authenticated session context

#### Root cause

Many protected backend routes still read `req.query.shop` or `req.body.shop` directly, even though the protected embedded request path for `/api/*` no longer sends `shop` for normal same-origin authenticated calls.

That causes these routes to return `400 Missing shop`, which the frontend then catches and silently replaces with fallback objects and zero-state cards.

#### Exact files involved

- `backend/src/routes/dashboardRoutes.ts`
- `backend/src/routes/trustAbuseRoutes.ts`
- `backend/src/routes/competitorRoutes.ts`
- `backend/src/routes/pricingProfitRoutes.ts`
- `backend/src/routes/settingsRoutes.ts`
- `backend/src/routes/reportsRoutes.ts`
- `backend/src/routes/pricingRoutes.ts`
- `backend/src/routes/profitRoutes.ts`
- `backend/src/routes/fraudRoutes.ts`
- `backend/src/routes/creditScoreRoutes.ts`
- `backend/src/routes/subscriptionRoutes.ts`

#### Exact code patterns found

- `const shop = typeof req.query.shop === "string" ? req.query.shop : undefined;`
- `return res.status(400).json({ error: "Missing shop." });`
- `return res.status(400).json({ error: "Missing shop query parameter." });`

#### Why this is misleading

The app can complete a real sync job and still show zero metrics because module pages never read the authenticated shop from the session, fail with 400, and then render fallback frontend state.

---

### B. Sync success is inferred from job completion instead of persisted data readiness

#### Root cause

`syncJobService.ts` marks a sync job as `SUCCEEDED` whenever:

1. `syncShopifyStoreData(shop)` resolves
2. `recomputeStoreDerivedData(shop)` resolves

There is no durable validation that:

- products were actually fetched and saved
- orders were actually fetched and saved
- customers were actually created/updated
- processing outputs were actually generated
- module-level readiness changed from setup to data-backed states

#### Exact files involved

- `backend/src/services/syncJobService.ts`
- `backend/src/services/shopifyAdminService.ts`
- `backend/src/services/coreEngineService.ts`
- `backend/src/services/dashboardService.ts`

#### Exact code patterns found

- `status: "SUCCEEDED"` after `syncShopifyStoreData` + `recomputeStoreDerivedData`
- `lastSyncStatus: "SUCCEEDED"` set on `Store`
- no persisted per-resource count fields on `Store`
- no truth gate like “fetched > 0 but saved == 0 => fail”

#### Why this is misleading

The dashboard can show a success toast like “Live Shopify data synced into VedaSuite” even when downstream module rows remain zero or route fallbacks are what the frontend is actually rendering.

---

### C. Sync pipeline creates baseline pricing rows but does not persist a clear raw-data vs processed-data lifecycle

#### Root cause

`shopifyAdminService.ts` syncs orders and creates baseline `PriceHistory` rows directly from Shopify product price plus store settings. `coreEngineService.ts` then uses those rows to synthesize pricing and profit outputs.

There is no typed module lifecycle state distinguishing:

- raw data missing
- sync complete but processing pending
- processing succeeded with no data
- ready with data
- failed

#### Exact files involved

- `backend/src/services/shopifyAdminService.ts`
- `backend/src/services/coreEngineService.ts`
- `backend/prisma/schema.prisma`

#### Exact code patterns found

- `priceHistory.create(...)` during sync for every synced product
- `profitOptimizationData.create(...)` during recompute from baseline assumptions
- no module processing state table or field
- no per-module failure reason

#### What is disconnected

The system has:

- raw resource sync
- derived row generation

but not a truthful persisted operational state for each module.

---

### D. Billing state can still drift from truthful runtime access

#### Root cause

Billing logic is centralized better than before, but several UI surfaces still derive trust from optimistic or fallback subscription state instead of a fully resolved, persisted backend runtime state.

#### Exact files involved

- `backend/src/services/subscriptionService.ts`
- `backend/src/routes/billingRoutes.ts`
- `frontend/src/lib/billingCapabilities.ts`
- `frontend/src/providers/SubscriptionProvider.tsx`
- `frontend/src/modules/SubscriptionPlans/SubscriptionPage.tsx`
- `frontend/src/layout/AppFrame.tsx`
- `frontend/src/modules/Settings/SettingsPage.tsx`
- `frontend/src/modules/Dashboard/DashboardPage.tsx`

#### Exact code patterns found

- `fallbackSubscription`
- `optimisticSubscription ?? cachedSubscription ?? fallbackSubscription`
- frontend messages reading `subscription?.planName ?? "TRIAL"`
- UI copy such as `PRO plan coverage is active for your connected Shopify store.`

#### What was hardcoded or misleading

- frontend fallback subscription behaves like a real current plan object
- settings and dashboard use plan strings and enabled-module booleans even when module data is not actually processed

---

### E. Competitor module can claim live monitoring while ingestion is stale or failed

#### Root cause

`competitorService.ts` builds overview mostly from `competitorData` rows and `freshnessHours`, but there is no dedicated persisted competitor-ingestion run record or failure state. The page can still display strong “live” language when rows exist but are stale or ingestion just failed.

#### Exact files involved

- `backend/src/services/competitorService.ts`
- `backend/src/routes/competitorRoutes.ts`
- `frontend/src/modules/CompetitorIntelligence/CompetitorPage.tsx`

#### Exact code patterns found

- page banner:
  - `rows.length === 0 ? "Competitor monitoring is ready to configure" : "Market monitoring is live"`
- backend overview:
  - `monitoringPosture: "Live monitoring"` whenever `recentRows.length > 0`
- no dedicated competitor ingestion run persistence

#### Why this is misleading

A stale or failing competitor feed should never be shown as “live” just because old rows exist.

---

### F. Settings page presents ready-to-edit defaults as if they are a valid merchant profile

#### Root cause

Settings intentionally stay usable offline, but the page still promotes fallback/cached defaults in a way that can be read as if the live merchant profile is healthy and synced.

#### Exact files involved

- `frontend/src/modules/Settings/SettingsPage.tsx`

#### Exact code patterns found

- `syncState !== "live"` banner uses:
  - `Using the ready-to-edit merchant defaults`
  - `Settings stay open on every plan...`
- active plan and enabled controls are shown regardless of module data readiness

#### Why this is misleading

It is possible to show editable defaults, but those defaults must not imply live merchant intelligence is active.

---

### G. Trust & Pricing pages still use large fallback overview objects

#### Root cause

When backend calls fail, these pages render richly structured fallback objects instead of a truthful backend-driven “not ready / sync required / failed” state.

#### Exact files involved

- `frontend/src/modules/TrustAbuse/TrustAbusePage.tsx`
- `frontend/src/modules/PricingProfit/PricingProfitPage.tsx`

#### Exact code patterns found

- `const fallbackOverview = { ... }`
- `setOverview(fallbackOverview)`
- `setSyncIssue(true)` but continue to show rich fallback sections
- banners:
  - `Using fallback trust and abuse view`
  - `Using fallback pricing and profit view`

#### Why this is misleading

Merchants are shown feature surfaces that look partially alive even when the API failed or no processed state exists.

---

## 2. Suspected Root Causes

1. Protected API routes are disconnected from authenticated session shop resolution.
2. Sync is treated as complete when request/engine functions resolve, not when persistent outputs become ready.
3. Module pages are too dependent on fallback frontend objects instead of backend operational states.
4. Sync and processing do not persist typed readiness states per module.
5. Competitor ingestion does not persist its own run history and freshness/failure state.
6. Billing state is better centralized, but optimistic/fallback frontend subscription data still colors dashboard/settings/module messaging.

---

## 3. Exact Hardcoded / Fake / Misleading Patterns Found

### Hardcoded or optimistic subscription behavior

- `frontend/src/lib/billingCapabilities.ts`
  - `fallbackSubscription`
- `frontend/src/providers/SubscriptionProvider.tsx`
  - `optimisticSubscription ?? cachedSubscription ?? fallbackSubscription`

### Fake or marketing-style readiness copy

- `frontend/src/modules/Dashboard/DashboardPage.tsx`
  - quick action badges hardcoded to `Ready`
  - copy like `PRO plan coverage is active for your connected Shopify store.`
- `frontend/src/modules/CompetitorIntelligence/CompetitorPage.tsx`
  - `Market monitoring is live`
- `frontend/src/modules/TrustAbuse/TrustAbusePage.tsx`
  - fallback trust/policy/simulator objects
- `frontend/src/modules/PricingProfit/PricingProfitPage.tsx`
  - fallback pricing/profit overview object

### Disconnected success assumptions

- `backend/src/services/syncJobService.ts`
  - marks sync `SUCCEEDED` without validating persisted readiness
- `frontend/src/modules/Dashboard/DashboardPage.tsx`
  - success toast based on job completion only

---

## 4. What Was Hardcoded

- Multiple frontend fallback overview structures
- Dashboard “ready” badges for quick actions
- Dashboard suite posture copy implying active coverage regardless of module readiness
- Settings defaults and presets always available without clear live-vs-local distinction

No single direct backend `defaultPlan = "PRO"` was found in the current audited files, but stale/optimistic frontend subscription presentation can still make the UI look locked to an active high-tier state.

---

## 5. What Was Disconnected

- Protected `/api/*` route shop resolution vs embedded request behavior
- Sync completion vs module readiness
- Competitor ingestion execution vs persisted freshness/failure state
- Billing/plan resolution vs frontend optimistic/fallback display
- Dashboard cards vs actual backend module states

---

## 6. What Was Misleading

- “Connected” / “Ready” / “Live” UI language when no module processing readiness is persisted
- rich fallback module surfaces after API failures
- competitor live language with stale rows
- success toasts that do not prove dashboard-ready data exists

---

## 7. Production-Safe Fix Direction

1. Introduce central authenticated shop resolution for all protected routes.
2. Add typed sync and module readiness states used consistently across backend.
3. Make sync persist truthful resource counts and fail when mapping produces zero saved rows unexpectedly.
4. Add truthful debug endpoints for sync health and billing health.
5. Replace frontend fallback overview rendering with backend-driven readiness states and reasons.
6. Make dashboard and module banners use persisted operational state, not guessed or optimistic frontend logic.
7. Persist competitor ingestion runs and expose stale/failed states explicitly.
8. Remove any remaining “ready/live/connected” language that is not backed by backend facts.

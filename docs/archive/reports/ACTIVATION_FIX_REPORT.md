# VedaSuite Activation Fix Report

## Root causes found

1. Protected backend module routes were still reading `req.query.shop` instead of the authenticated embedded session shop, so many embedded requests silently fell into 400/error paths and the frontend kept showing cached/fallback zero states.
2. Sync jobs were treated as successful too early. A `SUCCEEDED` sync job did not guarantee:
   - persisted raw Shopify records
   - processed pricing/profit outputs
   - timeline events
   - truthful module readiness
3. Dashboard and module pages were inferring readiness from:
   - HTTP 200
   - latest job status only
   - cached fallback payloads
   rather than persisted operational state.
4. Competitor ingestion had no durable ingestion run state, so the UI could look “live” or “configured” even when the latest ingestion produced no records or failed.
5. Reports were still using setup-report fallbacks and `SUCCEEDED`-only logic, which overstated readiness.
6. Frontend billing fallback state still normalized missing subscription data into an active-feeling plan state, which contributed to plan confusion and “stuck on PRO” symptoms.

## Files changed

### New files
- `DEBUG_AUDIT_REPORT.md`
- `ACTIVATION_FIX_REPORT.md`
- `backend/src/routes/routeShop.ts`
- `backend/src/services/storeOperationalStateService.ts`
- `backend/prisma/migrations/20260406_activation_truthfulness/migration.sql`

### Backend changes
- `backend/prisma/schema.prisma`
- `backend/src/routes/index.ts`
- `backend/src/routes/shopifyRoutes.ts`
- `backend/src/routes/dashboardRoutes.ts`
- `backend/src/routes/trustAbuseRoutes.ts`
- `backend/src/routes/competitorRoutes.ts`
- `backend/src/routes/pricingProfitRoutes.ts`
- `backend/src/routes/settingsRoutes.ts`
- `backend/src/routes/reportsRoutes.ts`
- `backend/src/routes/subscriptionRoutes.ts`
- `backend/src/routes/pricingRoutes.ts`
- `backend/src/routes/profitRoutes.ts`
- `backend/src/routes/fraudRoutes.ts`
- `backend/src/routes/creditScoreRoutes.ts`
- `backend/src/services/syncJobService.ts`
- `backend/src/services/dashboardService.ts`
- `backend/src/services/trustAbuseService.ts`
- `backend/src/services/pricingProfitService.ts`
- `backend/src/services/competitorService.ts`
- `backend/src/services/reportsService.ts`
- `backend/src/services/shopifyAdminService.ts`
- `backend/src/services/subscriptionService.ts`

### Frontend changes
- `frontend/src/lib/billingCapabilities.ts`
- `frontend/src/modules/Dashboard/DashboardPage.tsx`
- `frontend/src/modules/TrustAbuse/TrustAbusePage.tsx`
- `frontend/src/modules/PricingProfit/PricingProfitPage.tsx`
- `frontend/src/modules/CompetitorIntelligence/CompetitorPage.tsx`
- `frontend/src/modules/Reports/ReportsPage.tsx`
- `frontend/src/modules/Settings/SettingsPage.tsx`

## DB migrations added

### `20260406_activation_truthfulness`
Adds:
- `ProductSnapshot`
- `VariantSnapshot`

Purpose:
- persist real synced product/variant records from Shopify
- support truthful raw-data counts
- support operational readiness checks after sync

## Endpoints added or changed

### Added / improved
- `GET /api/shopify/diagnostics`
- `GET /api/internal/debug/sync-health`
- `GET /api/shopify/sync-health`
- `GET /api/internal/debug/billing-health`
- `GET /api/shopify/billing-health`

### Behavior changes
- `POST /api/shopify/sync`
  - now starts a tracked background sync job
  - no longer implies dashboard readiness from HTTP success alone
- `GET /api/shopify/sync-jobs/latest`
  - used for truthful polling
- `POST /api/competitor/ingest`
  - now persists a `competitor_ingest` sync job with:
    - `SUCCEEDED`
    - `SUCCEEDED_NO_DATA`
    - `FAILED`

## Plan / billing fixes

1. Removed frontend fallback behavior that normalized missing subscription state into a live-feeling paid plan.
2. Normalized unknown subscription state to `NONE`, not `TRIAL` or `PRO`.
3. Added a single-source backend helper:
   - `resolveActivePlan(shopDomain)`
4. Added billing debug response exposing:
   - DB plan
   - effective feature-gating plan
   - mismatches
   - active Shopify charge ID

## Sync fixes

1. Sync route now depends on authenticated embedded shop resolution, not `?shop=` drift.
2. Sync pipeline now persists:
   - raw products
   - raw variants
   - products/orders/customers counts
3. Sync jobs now store summary JSON including:
   - sync result
   - recompute result
   - operational counts
   - derived sync status
4. Sync success is no longer treated as “ready” unless persisted outputs exist.

## Processing fixes

1. Added store-level operational state resolver:
   - raw counts
   - processed counts
   - latest sync job
   - latest competitor ingest job
   - latest processing timestamp
2. Added typed statuses:
   - `NOT_CONNECTED`
   - `SYNC_REQUIRED`
   - `SYNC_IN_PROGRESS`
   - `SYNC_COMPLETED_PROCESSING_PENDING`
   - `READY_WITH_DATA`
   - `EMPTY_STORE_DATA`
   - `FAILED`
3. Added typed module readiness evaluation driven by persisted data and failure reasons.

## Truthful status fixes

### Dashboard
- No longer claims “connected/live/ready” from HTTP success alone.
- Quick actions now surface module readiness state and reason.
- Suite posture now reflects backend billing + sync state.

### Trust & Abuse
- Uses real readiness state from persisted operational outputs.
- Zero values are now clearly tied to:
  - no sync
  - processing pending
  - no data
  - failure

### Pricing & Profit
- Uses real readiness state from persisted pricing/profit rows.
- Avoids implying “active intelligence” when the processing layer has not produced outputs.

### Competitor Intelligence
- No longer claims live monitoring when ingestion is stale or failed.
- Ingest action now persists truthful run state and no-data outcomes.

### Reports
- No longer infers “live report” from sync job `SUCCEEDED` alone.
- Report readiness now follows persisted operational state.

### Settings
- No longer labels missing module access as “ready for activation”.
- Uses more truthful “configured only” copy when plan/module access is not active.

## Remaining risks

1. `GET /api/internal/debug/*` currently aliases through the main Shopify router. It works, but a dedicated internal debug router would be cleaner later.
2. Some older legacy module pages still contain fallback structures and should eventually be retired if they are no longer linked in production nav.
3. Competitor ingestion still depends on live fetch availability and monitored domains. The new job persistence makes failure truthful, but it does not guarantee external source availability.
4. If a store genuinely has no orders/customers/pricing history yet, many cards will still show zero — but now with a truthful readiness reason instead of a fake “live” state.

## Manual verification steps

1. Deploy latest `main` to Render.
2. Run Prisma migration during build:
   ```bash
   cd frontend && npm install && npm run build && cd ../backend && npm install && npx prisma generate && npx prisma migrate deploy && npm run build
   ```
3. Open the app from Shopify Admin.
4. Visit:
   - `/api/shopify/diagnostics`
   - `/api/internal/debug/sync-health`
   - `/api/internal/debug/billing-health`
5. Click:
   - `Sync live Shopify data`
6. Poll:
   - `/api/shopify/sync-jobs/latest`
7. Confirm after sync:
   - product counts > 0 if the store has products
   - order counts > 0 if the store has orders
   - processing rows increase after recompute
8. Open:
   - Dashboard
   - Trust & Abuse
   - Pricing & Profit
   - Competitor Intelligence
   - Reports
9. Confirm statuses are one of:
   - `NOT_CONNECTED`
   - `SYNC_REQUIRED`
   - `SYNC_IN_PROGRESS`
   - `SYNC_COMPLETED_PROCESSING_PENDING`
   - `READY_WITH_DATA`
   - `EMPTY_STORE_DATA`
   - `FAILED`
10. Confirm billing health shows the real DB/effective plan, not an implicit PRO fallback.

## Required env vars

- `SHOPIFY_API_KEY`
- `SHOPIFY_API_SECRET`
- `SHOPIFY_APP_URL`
- `SHOPIFY_SCOPES`
- `SHOPIFY_ADMIN_API_VERSION`
- `DATABASE_URL`
- `VITE_SHOPIFY_API_KEY`
- `SHOPIFY_BILLING_TEST_MODE`
- `VEDASUITE_ENABLE_DEMO_BOOTSTRAP=false`

## Routes and endpoints to confirm the system

- `GET /api/shopify/diagnostics`
- `GET /api/internal/debug/sync-health`
- `GET /api/internal/debug/billing-health`
- `GET /api/shopify/sync-jobs/latest`
- `POST /api/shopify/sync`
- `POST /api/shopify/register-webhooks`
- `POST /api/competitor/ingest`

## Sample JSON: sync health

```json
{
  "shop": "example.myshopify.com",
  "authState": "OK",
  "connectionHealthy": true,
  "lastSyncStatus": "SYNC_COMPLETED_PROCESSING_PENDING",
  "lastSyncReason": "Raw Shopify data synced, but derived processing outputs are not ready yet.",
  "rawCounts": {
    "products": 12,
    "orders": 4,
    "customers": 3
  },
  "processedCounts": {
    "pricingRows": 0,
    "profitRows": 0,
    "timelineEvents": 0,
    "competitorRows": 0
  },
  "lastSuccessfulPullTimestamps": {
    "sync": "2026-04-06T13:05:00.000Z",
    "competitor": null
  },
  "lastProcessingTimestamp": null,
  "blockingErrors": {
    "connection": null,
    "latestSyncJob": null,
    "latestCompetitorJob": null
  }
}
```

## Sample JSON: billing health

```json
{
  "shop": "example.myshopify.com",
  "dbPlan": "GROWTH",
  "dbBillingStatus": "ACTIVE",
  "activeSubscriptionId": "gid://shopify/AppSubscription/123456",
  "activeSubscriptionEndsAt": null,
  "lastBillingWebhookProcessedAt": "2026-04-06T12:40:00.000Z",
  "effectivePlanUsedByFeatureGating": "GROWTH",
  "effectiveBillingStatus": "ACTIVE",
  "mismatchWarnings": []
}
```

## Sample JSON: module readiness

```json
{
  "trustAbuse": {
    "readinessState": "READY_WITH_DATA",
    "reason": "Module data is backed by persisted outputs."
  },
  "competitor": {
    "readinessState": "FAILED",
    "reason": "Competitor monitoring is stale. Last successful ingestion was 201 hours ago."
  },
  "pricingProfit": {
    "readinessState": "SYNC_COMPLETED_PROCESSING_PENDING",
    "reason": "Data synced, but this module does not have enough processed output yet."
  }
}
```

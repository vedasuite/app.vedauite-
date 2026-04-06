# Shopify Reviewer Runbook

This runbook describes the cleanest end-to-end review path for VedaSuite inside Shopify Admin.

## 1. Install And Open

1. Install VedaSuite AI in the review store.
2. Open the app from Shopify Admin.
3. Confirm the embedded dashboard loads without a blank screen.
4. Refresh once inside the embedded app to confirm the session survives reload.

## 2. Verify Connection Health

1. From the embedded app session, open:
   - `/api/shopify/diagnostics`
2. Confirm the JSON shows:
   - `installation.found = true`
   - `installation.offlineTokenPresent = true`
   - `connection.healthy = true` or a factual recoverable state
   - webhook registration status
   - sync status
   - billing status
   - `reviewerSummary.reconnectRequired = false`

## 3. Run First Sync

1. On the Dashboard, click `Sync live Shopify data`.
2. Wait for the sync to complete.
3. Re-open `/api/shopify/diagnostics` and confirm:
   - `sync.lastSyncStatus` is populated
   - `sync.lastSyncAt` is updated

## 4. Verify Webhooks

1. On the Dashboard, click `Register sync webhooks`.
2. Re-open `/api/shopify/diagnostics`.
3. Confirm:
   - `webhooks.registeredAt` is populated
   - `webhooks.lastStatus` is not `FAILED`
   - `webhooks.liveStatus` reports tracked coverage

## 5. Verify One Real Module Workflow

Run at least one real workflow after sync:

- `Trust & Abuse Intelligence`
  - open the module
  - confirm timeline, review, or trust outputs load without a crash
- `Competitor Intelligence`
  - confirm the page shows factual monitored-data or setup state
- `Pricing & Profit Engine`
  - confirm the page shows factual baseline or synced recommendation state

## 6. Verify Billing Flow

1. Open `Subscription Plans`.
2. Trigger a plan change.
3. Confirm Shopify billing approval opens correctly.
4. Return to the embedded app.
5. Confirm the app reflects the updated plan state.

## 7. Verify Uninstall Lifecycle

1. Uninstall the app from the review store.
2. Reinstall it.
3. Open `/api/shopify/diagnostics` again from the reinstalled app session.
4. Confirm the installation returns to a healthy connected state.

## 8. Public Review Links

Confirm these public URLs open successfully:

- Privacy:
  - `https://app.vedasuite.in/legal/privacy`
- Terms:
  - `https://app.vedasuite.in/legal/terms`
- Support:
  - `https://app.vedasuite.in/support`
- Launch sanity:
  - `https://app.vedasuite.in/launch/sanity`

## Partner Dashboard Manual Checks

Confirm the Shopify Partner Dashboard is set to:

- App URL:
  - `https://app.vedasuite.in`
- Redirect URL:
  - `https://app.vedasuite.in/auth/callback`
- Embedded app:
  - enabled
- Protected customer data declarations:
  - completed before submission
- Compliance webhook topics:
  - `customers/data_request`
  - `customers/redact`
  - `shop/redact`

## Render Manual Checks

Confirm Render environment values:

- `SHOPIFY_API_KEY`
- `SHOPIFY_API_SECRET`
- `SHOPIFY_APP_URL=https://app.vedasuite.in`
- `SHOPIFY_SCOPES=read_products,write_products,read_orders,write_orders,read_customers`
- `SHOPIFY_ADMIN_API_VERSION=2026-01`
- `DATABASE_URL`
- `VITE_SHOPIFY_API_KEY`
- `SHOPIFY_BILLING_TEST_MODE=false`
- `VEDASUITE_ENABLE_DEMO_BOOTSTRAP=false`

Use this build command:

```bash
cd frontend && npm install && npm run build && cd ../backend && npm install && npx prisma generate && npx prisma migrate deploy && npm run build
```

# Shopify Submission Manual Checklist

Use this checklist before submitting VedaSuite for Shopify review.

## 1. Authoritative app root

- Deploy from `app-repo` only.
- Ignore legacy files outside `app-repo` when updating Render or Shopify config.

## 2. Shopify Partner Dashboard

- App URL:
  - `https://app.vedasuite.in`
- Allowed redirection URL:
  - `https://app.vedasuite.in/auth/callback`
- Embedded app:
  - enabled
- Compliance webhooks:
  - `customers/data_request`
  - `customers/redact`
  - `shop/redact`
- Sync webhooks in config:
  - `app/uninstalled`
  - `orders/create`
  - `orders/updated`
  - `customers/create`
  - `customers/update`
  - `app_subscriptions/update`
- Protected customer data declarations:
  - complete in Partner Dashboard before submission

## 3. Render environment

- `SHOPIFY_API_KEY`
- `SHOPIFY_API_SECRET`
- `SHOPIFY_APP_URL=https://app.vedasuite.in`
- `SHOPIFY_SCOPES=read_products,write_products,read_orders,write_orders,read_customers`
- `DATABASE_URL`
- `VITE_SHOPIFY_API_KEY`
- `SHOPIFY_BILLING_TEST_MODE=false` for real review billing behavior
- `VEDASUITE_ENABLE_DEMO_BOOTSTRAP=false`

## 4. Render build command

Use:

```bash
cd frontend && npm install && npm run build && cd ../backend && npm install && npx prisma generate && npx prisma migrate deploy && npm run build
```

## 5. Production verification

- Open the app from Shopify Admin sidebar
- Confirm dashboard loads after refresh
- Open:
  - Trust & Abuse
  - Competitor Intelligence
  - Pricing & Profit
  - Reports
  - Settings
  - Subscription Plans
- In dashboard:
  - run `Sync live Shopify data`
  - run `Register sync webhooks`
- Open:
  - `/api/shopify/diagnostics` from an authenticated embedded session and confirm:
    - installation found
    - offline token present
    - webhooks registered
    - sync status visible
    - billing status visible

## 6. Reconnect/reinstall repair

- If diagnostics shows auth unhealthy:
  - click `Reconnect Shopify`
  - complete OAuth
  - reopen the app
  - rerun sync + webhook registration
- If the store was installed before the auth hardening changes:
  - reconnect once after deployment
- If uninstall state is stuck:
  - uninstall from the dev store
  - reinstall from Partner Dashboard test link

## 7. Public review links

- Privacy:
  - `https://app.vedasuite.in/legal/privacy`
- Terms:
  - `https://app.vedasuite.in/legal/terms`
- Support:
  - `https://app.vedasuite.in/support`

## 8. Submission package

- Upload final app icon
- Upload screenshots
- Upload review/demo video
- Ensure listing copy does not claim unsupported capabilities
- Keep fraud, trust, pricing, and competitor claims explainable and operational

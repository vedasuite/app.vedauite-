# Live QA Owner Script

Timestamp: `2026-05-04T21:41:03.7474318+05:30`

This script is for the owner to run the final live QA in a real Shopify dev store after the current blocker-fix batch is pushed and deployed.

## Before starting

Confirm Render is running the updated code and production-safe backend commands:

1. `npx prisma generate`
2. `npx prisma migrate deploy`
3. `npm run build`

Confirm these environment values are correct:

- `DATABASE_URL`
- `SHOPIFY_API_KEY`
- `SHOPIFY_API_SECRET`
- `SHOPIFY_APP_URL=https://app.vedasuite.in`

## Render log events to watch

### Install and OAuth

- `shopify.auth.start`
- `shopify.auth.callback_completed`
- `shopify.auth.callback_failed`

### Billing and subscription truth

- `billing.starter_module_selected`
- `billing.confirmation_received`
- `billing.entitlements_resolved`
- `billing.app_state_refetched`
- `webhook.app_subscription_updated`
- `billing.webhook_reconciled`
- `billing.webhook_deactivated`

### Webhooks

- `webhook.app_uninstalled`
- `privacy.customer_data_request_exported`
- `privacy.customer_redacted`
- `privacy.shop_redacted`

## Live QA steps

Use one clean Shopify dev store and record screenshots or short videos for anything that fails.

### 1. Install app and OAuth

1. Install `VedaSuite AI` in the dev store.
2. Complete OAuth.
3. Let the app open inside Shopify Admin.

Expected:

- No blank or near-white screen during install or first open
- Render logs show `shopify.auth.start` then `shopify.auth.callback_completed`

### 2. Embedded reopen and refresh

1. Refresh the embedded app page.
2. Leave the app and reopen it from Shopify Admin.

Expected:

- No bootstrap crash
- No blank shell
- No permanent loading state

### 3. Starter fraud

1. Open billing.
2. Select Starter with `fraud`.
3. Complete Shopify billing approval.
4. Return to the embedded app.

Expected:

- Fraud or Trust Abuse opens normally
- Competitor shows locked upgrade state
- Pricing shows locked upgrade state
- Profit shows locked upgrade state
- Sidebar reflects the same access
- Render logs show:
  - `billing.starter_module_selected`
  - `billing.confirmation_received`
  - `billing.entitlements_resolved`
  - `billing.app_state_refetched`

### 4. Starter competitor

1. Change Starter to `competitor`.
2. Complete Shopify billing approval.
3. Return to the embedded app.

Expected:

- Competitor opens normally
- Fraud or Trust Abuse is locked
- Pricing is locked
- Profit is locked
- Sidebar reflects the same access
- Competitor does not still show Upgrade if it is the selected Starter module

### 5. Switch Starter fraud -> Starter competitor

1. Start in Starter fraud.
2. Switch to Starter competitor through billing.
3. Return to the embedded app.

Expected:

- Competitor opens immediately after return
- Fraud locks immediately after return
- No stale access remains from the prior Starter module
- No blank white screen during billing return

### 6. Switch Starter competitor -> Starter fraud

1. Start in Starter competitor.
2. Switch to Starter fraud through billing.
3. Return to the embedded app.

Expected:

- Fraud opens immediately after return
- Competitor locks immediately after return
- No stale access remains from the prior Starter module
- No blank white screen during billing return

### 7. Billing transition shell

During any billing upgrade, downgrade, or Starter-module switch:

Expected:

- You see an embedded loading shell such as:
  - `Redirecting to Shopify billing...`
  - `Waiting for Shopify approval...`
  - `Returning to VedaSuite...`
- You do not see a blank white page
- If Shopify takes too long, a retry or reopen path appears

### 8. Dashboard and Recent Insights

1. Open Dashboard.
2. Review Recent Insights and summary cards.

Expected:

- No fake order labels like `vedasuite-ai.myshopify.com-order-1002`
- No Shopify GIDs
- No DB IDs
- No synthetic shopper strings like `shopper 3zvn`
- If there is not enough real data, insights should be limited or absent rather than fake-looking

### 9. Fraud and evidence behavior

1. Open Fraud or Trust Abuse.
2. Use the `Review supporting evidence` CTA.

Expected:

- The click moves you to the evidence section
- The evidence tab is activated
- The URL hash updates to `#customer-order-evidence`
- No dead click and no silent no-op

Also confirm:

- No fake order labels or internal IDs appear in queue items, evidence cards, or review cards

### 10. Competitor locked and setup states

Check both cases:

1. Competitor locked because the current plan does not include it
2. Competitor unlocked but competitor setup is not configured

Expected when locked:

- Upgrade-only locked state
- No stale refresh date
- No live operational rows

Expected when unlocked but not configured:

- Setup or empty state
- No misleading stale operational state

### 11. Pricing insufficient-data behavior

1. Open AI Pricing Engine in a low-data store.

Expected:

- If data is insufficient, projected gain is hidden
- The page explains that there is not enough data yet
- No inflated projected gain number is shown beside insufficient-data copy

### 12. Uninstall webhook

1. Uninstall the app.
2. Watch Render logs.

Expected:

- `webhook.app_uninstalled` appears
- Reinstall works afterward

### 13. Privacy webhooks

Trigger or verify:

1. `customers/data_request`
2. `customers/redact`
3. `shop/redact`

Expected:

- Success responses
- Render logs show:
  - `privacy.customer_data_request_exported`
  - `privacy.customer_redacted`
  - `privacy.shop_redacted`

## What to record for any failure

- Step number
- Store name
- Timestamp
- Current URL
- Screenshot or short video
- Relevant Render log snippet
- Whether retry changed the result

## Final rule

Do not mark the app Shopify-ready until all critical steps above are marked PASS in [LIVE_QA_EVIDENCE_TEMPLATE.md](/C:/Users/Abhimanyu/OneDrive/Desktop/untitled%20folder/vedasuite-shopify-app/app-repo/LIVE_QA_EVIDENCE_TEMPLATE.md).

# Live QA Evidence Template

Timestamp started: `________________`

## Run metadata

- Release owner: `________________`
- Shopify dev store: `________________`
- App URL tested: `https://app.vedasuite.in`
- Git commit verified on Render: `________________`
- Render deploy ID or timestamp: `________________`

## Render deployment verification

- Latest GitHub commit deployed: `PASS / FAIL`
- Render backend command flow confirmed:
  - `npx prisma generate`: `PASS / FAIL`
  - `npx prisma migrate deploy`: `PASS / FAIL`
  - `npm run build`: `PASS / FAIL`
- Environment variables confirmed:
  - `DATABASE_URL`: `PASS / FAIL`
  - `SHOPIFY_API_KEY`: `PASS / FAIL`
  - `SHOPIFY_API_SECRET`: `PASS / FAIL`
  - `SHOPIFY_APP_URL=https://app.vedasuite.in`: `PASS / FAIL`

Notes:

`________________`

## QA checklist evidence

### 1. Install app

- Result: `PASS / FAIL`
- Screenshot/video note:
- Render log note:
- Comments:

### 2. OAuth callback and embedded open

- Result: `PASS / FAIL`
- Screenshot/video note:
- Render log note:
- Comments:

### 3. Refresh and reopen inside Shopify Admin

- Result: `PASS / FAIL`
- Screenshot/video note:
- Render log note:
- Comments:

### 4. Starter plan with fraud module

- Result: `PASS / FAIL`
- Fraud opens:
- Competitor locked:
- Pricing locked:
- Profit locked:
- Screenshot/video note:
- Render log note:
- Comments:

### 5. Starter plan with competitor module

- Result: `PASS / FAIL`
- Competitor opens:
- Fraud locked:
- Pricing locked:
- Profit locked:
- Screenshot/video note:
- Render log note:
- Comments:

### 6. Switch Starter fraud -> Starter competitor

- Result: `PASS / FAIL`
- Competitor opens immediately after billing return:
- Fraud locks immediately after billing return:
- No stale access remains:
- No blank white screen during billing return:
- Screenshot/video note:
- Render log note:
- Comments:

### 7. Switch Starter competitor -> Starter fraud

- Result: `PASS / FAIL`
- Fraud opens immediately after billing return:
- Competitor locks immediately after billing return:
- No stale access remains:
- No blank white screen during billing return:
- Screenshot/video note:
- Render log note:
- Comments:

### 8. Growth plan

- Result: `PASS / FAIL`
- Billing state refreshed correctly:
- Modules available as expected:
- Screenshot/video note:
- Render log note:
- Comments:

### 9. Pro plan

- Result: `PASS / FAIL`
- Billing state refreshed correctly:
- Full access available as expected:
- Screenshot/video note:
- Render log note:
- Comments:

### 10. Downgrade or cancel

- Result: `PASS / FAIL`
- Entitlements updated correctly:
- Stale access removed:
- Screenshot/video note:
- Render log note:
- Comments:

### 11. Dashboard and module consistency

- Result: `PASS / FAIL`
- Fraud count matches:
- Competitor count matches:
- Pricing count matches:
- Profit count matches:
- Screenshot/video note:
- Comments:

### 12. No fake/demo/sample leakage

- Result: `PASS / FAIL`
- Demo/sample data visible:
- If visible, was it clearly labeled sample preview:
- Screenshot/video note:
- Comments:

### 13. No internal order IDs exposed

- Result: `PASS / FAIL`
- Dashboard clean:
- Fraud clean:
- Evidence clean:
- Recent insights clean:
- Screenshot/video note:
- Comments:

### 14. Evidence CTA behavior

- Result: `PASS / FAIL`
- CTA scrolls or focuses evidence section:
- Correct evidence tab opens:
- No dead click:
- Screenshot/video note:
- Comments:

### 15. Competitor setup or empty state

- Result: `PASS / FAIL`
- Correct setup CTA or empty state shown:
- Locked state hides stale operational data:
- Screenshot/video note:
- Comments:

### 16. Pricing insufficient-data handling

- Result: `PASS / FAIL`
- Projected gain hidden when insufficient:
- Screenshot/video note:
- Comments:

### 17. Uninstall webhook

- Result: `PASS / FAIL`
- Render log note:
- Comments:

### 18. Privacy webhooks

- `customers/data_request`: `PASS / FAIL`
- `customers/redact`: `PASS / FAIL`
- `shop/redact`: `PASS / FAIL`
- Render log note:
- Comments:

## Failure evidence

Paste any screenshot paths, video links, or copied Render log snippets here:

`________________`

## Final owner verdict

- Live Shopify QA complete: `YES / NO`
- Safe to mark app Shopify-ready: `YES / NO`
- Final blocker summary:

`________________`

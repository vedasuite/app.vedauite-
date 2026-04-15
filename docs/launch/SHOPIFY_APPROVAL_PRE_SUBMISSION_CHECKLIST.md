# Shopify Approval Pre-Submission Checklist

Use this checklist immediately before submitting VedaSuite AI to the Shopify App Store.

## 1. Embedded App Behavior

- Confirm the app opens inside Shopify Admin without leaving the embedded frame.
- Confirm these embedded routes render correctly after direct load and browser refresh:
  - `/app/onboarding`
  - `/app/dashboard`
  - `/app/fraud-intelligence`
  - `/app/competitor-intelligence`
  - `/app/ai-pricing-engine`
  - `/app/billing`
  - `/app/settings`
- Confirm the app shell never shows a blank white screen during normal navigation.
- Confirm route errors show a merchant-safe fallback instead of a crash screen.

## 2. Install And Auth

- App URL in Partner Dashboard matches `https://app.vedasuite.in`
- Redirect URL matches `https://app.vedasuite.in/auth/callback`
- Embedded app is enabled in Partner Dashboard
- Fresh install persists a valid offline token
- Reauth flow returns the merchant to the correct embedded route
- Uninstall and reinstall return the app to a healthy connected state

## 3. Access Scopes

Current approval-target scopes:

- `read_products`
- `read_orders`
- `write_orders`
- `read_customers`

Scope justification:

- `read_products`: pricing, catalog, and competitor comparisons
- `read_orders`: fraud, pricing, and operational analytics
- `write_orders`: add order review tags from fraud workflows
- `read_customers`: customer-linked fraud and return-abuse evaluation

Final check:

- No unused write scopes remain in `shopify.app.toml`
- Partner Dashboard scopes match repo scopes exactly

## 4. Webhooks And Compliance

Confirm these webhook topics are configured and handled:

- `app/uninstalled`
- `orders/create`
- `orders/updated`
- `customers/create`
- `customers/update`
- `app_subscriptions/update`
- `customers/data_request`
- `customers/redact`
- `shop/redact`

Confirm:

- webhook HMAC validation is enforced
- uninstall webhook marks the installation inactive without deleting useful audit state prematurely
- compliance webhooks succeed without manual intervention
- billing webhook updates subscription truth and audit timestamps

## 5. Billing Readiness

- Billing page shows one canonical current plan state
- No contradictory lifecycle labels appear together
- Pending approval resolves after Shopify confirmation
- Module entitlements match the verified plan
- Cancel flow updates billing truth and access state cleanly
- Test mode is disabled in production before submission

## 6. Privacy And Protected Customer Data

- Public privacy policy URL is live
- Public terms URL is live
- Public support URL is live
- Protected customer data declaration is fully completed in Partner Dashboard
- Customer-facing UI avoids exposing unnecessary direct identifiers
- Customer redact and data request flows are supported and logged
- No cross-merchant raw customer contact data is exposed

## 7. Reviewer Trust And Merchant Clarity

- Onboarding explains what the app does and what to do next
- Dashboard does not overclaim that all modules are ready
- Competitor and pricing modules show truthful empty or partial states when data is limited
- No module claims live readiness without persisted backing data
- No dead buttons or placeholder reviewer-visible routes remain

## 8. Production Safety

- `SHOPIFY_APP_URL` points to the production domain
- `SHOPIFY_ADMIN_API_VERSION` is current and matches the repo config
- `VEDASUITE_ENABLE_DEMO_BOOTSTRAP=false`
- `SHOPIFY_BILLING_TEST_MODE=false`
- `DATABASE_URL` points to production
- Prisma migrations are deployed

## 9. Final Verification Endpoints

Check these before submission:

- `/launch/audit`
- `/launch/sanity`
- `/legal/privacy`
- `/legal/terms`
- `/support`
- `/api/shopify/diagnostics` from an authenticated embedded session

## 10. Submission Gate

Do not submit until all of these are true:

- install path works on a clean review store
- billing plan state is deterministic after approval
- compliance webhooks are live
- first sync completes without reviewer confusion
- every primary embedded route loads successfully

# Shopify Approval QA Checklist

## Install and OAuth

- Install the app into a clean development store from Shopify Admin.
- Confirm the embedded app opens inside Shopify Admin without blank white screens.
- Confirm OAuth callback returns to the embedded app successfully.
- Confirm reconnect flow works if the session is expired or the offline token is missing.

## Dashboard and onboarding

- Open `/app/onboarding` and verify it shows setup guidance rather than dashboard content.
- Open `/app/dashboard` and verify the dashboard renders even for a non-paid or trial store.
- Confirm onboarding and dashboard use the same readiness truth for:
  - connection health
  - sync status
  - billing readiness
  - module readiness

## Billing and subscription

- Verify `TRIAL` shows plan-limited behavior and does not unlock paid feature access.
- Verify `STARTER` with fraud selection unlocks fraud and keeps competitor/pricing/profit locked.
- Verify `STARTER` with competitor selection unlocks competitor and keeps fraud/pricing/profit locked.
- Verify `GROWTH` unlocks fraud, competitor, pricing, reports, and credit score.
- Verify `PRO` unlocks profit optimization features.
- Verify billing page shows:
  - current plan
  - active or inactive state
  - starter module when applicable
  - trial status when applicable
  - renewal or end date only when valid
- Complete a Shopify billing approval flow and confirm the UI refreshes from backend truth after return.
- Cancel or downgrade a plan and confirm entitlements update cleanly.

## Locked routes and feature gating

- Visit fraud routes on a non-fraud plan and confirm a backend `403 FEATURE_LOCKED` response.
- Visit competitor routes on a non-competitor plan and confirm a backend `403 FEATURE_LOCKED` response.
- Visit pricing routes on a non-pricing plan and confirm a backend `403 FEATURE_LOCKED` response.
- Visit profit routes on a non-PRO plan and confirm a backend `403 FEATURE_LOCKED` response.

## Fraud intelligence

- Verify empty-state copy when no risky orders exist.
- Verify fraud summary counts match the fraud table counts.
- Apply a fraud action to an order missing a valid Shopify order identity and confirm the merchant message is:
  - `Review status saved in VedaSuite. Shopify tagging will be available after the order is fully synced.`
- Apply a fraud action to a fully synced Shopify order and confirm local state plus Shopify tagging both succeed.

## Competitor intelligence

- With no domains configured, confirm the setup CTA appears.
- With no eligible products, confirm the page explains that products must be synced first.
- With older analysis data, confirm the page shows update guidance rather than raw extreme hour counts.
- With no comparable matches, confirm the page explains that competitor analysis completed but no matching products were found.
- Add `gymshark.com` or `allbirds.com`, run competitor analysis, and confirm the app shows either matched products with pricing or a clean no-match result.

## Pricing and profit

- With insufficient sales or cost data, confirm the page shows an advisory or empty state rather than inflated profit claims.
- Verify pricing counts on the dashboard match the pricing module.
- Verify profit-opportunity counts on the dashboard match the profit module.
- Approve a pricing action and confirm invalid Shopify product or variant IDs fail safely without crashing.

## Privacy and compliance

- Confirm privacy webhooks are registered:
  - `customers/data_request`
  - `customers/redact`
  - `shop/redact`
- Confirm uninstall webhook is registered and processed.
- Confirm customer/order/product access in the UI is consistent with the scopes and privacy disclosures.
- Confirm privacy, terms, and support URLs are production-ready.

## Production config

- Confirm `shopify.app.toml` uses `https://app.vedasuite.in`.
- Confirm production scopes are minimal for the deployed feature set.
- Confirm the app remains embedded and navigation works inside Shopify Admin.

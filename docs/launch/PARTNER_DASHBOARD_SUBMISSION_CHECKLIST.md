# Partner Dashboard Submission Checklist

Use this checklist while filling the Shopify Partner Dashboard for VedaSuite AI.

## App Setup

- App name: `VedaSuite AI`
- App handle: `vedasuite-ai`
- Embedded app: `Yes`
- App URL: use the production HTTPS app URL
- Allowed redirection URL: `<production-app-url>/auth/callback`

## Distribution

- Distribution method: `Public distribution`
- Confirm the app is not blocked by the Billing API distribution restriction
- Reinstall the app after major scope or auth changes

## Access Scopes

Current repo scopes:

- `read_products`
- `read_orders`
- `write_orders`
- `read_customers`

Scope note:

- `write_orders` is retained because VedaSuite can add review-oriented order tags from the fraud workflow.
- `write_products` has been removed from the app config because product price writes are not part of the reviewer-facing flow.

## Billing

Configure managed pricing to match the app experience:

- Trial
- Starter
- Growth
- Pro

Verify:

- prices match the in-app plan cards
- plan names match the billing names merchants see
- test mode is disabled in production

## Compliance and Webhooks

Configured webhook topics in the repo:

- `orders/create`
- `orders/updated`
- `customers/create`
- `customers/update`
- `app_subscriptions/update`
- `app/uninstalled`
- `customers/data_request`
- `customers/redact`
- `shop/redact`

Confirm these are reflected in the linked production app config.

## Protected Customer Data

Because VedaSuite AI processes customer, refund, fraud, and order-linked data, complete the protected customer data section carefully.

Be ready to explain:

- why customer/order data is needed
- how data is used for fraud scoring and shopper trust scoring
- how redact and data request workflows are handled
- how access is limited and logged

## Public URLs

Replace placeholders if needed, then paste into Partner Dashboard:

- Privacy policy URL: `/legal/privacy`
- Terms of service URL: `/legal/terms`
- Support URL: `/support`
- Support email: `abhimanyu@vedasuite.in`

## App Listing Assets

Prepare and upload:

- app icon
- desktop screenshots
- short feature descriptions
- pricing explanation
- demo/reviewer instructions

## Final Before Submit

- reinstall and test on a clean store
- test billing on the production-linked app
- verify compliance and uninstall webhooks
- verify session-token protected APIs work in the embedded app
- verify no placeholder legal/support values remain

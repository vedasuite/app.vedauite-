# Reviewer Walkthrough

This walkthrough is intended for Shopify App Review or internal launch QA.

## Core Review Path

1. Install VedaSuite AI in a Shopify dev store.
2. Open the app from Shopify Admin.
3. Verify the dashboard loads inside the embedded admin.
4. Open each module from the left navigation:
   - Dashboard
   - Fraud Intelligence
   - Competitor Intelligence
   - AI Pricing Strategy
   - AI Profit Optimization
   - Shopper Credit Score
   - Reports
   - Settings
   - Subscription Plans
5. Open Subscription Plans and trigger a billing selection.
6. Confirm the billing redirect opens correctly outside the iframe.
7. Return to the app and verify plan access updates.
8. Open Dashboard and test:
   - Sync live Shopify data
   - Register sync webhooks
9. Confirm support and legal URLs are reachable.

## What Reviewers Should Notice

- The app is embedded and uses Shopify-style UI patterns.
- Billing is handled via Shopify Billing.
- Compliance webhooks are supported.
- App uninstall and subscription lifecycle flows are handled.
- Session-token protected APIs are used for embedded requests.

## Demo Notes

- Competitor Intelligence includes website ingestion plus connector-style market signals for Google Shopping and Meta Ad Library.
- Some seeded/demo records may appear on first use before live Shopify data fills the store.
- Compliance export files are generated server-side and should use durable storage in production.

## Suggested Screenshot Set

- dashboard overview
- fraud module with flagged orders
- competitor module with connector cards
- pricing strategy recommendation review
- profit optimization table
- subscription plan screen
- settings page
- support page

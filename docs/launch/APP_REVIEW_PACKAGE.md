# Shopify App Review Package

This document is the operator-facing package for Shopify App Review preparation.

## App Summary

- App name: `VedaSuite AI`
- Type: `Embedded Shopify app`
- Core value: AI commerce intelligence suite covering fraud detection, competitor monitoring, pricing intelligence, shopper credit scoring, and profit optimization.

## Main Features

- Dashboard with suite KPIs
- Fraud Intelligence
- Competitor Intelligence
- AI Pricing Strategy
- Shopper Credit Score
- AI Profit Optimization Engine
- Weekly Reports
- Settings
- Subscription Plans with Shopify Billing

## Billing Plans

- `Trial`
- `Starter`
- `Growth`
- `Pro`

## Reviewer Guidance

Reviewers should test:

1. Install the app in a dev store.
2. Open the embedded app from Shopify Admin.
3. Confirm Dashboard loads.
4. Open each module from the left navigation.
5. Visit Subscription Plans and test billing entry.
6. Confirm webhooks and live sync can be triggered from the dashboard.

## Notes About Current Product State

- Competitor Intelligence includes website ingestion and connector-style signals for Google Shopping and Meta Ad Library.
- Some data may be seeded for new stores before live sync fills the store dataset.
- Compliance exports are currently written to backend runtime storage and should be moved to durable storage before production launch.

## Required Submission Assets

- App icon
- At least one desktop screenshot
- Billing explanation
- Privacy policy URL
- Terms of service URL
- Support email
- Support URL
- Demo/reviewer instructions

## Support Contact

- Support email: `abhimanyu@vedasuite.in`
- Support URL: replace with production support page

## Risk Notes

- Protected customer data review is required because the app processes customer, refund, order, and fraud-related data.
- Billing must be tested on the production app configuration, not only the dev tunnel configuration.

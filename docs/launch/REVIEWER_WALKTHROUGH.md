# Reviewer Walkthrough

This walkthrough is intended for Shopify App Review or internal launch QA.

## Core Review Path

1. Install VedaSuite AI in a Shopify dev store.
2. Open the app from Shopify Admin.
3. Verify the dashboard loads inside the embedded admin and does not break on refresh.
4. Open each module from the left navigation:
   - Dashboard
   - Trust & Abuse Intelligence
   - Competitor Intelligence
   - Pricing & Profit Engine
   - Reports
   - Settings
   - Subscription Plans
5. Open `/api/shopify/diagnostics` from the embedded app session and confirm:
   - install exists
   - offline token is present
   - reconnect is not required
   - webhook status is visible
   - sync status is visible
   - billing status is visible
6. Open Dashboard and test:
   - Update store insights
   - Verify Shopify connection
7. Trigger one real module workflow:
   - Trust & Abuse: review queue/timeline
   - Competitor Intelligence: add `gymshark.com` or `allbirds.com`, run analysis, then review matched products or the no-match result
   - Pricing & Profit: review AI-generated recommendation or baseline state
8. Open Subscription Plans and trigger a billing selection.
9. Confirm the billing redirect opens correctly outside the iframe.
10. Return to the app and verify plan access updates.
11. Confirm support and legal URLs are reachable.

## What Reviewers Should Notice

- The app is embedded and uses Shopify-style UI patterns.
- Billing is handled via Shopify Billing and reflects plan changes back in the embedded app.
- Compliance webhooks are supported.
- App uninstall and subscription lifecycle flows are handled.
- Embedded requests authenticate cleanly while server-admin operations use the stored offline installation.
- Reviewer-facing health and launch checks are factual, not score-based.

## Reviewer Notes

- Use a real public competitor domain such as `gymshark.com` or `allbirds.com`.
- The review-safe claims are competitor pricing analysis, refund risk analysis, customer risk insights, and AI-generated pricing suggestions.
- Beta integrations are disclosed as beta and are not required for the primary review path.

## Suggested Screenshot Set

- dashboard overview
- trust & abuse module
- competitor module with a tracked domain
- pricing & profit recommendation review
- subscription plan screen
- settings page
- support page

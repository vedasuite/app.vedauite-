# Onboarding UX Simplification Report

## What was removed

- Removed the duplicate hero-style title block inside the page content.
- Removed the redundant dashboard CTA pair by dropping `Skip to dashboard`.
- Removed the detailed module explorer actions from onboarding.
- Removed separate `Data requirements`, `Permissions and access`, and `Setup health` sections competing for attention.
- Reduced the feature-promo feeling of the onboarding page by removing oversized benefit chips from the top area.

## What was merged

- Merged data requirements, permissions, and setup health into one `Data and permissions` section.
- Kept billing as a compact summary instead of a larger management-style card.
- Kept setup flow explanation lightweight and separated it from the main progress checklist.

## New onboarding flow

1. Page header
   - one title
   - one subtitle
   - one primary action
   - one billing CTA
   - dashboard CTA appears only after onboarding is complete
2. Setup progress
   - primary focus area
   - progress percent
   - current step
   - cleaner checklist with one clear action at a time
3. What VedaSuite helps with
   - concise 3-card informational summary
4. Choose starting module
   - lightweight selector tied to the next workflow
5. Data and permissions
   - single scan-friendly explanation of what data is read and why
6. Billing summary
   - compact plan/unlocked/locked summary with CTA to billing
7. Completion state
   - explicit success banner with dashboard action and optional next recommended module action

## QA checklist

1. Confirm the page shows only one main title.
2. Confirm there is no `Open Dashboard` plus `Skip to dashboard` duplication.
3. Confirm `Setup progress` is the most prominent content block.
4. Confirm module explanation cards are informational and not ambiguous navigation controls.
5. Confirm `Data and permissions` contains:
   - what Shopify data is read
   - why it is needed
   - current sync/webhook status
6. Confirm billing stays compact and links to `/app/billing`.
7. Confirm completed onboarding shows a success section with dashboard access.
8. Confirm the page feels like guided setup rather than a landing page or mini-dashboard.

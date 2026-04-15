# Shopify Reviewer Test Guide

This guide is written for Shopify reviewers and internal pre-submit checks. It describes the shortest reliable path through VedaSuite AI.

## Review Store Notes

- Install the app in a Shopify review store with products, customers, and a small order history if available.
- The app is embedded and should be opened from Shopify Admin, not from a standalone browser tab.
- If the store has no meaningful catalog or order history yet, the app should still show factual setup and empty states.

## 1. Install The App

1. Install `VedaSuite AI`.
2. Open the app from Shopify Admin.
3. Expected behavior:
   - the embedded shell loads
   - onboarding opens for first-run stores
   - no blank white page persists
   - no browser escape is required for normal use

## 2. Verify The Main Embedded Routes

Open each route from inside the embedded app:

- `/app/onboarding`
- `/app/dashboard`
- `/app/fraud-intelligence`
- `/app/competitor-intelligence`
- `/app/ai-pricing-engine`
- `/app/billing`
- `/app/settings`

Expected behavior:

- each route loads its own page
- the sidebar active state matches the current route
- refreshing the browser on any route returns to the same route successfully

## 3. First-Run Journey

On a newly installed store:

1. Open `Onboarding`
2. Review connection and setup progress
3. Run the first sync from onboarding or dashboard

Expected behavior:

- onboarding explains what VedaSuite does
- setup status is factual
- the app does not claim competitor or pricing readiness before data exists

## 4. Dashboard Verification

1. Open `Dashboard`
2. Click `Sync live Shopify data`

Expected behavior:

- the sync button shows an in-flight state
- dashboard refresh feedback appears after sync
- the page explains whether visible values changed or not
- quick access cards align with the latest module readiness

## 5. Fraud Intelligence

1. Open `Fraud Intelligence`
2. Review the top summary row and action queue

Expected behavior:

- the page loads without a crash
- risky orders and review actions are clearly separated from lower-priority information
- customer labels are masked rather than exposing raw contact details unnecessarily

## 6. Competitor Intelligence

1. Open `Competitor Intelligence`
2. If no competitor domains are configured, use the setup action
3. If domains exist, run a refresh

Expected behavior:

- one primary monitoring state is shown at a time
- no contradictory stale / healthy / no-match messages appear together
- if no comparable products are found, the page explains that clearly

## 7. AI Pricing Engine

1. Open `AI Pricing Engine`
2. Review the state banner and recommendation section

Expected behavior:

- the page never hangs indefinitely in loading
- only one state is shown at a time: loading, empty, ready, or failed
- if recommendations are not ready, the page explains what data is still needed

## 8. Billing Flow

1. Open `Billing`
2. Review the current plan and available plans
3. Trigger a plan change
4. Approve the change in Shopify billing
5. Return to the embedded app

Expected behavior:

- billing shows one truthful current plan state
- pending approval resolves after confirmation
- the updated plan is reflected in module access and upgrade badges

## 9. Diagnostics And Compliance

From an authenticated embedded session, open:

- `/api/shopify/diagnostics`

Expected behavior:

- installation is found
- connection is healthy or clearly actionable
- webhook registration status is visible
- billing and sync states are populated

Public pages:

- `https://app.vedasuite.in/legal/privacy`
- `https://app.vedasuite.in/legal/terms`
- `https://app.vedasuite.in/support`
- `https://app.vedasuite.in/launch/audit`

Expected behavior:

- all pages load successfully
- privacy/support information is present
- audit output shows compliance and configuration checks

## 10. Expected Empty-State Behavior

If the review store has limited live data:

- onboarding should still explain setup clearly
- dashboard should show partial or collecting-data states
- competitor should explain missing domains or no matches
- pricing should explain whether store data or competitor data is still needed

These are valid outcomes as long as the app remains truthful and actionable.

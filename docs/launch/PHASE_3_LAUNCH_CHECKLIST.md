# Phase 3 Launch Checklist

This checklist covers the final non-trivial work required before submitting VedaSuite AI to Shopify App Review and operating it as a production app.

## Partner Dashboard

- Confirm the app is set to `Public distribution`.
- Confirm `embedded = true` behavior is working in the connected Shopify app.
- Re-link the app config if needed using Shopify CLI so `shopify.app.toml` reflects the real app.
- Verify redirect URLs exactly match the production app URL.
- Verify app scopes match the minimum required surface.
- Confirm billing plans and managed pricing configuration are aligned with the in-app plans.
- Complete protected customer data declarations and access justification.
- Add the privacy policy URL.
- Add the terms of service URL.
- Add the support contact email and support URL.
- Upload app icon and required listing images.

## Final QA

- Install app on a clean dev store.
- Confirm OAuth install flow completes without manual URL edits.
- Confirm reauthorization works after token invalidation.
- Confirm session-token protected APIs load correctly after install.
- Confirm embedded navigation works without losing `shop` or `host`.
- Confirm billing upgrade to Starter works.
- Confirm billing upgrade to Growth works.
- Confirm billing upgrade to Pro works.
- Confirm cancel and downgrade flows work.
- Confirm sidebar module locks/unlocks after plan changes.
- Confirm uninstall webhook removes store data correctly.
- Confirm compliance webhooks respond successfully.
- Confirm dashboard sync works manually.
- Confirm webhook auto-sync works after order/customer changes.
- Confirm app handles expired/stale access tokens by reauthorizing cleanly.

## Production Operations

- Configure production database backups.
- Configure production log aggregation for backend JSON logs.
- Configure alerting for repeated 401s, webhook failures, and Prisma errors.
- Ensure compliance export files are stored in a durable, access-controlled location.
- Define retention policy for compliance exports and application logs.
- Review error budgets and incident contact ownership.

## App Review Package

- Record a short install and usage demo video.
- Prepare reviewer instructions for:
  - install
  - billing plan selection
  - test flows
  - key feature entry points
- List any features that are demo-mode, simulated, or require external connectors.
- Provide test store access or review steps if needed.

## Go/No-Go

- No critical backend errors for install, billing, or webhook flows.
- No broken module routes.
- No missing auth/session-token failures in the embedded app.
- No invalid app distribution or billing restrictions.
- Legal/support links published and reachable.

# Final Shopify Submission Status

Timestamp: `2026-05-05T18:26:00+05:30`

## Latest code state

- Active app repo: `app-repo`
- Latest pushed GitHub commit before this local blocker-fix batch: `da386d1`
- Current status of this Starter-switch fix batch: local changes verified, not yet owner-live-QA verified

## Local code verification

- Status: PASS
- Backend build: PASS
- Frontend build: PASS
- Prisma validate: PASS
- Prisma generate: PASS

## Local regression test status

Executed directly with `node tests\\*.test.cjs` because `node --test` in this local environment hits `spawn EPERM`.

- `appStateRoutes.test.cjs`: PASS
- `appStateService.test.cjs`: PASS
- `billing-capabilities.test.cjs`: PASS
- `billingLifecycle.test.cjs`: PASS
- `bootstrapService.test.cjs`: PASS
- `competitorService.test.cjs`: PASS
- `dashboardConsistency.test.cjs`: PASS
- `feature-gating.test.cjs`: PASS
- `launch-smoke.test.cjs`: PASS
- `merchantLabels.test.cjs`: PASS
- `module-api-routes.test.cjs`: PASS
- `pricingEngineStateService.test.cjs`: PASS
- `pricingProfitOverview.test.cjs`: PASS
- `pricingProfitRoutes.test.cjs`: PASS
- `privacy-safety.test.cjs`: PASS
- `readinessEngineService.test.cjs`: PASS
- `shopify-connection-service.test.cjs`: PASS
- `shopify-routes-auth.test.cjs`: PASS
- `trustAbuseOverview.test.cjs`: PASS
- `frontend/tests/backendModuleAccess.test.cjs`: PASS
- `backend/tests/starterModuleRoutes.test.cjs`: PASS
- `frontend/tests/starterModuleMutation.test.cjs`: PASS

## Starter switching verification

- Starter fraud path: PASS
  - Verified by `billing-capabilities.test.cjs` and `feature-gating.test.cjs`
- Starter competitor path: PASS
  - Verified by `billing-capabilities.test.cjs` and `feature-gating.test.cjs`
- Starter fraud -> competitor switch: PASS
  - Verified by canonical entitlement swap test, starter-module route test, and frontend local-mutation decision test
- Starter competitor -> fraud switch: PASS
  - Verified by canonical entitlement swap test, starter-module route test, and frontend local-mutation decision test

## Production deployment readiness

- Active production app config: `app-repo/shopify.app.toml`
- Production app URL: `https://app.vedasuite.in`
- Embedded mode: enabled
- OAuth callback URL: `https://app.vedasuite.in/auth/callback`
- Production-safe backend deploy flow:
  1. `npx prisma generate`
  2. `npx prisma migrate deploy`
  3. `npm run build`
- Do not use `prisma db push --accept-data-loss` in production

## Blockers addressed in this pass

- Starter fraud vs Starter competitor entitlement switching
- Backend and frontend canonical module-key alignment
- Backend billing logs added for Starter-module request, confirmation, save, and app-state entitlement resolution
- Frontend module access now prefers backend app-state entitlements instead of stale subscription fallbacks for Starter access

## Live Shopify QA

- Status: OWNER ACTION REQUIRED
- Owner script: [LIVE_QA_OWNER_SCRIPT.md](/C:/Users/Abhimanyu/OneDrive/Desktop/untitled%20folder/vedasuite-shopify-app/app-repo/LIVE_QA_OWNER_SCRIPT.md)
- Evidence template: [LIVE_QA_EVIDENCE_TEMPLATE.md](/C:/Users/Abhimanyu/OneDrive/Desktop/untitled%20folder/vedasuite-shopify-app/app-repo/LIVE_QA_EVIDENCE_TEMPLATE.md)

Owner must still verify in the deployed embedded app:

1. Starter fraud unlocks fraud and locks competitor, pricing, and profit
2. Starter competitor unlocks competitor and locks fraud, pricing, and profit
3. Switching Starter fraud to Starter competitor updates access immediately after billing return
4. Switching Starter competitor to Starter fraud updates access immediately after billing return
5. Billing redirect and billing return never show a blank white screen
6. Dashboard, fraud, and evidence views never expose internal order IDs
7. Dashboard recent insights do not show synthetic shopper strings or internal-looking order labels
8. Competitor locked state shows upgrade-only state instead of stale operational data
9. Competitor unlocked but not-configured state shows setup guidance
10. Pricing hides projected gain when data is insufficient

## Final Shopify submission

- Status: NO

Why:

- Local code verification is complete and passing.
- Final Shopify submission must remain blocked until the owner completes live Shopify QA and records evidence for the remaining real-store flows.

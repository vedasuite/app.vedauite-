## Repository name
vedasuite-shopify-app (app-repo)

## Purpose
Embedded Shopify admin app for merchants. Provides onboarding, dashboard,
pricing/profit tooling, competitor tracking, fraud/readiness explainability,
and billing (trial + paid plans).

## GitHub repository
https://github.com/vedasuite/app.vedauite-.git

## Production URL
Driven by the `SHOPIFY_APP_URL` environment variable (value managed in Render,
not stored in this repo).

## Deployment platform
Render.

## Default branch
main

## Owner
VedaSuite

## Never place Shopify app code here? (Yes/No)
No — this repository IS the Shopify app.

## Never place website code here? (Yes/No)
Yes.

## Dependencies
Prisma + PostgreSQL (`DATABASE_URL`), Shopify Admin API, JWT-based session
handling, Express backend + Vite/React frontend.

## Important warnings
- Root-level `package.json` / `package-lock.json` (monorepo build/start
  scripts) are not tracked in git — verify Render's actual build/start
  commands and root directory in the dashboard rather than assuming these
  local scripts are what runs in production.
- A stale duplicate clone of this repository previously existed at
  `Desktop/vedasuite-app`. It has been retired and renamed to
  `Desktop/RETIRED-vedasuite-app-2026-08-03` (2026-08-03). Do not deploy,
  push, or develop from that path — it is kept only for reference and is not
  the canonical copy.

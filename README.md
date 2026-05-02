## VedaSuite AI

VedaSuite AI is the active Shopify embedded app codebase for fraud review, competitor monitoring, pricing guidance, customer-risk analysis, and profit workflows inside Shopify Admin.

This `app-repo` directory is the build and deploy source of truth. Historical patch reports have been archived in [`docs/archive/reports`](./docs/archive/reports) so the working repo reflects the live architecture rather than old interim fixes.

### Stack

- Frontend: React, TypeScript, Shopify Polaris, Shopify App Bridge
- Backend: Node.js, Express, TypeScript
- Database: PostgreSQL with Prisma
- Billing and auth: Shopify OAuth plus Shopify Billing API

### Structure

```text
app-repo/
  backend/
    prisma/
    src/
    tests/
  docs/
    archive/
      reports/
  frontend/
    src/
  shopify.app.toml
```

### Required production configuration

- App URL: `https://app.vedasuite.in`
- OAuth callback: `https://app.vedasuite.in/auth/callback`
- Embedded app: `true`
- Shopify scopes: `read_products,read_orders,write_orders,read_customers,write_own_subscription`

Only request `write_products` if live Shopify price publishing is enabled in the deployment you are shipping.
Use `npx prisma migrate deploy` in production deploys. Do not use `prisma db push --accept-data-loss` against live merchant databases.

### Backend quick start

```bash
cd backend
npm install
npx prisma generate
npx prisma validate
npm run build
```

### Frontend quick start

```bash
cd frontend
npm install
npm run build
```

### Operational notes

- Sample data must stay disabled in production unless it is explicitly labeled as sample preview content.
- Billing, entitlement, and feature gating are backend-authoritative.
- Dashboard, onboarding, and module readiness should be validated from the shared readiness and billing services before release.

### Approval docs

- Final fix report: [`APPROVAL_READINESS_FIX_REPORT.md`](./APPROVAL_READINESS_FIX_REPORT.md)
- Manual QA checklist: [`SHOPIFY_APPROVAL_QA_CHECKLIST.md`](./SHOPIFY_APPROVAL_QA_CHECKLIST.md)

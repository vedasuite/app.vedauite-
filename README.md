## VedaSuite AI – Shopify Embedded App

VedaSuite AI is an **AI Commerce Intelligence Suite for Shopify merchants** that combines **fraud detection**, **competitor intelligence**, **AI pricing**, **shopper credit scoring**, and **profit optimization** in a single embedded Shopify app.

This repository is structured as a **Suite App**: one installation, multiple modules controlled by feature flags and subscription plans.

### Tech Stack
- **Frontend**: React, TypeScript, Shopify Polaris, Shopify App Bridge
- **Backend**: Node.js, Express, TypeScript
- **Database**: PostgreSQL (via Prisma ORM)
- **Auth & Billing**: Shopify OAuth, Shopify Billing API
- **Hosting**: Ready for Vercel or AWS (frontend + backend separately or together via container)

---

### Repository Structure

```text
vedasuite-shopify-app/
  backend/
    src/
      app.ts
      server.ts
      config/
        env.ts
        shopify.ts
        billing.ts
      db/
        prismaClient.ts
        migrations/   # optional, for SQL migrations if needed
      middleware/
        shopifyAuth.ts
        shopifyWebhook.ts
        errorHandler.ts
      routes/
        index.ts
        authRoutes.ts
        billingRoutes.ts
        dashboardRoutes.ts
        fraudRoutes.ts
        competitorRoutes.ts
        pricingRoutes.ts
        creditScoreRoutes.ts
        profitRoutes.ts
        reportsRoutes.ts
        settingsRoutes.ts
        subscriptionRoutes.ts
      services/
        dashboardService.ts
        fraudService.ts
        competitorService.ts
        pricingService.ts
        creditScoreService.ts
        profitService.ts
        reportsService.ts
        settingsService.ts
        subscriptionService.ts
      types/
        shopify.ts
    prisma/
      schema.prisma
    package.json
    tsconfig.json

  frontend/
    src/
      main.tsx
      App.tsx
      shopifyAppBridge.ts
      api/client.ts
      layout/
        AppFrame.tsx
      modules/
        Dashboard/
          DashboardPage.tsx
        FraudIntelligence/
          FraudPage.tsx
        CompetitorIntelligence/
          CompetitorPage.tsx
        PricingStrategy/
          PricingPage.tsx
        CreditScore/
          CreditScorePage.tsx
        ProfitOptimization/
          ProfitPage.tsx
        Reports/
          ReportsPage.tsx
        Settings/
          SettingsPage.tsx
        SubscriptionPlans/
          SubscriptionPage.tsx
    package.json
    tsconfig.json
    vite.config.ts
```

---

### Backend – Quick Start

1. **Install dependencies**
   ```bash
   cd backend
   npm install
   ```

2. **Configure environment**
   Create a `.env` file in `backend/`:
   ```bash
   SHOPIFY_API_KEY=your_app_api_key
   SHOPIFY_API_SECRET=your_app_api_secret
   SHOPIFY_SCOPES=read_orders,write_orders,read_products,write_customers,read_customers,read_price_rules
   SHOPIFY_APP_URL=https://your-tunnel-or-production-url

   DATABASE_URL=postgresql://user:password@host:5432/vedasuite

   BILLING_PLAN_TRIAL_DAYS=3
   BILLING_PLAN_STARTER_PRICE=19.0
   BILLING_PLAN_GROWTH_PRICE=49.0
   BILLING_PLAN_PRO_PRICE=99.0
   ```

3. **Prisma migrate & generate**
   ```bash
   npx prisma migrate dev --name init
   npx prisma generate
   ```

4. **Run backend in development**
   ```bash
   npm run dev
   ```

The backend exposes:
- `GET /health` – health check
- `/auth/*` – Shopify OAuth installation and callback
- `/billing/*` – Shopify Billing API interactions and plan management
- `/api/*` – JSON APIs for each module (fraud, competitor, pricing, credit score, profit, reports, settings).

---

### Frontend – Quick Start

1. **Install dependencies**
   ```bash
   cd frontend
   npm install
   ```

2. **Configure environment**
   Create `.env` in `frontend/`:
   ```bash
   VITE_SHOPIFY_API_KEY=your_app_api_key
   VITE_BACKEND_URL=https://your-backend-url
   ```

3. **Run frontend in development**
   ```bash
   npm run dev
   ```

The React app:
- Uses **Shopify App Bridge** for embedded context and auth.
- Uses **Polaris** components for a native Shopify Admin look.
- Talks to the backend via `/api/*` endpoints, passing the `shop` and session information managed by App Bridge.

---

### Core Modules & APIs

- **Dashboard**
  - `GET /api/dashboard/metrics` – high-level KPIs (fraud alerts, high-risk orders, competitor changes, pricing suggestions, profit opportunities).

- **Fraud & Return Abuse Intelligence**
  - `GET /api/fraud/orders` – list recent orders with fraud scores.
  - `POST /api/fraud/score` – compute fraud score for a given order.
  - `POST /api/fraud/action` – merchant actions: allow, flag, block, manual review.
  - Optional **Shared Fraud Intelligence Network** flag at store level to share anonymized signals.

- **Competitor Intelligence**
  - `GET /api/competitor/overview` – competitor price/promotions summary.
  - `GET /api/competitor/products` – tracked products and competitor prices.
  - `POST /api/competitor/domains` – configure competitor tracking domains.

- **AI Pricing Strategy**
  - `GET /api/pricing/recommendations` – AI-driven price recommendations.
  - `POST /api/pricing/simulate` – what-if analysis for pricing changes.

- **Shopper Credit Score**
  - `GET /api/credit-score/customers` – list customers with scores.
  - `GET /api/credit-score/customer/:id` – detail view for a customer’s score and reasons.

- **AI Profit Optimization Engine** (Pro Plan only)
  - `GET /api/profit/recommendations` – optimal price, margin improvement, profit projections.
  - `GET /api/profit/opportunities` – discounts, bundles, and promotion suggestions.

- **Reports**
  - `GET /api/reports/weekly` – weekly combined report for fraud, competitor, pricing, profit.

- **Settings & Subscription**
  - `GET/POST /api/settings` – fraud sensitivity, competitor domains, pricing strategy, profit optimization params.
  - `GET /api/subscription/plan` – current plan and allowed modules.
  - `POST /api/subscription/change` – request plan upgrade/downgrade (handled via Shopify Billing).

---

### Database Schema (Prisma Overview)

Core models (simplified):
- `Store` – one row per Shopify store / installation.
- `Customer` – mapped to Shopify customers with Shopper Credit Score.
- `Order` – high-level order info plus fraud score.
- `FraudSignal` – normalized fraud signal record (IP, email, payment fingerprint, etc.).
- `CompetitorData` – competitor prices, promotions, ads, stock signals.
- `PriceHistory` – historical price and recommendation records.
- `ProfitOptimizationData` – cost, price, ad spend, returns, profit predictions.
- `SubscriptionPlan` + `StoreSubscription` – plan definitions and store’s active subscription.

See `backend/prisma/schema.prisma` for exact field definitions.

---

### Deployment Notes

- **Backend**
  - Can be deployed to **Vercel serverless functions**, **Render**, **Heroku**, or **AWS ECS/Lambda**.
  - Make sure `SHOPIFY_APP_URL` points to the HTTPS root that Shopify calls for OAuth and loads the app.

- **Frontend**
  - Deployed as static assets (Vercel, S3 + CloudFront, Netlify, etc.).
  - The embedded app URL in the Shopify Partners dashboard should point to the backend entry that renders the React app (or proxies to it).

---

### Development Notes

- The codebase is designed to be:
  - **Modular** – each module (Fraud, Competitor, Pricing, Credit Score, Profit) has dedicated service and route files.
  - **Extensible** – adding new modules is as simple as adding new services, routes, and a Polaris page.
  - **Testable** – business logic is isolated in services that can be unit-tested without Shopify or Express.

---

### Launch Docs

Launch and review packaging docs are included here:

- [Phase 3 Launch Checklist](C:\Users\Abhimanyu\OneDrive\Desktop\untitled folder\vedasuite-shopify-app\docs\launch\PHASE_3_LAUNCH_CHECKLIST.md)
- [App Review Package](C:\Users\Abhimanyu\OneDrive\Desktop\untitled folder\vedasuite-shopify-app\docs\launch\APP_REVIEW_PACKAGE.md)
- [Launch Readiness Summary](C:\Users\Abhimanyu\OneDrive\Desktop\untitled folder\vedasuite-shopify-app\docs\launch\LAUNCH_READINESS_SUMMARY.md)
- [Privacy Policy Placeholder](C:\Users\Abhimanyu\OneDrive\Desktop\untitled folder\vedasuite-shopify-app\PRIVACY_POLICY.md)
- [Terms of Service Placeholder](C:\Users\Abhimanyu\OneDrive\Desktop\untitled folder\vedasuite-shopify-app\TERMS_OF_SERVICE.md)
- [Support Guide](C:\Users\Abhimanyu\OneDrive\Desktop\untitled folder\vedasuite-shopify-app\SUPPORT.md)
- [Security Reporting Guide](C:\Users\Abhimanyu\OneDrive\Desktop\untitled folder\vedasuite-shopify-app\SECURITY.md)

---

### Production Domain Values

Use these exact production values during deployment and Shopify configuration:

- App URL: `https://app.vedasuite.in`
- OAuth redirect URL: `https://app.vedasuite.in/auth/callback`
- Privacy Policy URL: `https://app.vedasuite.in/legal/privacy`
- Terms of Service URL: `https://app.vedasuite.in/legal/terms`
- Support URL: `https://app.vedasuite.in/support`

Use [backend/.env.example](C:\Users\Abhimanyu\OneDrive\Desktop\untitled folder\vedasuite-shopify-app\app-repo\backend\.env.example) as the source of truth for Render environment variables.


# VedaSuite Billing Flow Audit

Date: 2026-04-08

## Current DB source of truth

- Primary current-plan record: `StoreSubscription` in [schema.prisma](/C:/Users/Abhimanyu/OneDrive/Desktop/untitled%20folder/vedasuite-shopify-app/app-repo/backend/prisma/schema.prisma)
- Plan catalog: `SubscriptionPlan`
- Billing audit trail: `BillingAuditLog`
- Store-level install/session truth: `Store`
- Current normalized billing resolver: `resolveBillingState(shop)` in [subscriptionService.ts](/C:/Users/Abhimanyu/OneDrive/Desktop/untitled%20folder/vedasuite-shopify-app/app-repo/backend/src/services/subscriptionService.ts)

## Current Shopify source of truth

- App subscription create mutation: `createAppSubscription()` in [shopifyAdminService.ts](/C:/Users/Abhimanyu/OneDrive/Desktop/untitled%20folder/vedasuite-shopify-app/app-repo/backend/src/services/shopifyAdminService.ts)
- Active subscription lookup: `getActiveAppSubscription()`
- Cancel mutation: `cancelAppSubscription()`
- Webhook-driven reconciliation: `reconcileStoreSubscriptionFromWebhook()` via `APP_SUBSCRIPTIONS_UPDATE`

## Plan enum definitions

- Backend shared enum/constants:
  - [capabilities.ts](/C:/Users/Abhimanyu/OneDrive/Desktop/untitled%20folder/vedasuite-shopify-app/app-repo/backend/src/billing/capabilities.ts)
- Frontend shared enum/constants:
  - [billingCapabilities.ts](/C:/Users/Abhimanyu/OneDrive/Desktop/untitled%20folder/vedasuite-shopify-app/app-repo/frontend/src/lib/billingCapabilities.ts)
- Supported plans:
  - `NONE`
  - `TRIAL`
  - `STARTER`
  - `GROWTH`
  - `PRO`

## Existing routes

### Backend

- Public billing routes in [billingRoutes.ts](/C:/Users/Abhimanyu/OneDrive/Desktop/untitled%20folder/vedasuite-shopify-app/app-repo/backend/src/routes/billingRoutes.ts)
  - `POST /billing/create-recurring`
  - `GET /billing/start`
  - `GET /billing/activate`
- Subscription routes in [subscriptionRoutes.ts](/C:/Users/Abhimanyu/OneDrive/Desktop/untitled%20folder/vedasuite-shopify-app/app-repo/backend/src/routes/subscriptionRoutes.ts)
  - `GET /api/subscription/plan`
  - `POST /api/subscription/cancel`
  - `POST /api/subscription/downgrade-to-trial`
  - `POST /api/subscription/starter-module`
- Billing health/debug routes in [shopifyRoutes.ts](/C:/Users/Abhimanyu/OneDrive/Desktop/untitled%20folder/vedasuite-shopify-app/app-repo/backend/src/routes/shopifyRoutes.ts)
  - `GET /api/internal/debug/billing-health`
  - `GET /api/shopify/billing-health`
- Webhook handler in [shopifyWebhookRoutes.ts](/C:/Users/Abhimanyu/OneDrive/Desktop/untitled%20folder/vedasuite-shopify-app/app-repo/backend/src/routes/shopifyWebhookRoutes.ts)
  - `POST /webhooks/shopify/app_subscriptions_update`

### Frontend

- Billing UI page:
  - [SubscriptionPage.tsx](/C:/Users/Abhimanyu/OneDrive/Desktop/untitled%20folder/vedasuite-shopify-app/app-repo/frontend/src/modules/SubscriptionPlans/SubscriptionPage.tsx)
- Subscription state provider:
  - [SubscriptionProvider.tsx](/C:/Users/Abhimanyu/OneDrive/Desktop/untitled%20folder/vedasuite-shopify-app/app-repo/frontend/src/providers/SubscriptionProvider.tsx)
- Current navigation:
  - billing page exists at `/subscription`, but there is no first-class nav item in [AppFrame.tsx](/C:/Users/Abhimanyu/OneDrive/Desktop/untitled%20folder/vedasuite-shopify-app/app-repo/frontend/src/layout/AppFrame.tsx)

## Current frontend gaps

1. The billing page can start checkout, but it is not a full billing-management surface.
2. There is no persisted pending plan-switch intent before redirecting to Shopify approval.
3. The public callback updates DB directly, but there is no intent verification lifecycle.
4. There is no dedicated backend billing-management API that returns:
   - available actions
   - pending status
   - change/cancel state
5. Cancellation exists in backend, but there is no proper confirmation UX or explicit pending/result state.
6. The page still relies on query-based activation messaging and optimistic transitions more than it should.
7. There is no clean “awaiting Shopify approval / pending confirmation / failed / recovered” state model for billing changes.

## Current risks before implementation

1. Redirect return could be mistaken for billing success without a durable pending intent model.
2. Replacing one paid plan with another has no explicit pending transition tracking.
3. Billing callback and webhook both update subscription truth, but there is no explicit per-transition intent record tying them together.
4. Starter-module selection during plan activation is passed through query params only and is not persisted as a pending change intent before redirect.
5. The frontend current-plan UI is more capable than before, but it still does not provide a production-safe billing management flow for:
   - switching plans
   - awaiting confirmation
   - recovering incomplete approvals
   - verifying cancellation truth

## Missing flows to build

1. Pending billing intent persistence in DB
2. Backend `change-plan` API
3. Backend `cancel-plan` API with explicit confirmation semantics
4. Idempotent return confirmation path tied to the pending intent
5. Rich billing-management state endpoint for current plan + available actions + pending transition
6. Frontend billing page with:
   - current plan summary
   - plan cards
   - pending/failed/cancel confirmation states
   - starter-module selection on Starter checkout
   - backend-confirmed refresh after return from Shopify approval

## Implementation direction

- Keep `StoreSubscription` and `resolveBillingState(shop)` as the canonical active subscription truth.
- Add a durable pending billing intent model for plan switches.
- Route all plan management through backend APIs, not direct querystring-driven assumptions.
- Let the public billing callback verify actual Shopify subscription truth, then reconcile DB and finalize the pending intent.
- Keep webhook reconciliation active as the eventual-consistency safety path.

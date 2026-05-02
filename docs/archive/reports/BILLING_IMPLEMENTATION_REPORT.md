# VedaSuite Billing Implementation Report

Date: 2026-04-08

## Files changed

### Audit and documentation
- `BILLING_FLOW_AUDIT.md`
- `BILLING_IMPLEMENTATION_REPORT.md`

### Database and schema
- `backend/prisma/schema.prisma`
- `backend/prisma/migrations/20260408_billing_management_intents/migration.sql`

### Backend services
- `backend/src/services/billingManagementService.ts`
- `backend/src/services/subscriptionService.ts`

### Backend routes
- `backend/src/routes/billingRoutes.ts`
- `backend/src/routes/index.ts`
- `backend/src/routes/shopifyRoutes.ts`
- `backend/src/routes/subscriptionRoutes.ts`

### Frontend billing state and UI
- `frontend/src/providers/SubscriptionProvider.tsx`
- `frontend/src/hooks/useBillingFlash.ts`
- `frontend/src/layout/AppFrame.tsx`
- `frontend/src/components/ModuleGate.tsx`
- `frontend/src/lib/billingCapabilities.ts`
- `frontend/src/lib/subscriptionState.ts`
- `frontend/src/modules/SubscriptionPlans/SubscriptionPage.tsx`

### Tests
- `backend/tests/module-api-routes.test.cjs`

## Routes added or changed

### Added or completed
- `GET /api/billing/state`
- `POST /api/billing/change-plan`
- `POST /api/billing/cancel-plan`
- `POST /api/billing/confirm-return`

### Existing routes refactored into the new billing flow
- `POST /billing/create-recurring`
- `GET /billing/start`
- `GET /billing/activate`

### Existing debug routes extended
- `GET /api/internal/debug/billing-health`
- `GET /api/shopify/billing-health`
- `GET /api/shopify/diagnostics`
- `GET /api/subscription/plan`

## DB migrations added

### `20260408_billing_management_intents`

Adds `BillingPlanIntent` for durable pending billing transitions:
- requested plan
- requested starter module
- action type
- pending approval status
- confirmation URL
- Shopify charge id
- host / return path
- error code / message
- confirmed / cancelled / expired timestamps

Also links `Store` to billing intents.

## Webhook changes

The billing management flow now depends on the existing `APP_SUBSCRIPTIONS_UPDATE` webhook path plus a stronger normalized reconciliation model.

Behavior now enforced:
- webhook reconciliation updates the canonical local subscription record
- webhook reconciliation writes:
  - `lastBillingSyncAt`
  - `lastBillingWebhookProcessedAt`
  - `lastBillingResolutionSource`
  - `lastBillingSubscriptionName`
- cancelled subscriptions preserve period-end access truthfully when Shopify still allows access until the end of the cycle
- billing audit logs capture:
  - event type
  - previous and next plan
  - starter module changes
  - billing status
  - metadata such as charge id and period end

## Plan switching logic

Plan switching is now handled centrally in `billingManagementService`.

### Flow
1. Frontend calls `POST /api/billing/change-plan`
2. Backend resolves authenticated shop from embedded session
3. Backend validates requested plan and Starter module
4. Backend loads normalized current billing state
5. Backend decides whether the request is:
   - no-op
   - same-plan Starter module update
   - paid plan replacement requiring Shopify approval
6. Backend persists a `BillingPlanIntent` before redirecting the merchant
7. Backend creates the real Shopify app subscription confirmation URL
8. Frontend redirects merchant to Shopify approval
9. On return, backend confirms actual Shopify billing truth before finalizing the plan state

### Guarantees
- redirect return alone does not mark billing successful
- plan state is not switched optimistically in frontend
- pending intent is persisted before approval
- duplicate pending intents are avoided
- stale pending intents are superseded or expired safely

## Cancellation logic

Cancellation is now handled by `POST /api/billing/cancel-plan`.

### Flow
1. Frontend requires explicit confirmation
2. Backend finds the current active subscription
3. Backend cancels the Shopify app subscription with GraphQL
4. Backend updates local subscription state truthfully
5. If Shopify access remains active until period end:
   - `billingStatus` becomes `CANCELLED`
   - `active` stays `true` until `endsAt`
6. Billing audit log is recorded
7. Frontend refreshes from backend truth

## Callback and confirmation logic

Billing callback verification is now routed through:
- `GET /billing/activate`
- `POST /api/billing/confirm-return`

### Behavior
- callback loads the persisted billing intent
- backend verifies the actual active Shopify app subscription
- only after verification does backend mark the billing intent `CONFIRMED`
- starter module selection is finalized only after the STARTER subscription is truly confirmed
- frontend clears pending UI only after backend confirmation

## Starter module handling

Starter remains a one-module paid plan.

### Current behavior
- Starter requires module selection before plan request
- supported modules:
  - `trustAbuse`
  - `competitor`
- current Starter module is displayed in the billing UI
- same-plan Starter module changes route through backend
- backend respects existing Starter module cooldown logic in `subscriptionService`
- after confirmed STARTER billing, the selected module is persisted and reflected in feature gating

## Frontend UX changes

### Billing page
The billing page now shows:
- current plan
- active/inactive state
- billing status
- lifecycle state
- period end / renewal date
- trial end date
- current Starter module
- mismatch warnings
- all paid plans as actionable cards
- pending approval banner
- cancellation confirmation banner

### Navigation
- added `Billing` entry in app navigation

### Truthfulness changes
- frontend no longer derives success from redirect alone
- frontend no longer defaults missing plan state to `TRIAL`
- frontend no longer preserves stale paid state over backend-confirmed downgrade/trial/none
- module upgrade gates route merchants to the billing page using backend-confirmed plan state

## Remaining risks

1. Existing stores with unusual historical subscription rows may still need one clean reconcile cycle after the next billing webhook or billing-health fetch.
2. If Shopify approval is started and abandoned for a long time, the pending intent remains visible until it is superseded, expired, or completed. This is intentional for supportability.
3. If Shopify delays webhook delivery, the callback confirmation path still resolves truth directly from Shopify, but debug timestamps may show callback-based confirmation before webhook freshness updates.

## Manual test checklist

### Current plan view
1. Open `/subscription`
2. Confirm current plan, billing status, active state, and dates render
3. Confirm current Starter module is shown only when relevant

### Upgrade
1. Start from `NONE`, `TRIAL`, `STARTER`, or `GROWTH`
2. Choose a higher plan on `/subscription`
3. Confirm the UI shows pending approval, not fake success
4. Approve in Shopify
5. Return to the app
6. Confirm `/api/internal/debug/billing-health` shows the new effective plan

### Downgrade
1. Start from `PRO`
2. Choose `GROWTH` or `STARTER`
3. Approve in Shopify
4. Confirm backend reflects the downgraded plan
5. Confirm gated modules/features lock appropriately after refresh

### Cancel
1. Open `/subscription`
2. Click `Cancel subscription`
3. Confirm the warning step appears
4. Confirm cancellation
5. Verify backend returns updated state and `billing-health` reflects cancellation
6. If Shopify keeps access until period end, confirm UI shows cancelled lifecycle with the correct end date

### Return from Shopify billing approval
1. Start any plan change
2. Approve in Shopify
3. Confirm return lands in `/subscription`
4. Confirm success only appears after backend confirmation refresh

### Webhook verification
1. Trigger or wait for `APP_SUBSCRIPTIONS_UPDATE`
2. Open `/api/internal/debug/billing-health`
3. Confirm:
   - billing state is correct
   - webhook freshness fields are populated
   - no mismatch warning remains

### Backend billing-health verification
1. Open `/api/internal/debug/billing-health`
2. Confirm:
   - `dbPlan`
   - `effectivePlanUsedByFeatureGating`
   - `activeSubscriptionId`
   - `pendingIntent`
   - `mismatchWarnings`

### Feature gating verification
1. Switch from `PRO` to `GROWTH`
2. Confirm Pro-only features disappear after backend refresh
3. Switch from `GROWTH` to `STARTER`
4. Confirm only the selected Starter module remains available
5. Cancel or move to `NONE`
6. Confirm paid module routes show locked-plan behavior instead of stale paid access

## Example JSON responses

### `GET /api/subscription/plan`
```json
{
  "subscription": {
    "planName": "PRO",
    "price": 99,
    "trialDays": 3,
    "starterModule": null,
    "active": true,
    "endsAt": "2026-05-08T09:30:00.000Z",
    "trialStartedAt": "2026-04-01T09:30:00.000Z",
    "trialEndsAt": "2026-04-04T09:30:00.000Z",
    "status": "active_paid",
    "billingStatus": "ACTIVE",
    "starterModuleSwitchAvailableAt": null,
    "enabledModules": {
      "trustAbuse": true,
      "competitor": true,
      "pricingProfit": true,
      "reports": true,
      "settings": true,
      "fraud": true,
      "pricing": true,
      "creditScore": true,
      "profitOptimization": true
    },
    "featureAccess": {
      "shopperTrustScore": true,
      "returnAbuseIntelligence": true,
      "fraudReviewQueue": true,
      "supportCopilot": true,
      "evidencePackExport": true,
      "competitorMoveFeed": true,
      "competitorStrategyDetection": true,
      "weeklyCompetitorReports": true,
      "pricingRecommendations": true,
      "explainableRecommendations": true,
      "scenarioSimulator": true,
      "profitLeakDetector": true,
      "marginAtRisk": true,
      "dailyActionBoard": true,
      "advancedAutomation": true,
      "fullProfitEngine": true
    },
    "capabilities": {
      "billing.planManagement": true
    }
  },
  "billing": {
    "subscription": {
      "planName": "PRO"
    }
  }
}
```

### `POST /api/billing/change-plan`
Redirect-required response:
```json
{
  "result": {
    "outcome": "REDIRECT_REQUIRED",
    "confirmationUrl": "https://admin.shopify.com/store/example/charges/confirm?...",
    "pendingIntent": {
      "id": "cmabc123",
      "requestedPlanName": "GROWTH",
      "requestedStarterModule": null,
      "actionType": "CHANGE_PLAN",
      "status": "PENDING_APPROVAL",
      "confirmationUrl": "https://admin.shopify.com/store/example/charges/confirm?...",
      "errorMessage": null,
      "createdAt": "2026-04-08T10:45:00.000Z",
      "expiresAt": "2026-04-08T11:45:00.000Z"
    },
    "state": {
      "subscription": {
        "planName": "PRO"
      }
    }
  }
}
```

No-op or immediate update response:
```json
{
  "result": {
    "outcome": "UPDATED",
    "message": "Starter module updated.",
    "state": {
      "subscription": {
        "planName": "STARTER",
        "starterModule": "competitor"
      }
    }
  }
}
```

### `POST /api/billing/cancel-plan`
```json
{
  "result": {
    "subscription": {
      "planName": "PRO",
      "active": true,
      "status": "cancelled",
      "billingStatus": "CANCELLED",
      "endsAt": "2026-05-08T09:30:00.000Z"
    },
    "billing": {
      "planName": "PRO",
      "normalizedBillingStatus": "CANCELLED",
      "active": true,
      "status": "cancelled"
    }
  }
}
```

### `GET /api/internal/debug/billing-health`
```json
{
  "shop": "example.myshopify.com",
  "dbPlan": "PRO",
  "dbBillingStatus": "ACTIVE",
  "activeSubscriptionId": "gid://shopify/AppSubscription/123456789",
  "activeSubscriptionEndsAt": "2026-05-08T09:30:00.000Z",
  "lastBillingWebhookProcessedAt": "2026-04-08T10:49:00.000Z",
  "billingResolutionSource": "webhook_app_subscriptions_update",
  "effectivePlanUsedByFeatureGating": "PRO",
  "effectiveBillingStatus": "ACTIVE",
  "pendingIntent": null,
  "mismatchWarnings": []
}
```

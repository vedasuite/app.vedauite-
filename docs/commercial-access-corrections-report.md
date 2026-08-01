# Commercial Access Corrections — Implementation Report

Branch: `phase-1-intelligence-ui` · committed locally, **not pushed, not deployed**

## 1. Audit findings (before any change)

**Billing mechanism.** The app uses the **Shopify Billing API** —
`appSubscriptionCreate` with a `trialDays` argument
(`shopifyAdminService.ts`), called from `billingManagementService.ts` with
`trialDays: env.billing.trialDays`. It does **not** use Shopify managed App
Pricing. The trial was therefore implemented using the existing mechanism; no
parallel billing system was built.

**Root cause of the reported bug** (`planName=TRIAL` but every module locked),
in two places:

1. `backend/src/billing/capabilities.ts` → `buildCapabilities()` excluded TRIAL
   from every module gate:
   `fraudModule = isStarterTrust || isGrowth || isPro` — no TRIAL branch
   existed for fraud, competitor, pricing or profit. TRIAL only ever set the
   `billing.trialActive` flag, so it granted **zero** modules.
2. `subscriptionService.resolveEntitlements(shopDomain)` — the function the
   insights endpoint calls — re-resolved entitlements from the plan name and
   **never passed a trial flag at all**, so even a corrected
   `buildCapabilities` could not have reached the API.

**Schema.** No migration required. `SupportTicket.category` is a plain
`String`; `Store.trialStartedAt` / `trialEndsAt` and
`StoreSubscription.starterModule` / `billingStatus` already exist.

## 2. Files changed

| File | Change |
|---|---|
| `backend/src/billing/capabilities.ts` | Trial → Pro-equivalent via an `effectivePlan` override; `trialActive` threaded through `resolveEntitlements`; `pricing` added as a Starter module; legacy standalone `TRIAL` collapses to `NONE` once its window closes; `DEFAULT_TRIAL_DAYS` 3 → 7 |
| `backend/src/services/subscriptionService.ts` | `buildCanonicalEntitlements` computes `fullAccessTrial` and passes it down; retains the selected plan and Starter module through the trial; `resolveEntitlements(shop)` now derives modules from the canonical state instead of re-resolving |
| `backend/src/config/env.ts` | `BILLING_PLAN_TRIAL_DAYS` default 3 → 7 |
| `backend/src/services/supportService.ts` | `complaint` and `feedback` added to `SUPPORT_TICKET_CATEGORIES` |
| `frontend/src/lib/billingCapabilities.ts` | Client mirror updated to match the server exactly (trial override, Starter pricing); trial-aware capability fallbacks |
| `frontend/src/modules/Support/SupportPage.tsx` | Complaint + Feedback options; page title → "Support & Feedback" |
| `frontend/src/layout/AppFrame.tsx`, `frontend/src/App.tsx` | Nav item and route label → "Support & Feedback" |
| `frontend/src/modules/SubscriptionPlans/PricingPage.tsx` | "7-day full-access trial" banner with exact end date and days remaining |
| `backend/tests/entitlementMatrix.test.cjs` | **New** — 13 tests |
| `backend/tests/supportCategories.test.cjs` | **New** — 6 tests |
| `backend/tests/insightsDashboardContract.test.cjs` | +4 endpoint enforcement tests |

**No** changes to authentication, token handling, scopes, webhooks, Prisma
schema/migrations, or intelligence calculations.

## 3. Entitlement truth table

| State | fraud | competitor | pricing | profit | Notes |
|---|:--:|:--:|:--:|:--:|---|
| **Active trial** (any selected plan) | ✅ | ✅ | ✅ | ✅ | Pro-equivalent; nothing locked, so no Upgrade badges |
| **Starter — fraud** | ✅ | ❌ | ❌ | ❌ | Selected module only |
| **Starter — competitor** | ❌ | ✅ | ❌ | ❌ | |
| **Starter — pricing** | ❌ | ❌ | ✅ | ❌ | Newly supported |
| **Growth** | ✅ | ✅ | ✅ | ❌ | No full Profit Optimization |
| **Pro** | ✅ | ✅ | ✅ | ✅ | Full profit engine |
| **Expired, no valid subscription** | ❌ | ❌ | ❌ | ❌ | "Choose a plan to continue." |
| **Legacy `TRIAL` plan, window closed** | ❌ | ❌ | ❌ | ❌ | Collapses to `NONE` — no indefinite free plan |

Billing-surface capabilities (`billing.moduleSelectionStarter`,
`billing.downgrade`) always key off the **selected** plan, never the trial
override, so a trialing Starter merchant can still pick their module.

## 4. Trial lifecycle

1. Merchant selects Starter, Growth or Pro.
2. `billingManagementService` calls `appSubscriptionCreate` with
   `trialDays: env.billing.trialDays` (now 7). Shopify creates the subscription
   with the trial; **no charge occurs until it ends**.
3. While `trialEndsAt` is in the future, `buildCanonicalEntitlements` sets
   `fullAccessTrial`, tier becomes `trial`, capabilities resolve Pro-equivalent,
   and `planName` keeps reporting the selected plan.
4. UI shows "7-day full-access trial", the exact end date and days remaining.
   Every module is unlocked, so no Upgrade badge can render (the nav badge is
   derived from real module access).
5. On expiry the override drops. Access then depends solely on
   `accessActive`, which comes from Shopify reconciliation — an active paid
   subscription yields exactly that plan's entitlement; otherwise everything is
   blocked with "Choose a plan to continue."
6. **Reinstall cannot mint a new trial:** `persistInstallationRecord` preserves
   any existing `trialStartedAt`/`trialEndsAt`
   (`existingStore?.trialStartedAt ?? …`), and uninstall is a soft flag rather
   than a row delete, so the original window survives.

## 5. Test results

| Suite | Result |
|---|---|
| `entitlementMatrix.test.cjs` (new) | **13/13 pass** |
| `supportCategories.test.cjs` (new) | **6/6 pass** |
| `insightsDashboardContract.test.cjs` | **13/13 pass** (4 new enforcement tests) |
| Full backend suite | **144 tests, 138 pass, 6 fail** |
| Backend TypeScript | 0 errors |
| Backend build | success |
| Frontend TypeScript | 32 — unchanged baseline |
| Frontend build | success |

The 6 failures are the long-standing pre-existing Cookie-header/session
harness failures (`shopify-routes-auth`, `appStateService`, `launch-smoke`),
proven unrelated in the earlier release audit. Test count rose 121 → 144.

## 6. Staging retest steps

1. Deploy the branch to `vedasuite-staging`.
2. Open Billing, choose a plan, approve in Shopify. Confirm the charge shows a
   **7-day trial** and no immediate charge.
3. Confirm the "7-day full-access trial" banner shows the correct end date and
   days remaining.
4. Confirm the left nav shows **no Upgrade badges** on Fraud, Competitor or
   AI Pricing, and all three open.
5. Confirm the Dashboard shows Executive Summary, Where to Focus, Critical
   Attention and Revenue Leak across all modules.
6. Open **Support & Feedback**, file one **Complaint** and one **Feedback**
   ticket, confirm both appear with the right category in the merchant list and
   the admin console.
7. To verify expiry without waiting, set `Store.trialEndsAt` to a past
   timestamp in the staging database, reload, and confirm paid modules block
   with "Choose a plan to continue" unless Shopify reports an active plan.

## 7. Known limitations

- **Trial window is tracked by local dates**, seeded at install and never reset
  on reinstall. Shopify's `activeSubscriptions` query in this codebase does not
  return trial metadata, so reading the remaining trial directly from Shopify
  would require extending that query — deliberately out of scope here, since
  post-expiry access is already gated on Shopify-verified `accessActive`.
- **Starter "basic Executive Summary / Revenue Leak snapshot / one top
  recommended action"** are delivered by module scoping: with only one module
  entitled, those sections already contain only that module's data. No separate
  "basic" variant was invented.
- **Priority support, exports, history and refresh limits** were not added to
  the plan UI — those capabilities are not implemented in the product, and the
  brief said not to list unimplemented capabilities.

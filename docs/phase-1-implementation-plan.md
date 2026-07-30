# Phase 1 Implementation Plan — Explainability & Prioritization

Date: 2026-07-30
Depends on: `docs/approved-baseline-audit.md`
Status: **PLAN ONLY — not implemented in this pass.** No deploy.

Phase 1 goal: turn dashboards into a decision-support layer answering — what happened, why VedaSuite detected it, what evidence supports it, what financial impact, what to review first, and how confident. Delivered as an **additive** layer over existing deterministic data.

---

## 1. Architecture map

```
                    (existing, untouched)
  fraudService  trustAbuseService  competitorService  pricingService
  profitService  pricingEngineStateService  decisionCenterService
  dashboardService                     coreEngineService (writes analytics)
        │              │             │            │
        └──────────────┴─────┬───────┴────────────┘
                             ▼
                 explainabilityService.ts   ← NEW, read-only aggregator
                 (composes existing outputs into Phase-1 shapes;
                  performs deterministic derivations only)
                             │
                             ▼
        GET /api/insights/*  (NEW additive read-only router, /api, session-gated)
          /summary        → ExecutiveSummary
          /opportunities  → ExplainableInsight[] + OpportunityScore (ranked)
          /revenue-leak   → RevenueLeakSummary
          (optional) POST /api/insights/:id/status → merchant recommendation status
                             │
                             ▼
   Frontend (NEW components, reuse ModuleGate/PageState/embeddedShopRequest)
     ExecutiveSummaryCard   OpportunityList/ExplainableInsightCard
     RevenueLeakSummaryCard  WhereToFocusToday
   rendered inside the EXISTING /app/dashboard route (additive sections)
```

Principle: **new code reads from existing services; it never rewrites them.** The request path performs only deterministic composition — no LLM calls, no Shopify writes, no automated actions.

---

## 2. Files expected to change (additive)

**New files (backend):**
- `backend/src/services/explainabilityService.ts`
- `backend/src/routes/insightsRoutes.ts`
- (optional, only if merchant recommendation status is persisted) `backend/prisma/schema.prisma` — **additive** `InsightReviewStatus` model

**New files (frontend):**
- `frontend/src/modules/Dashboard/components/ExecutiveSummaryCard.tsx`
- `frontend/src/modules/Dashboard/components/OpportunityList.tsx`
- `frontend/src/modules/Dashboard/components/ExplainableInsightCard.tsx`
- `frontend/src/modules/Dashboard/components/RevenueLeakSummaryCard.tsx`
- `frontend/src/lib/insightsTypes.ts` (shared TS types)

**Minimally edited existing files (additive only):**
- `backend/src/routes/index.ts` — mount the new `insightsRouter` under `/api/insights` (one `router.use` line; existing mounts untouched).
- `frontend/src/modules/Dashboard/DashboardPage.tsx` — render the new cards as **additional** sections. No removal or reordering of existing content beyond adding sections.

---

## 3. Files that MUST NOT change (protected)

`authRoutes.ts`, `verifyShopifySessionToken.ts`, `ensureOfflineToken.ts`, `shopifyConnectionService.ts`, `subscriptionService.ts`, `billingManagementService.ts`, `billing/capabilities.ts`, `billingRoutes.ts`, `requireCapability.ts`, `ModuleGate.tsx` (reuse, don't edit), `shopifyWebhookRoutes.ts`, `shopify.app.toml`, `AppStateProvider.tsx`, `privacyService.ts`, and **all existing Prisma fields/columns**. No route removal/rename. No nav changes beyond (optionally) adding a section anchor.

---

## 4. Reusable services / components

Backend: `decisionCenterService.getUnifiedDecisionCenter` (primary input for prioritization), `dashboardService.getDashboardMetrics` (revenue/counts), and the per-module read functions in `fraudService`/`competitorService`/`pricingService`/`profitService`. All consumed read-only.

Frontend: `ModuleGate` (gate any paid surface), `PageState` (loading/empty/insufficient-data), `RouteErrorBoundary`/`withRouteBoundary`, `embeddedShopRequest` (API client), `useAppState`/`useSubscriptionPlan`, Polaris components.

---

## 5. Proposed TypeScript types (`insightsTypes.ts`, mirrored server-side)

```ts
type Confidence = "high" | "medium" | "low" | "insufficient_data";
type Urgency = "critical" | "high" | "medium" | "low";
type InsightModule = "fraud" | "trust" | "return_abuse" | "competitor" | "pricing" | "profit";

interface FinancialImpact {
  amount: number | null;          // null => not quantifiable
  currency: string;
  basis: string;                  // human-readable derivation basis
  isEstimate: boolean;
}

interface ExplainableInsight {
  id: string;
  module: InsightModule;
  title: string;                  // "what happened"
  reasons: string[];              // "why detected" (existing builders)
  evidence: { label: string; value: string }[]; // "what evidence"
  financialImpact: FinancialImpact;
  confidence: Confidence;
  recency: string;                // ISO timestamp of underlying data
  urgency: Urgency;
  recommendedAction: string;      // advisory only, never auto-executed
  opportunityScore: number;       // 0–100, deterministic (see §7)
  route: string;                  // deep link to the module view
  dataQuality: "ok" | "insufficient_data";
}

interface OpportunityScore { insightId: string; score: number; rank: number; }
interface RevenueLeakItem { module: InsightModule; label: string; amount: number | null; confidence: Confidence; }
interface RevenueLeakSummary { totalExposure: number | null; currency: string; items: RevenueLeakItem[]; hasInsufficientData: boolean; }
interface ExecutiveSummary {
  generatedAt: string;
  headline: string;
  bullets: string[];
  topOpportunity: ExplainableInsight | null;
  revenueLeak: RevenueLeakSummary;
  dataReady: boolean;             // false => render readiness state, not a summary
}
```

---

## 6. Proposed API changes (additive, read-only)

New router `insightsRouter` mounted at `/api/insights` (session-token + `ensureOfflineToken`, same as every `/api` route — no new middleware):

- `GET /api/insights/summary` → `ExecutiveSummary`
- `GET /api/insights/opportunities` → `{ insights: ExplainableInsight[] }` (ranked by `opportunityScore` desc)
- `GET /api/insights/revenue-leak` → `RevenueLeakSummary`
- (optional) `POST /api/insights/:id/status` → body `{ status: "reviewed" | "dismissed" | "actioned" }`; the **only** write, into a new additive table, scoped by `storeId`.

No existing endpoint signature changes. No new scopes.

---

## 7. Formulas and assumptions

All inputs already exist in the DB.

- **Margin %** = `(sellingPrice − productCost) / sellingPrice`, only when `productCost > 0`; else `insufficient_data`.
- **Opportunity Score (0–100)**, deterministic:
  `score = round( normalize(financialImpact) * 0.45 + confidenceWeight * 0.25 + urgencyWeight * 0.20 + recencyWeight * 0.10 )`
  where `normalize(financialImpact)` caps impact against a per-store rolling scale, `confidenceWeight` = {high:1, medium:0.6, low:0.3, insufficient:0}, `urgencyWeight` = {critical:1, high:0.75, medium:0.5, low:0.25}, `recencyWeight` decays linearly to 0 over 30 days. If `confidence = insufficient_data` OR `financialImpact.amount = null`, the insight is **excluded from ranking** and shown under an "insufficient data" group (never scored as if it were 0).
- **Revenue Leak total** = Σ of quantifiable negative-impact items (refund exposure, un-actioned pricing gain, competitor undercut exposure). Any item lacking a firm number sets `hasInsufficientData = true` and is listed without contributing a fabricated amount.
- **Assumptions (documented, conservative):** impact numbers are **advisory estimates** derived from stored analytics, labeled `isEstimate: true`; no forward-looking guarantee is presented; no claim is made that acting will realize the number.

---

## 8. Confidence rules

- Confidence is inherited from the source where it exists (`competitorService.confidenceLabel`, `fraudService.buildFraudConfidence`, pricing `demandScore` → banded).
- Where a source has no confidence signal, confidence is derived from **data sufficiency** (row count + recency), never assumed "high."
- `low` confidence items are shown but visually de-emphasized and excluded from the headline Opportunity ranking.
- `insufficient_data` is a first-class state, distinct from `low`.

---

## 9. Insufficient-data behaviour

- Per §5 audit list: cost/margin without COGS, low-confidence competitor matches, thin order history, null impact fields, and still-syncing stores all render an explicit **"Insufficient data"** treatment via `PageState`, with a one-line reason and (where relevant) a link to the action that would improve it (e.g. "Add product cost in Settings").
- The Executive Summary and Opportunity list **never fabricate**; when the store isn't ready they show the existing readiness/collecting-data state.

---

## 10. UI component plan

- **ExecutiveSummaryCard** — headline + 3–5 bullets + "top opportunity" + revenue-leak total. Additive top section on `/app/dashboard`.
- **WhereToFocusToday / OpportunityList** — ranked `ExplainableInsightCard`s (max N, e.g. 5), each expandable to reasons + evidence + impact + confidence + recommended action + deep link.
- **RevenueLeakSummaryCard** — total exposure + itemized list with confidence chips.
- All built from Polaris (`Card`, `BlockStack`, `Badge`, `Banner`, `Text`, `Button`, `Collapsible`) for Shopify-native look and built-in a11y. Paid surfaces wrapped in `ModuleGate` with the appropriate existing capability; support/summary basics available per current plan rules (no new gating logic invented).

---

## 11. Accessibility requirements

- Use Polaris components (WCAG-oriented by default). Every interactive control keyboard-reachable and labeled.
- Confidence/urgency conveyed by **text + Badge**, never colour alone.
- `Spinner`/`Banner` carry `accessibilityLabel`/titles. Expand/collapse uses Polaris `Collapsible` with proper `aria` wiring. Meaningful heading hierarchy (`Text as="h2"/"h3"`).

---

## 12. Mobile behaviour

- Shopify admin embeds render on mobile; Polaris `Layout`/`Card`/`BlockStack` are responsive. Cards stack vertically; tables scroll within their own `overflow-x` container; no fixed widths. Touch targets meet Polaris minimums. Verified at mobile widths during implementation, not assumed.

---

## 13. Database migration plan

- **Default Phase 1: no schema change.** All surfaces are read/derive-only.
- **If merchant recommendation status is persisted:** additive `InsightReviewStatus` table (`id, storeId, insightKey, status, createdAt, updatedAt`, `onDelete: Cascade` to `Store` so redaction erases it). Applied by the existing `prisma db push` on deploy.
- **Mandatory guard:** before any deploy carrying a schema change, run `prisma migrate diff` and confirm the output contains **only** `CREATE TABLE` / `ADD COLUMN` (zero `DROP`/`ALTER … TYPE`). No destructive migration ever ships. No changes to existing columns.

---

## 14. Test plan

Since no test harness exists today (baseline finding), Phase 1 introduces **additive** verification without changing existing scripts:

- **Unit (pure functions):** Opportunity Score, margin, revenue-leak aggregation, and insufficient-data branching are pure and get unit tests (Node `--test`, added as a new script — additive, does not alter build/deploy).
- **Type safety:** new code must pass `tsc --noEmit` with **zero new errors** (backend already clean; frontend new files must be clean even though the pre-existing 32 remain).
- **Build:** `vite build` must continue to succeed.
- **Manual QA matrix:** ready store (data present), still-syncing store, store with no COGS, low-confidence competitor matches, empty store — each must render correctly (real values or explicit insufficient-data).
- **Regression smoke:** confirm auth, billing, plan-gating, install/reconnect, webhooks, and existing module routes behave identically (no protected file changed).

---

## 15. Release and rollback plan

- **Release:** additive commits behind the existing deploy flow; new endpoints are read-only and new UI sections degrade to insufficient-data/empty if the endpoint is unavailable.
- **Feature exposure:** new dashboard sections can be introduced incrementally; if any issue arises, removing the added sections/endpoint reverts to the exact approved dashboard (they are additive).
- **Rollback:** because everything is additive and the approved baseline is snapshotted (`approved-backup-app1` branch + tag + zip), rollback = revert the additive commits (non-destructive) or redeploy the prior commit. If an optional additive table shipped, it can be left in place harmlessly (unused) — no destructive down-migration required.

---

## 16. Shopify compliance safeguards

- **No new scopes**, no API-version change, no app-URL/redirect change, no webhook change.
- **No prohibited automation:** recommendations are advisory only — no automatic order blocking, cancellation, refunds, or repricing; no chargeback guarantee; no formal credit-scoring claim. All action buttons deep-link the merchant to review, they do not execute.
- **No fabricated data:** insufficient-data states everywhere a value can't be computed; impact figures labeled as estimates.
- **Protected customer data:** no new PII collected or exposed; new endpoints read existing store-scoped analytics only, enforced by `verifyShopifySessionToken` shop-matching (tenant isolation preserved).
- **Listing claims:** no UI copy that would exceed approved public listing claims (no guarantees, no "we block fraud," etc.).
- **Executive Summary is deterministic/templated** in the request path (not a live LLM call), avoiding latency, non-determinism, and any data-egress concern during a merchant request.

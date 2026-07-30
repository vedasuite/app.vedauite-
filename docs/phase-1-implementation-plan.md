# Phase 1 Implementation Plan — Explainability & Prioritization

Date: 2026-07-30 · Amended: 2026-07-30 (see `docs/phase-1-plan-amendment-summary.md`)
Depends on: `docs/approved-baseline-audit.md`
Status: **PLAN ONLY — not implemented in this pass.** No deploy. No feature code.

Phase 1 goal: turn dashboards into a decision-support layer answering — what happened, why VedaSuite detected it, what evidence supports it, what financial impact, what to review first, and how confident. Delivered as an **additive**, **read-only** layer over existing deterministic data.

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
                 (deterministic composition + scoring; NO LLM in request path,
                  NO writes, NO raw PII in outputs)
                             │
                             ▼
        GET /api/insights/dashboard   ← NEW single aggregate endpoint (§6)
          → { executiveSummary, opportunities, revenueLeak,
              dataCoverage, generatedAt }
                             │
                             ▼
   Frontend (NEW components, reuse ModuleGate/PageState/embeddedShopRequest)
     rendered as ADDITIVE, REORDERED sections inside the EXISTING /app/dashboard
```

Principle: **new code reads from existing services; it never rewrites them.** The request path performs only deterministic composition — no LLM calls, no Shopify writes, no automated actions, **no raw customer PII in responses or logs**.

---

## 2. Files expected to change (additive)

**New files (backend):**
- `backend/src/services/explainabilityService.ts`
- `backend/src/routes/insightsRoutes.ts`

**New files (frontend):**
- `frontend/src/modules/Dashboard/components/ExecutiveSummaryCard.tsx`
- `frontend/src/modules/Dashboard/components/WhereToFocusToday.tsx`
- `frontend/src/modules/Dashboard/components/ExplainableInsightCard.tsx` (expandable, with "Why this priority?")
- `frontend/src/modules/Dashboard/components/RevenueLeakDetector.tsx` (two groups, clickable categories)
- `frontend/src/lib/insightsTypes.ts` (shared TS types, mirrored server-side)

**Minimally edited existing files (additive only):**
- `backend/src/routes/index.ts` — one `router.use("/api/insights", insightsRouter)` line.
- `frontend/src/modules/Dashboard/DashboardPage.tsx` — render new sections and **reorder** sections into the required hierarchy (§10). No capability, route, control, or gating removed.

**NO database changes in the first release (§13).**

---

## 3. Files that MUST NOT change (protected)

`authRoutes.ts`, `verifyShopifySessionToken.ts`, `ensureOfflineToken.ts`, `shopifyConnectionService.ts`, `subscriptionService.ts`, `billingManagementService.ts`, `billing/capabilities.ts`, `billingRoutes.ts`, `requireCapability.ts`, `ModuleGate.tsx` (reuse, don't edit), `shopifyWebhookRoutes.ts`, `shopify.app.toml`, `AppStateProvider.tsx`, `privacyService.ts`, and **all existing Prisma fields/columns**. No route removal/rename. No plan-gating change. No new scopes.

---

## 4. Reusable services / components

Backend read-only: `decisionCenterService.getUnifiedDecisionCenter`, `dashboardService.getDashboardMetrics`, and per-module read functions in `fraudService`/`competitorService`/`pricingService`/`profitService`. Frontend: `ModuleGate`, `PageState`, `RouteErrorBoundary`/`withRouteBoundary`, `embeddedShopRequest`, `useAppState`/`useSubscriptionPlan`, Polaris.

---

## 5. TypeScript types (`insightsTypes.ts`, mirrored server-side)

```ts
type Confidence = "high" | "medium" | "low" | "insufficient_data";
type Urgency = "critical" | "high" | "medium" | "low";
type InsightModule = "fraud" | "trust" | "return_abuse" | "competitor" | "pricing" | "profit";

// AMENDMENT 4: aggregate-only evidence. No raw PII fields ever.
interface AggregateEvidence {
  label: string;                  // e.g. "Return rate", "Order count"
  value: string;                  // pre-formatted, already-aggregated
}

// AMENDMENT 3: financial impact is a BOUNDED RANGE, or explicitly not quantifiable.
type FinancialImpact =
  | { status: "quantified"; min: number; max: number; currency: string; period: "monthly"; basis: string; isEstimate: true }
  | { status: "impact_not_quantifiable"; reason: string };

// AMENDMENT 1: every component score returned so UI can show "Why this priority?".
interface OpportunityScoreBreakdown {
  total: number;                  // 0–100
  components: {
    financialImpact: number;      // 0–100 (weight 35%)
    urgency: number;              // 0–100 (weight 25%)
    confidence: number;           // 0–100 (weight 20%)
    easeOfAction: number;         // 0–100 (weight 10%)
    recency: number;              // 0–100 (weight 10%)
  };
  weights: { financialImpact: 0.35; urgency: 0.25; confidence: 0.20; easeOfAction: 0.10; recency: 0.10 };
  excludedFromRanking: boolean;   // true when impact/confidence unavailable
  excludedReason?: string;
}

interface ExplainableInsight {
  id: string;
  module: InsightModule;
  title: string;                  // "what happened"
  reasons: string[];              // "why detected" (existing builders)
  evidence: AggregateEvidence[];  // aggregate-only (§ Amendment 4)
  financialImpact: FinancialImpact;
  confidence: Confidence;
  recency: string;                // ISO timestamp of underlying data
  urgency: Urgency;
  easeOfAction: "one_click_review" | "guided" | "manual";  // §7 derivation
  recommendedAction: string;      // advisory only, never auto-executed
  score: OpportunityScoreBreakdown;
  route: string;                  // deep link to the module view
  dataQuality: "ok" | "insufficient_data";
}

// AMENDMENT 2: potential upside and revenue-at-risk are SEPARATE. Never summed.
interface LeakGroup {
  kind: "potential_upside" | "revenue_at_risk";
  min: number;
  max: number;
  currency: string;
  period: "monthly";
  items: { key: string; label: string; min: number; max: number; confidence: Confidence }[];
  confidence: Confidence;         // group-level rollup
  dataCoverage: DataCoverage;
}
interface RevenueLeakModel {
  potentialUpside: LeakGroup;     // underpricing, margin, safe-pricing profit opportunities
  revenueAtRisk: LeakGroup;       // competitor-price pressure, return-abuse, high-risk-order exposure
  // NO combined total field exists by design.
}

interface DataCoverage {
  module: InsightModule | "all";
  rowsAvailable: number;
  lastSyncAt: string | null;
  sufficient: boolean;
  note?: string;                  // e.g. "Add product cost to quantify margin"
}

interface ExecutiveSummary {
  generatedAt: string;
  headline: string;
  bullets: string[];
  topOpportunity: ExplainableInsight | null;
  dataReady: boolean;             // false => render readiness state, not a summary
}

// AMENDMENT 7: single aggregate response.
interface DashboardInsightsResponse {
  executiveSummary: ExecutiveSummary;
  opportunities: ExplainableInsight[];   // ranked desc by score.total; excluded items grouped separately
  revenueLeak: RevenueLeakModel;
  dataCoverage: DataCoverage[];
  generatedAt: string;                   // single timestamp for the whole response
}
```

---

## 6. API changes (additive, read-only) — single aggregate endpoint

**AMENDMENT 7.** Phase 1 exposes **one** aggregate endpoint:

- `GET /api/insights/dashboard` → `DashboardInsightsResponse`

**Performance reasoning:** the executive summary, opportunity ranking, and revenue-leak model all derive from the **same** underlying reads (`decisionCenterService`, `dashboardService`, `PriceHistory`, `ProfitOptimizationData`, `CompetitorData`). Computing them in one request:
- **avoids duplicate DB/service work** — the shared reads happen once, not three times;
- **guarantees one consistent `generatedAt`** across all sections (three separate calls could interleave with a sync and show mismatched timestamps/numbers);
- **reduces round-trips** from the embedded iframe (each request re-acquires a session token).

Focused module endpoints are **not** added in Phase 1; they may be introduced later **only** if a genuinely independent, separately-cached surface needs them. No new middleware; same `/api` session-token + `ensureOfflineToken` chain. **No `POST` / status-write endpoint in the first release (§13).** No new scopes.

---

## 7. Formulas and assumptions

All inputs already exist in the DB. All scoring is deterministic; no LLM in the request path.

### 7.1 Opportunity Score (AMENDMENT 1)

Weighted sum of five factors, each normalized to **[0,100]**, then combined:

`total = 0.35·financialImpact + 0.25·urgency + 0.20·confidence + 0.10·easeOfAction + 0.10·recency`

Deterministic normalization of each factor:

| Factor | Weight | Normalized [0,100] definition |
|---|---|---|
| **financialImpact** | 35% | `impact.status == "quantified"` → `100 · clamp( impact.max / storeImpactCap , 0, 1)`, where `storeImpactCap` = the 90th-percentile monthly impact seen for that store over the lookback window (deterministic from stored rows; falls back to a fixed sane cap when < N rows). `impact_not_quantifiable` → factor is **undefined**, insight is excluded (see rule below). |
| **urgency** | 25% | `critical→100, high→75, medium→50, low→25` (from existing `severity`/`riskLevel`). |
| **confidence** | 20% | `high→100, medium→60, low→30, insufficient_data→` **undefined → excluded**. |
| **easeOfAction** | 10% | `one_click_review→100, guided→60, manual→30` (derivation in 7.2). |
| **recency** | 10% | linear decay from 100 (today) to 0 at 30 days old, using the underlying data timestamp; clamped ≥0. |

**Hard rule (AMENDMENT 1):** if `financialImpact.status == "impact_not_quantifiable"` **OR** `confidence == "insufficient_data"`, the insight is **excluded from ranking** (`excludedFromRanking = true`, with reason) and shown in a separate "Needs more data" group. It is **never** given a high score, and missing factors are **never** treated as 0-that-still-ranks — they remove the item from the ranked list entirely.

Every component score and the weights are returned in `OpportunityScoreBreakdown` so the UI can render **"Why this priority?"** with the exact contribution of each factor.

### 7.2 Ease of action — conservative, deterministic, no LLM (AMENDMENT 1)

Derived **only** from the existing recommendation/action type already produced by the services — never generated or phrased by an LLM:

| Existing recommendation type | easeOfAction |
|---|---|
| Advisory review of a single flagged order/customer (deep-link opens the item) | `one_click_review` |
| Pricing/profit recommendation with a concrete stored `recommendedPrice`/`optimalPrice` the merchant applies in Shopify | `guided` |
| Anything requiring merchant judgement, external steps, or multi-item work (e.g. "review margin-defense playbook", competitor strategy) | `manual` |

The mapping is a fixed lookup table over the finite set of `recommendedAction` strings the services already emit. If an action type is unrecognized, it defaults to the most conservative bucket (`manual`).

### 7.3 Revenue Leak model — two separate groups, never summed (AMENDMENT 2)

No `totalExposure`. Two independent groups, each a **bounded range** with its own confidence and data coverage:

**A. Potential upside** (opportunities to gain, all *supported* by stored data):
- supported underpricing opportunity — from `PriceHistory` rows where `recommendedPrice > currentPrice` and `expectedProfitGain > 0`.
- supported margin opportunity — from `ProfitOptimizationData` where `projectedMarginIncrease > 0` **and** `productCost > 0`.
- supported safe-pricing profit opportunity — from `PriceHistory.expectedProfitGain` on recommendations whose automation posture is "merchant review recommended" (conservative subset).

**B. Revenue at risk** (potential losses, all *supported*):
- supported competitor-price pressure — §7.4 bounded competitor range (only where quantifiable).
- supported return-abuse exposure — from `Customer.refundRate`/`totalRefunds` × related `Order.totalAmount`, high-return cohort only.
- supported high-risk-order exposure — from `Order` where `fraudRiskLevel = High`, summing `totalAmount` of currently-open/unresolved high-risk orders.

Each group returns `min`, `max`, `currency`, `period` (monthly), per-item breakdown, group `confidence`, and `dataCoverage`. **The UI never displays A+B as a combined "total exposure", "confirmed loss", or "guaranteed profit".** Copy is explicitly framed as ranges of *opportunity* vs *risk*, both estimates.

### 7.4 Competitor revenue impact — bounded, or not quantifiable (AMENDMENT 3)

**Code audit result:** no defensible competitor-revenue-impact formula exists today (`competitorService` computes match/price-gap/priority signals only; nothing links a price gap to revenue). Also, **there are no order line items in the schema**, so true per-product revenue is not directly available.

Therefore Phase 1 defines a **conservative bounded range**, computed **only** when all inputs are present, else `impact_not_quantifiable`:

- **recent product revenue proxy** = `ProfitOptimizationData.sellingPrice × salesVelocity` for the handle (the only per-product revenue signal available). If absent → `impact_not_quantifiable`.
- **competitor price gap** = `(ourPrice − competitorPrice) / ourPrice`, only when a `CompetitorData.price` exists for the handle.
- **match confidence** = `competitorService.confidenceLabel`; if `low` → `impact_not_quantifiable`.
- **recency** = `CompetitorData.collectedAt`; stale (> 14 days) → `impact_not_quantifiable`.
- **product importance** = the handle's share of the store's revenue-proxy total (bounds influence of tiny SKUs).

Bounded range: `min = 0`; `max = recentProductRevenueProxy × min(priceGap, gapCap) × confidenceFactor × importanceWeight`, with **caps**: `gapCap = 0.15` (never attribute more than a 15% gap effect), `confidenceFactor` = {high:0.6, medium:0.3} (deliberately < 1 — we never claim the full gap converts to revenue), `importanceWeight ∈ [0,1]`. **Assumptions documented:** this is an upper-bounded *estimate of exposure*, not a prediction; `min` is always 0 because we cannot assert a floor. If any input is missing/stale/low-confidence, return `impact_not_quantifiable` rather than an invented number.

---

## 8. Confidence rules

Confidence is inherited where a source provides it (`competitorService.confidenceLabel`, `fraudService.buildFraudConfidence`, pricing `demandScore` banded); otherwise derived from **data sufficiency** (row count + recency), never assumed "high". `low` items are shown but excluded from the headline ranking (§7.1). `insufficient_data` is first-class and excludes the item from scoring.

---

## 9. Insufficient-data behaviour

Per the audit list (cost/margin without COGS, low-confidence competitor matches, thin history, null impact, still-syncing stores) every unquantifiable value renders an explicit **"Insufficient data"** state via `PageState`, with a one-line reason and, where useful, a link to the action that would improve it. The Executive Summary and Opportunity list **never fabricate**; a not-ready store shows the existing readiness/collecting-data state.

---

## 10. Dashboard presentation & UI plan (AMENDMENTS 8 & 9)

### 10.1 Section hierarchy (reorder within the existing `/app/dashboard` route)

Sections are **reordered** (not removed) into:

1. **AI Executive Summary**
2. **Where to focus today** (ranked Opportunity list)
3. **Revenue Leak Detector** (two groups: upside / at-risk)
4. **Existing metric cards** (unchanged)
5. **Recent insights / activity** (unchanged)
6. **Data coverage & sync status**

No existing dashboard capability, route, update/refresh control, or plan gating is removed. Reordering is layout-only inside the one route.

### 10.2 UI phase scope (AMENDMENT 9)

- **Expandable Explainable Insight cards** (Polaris `Collapsible`) — collapsed shows title + score + one-line impact; expanded shows reasons, aggregate evidence, impact range, confidence, recommended action, deep link.
- **"Why this priority?"** disclosure — renders the five component scores + weights from `OpportunityScoreBreakdown`.
- **Clickable Revenue Leak categories** — each item expands to its supporting breakdown and deep-links to the module.
- **Meaningful loading and empty states** (reuse `PageState`); explicit insufficient-data states.
- **Responsive Polaris layouts** — cards stack on mobile, tables scroll within their own container, no fixed widths.
- **Keyboard accessibility** — all controls reachable/labeled; expand/collapse via Polaris.
- **Reduced-motion support** — respect `prefers-reduced-motion`; disable non-essential transitions when set.
- **Subtle transitions only** — no large/animated motion; enhancement, not spectacle.

This is a **Shopify-native enhancement** using the existing Polaris design system and navigation — **not** a replacement of either.

---

## 11. Accessibility requirements

Polaris components (WCAG-oriented). Keyboard-reachable, labeled controls. Confidence/urgency conveyed by **text + Badge**, never colour alone. `Spinner`/`Banner` carry accessibility labels. Proper heading hierarchy. **`prefers-reduced-motion` respected** (AMENDMENT 9).

---

## 12. Mobile behaviour

Responsive Polaris (`Layout`/`Card`/`BlockStack`). Cards stack; tables scroll within `overflow-x`; touch targets meet Polaris minimums. Verified at mobile widths during implementation, not assumed.

---

## 13. Database scope (AMENDMENT 6)

**No database changes in the first Phase 1 release.** `InsightReviewStatus` and any migration are **removed** from the first release. Phase 1 ships **read-only** intelligence only. Merchant recommendation-status persistence (reviewed/dismissed/actioned) is deferred to a **later optional enhancement** after the read-only dashboard is stable; when/if added it will be a purely additive, cascade-scoped table verified non-destructive via `prisma migrate diff` — but that is out of scope here.

---

## 14. TypeScript baseline & test plan (AMENDMENT 5)

### 14.1 Reproducible TS baseline

A committed baseline of the **32 pre-existing frontend `tsc` errors** is recorded at `docs/ts-baseline-frontend.txt` (error signatures + per-file counts), generated by:

```bash
cd frontend && npx tsc --noEmit 2>&1 | grep -E "error TS" | sort > ../docs/ts-baseline-frontend.txt
```

### 14.2 Implementation requirements (gate before commit)

- **No new error signatures** vs baseline.
- **No increase in total error count** (stays 32).
- **No new Phase-1 file** appears in `tsc` output.
- **Backend stays at 0** `tsc` errors.
- **Production build (`vite build`) stays green.**

### 14.3 Baseline comparison procedure

```bash
cd frontend && npx tsc --noEmit 2>&1 | grep -E "error TS" | sort > /tmp/ts-now.txt
diff ../docs/ts-baseline-frontend.txt /tmp/ts-now.txt   # MUST be empty
grep -E "modules/Dashboard/components|lib/insightsTypes" /tmp/ts-now.txt  # MUST be empty
cd ../backend && npx tsc --noEmit   # MUST exit 0
cd ../frontend && npm run build     # MUST succeed
```

### 14.4 Functional test plan

- **Unit (pure functions):** Opportunity Score + component normalization, ease-of-action lookup, revenue-leak two-group aggregation, competitor bounded range incl. `impact_not_quantifiable`, evidence allowlist mapping. Node `--test`, added as a new script (additive; existing scripts unchanged).
- **Manual QA matrix:** ready store, still-syncing store, no-COGS store, low-confidence competitor matches, empty store — each renders correctly (real ranges or explicit insufficient-data), and **no raw PII appears in any response or log**.
- **Regression smoke:** auth, billing, plan-gating, install/reconnect, webhooks, existing routes behave identically (no protected file changed).

---

## 15. Release and rollback plan

- **Release:** additive commits through the existing deploy flow; the single new endpoint is read-only; new dashboard sections degrade to insufficient-data/empty if unavailable. **Gate:** the §14.3 baseline comparison + build must pass before commit and before any deploy.
- **Rollback:** everything is additive and the approved baseline is snapshotted (`approved-backup-app1` branch/tag/zip). Rollback = revert the additive commits (non-destructive) or redeploy the prior commit. No DB migration ships in the first release, so there is nothing to roll back on the data layer.

---

## 16. Shopify compliance & protected-data safeguards (AMENDMENT 4)

- **No new scopes / API-version / app-URL / redirect / webhook changes.**
- **No prohibited automation:** advisory only — no auto order-blocking, cancellation, refunds, or repricing; no chargeback guarantee; no formal credit-scoring claim; no fabricated data.
- **Strict evidence allowlist (new):** explainability responses and logs expose **only aggregate, merchant-friendly evidence** — return rate, order count, refund count, address count, order-frequency band, risk-signal count. The following are **never** placed in generic evidence responses or logs: **full email, full address, IP address, device fingerprint, payment fingerprint, raw Shopify customer or order payloads.** Identity visibility is capped at exactly what the corresponding **approved module already shows** — Phase 1 does not expand protected-data visibility.
- **Tenant isolation preserved:** new endpoint reads store-scoped analytics only, enforced by `verifyShopifySessionToken` shop-matching.
- **Executive Summary is deterministic/templated** in the request path (no live LLM call), avoiding latency, non-determinism, and data-egress concerns.

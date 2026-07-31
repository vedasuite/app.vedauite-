# Phase 1 Implementation Plan — Explainability & Prioritization

Date: 2026-07-30 · Amended: 2026-07-30 · Finalized: 2026-07-31
Governing amendments: `docs/phase-1-plan-amendment-summary.md`; final gate: `docs/phase-1-final-readiness-check.md`
Status: **PLAN ONLY — not implemented. No deploy. No feature code.**

Phase 1 turns dashboards into a decision-support layer answering: what happened, why detected, what evidence, what financial impact (or not quantifiable), what to review first, how confident. Additive, read-only, deterministic.

---

## 1. Architecture map

```
   existing services (untouched): fraud/trust/competitor/pricing/profit/
   pricingEngineState/decisionCenter/dashboard/coreEngine
                             ▼
       explainabilityService.ts   ← NEW read-only aggregator
       (deterministic scoring + dedup + period-aware ranges;
        NO LLM in request path, NO writes, NO raw PII in output/logs)
                             ▼
       GET /api/insights/dashboard  → { executiveSummary, opportunities,
         criticalAttention, revenueLeak, dataCoverage, generatedAt }
                             ▼
   Frontend (additive):
     Dashboard: Executive Summary, Where-to-focus, Critical attention,
                Revenue Leak Detector (reordered sections in existing route)
     Module pages (Fraud, Competitor, Pricing/Profit): reuse
                ExplainableInsightCard on existing major findings
```

---

## 2. Files expected to change (additive)

**New (backend):** `services/explainabilityService.ts`, `routes/insightsRoutes.ts`.
**New (frontend):** `modules/Dashboard/components/{ExecutiveSummaryCard,WhereToFocusToday,CriticalAttentionLane,ExplainableInsightCard,RevenueLeakDetector}.tsx`, `lib/insightsTypes.ts`.
**Minimally edited existing (additive only):**
- `backend/src/routes/index.ts` — one `router.use("/api/insights", insightsRouter)` line.
- `frontend/src/modules/Dashboard/DashboardPage.tsx` — render + reorder new sections.
- **Module pages (Amendment item 5), minimally edited to embed `ExplainableInsightCard` on existing major findings only:**
  - `frontend/src/modules/FraudIntelligence/FraudPage.tsx`
  - `frontend/src/modules/CompetitorIntelligence/CompetitorPage.tsx`
  - `frontend/src/modules/PricingProfit/PricingProfitPage.tsx`

**NO database change in the first release (§13).**

---

## 3. Files that MUST NOT change (protected)

`authRoutes.ts`, `verifyShopifySessionToken.ts`, `ensureOfflineToken.ts`, `shopifyConnectionService.ts`, `subscriptionService.ts`, `billingManagementService.ts`, `billing/capabilities.ts`, `billingRoutes.ts`, `requireCapability.ts`, `ModuleGate.tsx`, `shopifyWebhookRoutes.ts`, `shopify.app.toml`, `AppStateProvider.tsx`, `privacyService.ts`, all existing Prisma fields. No route removal/rename, no plan-gating change, no new scopes. **Module-page edits are strictly additive display of `ExplainableInsightCard`; routes, `ModuleGate` usage, existing controls, and gating are preserved.**

---

## 4. Reusable services / components

Backend read-only: `decisionCenterService.getUnifiedDecisionCenter`, `dashboardService.getDashboardMetrics`, per-module readers. Frontend: `ModuleGate`, `PageState`, `RouteErrorBoundary`, `embeddedShopRequest`, `useAppState`/`useSubscriptionPlan`, Polaris.

---

## 5. TypeScript types (`insightsTypes.ts`, mirrored server-side)

```ts
type Confidence = "high" | "medium" | "low" | "insufficient_data";
type Urgency = "critical" | "high" | "medium" | "low";
type InsightModule = "fraud" | "trust" | "return_abuse" | "competitor" | "pricing" | "profit";

// AMENDMENT (final) item 3 — explicit, non-interchangeable periods.
type ImpactPeriod =
  | "per_order"
  | "current_open_exposure"   // point-in-time snapshot
  | "last_7_days"
  | "last_30_days"
  | "monthly_estimate";

interface AggregateEvidence { label: string; value: string } // no raw PII, ever

type FinancialImpact =
  | { status: "quantified"; min: number; max: number; currency: string;
      period: ImpactPeriod; basis: string; isEstimate: true }
  | { status: "impact_not_quantifiable"; reason: string };

interface OpportunityScoreBreakdown {
  total: number;                        // 0–100
  components: { financialImpact: number; urgency: number; confidence: number; easeOfAction: number; recency: number };
  weights: { financialImpact: 0.35; urgency: 0.25; confidence: 0.20; easeOfAction: 0.10; recency: 0.10 };
  excludedFromMonetaryRanking: boolean; // true when impact/confidence unavailable
  excludedReason?: string;
}

interface Methodology { summary: string; assumptions: string[]; caps: string[] } // "how we derived this"

interface ExplainableInsight {
  id: string;                           // canonical dedup identity (§7.5)
  module: InsightModule;
  title: string;
  reasons: string[];
  evidence: AggregateEvidence[];        // aggregate-only
  financialImpact: FinancialImpact;     // carries its own period
  confidence: Confidence;
  recency: string;                      // ISO timestamp
  urgency: Urgency;
  easeOfAction: "one_click_review" | "guided" | "manual";
  recommendedAction: string;            // advisory only
  score: OpportunityScoreBreakdown;
  methodology: Methodology;             // item 5 requirement
  route: string;
  dataQuality: "ok" | "insufficient_data";
  isCriticalNonMonetary?: boolean;      // item 7 — routes to Critical attention lane
}

// AMENDMENT item 3 — a group only aggregates items of ONE compatible period.
interface LeakGroup {
  kind: "potential_upside" | "revenue_at_risk";
  period: ImpactPeriod;                 // the group's single period
  min: number; max: number; currency: string;
  items: { key: string; label: string; min: number; max: number; period: ImpactPeriod; confidence: Confidence }[];
  confidence: Confidence;
  dataCoverage: DataCoverage;
}
// Revenue-at-risk may hold MULTIPLE groups because its members have different
// periods (e.g. current_open_exposure vs last_30_days) that must NOT be summed.
interface RevenueLeakModel {
  potentialUpside: LeakGroup[];         // grouped by period; never cross-summed
  revenueAtRisk: LeakGroup[];           // grouped by period; never cross-summed
  // No single combined total anywhere.
}

interface DataCoverage { module: InsightModule | "all"; rowsAvailable: number; lastSyncAt: string | null; sufficient: boolean; note?: string }

interface ExecutiveSummary { generatedAt: string; headline: string; bullets: string[]; topOpportunity: ExplainableInsight | null; dataReady: boolean }

interface DashboardInsightsResponse {
  executiveSummary: ExecutiveSummary;
  opportunities: ExplainableInsight[];      // monetary-ranked (excluded items omitted)
  criticalAttention: ExplainableInsight[];  // item 7 — high-confidence critical, incl. non-monetary
  revenueLeak: RevenueLeakModel;
  dataCoverage: DataCoverage[];
  generatedAt: string;                      // one timestamp for the whole response
}
```

---

## 6. API — single aggregate endpoint

`GET /api/insights/dashboard` → `DashboardInsightsResponse`. One request computes the shared reads once and returns one consistent `generatedAt` (avoids duplicate work and interleaving with a sync). No status-write endpoint in the first release. Same `/api` session-token + `ensureOfflineToken` chain; no new middleware; no new scopes. Module pages reuse this same endpoint (filtered client-side by `module`) — no per-module endpoints added.

---

## 7. Formulas and assumptions

### 7.1 Opportunity Score + Critical Attention lane (items 1, 7)

`total = 0.35·financialImpact + 0.25·urgency + 0.20·confidence + 0.10·easeOfAction + 0.10·recency` (each factor 0–100, deterministic normalization per the amendment). If `financialImpact = impact_not_quantifiable` OR `confidence = insufficient_data`, the item is **excluded from the monetary `opportunities` ranking** (`excludedFromMonetaryRanking = true`).

**Item 7 — critical non-monetary findings are NOT lost. Chosen approach: A (separate lane).**
A finding is routed into `criticalAttention` (in addition to, or instead of, monetary ranking) when: `urgency = "critical"` AND `confidence ∈ {high, medium}` — **even if** `financialImpact = impact_not_quantifiable`. In the Critical attention lane:
- items are ordered by `urgency` then `confidence` then `recency` (NOT by a fabricated money score);
- each shows an explicit **"Impact not quantified"** label when money is unavailable;
- **no financial-impact score is invented** — the monetary component simply does not contribute, and the item never appears in the monetary `opportunities` list unless it also has a valid quantified impact.
This guarantees a high-confidence critical fraud/operational risk always surfaces in "Where to focus", regardless of monetary quantifiability. (Approach B — allowing non-monetary items into the monetary list under a strict score cap — is explicitly rejected to avoid any fabricated score.)

### 7.2 Ease of action (deterministic, no LLM)

Fixed lookup over the finite set of existing `recommendedAction` types → `one_click_review` (single flagged item deep-link) / `guided` (concrete stored recommended price to apply) / `manual` (judgement/multi-step). Unknown → `manual`.

### 7.3 Return-abuse exposure — precise definition (item 2)

**Exact field semantics (code-audited):**
- `Customer.totalRefunds` = **COUNT of refunded orders** (`shopifyAdminService.ts:919` filters `order.refunded`), **not a monetary amount**.
- `Customer.refundRate` = `totalRefunds / totalOrders` (ratio 0–1).
- `Order.refunded`, `Order.refundRequested` = booleans. `Order.totalAmount` = order total (float). **No refund-amount field exists** anywhere in the schema.
- Customer↔Order: `Order.customerId → Customer`; `Customer.orders`.
- Eligible/completed order = `Order.status ∈ {"paid","approved"}` (allowlist; the synthetic `"baseline"` status and anything else are excluded).

**The vague formula `refundRate/totalRefunds × Order.totalAmount` is rejected** (dimensionally meaningless — a ratio/count times an amount).

**Conservative formula — excess behaviour above store baseline:**
```
Let LOOKBACK = 90 days.
Eligible orders E(customer) = customer's orders with status∈{paid,approved},
   createdAt within LOOKBACK, deduplicated by Order.id.
storeBaselineRefundRate = (# refunded eligible orders store-wide) / (# eligible orders store-wide)
customerRefundRate       = (# refunded orders in E) / |E|
excessRate = max(0, customerRefundRate − storeBaselineRefundRate)

behaviouralFinding = ALWAYS shown when thresholds met (elevated refund rate vs baseline).

monetaryExposure (upper-bounded proxy, since no refund amount exists):
   refundedValue = Σ Order.totalAmount over refunded orders in E   (deduped)
   max = min( excessRate × refundedValue , eligibleRecentOrderValue )
   min = 0
   period = "last_30_days"   // reported over the recent window, not "monthly"
```
**Required thresholds (else `impact_not_quantifiable`, but STILL show the behavioural finding):**
- `|E| ≥ 5` (minimum customer completed orders);
- store eligible-order count `≥ 50` (minimum store completed orders);
- `LOOKBACK = 90 days` fixed;
- exclude non-`{paid,approved}` (cancelled/test/synthetic) orders;
- dedupe by `Order.id` (no order counted twice);
- monetary cap at `eligibleRecentOrderValue = Σ totalAmount over E`.
**Assumption documented:** because only a boolean `refunded` and the full `totalAmount` exist (no partial-refund amount), `refundedValue` treats a refunded order as fully returned — an over-estimate — hence the `excessRate` scaling and the hard cap keep it conservative. If thresholds fail, return `impact_not_quantifiable` and render the behavioural finding (rate vs baseline) with `dataQuality: "insufficient_data"` for the money only.

### 7.4 Competitor revenue impact — simplified, importance not double-counted (item 4)

**Math review:** `recentProductRevenueProxy = sellingPrice × salesVelocity` already encodes product scale; multiplying again by an importance *share* (proxy/Σproxy) double-discounts small SKUs. There is **no code-level evidence** for the previous importance-multiplier treatment (no competitor-revenue formula exists in the codebase), so it is removed from the monetary estimate.

**Final formula:**
```
max = recentProductRevenueProxy × min(validPriceGap, gapCap) × confidenceFactor
min = 0
period = "monthly_estimate"   // salesVelocity is a ~monthly-scaled proxy
```
where `gapCap = 0.15`, `confidenceFactor = {high:0.6, medium:0.3}`, `validPriceGap = (ourPrice − competitorPrice)/ourPrice` (>0 only).
**Return `impact_not_quantifiable`** when: `salesVelocity` is null/absent (must be a **real stored** value, not the code's `?? 8` default), no fresh `CompetitorData.price`, match `confidenceLabel = low`, or `collectedAt` older than 14 days.
**Product importance is used only for prioritization, not money:** it may raise/lower `urgency` and acts as an **absolute cap** (a tiny-SKU insight cannot outrank larger ones), but it never multiplies the dollar estimate. Boundary tests in §14.

### 7.5 Potential-upside canonical selection & de-duplication (item 1)

**Problem:** underpricing, safe-pricing profit, and margin opportunity can reference the *same* product/recommendation (`PriceHistory.expectedProfitGain` reused; `ProfitOptimizationData.projectedMonthlyProfit` for the same handle), risking double counting.

**Canonical identity:** `dedupKey = storeId + ":" + productHandle + ":" + analysisWindow` (analysisWindow = the recommendation's rounded time bucket, e.g. day). Every product/recommendation contributes to **exactly one** potential-upside amount per window.

**Source-priority hierarchy (first match wins; others for the same `dedupKey` are dropped):**
1. Valid `PriceHistory.expectedProfitGain` (non-null, > 0, fresh) — most specific.
2. Else valid `ProfitOptimizationData.projectedMonthlyProfit` (non-null, > 0).
3. Else a supported deterministic derived estimate (e.g. `max(0, recommendedPrice − currentPrice) × realSalesVelocity`) — only when inputs are real (no defaulted velocity).
4. Else `impact_not_quantifiable`.

**Rule:** never sum multiple opportunity estimates for the same `dedupKey`. When multiple `PriceHistory` rows exist for one product/window, select the **most recent valid** row only. The three upside "categories" become *labels describing which source won*, not additive buckets.

### 7.6 Impact periods (item 3)

Every `FinancialImpact` and `LeakGroup` carries an explicit `ImpactPeriod`. **Only amounts with the same period are aggregated.** Concretely:
- high-risk-order exposure → `current_open_exposure` (point-in-time; sum of `totalAmount` of currently-open High-risk orders) — **never** added to pricing/competitor `monthly_estimate`;
- competitor pressure → `monthly_estimate`; return-abuse → `last_30_days`; pricing/margin upside → `monthly_estimate` or `per_order` as applicable.
`revenueAtRisk`/`potentialUpside` are therefore **arrays of period-homogeneous groups**; the UI renders each group separately and **shows the period beside every amount**. No cross-period sum ever appears.

---

## 8. Confidence rules

Inherited where a source provides it; else derived from data sufficiency (row count + recency); never assumed high. `low` shown but excluded from monetary headline ranking. `insufficient_data` excludes from monetary scoring (but see §7.1 critical lane).

## 9. Insufficient-data behaviour

Every unquantifiable value renders an explicit "Insufficient data"/"Impact not quantified" state via `PageState`, with a one-line reason and (where useful) the action that would improve it. Summaries never fabricate; a not-ready store shows the existing readiness state. **Behavioural findings still render even when their money is not quantifiable (§7.3).**

---

## 10. Dashboard + module presentation (items 5, 8, 9)

### 10.1 Dashboard section hierarchy (reorder within existing `/app/dashboard`)
1. AI Executive Summary → 2. Where to focus today → 3. **Critical attention** (item 7) → 4. Revenue Leak Detector → 5. existing metric cards → 6. recent insights/activity → 7. data coverage & sync status. Nothing removed.

### 10.2 Module-level explainability (item 5)
On the **existing** Fraud, Competitor, and Pricing/Profit pages, each **major existing finding** gains an expandable `ExplainableInsightCard` (or a compact module wrapper) disclosing: what was detected · why · aggregate evidence · estimated impact **or** `impact_not_quantifiable` · recommended action · confidence · data quality · **methodology**. This is additive display only — **no redesign, no route change, no `ModuleGate`/control/gating change.** Exact files edited: `FraudPage.tsx`, `CompetitorPage.tsx`, `PricingProfitPage.tsx` (listed in §2).

### 10.3 UI scope
Expandable cards; "Why this priority?" (component scores + weights); clickable Revenue Leak categories; meaningful loading/empty/insufficient-data states; responsive Polaris; keyboard accessibility; `prefers-reduced-motion`; subtle transitions only. Shopify-native enhancement using existing Polaris + navigation.

---

## 11. Accessibility
Polaris (WCAG-oriented); keyboard-reachable/labeled; status by text + Badge, never colour alone; accessibility labels on Spinner/Banner; heading hierarchy; `prefers-reduced-motion` respected.

## 12. Mobile
Responsive Polaris; cards stack; tables scroll in `overflow-x`; touch targets meet Polaris minimums; verified at mobile widths.

---

## 13. Database scope (item 6)

**No database change in the first release — full stop.** No `InsightReviewStatus`, no new table, no Prisma schema change, no migration. Phase 1 ships read-only intelligence only. Any future workflow-status persistence is a **separate later enhancement**, out of scope here.

---

## 14. TypeScript baseline & tests (item 1/2/4/7 tests)

### 14.1 TS baseline
`docs/ts-baseline-frontend.txt` holds the 32 pre-existing frontend errors. **Gate:** no new signatures, count stays 32, no Phase-1 file in `tsc` output, backend stays 0, `vite build` green.

### 14.2 Baseline comparison procedure
```bash
cd frontend && npx tsc --noEmit 2>&1 | grep -E "error TS" | sort > /tmp/ts-now.txt
diff docs/ts-baseline-frontend.txt /tmp/ts-now.txt        # MUST be empty
grep -E "modules/Dashboard/components|lib/insightsTypes|CriticalAttention" /tmp/ts-now.txt  # MUST be empty
cd backend && npx tsc --noEmit                            # MUST exit 0
cd ../frontend && npm run build                           # MUST succeed
```
Canonical, path-independent gate: count unchanged + no new signatures + no new Phase-1 file.

### 14.3 Required unit tests (deterministic pure functions)

**Potential-upside dedup (§7.5):**
- same product in both `PriceHistory` and `ProfitOptimizationData` → counted **once** (PriceHistory wins);
- multiple `PriceHistory` rows for one product → only the most-recent valid row used;
- stale recommendation rows → excluded;
- duplicate recommendation events (same `dedupKey`) → single contribution;
- different products with legitimate separate opportunities → each counted once.

**Return-abuse (§7.3):**
- below `|E|≥5` or store `<50` eligible → `impact_not_quantifiable` **but** behavioural finding present;
- cancelled/test/`baseline`-status orders excluded; duplicates by `Order.id` not double-counted;
- monetary result capped at `eligibleRecentOrderValue`; `excessRate=0` when at/below baseline.

**Competitor (§7.4) boundary:**
- `gapCap` enforced (gap 0.5 → treated as 0.15); `confidenceFactor` applied; `min=0`;
- null/defaulted `salesVelocity` → `impact_not_quantifiable`; stale `collectedAt` (>14d) → `impact_not_quantifiable`; `low` confidence → `impact_not_quantifiable`;
- importance never changes the dollar amount (only urgency/cap).

**Periods (§7.6):** items of different periods are never summed; each group is period-homogeneous.

**Critical lane (§7.1/item 7):** a `critical`+`high`-confidence fraud finding with `impact_not_quantifiable` appears in `criticalAttention`, is labeled "Impact not quantified", and receives **no** fabricated monetary score.

**Evidence allowlist:** aggregate-only mapper never emits email/address/IP/device/payment fingerprint/raw payloads.

### 14.4 Manual QA matrix
Ready store · still-syncing · no-COGS · low-confidence competitor · empty store — each renders real ranges or explicit insufficient/not-quantifiable, with **period shown beside every amount** and **no raw PII in any response or log**. Regression smoke on auth/billing/gating/install/webhooks/routes.

---

## 15. Release & rollback
Additive commits via existing flow; single read-only endpoint; new sections degrade gracefully. Gate: §14.2 comparison + build pass before commit/deploy. Rollback = revert additive commits (baseline snapshotted as `approved-backup-app1`); **no DB migration ships, so nothing to roll back on the data layer.**

## 16. Compliance & protected-data safeguards
No new scopes/API-version/URL/webhook change. No prohibited automation (advisory only; deep-links, never execute). **Strict aggregate-only evidence allowlist**; forbidden fields (full email/address/IP/device/payment fingerprint/raw payloads) never in responses or logs; identity capped to what the approved module already shows. Tenant isolation preserved (store-scoped reads). Executive Summary deterministic/templated (no live LLM).

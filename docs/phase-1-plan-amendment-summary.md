# Phase 1 Plan — Amendment Summary

Date: 2026-07-31
Applies to: `docs/approved-baseline-audit.md`, `docs/phase-1-implementation-plan.md`, `docs/phase-1-risk-register.md`
Status: **Documentation only. No feature code implemented. No deploy.**

This records the mandatory corrections applied to the Phase 1 plan before implementation.

---

## Corrections applied

### 1. Opportunity Score — reweighted, component scores exposed
**Why:** the original single-blend formula over-weighted impact/confidence and did not expose *why* something ranked. Merchants need "Why this priority?".
**Changed:** implementation plan **§5** (`OpportunityScoreBreakdown` type), **§7.1** (formula + normalization), **§7.2** (ease of action). Audit **§4**. Risk **R4, R11**.
**Final formula:** `total = 0.35·financialImpact + 0.25·urgency + 0.20·confidence + 0.10·easeOfAction + 0.10·recency`, each factor normalized to [0,100] deterministically. **Every component score + weights returned to the UI.** If financial impact is `impact_not_quantifiable` **or** confidence is `insufficient_data`, the item is **excluded from ranking** (never scored high). **Ease of action** is a fixed lookup over existing recommendation types (`one_click_review` / `guided` / `manual`), conservative default `manual` — **never LLM-generated.**

### 2. Revenue Leak — two separate groups, never summed
**Why:** combining upside and risk into one number reads as a confirmed loss or guaranteed profit — misleading and a compliance risk.
**Changed:** plan **§5** (`RevenueLeakModel`, `LeakGroup` — no `totalExposure`), **§7.3**, **§10**. Audit **§4**. Risk **R3**.
**Final model:** `potentialUpside` (underpricing / margin / safe-pricing profit) and `revenueAtRisk` (competitor-price pressure / return-abuse / high-risk-order), each with `min, max, currency, period, items[], confidence, dataCoverage`. **No combined total field exists.** UI never shows A+B as total exposure / confirmed loss / guaranteed profit.

### 3. Competitor impact — audited, bounded, or not quantifiable
**Why:** must not invent a competitor revenue number.
**Audit result (code-verified):** **no defensible competitor-revenue-impact formula exists**; and **no order line items exist**, so per-product revenue is only approximable via `ProfitOptimizationData` (`sellingPrice × salesVelocity`).
**Changed:** plan **§7.4**. Audit **§4** (clarification note). Risk **R6, R7**.
**Final rule:** conservative bounded range `max = revenueProxy × min(priceGap, 0.15) × confidenceFactor(high 0.6 / medium 0.3) × importanceWeight`, `min = 0` always. Any missing/stale(>14d)/low-confidence input → **`impact_not_quantifiable`** (no invented amount). Caps and assumptions documented in §7.4.

### 4. Protected customer data — strict aggregate-only evidence allowlist
**Why:** explainability must not widen protected-data exposure beyond the approved modules.
**Changed:** plan **§5** (`AggregateEvidence`), **§16**. Audit **§4** (evidence note). Risk **R5**.
**Final rule:** evidence responses/logs expose **only** aggregate values — return rate, order count, refund count, address count, order-frequency band, risk-signal count. **Never** exposed in generic evidence or logs: full email, full address, IP address, device fingerprint, payment fingerprint, raw Shopify customer/order payloads. Identity visibility capped to exactly what the approved module already shows.

### 5. TypeScript baseline — reproducible + gated
**Why:** the 32 pre-existing frontend `tsc` errors must not grow or be masked, and new code must be clean.
**Changed:** plan **§14** (baseline, requirements, comparison procedure), **§15**. New file **`docs/ts-baseline-frontend.txt`** (32 error lines captured from `main`). Risk **R9**.
**Requirements:** no new error signatures; count stays 32; no Phase-1 file in `tsc` output; backend stays 0; `vite build` green. Comparison procedure documented in §14.3 (run in the same working tree; the canonical, path-independent gate is *count unchanged + no new signatures + no new Phase-1 file*).

### 6. Database scope — no migration in the first release
**Why:** ship read-only intelligence first; avoid any schema risk on a live approved app.
**Changed:** plan **§2, §13**. Risk **R2**.
**Final decision:** `InsightReviewStatus` and all migrations **removed** from the first release. Merchant recommendation-status persistence deferred to a later optional additive enhancement.

### 7. Dashboard API — single aggregate endpoint
**Why:** one request avoids duplicate DB/service work and inconsistent timestamps.
**Changed:** plan **§5** (`DashboardInsightsResponse`), **§6**. Risk **R10**.
**Final decision:** one `GET /api/insights/dashboard` returning `{ executiveSummary, opportunities, revenueLeak, dataCoverage, generatedAt }`. Shared reads computed once; one consistent `generatedAt`. No status-write endpoint in the first release. Focused endpoints only later if genuinely needed.

### 8. Dashboard presentation — safe reordering
**Why:** decision-support hierarchy should lead; existing capabilities must stay.
**Changed:** plan **§10.1**. Risk (covered by R1).
**Final order (within the existing `/app/dashboard` route):** 1) AI Executive Summary, 2) Where to focus today, 3) Revenue Leak Detector, 4) existing metric cards, 5) recent insights/activity, 6) data coverage & sync status. No route/control/gating removed.

### 9. UI phase — scope clarified
**Why:** confirm this is a Shopify-native enhancement, not a redesign.
**Changed:** plan **§10.2, §11**. Risk **R15**.
**Final scope:** expandable Explainable Insight cards; "Why this priority?" disclosure; clickable Revenue Leak categories; meaningful loading/empty/insufficient-data states; responsive Polaris; keyboard accessibility; `prefers-reduced-motion` support; subtle transitions only. Polaris + existing navigation preserved.

---

## Final agreed types (canonical)

- `OpportunityScoreBreakdown` — total + five component scores + fixed weights `{impact .35, urgency .25, confidence .20, ease .10, recency .10}` + `excludedFromRanking`.
- `FinancialImpact` — discriminated union: `quantified {min,max,currency,period,basis,isEstimate}` | `impact_not_quantifiable {reason}`.
- `AggregateEvidence` — `{label, value}` only; no raw PII.
- `RevenueLeakModel` — `{potentialUpside: LeakGroup, revenueAtRisk: LeakGroup}`; **no combined total**.
- `LeakGroup` — `{kind, min, max, currency, period, items[], confidence, dataCoverage}`.
- `DashboardInsightsResponse` — `{executiveSummary, opportunities[], revenueLeak, dataCoverage[], generatedAt}`.
(Full definitions in implementation plan §5.)

## Final agreed formulas (canonical)

- **Opportunity Score:** `0.35·impact + 0.25·urgency + 0.20·confidence + 0.10·ease + 0.10·recency` (each 0–100); exclude if impact/confidence unavailable.
- **Ease of action:** fixed lookup over existing recommendation types → `one_click_review|guided|manual`; default `manual`; no LLM.
- **Competitor impact (bounded):** `min=0`, `max = revenueProxy × min(gap, 0.15) × confidenceFactor × importance`; else `impact_not_quantifiable`.
- **Revenue leak:** two independent bounded groups; never summed.

---

## Confirmations

- ✅ **No feature code was implemented.** Only Markdown docs and the `ts-baseline-frontend.txt` capture were created/edited. No `.ts`/`.tsx`/schema files changed.
- ✅ **Protected files remain unchanged.** No edits to auth, token exchange, session handling, offline-token storage, scopes, protected-data permissions, billing, subscriptions, trial, plan gating, install/reconnect, uninstall, webhooks, API version, app/redirect URLs, navigation routes, tenant isolation, or existing DB fields. (Verified by `git diff` — only files under `docs/` changed.)
- ✅ **No deploy.** Nothing pushed as part of this amendment task beyond the local commit.
- ✅ **No database migration** planned for the first release.

## Files changed in this amendment

- `docs/approved-baseline-audit.md` — §4 clarifications (competitor formula absence, no line items, two-group leak, evidence allowlist).
- `docs/phase-1-implementation-plan.md` — §2, §5, §6, §7, §10, §11, §13, §14, §15, §16 rewritten/added.
- `docs/phase-1-risk-register.md` — risks re-issued (R2–R15) reflecting amendments.
- `docs/ts-baseline-frontend.txt` — **new**, reproducible 32-error baseline.
- `docs/phase-1-plan-amendment-summary.md` — **new**, this file.

# Phase 1 — Final Readiness Check

Date: 2026-07-31
Purpose: the final pre-implementation gate. Every item below must be TRUE before any Phase 1 feature code is written. **No feature code has been implemented; nothing has been deployed.**
References: `approved-baseline-audit.md`, `phase-1-implementation-plan.md`, `phase-1-risk-register.md`, `phase-1-plan-amendment-summary.md`.

---

## 1. No double-counting — ✅ confirmed

Canonical identity `dedupKey = storeId + productHandle + analysisWindow` with a strict source-priority hierarchy (`PriceHistory.expectedProfitGain` → `ProfitOptimizationData.projectedMonthlyProfit` → supported derived estimate with real velocity → `impact_not_quantifiable`). **Each product/recommendation contributes to exactly one potential-upside amount per window; estimates are never summed for the same underlying product.** Multiple `PriceHistory` rows for one product resolve to the most-recent valid row only. Five unit tests specified (same product across both tables, multiple rows, stale rows, duplicate events, legitimately-separate products). — Plan §7.5, §14.3; Risk R7.

## 2. Exact return-abuse field semantics — ✅ confirmed (code-audited)

- `Customer.totalRefunds` = **COUNT of refunded orders**, not an amount (`shopifyAdminService.ts:919`).
- `Customer.refundRate` = `totalRefunds / totalOrders` (ratio 0–1).
- `Order.refunded` / `refundRequested` = booleans; `Order.totalAmount` = order total. **No refund-amount / partial-refund field exists.**
- Eligible order = `status ∈ {"paid","approved"}` (allowlist; synthetic `"baseline"` excluded); Customer↔Order via `Order.customerId`.

The vague `refundRate/totalRefunds × totalAmount` formula is **rejected**. Replaced with excess-over-store-baseline over a fixed **90-day** lookback, thresholds `|E| ≥ 5` (customer) and `≥ 50` (store), dedupe by `Order.id`, monetary cap at eligible recent order value; otherwise `impact_not_quantifiable` **while still showing the behavioural finding**. — Plan §7.3; Audit §9/10 table; Risk R8.

## 3. Correct impact periods — ✅ confirmed

Explicit `ImpactPeriod` = `per_order | current_open_exposure | last_7_days | last_30_days | monthly_estimate` on every `FinancialImpact` and `LeakGroup`. **Only same-period amounts are aggregated;** groups are period-homogeneous arrays. Point-in-time high-risk-order exposure (`current_open_exposure`) is **never** added to monthly pricing/competitor estimates. **The UI shows the period beside every amount.** — Plan §5, §7.6, §10; Risk R9.

## 4. Final competitor formula — ✅ confirmed

`max = recentProductRevenueProxy × min(validPriceGap, 0.15) × confidenceFactor{high:0.6, medium:0.3}`, `min = 0`, `period = "monthly_estimate"`. **Product importance is NOT multiplied into the money** (that would double-discount, since `sellingPrice × salesVelocity` already encodes scale, and no code supports the old treatment); importance is used only for urgency and as an absolute prioritization cap. Requires a **real stored** `salesVelocity` (not the `?? 8` default), fresh `CompetitorData.price` (≤14 days), and non-`low` match confidence; otherwise `impact_not_quantifiable`. Boundary tests specified. — Plan §7.4; Risk R10.

## 5. Module-level UI integration — ✅ confirmed

Explainability is added to the **existing** Fraud, Competitor, and Pricing/Profit pages via an additive `ExplainableInsightCard` on existing major findings, disclosing: what · why · aggregate evidence · impact or `impact_not_quantifiable` · recommended action · confidence · data quality · methodology. **Exact files minimally edited:** `frontend/src/modules/FraudIntelligence/FraudPage.tsx`, `frontend/src/modules/CompetitorIntelligence/CompetitorPage.tsx`, `frontend/src/modules/PricingProfit/PricingProfitPage.tsx`. **No redesign; routes, `ModuleGate` behaviour, existing controls, and plan gating preserved.** — Plan §2, §10.2; Risk R15.

## 6. No database changes — ✅ confirmed

First Phase 1 release has **no `InsightReviewStatus`, no new table, no Prisma schema change, and no migration**. The audit conclusion has been corrected to remove any suggestion of a first-release optional table. Persistence is a separate later enhancement, out of scope. — Audit §9/10; Plan §13; Risk R2.

## 7. Critical non-monetary findings — ✅ confirmed (Approach A)

A separate **Critical attention** lane surfaces `urgency = critical` + `confidence ∈ {high, medium}` findings **even when `impact_not_quantifiable`**, ordered by urgency/confidence/recency, labeled "Impact not quantified". **No fabricated financial-impact score.** A high-confidence critical fraud/operational risk therefore never disappears from "Where to focus". Unit test specified. — Plan §7.1, §5, §10.1, §14.3; Risk R11.

## 8. No feature code implemented — ✅ confirmed

Only Markdown documents (and the `ts-baseline-frontend.txt` capture) were created/edited across both amendment rounds. **No `.ts`, `.tsx`, or `.prisma` file was changed.** To be re-verified by `git diff` before any commit: only files under `docs/` differ.

## 9. Protected files unchanged — ✅ confirmed

No edits to OAuth, token exchange, session-token acquisition, offline-token storage, Shopify scopes, protected-customer-data permissions, billing, subscriptions, trial logic, plan gating, install/reconnect, uninstall, webhooks, API version, app/redirect URLs, public listing claims, navigation routes, tenant isolation, or existing DB fields. Planned module-page edits are strictly additive display only.

## 10. No deploy — ✅ confirmed

Nothing was pushed or deployed in this pass. The approved production baseline remains snapshotted at `approved-backup-app1` (branch + tag `approved-backup-app1-v1` + zip).

---

## Cross-check summary

| Requirement | Status | Where enforced |
|---|---|---|
| No double-counting | ✅ | Plan §7.5; Tests §14.3; R7 |
| Return-abuse semantics exact | ✅ | Audit §9/10; Plan §7.3; R8 |
| Correct impact periods | ✅ | Plan §5/§7.6; R9 |
| Final competitor formula | ✅ | Plan §7.4; R10 |
| Module-level UI (3 files) | ✅ | Plan §2/§10.2; R15 |
| No DB changes | ✅ | Audit §9/10; Plan §13; R2 |
| Critical non-monetary lane | ✅ | Plan §7.1; R11 |
| No feature code | ✅ | git diff (docs-only) |
| Protected files unchanged | ✅ | must-not-change list §3 |
| No deploy | ✅ | this pass |

**Readiness: PASS — plan is full and final. Implementation may proceed only on explicit go-ahead, following this plan exactly.**

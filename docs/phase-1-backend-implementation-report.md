# Phase 1 — Backend Implementation Report

Date: 2026-07-31
Scope: backend intelligence layer (Parts 1–7). **No deploy.** Frontend UI not built in this step.
Governing docs: `phase-1-implementation-plan.md`, `phase-1-final-readiness-check.md`.

---

## Files changed

**New (additive):**
- `backend/src/services/explainabilityCalc.ts` — all pure deterministic types + calculations (no DB/network/LLM).
- `backend/src/services/explainabilityService.ts` — store-scoped orchestration (one read, capability enforcement, assembly).
- `backend/src/routes/insightsRoutes.ts` — `GET /api/insights/dashboard`.
- `backend/tests/explainabilityCalc.test.cjs` — 26 unit tests.

**Modified (additive only):**
- `backend/src/routes/index.ts` — **3 lines**: import + comment + `router.use("/api/insights", insightsRouter)`. No other change.

**Docs:** `phase-1-backend-implementation-report.md` (this), plus three stale-line corrections in `phase-1-plan-amendment-summary.md`.

**Not changed:** no Prisma schema, no migration, no protected file (see confirmation below).

---

## Exact formulas (as implemented)

- **Opportunity Score:** `total = 0.35·impact + 0.25·urgency + 0.20·confidence + 0.10·ease + 0.10·recency`, each factor 0–100. `impact = 100·clamp(max/storeImpactCap,0,1)`; `urgency {critical100,high75,medium50,low25}`; `confidence {high100,medium60,low30,insufficient→excluded}`; `ease {one_click100,guided60,manual30}`; `recency` linear 100→0 over 30 days. **Excluded from monetary ranking** (total forced 0) when impact is `impact_not_quantifiable` OR confidence is `insufficient_data`.
- **Critical Attention:** included when `urgency=critical` AND `confidence∈{high,medium}`, even if `impact_not_quantifiable`; ordered by confidence then recency; **no fabricated money score**.
- **Ease of action:** fixed regex lookup over existing recommendation text → `one_click_review|guided|manual`, default `manual`. No LLM.
- **Potential-upside dedup:** `dedupeKey = storeId::(id:<productId> | handle:<handle>)::<UTC YYYY-MM-DD>`; source priority `price_history(1) > profit_optimization(2) > derived(3)`; among same source, latest timestamp wins; one contribution per key; never summed.
- **Competitor impact:** `max = (sellingPrice × salesVelocity) × min(validPriceGap, 0.15) × confidenceFactor{high0.6,medium0.3}`, `min=0`, period `monthly_estimate`. Importance never multiplies money. `impact_not_quantifiable` if velocity null/absent, no selling price, no competitor price, match confidence `low`, gap ≤ 0, or `collectedAt` > 14 days.
- **Return-abuse:** 90-day baseline; `excessRate = max(0, customerRefundRate − storeBaselineRefundRate)`; money over the last 30 days only: `max = min(excessRate × refundedValue30d, eligibleOrderValue30d)`, `min=0`, period `last_30_days`. Thresholds: ≥5 eligible customer orders, ≥50 eligible store orders; dedupe by `Order.id`; basis explicitly discloses full order value is used because partial-refund amounts are not stored. Below thresholds → `impact_not_quantifiable`, behavioural finding preserved.
- **High-risk open exposure:** sum of `totalAmount` for deduped High-risk orders in open statuses, `min=0`, period `current_open_exposure`.
- **Revenue Leak:** `groupLeaksByPeriod` builds period-homogeneous `LeakGroup[]`; different periods are never summed.

## Exact eligible / order statuses

- **Eligible completed order** (return-abuse baseline + windows): `Order.status ∈ {"paid","approved"}` (Shopify `displayFinancialStatus` lowercased). Excludes `cancelled`, `test`, `voided`, `refunded`-status, and the synthetic `"baseline"`.
- **Currently open/unresolved High-risk order** (open exposure): `fraudRiskLevel === "High"` AND `refunded === false` AND `status ∈ {"paid","approved","manual_review"}` (`manual_review` is the app’s existing review queue). Refunded/voided/expired/cancelled/baseline are excluded — a historical High-risk order is **not** assumed still open.

## Exact capability-filtering behaviour (Part 3)

- Server resolves entitlements via the existing `subscriptionService.resolveEntitlements(shop)` → `enabledModules ⊆ {fraud,competitor,pricing,profit}`. No billing file or plan definition changed.
- Insight→capability map: `fraud/trust/return_abuse → fraud`, `competitor → competitor`, `pricing → pricing`, `profit → profit`.
- Filtering happens **before** scoring, ranking, revenue-leak grouping, data-coverage, and executive summary. Inaccessible-module insights and leak items are removed first, so they cannot appear in the JSON or influence any total/ranking. Fully-entitled merchants see all modules (unchanged behaviour).
- Defense-in-depth: every DB read is scoped to the one authenticated store; `scopeInsightsToStore` re-filters by `storeId` on top of that.

## Tests and results

`backend/tests/explainabilityCalc.test.cjs` — **26/26 pass.** Covers: opportunity weights, exclusion of unquantifiable/low-confidence from ranking, critical-attention inclusion without fabricated score, all six dedup cases (incl. productId-preferred), all return-abuse cases (thresholds, status exclusion, dup Order.id, 90-vs-30 windows, zero-excess, 30-day cap), competitor cases (15% cap, high/medium factors, low/stale/null-velocity not-quantifiable, importance-independent money), period homogeneity, high-risk open exposure, evidence allowlist (PII dropped), capability filtering (lower & full plan), two-store isolation, and gated-data-excluded-from-totals.

**Suite comparison (proves no regressions):** baseline (no Phase 1) = 73 tests / 67 pass / 6 fail; with Phase 1 = 99 tests / 93 pass / 6 fail. **+26 passing, +0 failing.** The 6 pre-existing failures are integration tests failing on a Node HTTP-header env issue (`Invalid value "undefined" for header "Cookie"`) in test files unrelated to Phase 1; confirmed identical on the committed baseline.

**Build gates:** backend `tsc` = 0 errors; frontend `tsc` = 32 (identical to `docs/ts-baseline-frontend.txt`, no new signatures, no Phase-1 file in output); frontend `vite build` = green.

## Performance considerations

- **One store-scoped `prisma.store.findUnique`** with nested selects for orders/customers/priceHistory/profitData/competitorData — no N+1. Return-abuse groups orders by `customerId` in memory (no per-customer query). Competitor joins profit data via an in-memory `Map` by handle. One `resolveEntitlements` call. Single `generatedAt`. Per-module result caps (10) bound work. All computation is O(n) over the read rows.

## Privacy review (Part 4)

- Evidence is built **only** through `buildAggregateEvidence`, which drops any key not on the allowlist (return_rate, order_count, refund_count, address_count, order_frequency_band, risk_signal_count, price_gap, match_confidence, margin_percentage, sales_velocity). Unit test asserts email/IP/address/device/payment fingerprint/raw payload are never emitted.
- The service **does not select** email, address, IP, device/payment fingerprint, tokens, or raw Shopify payloads. Return-abuse insights carry no customer identifier (internal `customer.id` cuid only, used as an opaque key). Identity visibility is unchanged from the approved modules (merchant sees identity only by deep-linking into the existing module).
- Logs emit counts/flags only (`insights.dashboard_built`), never PII.
- Every query is scoped to the authenticated `storeId`; two-store isolation unit-tested.

## Known limitations

- **No partial-refund amounts exist** in the schema, so return-abuse money uses full order value (disclosed in `basis`) and is conservatively excess-scaled + capped.
- **Per-product revenue** is a proxy (`sellingPrice × salesVelocity`); when velocity is absent the competitor estimate is `impact_not_quantifiable` rather than using the app’s `?? 8` default.
- **Match confidence** is read from `CompetitorData.insightsJson`; when absent it defaults to `low` → `impact_not_quantifiable` (safe).
- Frontend UI (dashboard sections, module cards, `insightsTypes.ts`) is **not** in this step; the endpoint is backend-only for now.

## Confirmation — protected files unchanged

No modification to: OAuth, token exchange, session-token acquisition, offline-token storage, Shopify scopes, API version, app/redirect URLs, billing, subscriptions, trial, plan definitions, install/reconnect/uninstall, webhooks, protected customer-data permissions, existing Prisma fields, or existing routes/navigation. `git diff` shows the only tracked code change is `+3` lines in `backend/src/routes/index.ts` (the additive route mount). No database table or migration added. No automated order/cancel/refund/reprice/customer/product actions.

## Rollback steps

Everything is additive. To roll back: revert this commit (`git revert <sha>`) — it removes the mount line and the new files; nothing else is affected. No data-layer change ships, so there is nothing to undo in the database. The approved baseline remains snapshotted at branch/tag `approved-backup-app1`.

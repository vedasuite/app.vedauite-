# Approved Baseline Audit — VedaSuite

Date: 2026-07-30
Branch audited: `main` @ `ccfbfbc` (approved production baseline; also snapshotted as tag `approved-backup-app1-v1`)
Purpose: complete repository audit before any Phase 1 explainability work. **No feature code in this pass.**

---

## 0. Baseline validation results (audit item 7)

Run against `main` on 2026-07-30. Pre-existing state, recorded verbatim — **not** to be "fixed" as part of Phase 1.

| Check | Result |
|---|---|
| Backend `tsc --noEmit` | ✅ **0 errors** — clean |
| Frontend `tsc --noEmit` | ⚠️ **32 pre-existing errors** across 11 files (see below) |
| Frontend production build (`vite build`, what Render runs) | ✅ **succeeds** — Vite does not typecheck, so tsc errors do not block deploy |
| Unit tests | ❌ **none exist** — no `test` script in either `package.json` |
| Lint | ❌ **none configured** — no ESLint config, no `lint` script |

### Pre-existing frontend `tsc` errors (do not touch)

By error code: `TS2322` ×15 (Polaris prop type mismatches — e.g. `gap="250"`, tone/variant casing), `TS7016` ×7 (**6 of them** are the missing declaration for `../lib/backendModuleAccess.js` — an untyped JS module imported across pages), `TS2339` ×5, `TS18047` ×3, `TS2352` ×1, `TS18048` ×1.

Files with pre-existing errors: `ModuleGate.tsx`, `AppFrame.tsx`, `CompetitorPage.tsx`, `DashboardPage.tsx`, `FraudPage.tsx`, `OnboardingPage.tsx`, `PricingProfitPage.tsx`, `SettingsPage.tsx`, `PricingPage.tsx`, `TrustAbusePage.tsx`, `OnboardingProvider.tsx`.

**Rule for Phase 1:** new code must be `tsc`-clean; we do not add to this count and we do not rewrite these unrelated errors. Because the build already tolerates them, the deploy risk from Phase 1 comes only from *new* code, which we hold to a higher bar than the baseline.

---

## 1. Frontend routes and components (audit item 1)

Routing is in `frontend/src/App.tsx` (React Router). Navigation is in `frontend/src/layout/AppFrame.tsx` (`navigationItems`). Server-side, every route is also listed in `backend/src/app.ts` `embeddedAppRoutes` so a hard refresh serves the SPA (not a 404).

| Route | Component | Module dir | Nav label |
|---|---|---|---|
| `/app/onboarding` | `OnboardingPage` | `modules/Onboarding` | Onboarding |
| `/app/dashboard` | `DashboardPage` | `modules/Dashboard` | Dashboard |
| `/app/fraud-intelligence` | `FraudPage` (via `InsightRoute moduleKey="fraud"`) | `modules/FraudIntelligence` | Fraud Intelligence |
| `/app/competitor-intelligence` | `CompetitorPage` | `modules/CompetitorIntelligence` | Competitor Intelligence |
| `/app/ai-pricing-engine` | `PricingProfitPage` (via `InsightRoute moduleKey="pricing"`) | `modules/PricingProfit` | AI Pricing Engine |
| `/app/billing` | `PricingPage` | `modules/SubscriptionPlans` | Billing |
| `/app/settings` | `SettingsPage` | `modules/Settings` | Settings |
| `/app/support` | `SupportPage` | `modules/Support` | Support |

Additional module directories that are **sub-views / supporting UI** (not top-level routes): `CreditScore`, `TrustAbuse`, `PricingStrategy`, `ProfitOptimization`, `Reports`. Customer-trust / shopper-risk / return-abuse content is surfaced through the **Fraud Intelligence** route and the `TrustAbuse`/`CreditScore` modules. Profit recommendations are surfaced through the **AI Pricing Engine** route and `ProfitOptimization`/`PricingProfit`.

Legacy path redirects (all `Navigate` to the `/app/*` canonical): `/dashboard`, `/onboarding`, `/modules/fraud`, `/modules/competitor`, `/modules/pricing`, `/trust-abuse`, `/competitor`, `/pricing-profit`, `/subscription`, `/settings`, `/fraud`, `/credit-score`, `/pricing`, `/profit`. **These are approved navigation routes — do not remove or rename (protected).**

---

## 2. Backend services, APIs and database models (audit item 2)

### Prisma models (`backend/prisma/schema.prisma`)

`Store`, `ProductSnapshot`, `VariantSnapshot`, `SubscriptionPlan`, `StoreSubscription`, `BillingAuditLog`, `BillingPlanIntent`, `Customer`, `Order`, `FraudSignal`, `CompetitorDomain`, `CompetitorData`, `PriceHistory`, `ProfitOptimizationData`, `TimelineEvent`, `SyncJob`, `SupportTicket`.

### Value → source-of-truth map

| Value the audit asks about | Where it lives today |
|---|---|
| Order risk | `Order.fraudScore`, `Order.fraudRiskLevel`; `FraudSignal.riskScore`, `FraudSignal.riskLevel` |
| Customer risk | `Customer.creditScore`, `creditCategory`, `paymentReliability`, `fraudSignalsCount`, `refundRate` |
| Return / refund metrics | `Customer.totalRefunds`, `refundRate`; `Order.refundRequested`, `refunded`; `ProfitOptimizationData.returnRate`; `FraudSignal.refundHistory` |
| Order history | `Order` (`totalAmount`, `currency`, `status`, `createdAt`) |
| Product sales velocity | `ProfitOptimizationData.salesVelocity` |
| Competitor price changes | `CompetitorData.price`, `promotion`, `stockStatus`, `collectedAt` (time-series by `collectedAt`) |
| Product matching | `CompetitorData.productHandle` ↔ competitor; `competitorService.ts` matching logic |
| Match confidence | `competitorService.ts` — `confidenceScore` (0–100), `confidenceLabel` (`high/medium/low`), `matchReason` |
| Current prices | `PriceHistory.currentPrice`; `ProfitOptimizationData.sellingPrice`; `ProductSnapshot.currentPrice` |
| Recommended prices | `PriceHistory.recommendedPrice`; `ProfitOptimizationData.optimalPrice` |
| Product costs | `ProfitOptimizationData.productCost` |
| Margins | `PriceHistory.expectedMarginDelta`; `ProfitOptimizationData.projectedMarginIncrease`; derivable `(sellingPrice - productCost) / sellingPrice` |
| Margin guardrails | `Store.profitGuardrail` (Int, default 18) |
| Pricing confidence | `PriceHistory.rationaleJson` (`demandScore`, `demandTrend`, `demandSignals`, `competitorPressure`, `evidenceSignals`); `pricingService.deriveAutomationPosture` |
| Recent revenue | `Order.totalAmount` aggregated; `dashboardService.getDashboardMetrics` |
| Recommendation status | `pricingEngineStateService.ts` (`no_recommendations`, `recommendationCount`, `invalidRecommendationCount`) |

### Relevant services

`fraudService`, `trustAbuseService`, `creditScoreService`, `competitorService`, `pricingService`, `pricingProfitService`, `profitService`, `pricingEngineStateService`, `coreEngineService` (central scoring/derivation engine that writes `PriceHistory`, `ProfitOptimizationData`, `TimelineEvent`), `dashboardService`, `decisionCenterService`, `reportsService`, `storeOperationalStateService`, `readinessEngineService`, `unifiedModuleStateService`.

### Relevant read APIs (all under `/api`, session-token gated)

- `GET /api/dashboard/metrics`
- `GET /api/dashboard/decision-center` → **`decisionCenterService.getUnifiedDecisionCenter`** (see §3)
- `GET /api/reports/weekly`, `GET /api/reports/weekly/export` (`requireFeature("reports")`)
- Module reads: `/api/fraud`, `/api/competitor`, `/api/pricing`, `/api/pricing-profit`, `/api/profit`, `/api/trust-abuse`, `/api/credit-score`

---

## 3. Values that already exist for reasons/evidence/confidence/impact (audit item 3)

**This is the most important finding: the explainability primitives already exist per-module.** Phase 1 is largely *unification and surfacing*, not new derivation.

| Primitive | Already implemented in |
|---|---|
| **Reasons** | `fraudService.buildFraudReasons`, `buildWardrobingReasons`; `pricingService` `demandSignals`/`evidenceSignals`; `competitorService.matchReason`; `PriceHistory.rationaleJson` |
| **Evidence** | `FraudSignal` raw fields (`ipAddress`, `email`, `shippingAddress`, `deviceFingerprint`, `paymentFingerprint`, `refundHistory`, `orderFrequency`); `CompetitorData` (`price`, `promotion`, `stockStatus`, `adCopy`, `source`); pricing `evidenceSignals` |
| **Confidence** | `fraudService.buildFraudConfidence`; `competitorService.confidenceScore`/`confidenceLabel`; pricing rationale `demandScore` |
| **Recommended action** | `fraudService.buildFraudRecommendedAction`, `buildAutomationPosture`; `pricingService.deriveAutomationPosture`; `decisionCenterService` per-decision `recommendedAction` |
| **Financial impact** | `PriceHistory.expectedProfitGain`, `expectedMarginDelta`; `ProfitOptimizationData.projectedMonthlyProfit`, `projectedMarginIncrease` |
| **Recency** | `createdAt`/`collectedAt`/`updatedAt`/`lastSyncAt` on every model |
| **Cross-module prioritization** | **`decisionCenterService.getUnifiedDecisionCenter`** already aggregates fraud + credit + competitor + pricing + profit into ranked decisions with `severity`, `rationale`, `recommendedAction`, `route`, and a top-level `priorityLevel`. Exposed at `GET /api/dashboard/decision-center`. **This is the natural foundation for "Where to focus today" and Opportunity Score.** |

### Phase-1 concept names — none exist yet (all net-new, additive)

A repo-wide search for `opportunityScore`, `executiveSummary`, `revenueLeak`, `whereToFocus`, `explainableInsight`, and `insufficient data` returned **no existing implementations** (one incidental "Not enough data yet" string in `PricingProfitPage.tsx`). So the Phase-1 surface types are greenfield and can be introduced additively without colliding with existing names.

---

## 4. New values derivable deterministically from existing data (audit item 4)

> **Amended 2026-07-30** — formulas below are governed by the amended implementation plan (§7). Two facts were confirmed by code audit and constrain what is derivable:
> - **No competitor-revenue-impact formula exists** in the codebase (`competitorService` computes match/price-gap/priority signals only; nothing links a price gap to revenue).
> - **No order line items exist** in the schema (`Order` has `totalAmount` but no per-product breakdown). True per-product revenue is therefore **not** directly available; the only per-product revenue signal is the `ProfitOptimizationData` proxy `sellingPrice × salesVelocity`.

All of the following can be computed from data already in the DB, with **no new Shopify scopes and no new external calls**:

- **Margin %** = `(sellingPrice − productCost) / sellingPrice` (from `ProfitOptimizationData`), only when `productCost > 0`.
- **Margin-vs-guardrail status** = compare derived margin to `Store.profitGuardrail`.
- **Opportunity Score** (per insight) = deterministic weighted sum of five normalized factors — **financial impact 35% · urgency 25% · confidence 20% · ease of action 10% · recency 10%** — with every component score returned to the UI. Missing impact or confidence **excludes** the item from ranking (never scored high). See implementation plan §7.1–7.2.
- **Revenue Leak** = **two separate groups, never summed** — *potential upside* (underpricing / margin / safe-pricing profit opportunities) and *revenue at risk* (competitor-price pressure / return-abuse / high-risk-order exposure). Each is a bounded range with confidence + data coverage. No combined "total exposure". See §7.3.
- **Competitor revenue impact** = conservative **bounded range** from the velocity revenue proxy × capped price gap × confidence factor × importance, or **`impact_not_quantifiable`** when inputs are missing/stale/low-confidence. See §7.4.
- **Urgency** = deterministic bucket from `severity`/`riskLevel`.
- **Executive Summary** = deterministic templated roll-up of decision-center items + dashboard metrics. **Templated/deterministic, not a live LLM call.**
- **Data-quality / coverage** = derived from row counts and `lastSyncAt` recency per module.

**Evidence exposure (amended):** explainability evidence is **aggregate-only** (return rate, order/refund/address counts, order-frequency band, risk-signal count). Raw PII — full email, full address, IP, device/payment fingerprint, raw Shopify payloads — is **never** placed in generic evidence responses or logs (implementation plan §16).

---

## 5. Values that CANNOT be reliably calculated → must show "insufficient data" (audit item 5)

These must render an explicit **"Insufficient data"** state, never an invented number:

- **Product cost / margin** when `ProfitOptimizationData.productCost` is 0/absent (merchant hasn't entered COGS). Margin is meaningless without cost.
- **Competitor comparison** when `confidenceLabel = "low"` or no `CompetitorData` rows for the handle — do not present a low-confidence match as a firm price gap.
- **Sales velocity / demand** when `salesVelocity` is null or the store has < a minimum order history window.
- **Revenue trends** when order history is below a minimum count (small-sample noise).
- **Any per-insight financial impact** where the underlying field (`expectedProfitGain`, `projectedMonthlyProfit`) is null — show "impact not yet quantifiable," not `$0`.
- **Executive Summary / Opportunity Score** for a store still syncing (`lastSyncStatus` not ready) — show the existing readiness/collecting-data state, not a fabricated summary.

---

## 6. Shared components safe to reuse (audit item 6)

- `components/ModuleGate.tsx` — plan/capability gating wrapper (do not modify; **reuse** to gate any new paid surface).
- `components/PageState.tsx` — loading/empty/error state rendering (**reuse** for insufficient-data and loading states).
- `components/RouteErrorBoundary.tsx` — per-route error boundary (**reuse** — new routes/sections wrap in it, as existing routes do via `withRouteBoundary`).
- Hooks: `useAppState`, `useSubscriptionPlan`, `useEmbeddedNavigation`, `useShopifyAdminLinks` (**reuse** read-only).
- `lib/embeddedShopRequest.ts` — the session-token API client (**reuse** for any new read endpoint; do not modify).
- Polaris design system (`@shopify/polaris`) — all new UI uses Polaris primitives for Shopify-native look + built-in accessibility.

---

## 8. Protected flows that must remain untouched (audit item 8)

Confirmed present and **out of scope for modification**:

| System | Location (do not modify) |
|---|---|
| OAuth / token exchange / session-token acquisition | `routes/authRoutes.ts`, `middleware/verifyShopifySessionToken.ts`, `middleware/ensureOfflineToken.ts`, `services/shopifyConnectionService.ts` (`exchangeSessionTokenForOfflineToken`, `ensureOfflineAccessToken`) |
| Offline-token storage | `Store.accessToken` / `refreshToken` / `accessTokenExpiresAt`; `persistInstallationRecord` |
| Shopify API scopes / version / app URL | `shopify.app.toml` (`scopes = read_products,read_orders,write_orders,read_customers`; `api_version = 2026-01`; `application_url`; redirect URLs) |
| Protected customer data permissions | scope + Partner Dashboard declaration; `Customer`/`Order` PII handling; `privacyService.ts` |
| Billing / subscriptions / trial / plan gating | `services/subscriptionService.ts`, `billingManagementService.ts`, `billing/capabilities.ts`, `routes/billingRoutes.ts`, `middleware/requireCapability.ts`, `components/ModuleGate.tsx` |
| Install / reconnect / uninstall | `authRoutes.ts`, `shopifyWebhookRoutes.ts` (`handleAppUninstalled`), `AppStateProvider.tsx` |
| Webhooks | `shopify.app.toml` webhook subscriptions; `routes/shopifyWebhookRoutes.ts` |
| Tenant isolation | every query scoped by `storeId`; `resolveAuthenticatedShop`; `verifyShopifySessionToken` shop match |
| DB fields used by approved workflows | all existing columns (additive-only changes permitted; no destructive migrations) |

---

## 9 & 10. Architecture & DB conclusions (feed the implementation plan)

- **Safest additive architecture:** one new **read-only aggregation service** (`explainabilityService`) that composes existing service outputs into new Phase-1 shapes (`ExplainableInsight`, `OpportunityScoreBreakdown`, `ExecutiveSummary`, `RevenueLeakModel`), exposed via a **single additive read-only endpoint** `GET /api/insights/dashboard`, consumed by **new UI components** that reuse `ModuleGate`/`PageState`, and also surfaced on the existing Fraud/Competitor/Pricing-Profit pages via `ExplainableInsightCard`. No writes anywhere in the request path.
- **DB changes (final):** **The first Phase 1 release makes no database change — no `InsightReviewStatus`, no new table, no Prisma schema change, and no migration.** Phase 1 is read/derive-only. Merchant recommendation-status persistence is **not** part of the first release; it is a separate, later, optional enhancement and is out of scope here.

### Return-abuse field semantics (code-audited, item 2)

For any monetary return-abuse logic, the exact stored meanings are:

| Field | Type / meaning | Source of truth |
|---|---|---|
| `Customer.totalRefunds` | **COUNT of refunded orders** (not an amount) | `shopifyAdminService.ts:919` — `customer.orders.filter(o => o.refunded).length` |
| `Customer.refundRate` | ratio `totalRefunds / totalOrders` (0–1) | `shopifyAdminService.ts:920` |
| `Order.refunded` / `refundRequested` | booleans | `Order` model |
| `Order.totalAmount` | order total (float). **No refund-amount / partial-refund field exists** | `Order` model |
| Eligible/completed order | `Order.status ∈ {"paid","approved"}` (allowlist; synthetic `"baseline"` excluded) | `shopifyAdminService.ts:923` |
| Customer ↔ Order | `Order.customerId → Customer`; `Customer.orders` | schema |

Consequence: a monetary refund figure can only be built from the **full `totalAmount` of refunded orders** (an upper bound, since no partial-refund amount is stored), which forces the conservative excess-over-baseline formula and hard cap in implementation-plan §7.3, or `impact_not_quantifiable` while still showing the behavioural finding.

---

## Summary for reviewers

The heavy lifting for explainability **already exists** in per-module services and in `decisionCenterService`. Phase 1 is an **additive, read-only aggregation + presentation** layer over existing, deterministic data — achievable without touching any protected system, **without new scopes, and with no database change in the first release.**

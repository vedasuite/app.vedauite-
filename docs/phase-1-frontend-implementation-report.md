# Phase 1 Frontend Implementation Report — Interactive Intelligence UI

Repository: `app-repo`
Branch: `phase-1-intelligence-ui` (created off `main` at commit `55ec8c2` — Phase 1 backend)
Commit: `0f71d24` — "feat: add phase 1 interactive intelligence UI"
Status: Complete, committed locally on `phase-1-intelligence-ui`, **not merged to `main`, not pushed, not deployed**.

## 0. Phase 1 final verification pass (post-`0f71d24`)

A follow-up correctness/QA verification was performed against commit
`0f71d24` before manual QA. It found and fixed one genuine correctness bug
in the return-abuse calculation under large order volumes; all other areas
checked out with no code changes required. Fixed and committed separately
as `fix: phase 1 verification corrections`.

### 0.1 Return-abuse correctness under large datasets — bug found and fixed

**The bug.** `explainabilityService.ts` loads orders for the 90-day
return-abuse window with a bounded query:
`order.findMany({ where: { storeId, createdAt: { gte: lookbackStart } }, orderBy: { createdAt: "desc" }, take: 5000 })`.
Per-customer grouping (`ordersByCustomer`) was built entirely from this
bounded, in-memory row set. For a store with **more than 5,000 orders in
the trailing 90 days** (~56/day), the query silently drops the oldest
orders in that window. Any customer whose orders straddle that truncation
boundary would get an incomplete order list — their computed refund rate,
excess-rate, and monetary exposure could be silently wrong, and a customer
whose orders fell entirely outside the retained 5,000 would be missing
from return-abuse analysis entirely, with no indication anything was
truncated.

**Direct answers:**

| Question | Answer |
|---|---|
| Does every eligible order always participate? | No — only if total orders in the 90-day window are ≤ 5,000. Above that, only the most recent 5,000 (by `createdAt`) are read. |
| Can a merchant with >5,000 eligible orders receive incomplete customer grouping? | Yes — this was the bug. Customers whose orders fall in the truncated (older) portion of the window are dropped or partially represented. |
| Do the `count()` queries alone guarantee correctness? | No. `storeEligibleOrderCount` / `storeRefundedEligibleCount` are exact DB-side aggregates and were already correct, but they say nothing about *per-customer* grouping, which is still built from the bounded, in-memory `recentOrders` rows. |
| Is pagination required? | Not chosen here — full pagination would still do unbounded work in the worst case (a store that never stops growing past 90 days of volume) and was explicitly out of scope ("do not introduce unbounded queries"). |
| Is aggregation required? | For a fully general fix at arbitrary scale, DB-side `groupBy` per customer would be the more scalable long-term answer (see "recommended improvement" below). For the immediate correctness gap, detection + graceful degradation was the smallest safe fix. |
| Should the result become `impact_not_quantifiable` if truncation occurs? | Yes for the affected module. Implemented as: suppress return-abuse insights entirely for the request (not per-customer patching, since which customers are affected can't be determined from the truncated set), and surface the condition in `dataCoverage`. |

**The fix (`backend/src/services/explainabilityService.ts`).** Added one
additional bounded, DB-side `count()` query —
`order.count({ where: { storeId, createdAt: { gte: lookbackStart } } })`
(no `take`, O(1) round trip) — to get the *exact* total order count in the
90-day window, independent of the 5,000-row cap. If that exact total
exceeds `READ_CAPS.orders` (5,000), the per-customer return-abuse loop is
skipped entirely for that request (no insights of module `return_abuse`
are emitted from a data set known to be incomplete), and the `fraud`
`dataCoverage` entry's `note` is set to
`"Order volume exceeds the analysis bound for this period; return-abuse exposure not quantified."`
No other module, no schema, and no query bound was changed — this only
gates the return-abuse code path, and only when truncation is detected.
No unbounded query was introduced.

**Regression tests added** (`backend/tests/insightsDashboardContract.test.cjs`):
1. `return-abuse: order window within the bounded read produces a normal insight` — confirms the existing (pre-fix) behavior is unchanged when the store is under the cap.
2. `return-abuse: truncated order window suppresses return-abuse insights instead of computing them from partial data` — simulates a store with 5,001 orders in the window; asserts no `return_abuse` insight is emitted, the `fraud` coverage note explains why, and unrelated modules (e.g. `competitor`) are unaffected.

Phase 1 backend test count is now **35/35 passing** (26 calc + 9 contract,
up from 33/33 — the 2 new regression tests).

### 0.2 Frontend ↔ backend contract validation — no discrepancy found

Compared `frontend/src/lib/insightsTypes.ts` field-by-field against
`backend/src/services/explainabilityCalc.ts` (the source of truth for the
`GET /api/insights/dashboard` response shape): `Confidence`, `Urgency`,
`InsightModule`, `ImpactPeriod`, `EaseOfAction`, `AggregateEvidence`,
the `FinancialImpact` discriminated union (`quantified` /
`impact_not_quantifiable`), `OpportunityScoreBreakdown` (including the
5-component weight breakdown), `Methodology`, `ExplainableInsight`
(including optional `isCriticalNonMonetary`), `LeakItem`, `LeakGroup`,
`RevenueLeakModel`, `ExecutiveSummary`, `DataCoverage` (`module:
InsightModule | "all"`), and `DashboardInsightsResponse` all match exactly
— same field names, same optionality, same enum value sets. The only
difference is that the backend's `OpportunityScoreBreakdown.weights` uses
TypeScript numeric-literal types (`0.35`, `0.25`, …) while the frontend
types them as plain `number` — a safe widening, not a contract mismatch,
since the serialized JSON values are identical either way. No fix
required.

### 0.3 Safe deep-link validation — no vulnerability found

Every `insight.route` value in `explainabilityService.ts` is a hardcoded
string literal — `"/app/ai-pricing-engine"`, `"/app/competitor-intelligence"`,
or `"/app/fraud-intelligence"` (×2, for return-abuse and high-risk-open) —
never interpolated from order, customer, competitor, or any other
merchant/DB-controlled data. Confirmed via a repo-wide search for `route:`
assignments; explainability is the only producer of `ExplainableInsight`
objects and all four call sites are literals. On the frontend,
`navigateEmbedded` (`useEmbeddedNavigation.ts`) passes the path through
React Router's `navigate()`, which performs in-SPA client-side routing
only — it does not set `window.location.href`, so even a hypothetical
attacker-controlled string could not force full-page navigation to an
external origin. No code change made. **Recommended improvement (not a
blocker):** add a small allowlist check (e.g. a `Set` of the known
`/app/...` routes) at the point `ExplainableInsightCard` calls
`navigateEmbedded(insight.route)`, as defense-in-depth against a future
contributor accidentally making `route` data-derived. `route` is typed as
plain `string` today, not a literal union, so nothing currently enforces
this at the type level.

### 0.4 Query performance review — no remaining concern

Reviewed `explainabilityService.ts` end to end:
- **No N+1 queries.** All reads happen once, up front, in a single
  `Promise.all` of 11 independent, flat queries (5 bounded `findMany` +
  6 `count`, including the new count added in 0.1). Nothing loops and
  issues a query per row/customer/product.
- **Bounded reads.** Every `findMany` has `take` (5,000 orders / 1,000
  open-high-risk / 500 each for price history, profit data, competitor
  data) plus a targeted `where`.
- **Minimal selected columns.** Every query uses an explicit `select`
  listing only the fields actually consumed downstream (confirmed no
  `include` of full relations anywhere in the file).
- **Appropriate `orderBy`.** All bounded reads order by recency
  (`createdAt`/`collectedAt` desc) so the `take` cap keeps the most
  relevant rows.
- **Appropriate `where` filters.** Order queries are scoped to
  `storeId` + the 90-day window (or targeted `fraudRiskLevel`/`status`
  for the open-high-risk read) — no full-table scans.
- **No unnecessary relations.** No Prisma relation traversal (`include`)
  is used; all cross-entity joins (e.g. profit data by product handle)
  are done in memory via `Map`, which is O(n) over already-bounded data.
- **In-memory work is bounded and linear.** Per-customer grouping,
  dedup, and scoring all iterate the capped result sets once; no
  quadratic passes were found.

No remaining performance concern identified for this phase.

## 1. Backend hardening (performed before frontend work)

### 1.1 Bounded database queries in `explainabilityService.ts`

The original implementation loaded a store's orders, price history, profit
data, and competitor data via a single `prisma.store.findUnique` with nested
`select` on relations and no `take`/`orderBy` — effectively unbounded reads
that grow with store size. It also selected an unused `customers` relation.

Replaced with a `Promise.all` of parallel, bounded queries, each with
`where` / `orderBy` / `take` / `select`:

- `order.findMany` (recent orders, `take: 5000`, `orderBy: createdAt desc`)
- `order.findMany` (open high-risk orders, `take: 1000`)
- `priceHistory.findMany`, `profitOptimizationData.findMany`,
  `competitorData.findMany` (each `take: 500`, ordered by recency)
- Paired `count()` queries (`order.count`, `competitorData.count`,
  `priceHistory.count`, `profitOptimizationData.count`, plus eligible/refunded
  counts for the return-abuse baseline) so coverage totals and the
  return-abuse baseline stay numerically exact regardless of the read caps.

The unused `customers` relation was removed. No schema change, no migration,
no behavioural change to the calculation layer — only the data-loading layer
was touched.

**Verification:**
- `npx tsc --noEmit` (backend): 0 errors
- `npm run build` (backend): success
- `node --test tests/explainabilityCalc.test.cjs`: 26/26 pass (unchanged —
  confirms no regression, since only data loading changed, not the pure
  calculation functions)

### 1.2 Contract test for `GET /api/insights/dashboard`

New file: `backend/tests/insightsDashboardContract.test.cjs`.

Does **not** use the existing shared integration HTTP helper (which fails
with `ERR_HTTP_INVALID_HEADER_VALUE` due to an undefined `Cookie` header —
a known pre-existing issue). Instead it:

- Mocks `dist/db/prismaClient.js`, `dist/services/subscriptionService.js`,
  and `dist/services/observabilityService.js` via `require.cache` injection,
  driven by a resettable in-memory `state` object.
- Mounts the real, compiled `insightsRouter` in a minimal Express app with a
  fake auth middleware that sets `req.shopifySession`.
- Uses a purpose-built `http.request` helper with only a `Content-Type`
  header (no undefined `Cookie` header).

7 scenarios, all passing:

| Test | Result |
|---|---|
| Successful response has full contract shape, one `generatedAt` | ✅ |
| Fully entitled merchant sees all modules | ✅ |
| Lower plan (fraud only) — no competitor/pricing data anywhere, including revenue leak | ✅ |
| Empty store — 200, `dataReady: false`, empty lists | ✅ |
| Missing authenticated store — no shop → 400; store not found → 200 empty | ✅ |
| Controlled service error → 503 `INSIGHTS_UNAVAILABLE` | ✅ |
| No forbidden PII in serialized JSON (email, IP, fingerprints, tokens) | ✅ |

## 2. Frontend architecture

### New files

| File | Purpose |
|---|---|
| `frontend/src/lib/insightsTypes.ts` | TypeScript types mirroring the backend `DashboardInsightsResponse` contract, plus presentation helpers (`formatMoney`, `impactRangeText`, `confidenceTone`, `urgencyTone`, `PERIOD_LABEL`, `MODULE_LABEL`) |
| `frontend/src/hooks/useInsightsDashboard.ts` | Fetches `/api/insights/dashboard` via the existing `embeddedShopRequest` wrapper; classifies errors into `authRequired` / `unavailable` / generic `error`; exposes `loading`, `refreshing`, `reload` |
| `frontend/src/modules/Dashboard/components/ExplainableInsightCard.tsx` | Reusable collapsed/expanded insight card with weighted Opportunity Score breakdown |
| `frontend/src/modules/Dashboard/components/ExecutiveSummaryCard.tsx` | AI executive summary card |
| `frontend/src/modules/Dashboard/components/WhereToFocusToday.tsx` | Renders opportunity cards, empty state |
| `frontend/src/modules/Dashboard/components/CriticalAttentionLane.tsx` | Renders critical items, warns when non-monetary, never fabricates values |
| `frontend/src/modules/Dashboard/components/RevenueLeakDetector.tsx` | Two independent columns (Potential Upside / Revenue At Risk), never totals across periods |
| `frontend/src/modules/Dashboard/components/InsightsDashboardSections.tsx` | Dashboard-level container wiring the hook to all required states and the required section order |
| `frontend/src/modules/Dashboard/components/ModuleInsights.tsx` | Reusable panel for embedding filtered insights into existing module pages |

### Modified files (additive only)

| File | Change |
|---|---|
| `frontend/src/modules/Dashboard/DashboardPage.tsx` | +1 import, +1 `<InsightsDashboardSections />` inserted before the existing metric-cards section. No existing JSX removed or altered. |
| `frontend/src/modules/FraudIntelligence/FraudPage.tsx` | +1 import, +1 `<Layout.Section><ModuleInsights modules={["fraud","trust","return_abuse"]} /></Layout.Section>` as the first section. |
| `frontend/src/modules/CompetitorIntelligence/CompetitorPage.tsx` | +1 import, +1 `<Layout.Section><ModuleInsights modules={["competitor"]} /></Layout.Section>` as the first section. |
| `frontend/src/modules/PricingProfit/PricingProfitPage.tsx` | +1 import, +1 `<Layout.Section><ModuleInsights modules={["pricing","profit"]} /></Layout.Section>` as the first section. |

Diff stat: `5 files changed, 89 insertions(+), 49 deletions(-)` — the 49
deletions/insertions are entirely within `explainabilityService.ts` (the
query-hardening rewrite); the four page files each have a strictly additive
4–7 line diff. `ModuleGate`, routing, billing, authentication, and
navigation files are untouched (confirmed via `git status`/`git diff --stat`).

## 3. Dashboard layout (required order, implemented as-is)

1. AI Executive Summary (`ExecutiveSummaryCard`)
2. Where to Focus Today (`WhereToFocusToday`)
3. Critical Attention (`CriticalAttentionLane`, only rendered when non-empty)
4. Revenue Leak Detector (`RevenueLeakDetector`)
5. Existing metric cards (unchanged, unmoved)
6. Existing recent insights / activity (unchanged, unmoved)
7. Data coverage & sync status — new `DataCoverageCard` (module coverage) is
   rendered directly after the Phase 1 sections; the existing sync-status UI
   further down the page is unchanged.

If `executiveSummary.dataReady` is `false`, sections 2–4 are replaced with a
single informational banner rather than being rendered empty or with
placeholder data.

## 4. Explainable Insight Card

- **Collapsed**: title, module badge, priority badge, monetary range (via
  `impactRangeText`) or literal `"Impact not quantified"`, confidence badge,
  recommended action text.
- **Expanded** (Polaris `Collapsible`, keyboard-toggled): Opportunity Score
  total (or an explicit exclusion message when
  `score.excludedFromMonetaryRanking` is true — never a fabricated score),
  the 5-component weighted breakdown (Impact 35%, Urgency 25%, Confidence
  20%, Ease 10%, Recency 10%), detected reasons, aggregate evidence,
  methodology summary, calculation basis (or the impact-not-quantified
  reason), assumptions, and a primary "Open in {Module}" button that calls
  the existing `useEmbeddedNavigation().navigateEmbedded(insight.route)`.
- Critical Attention items render through the same component; when
  `financialImpact.status === "impact_not_quantifiable"`, the UI shows the
  literal not-quantified text and never substitutes a number.

## 5. Revenue Leak Detector

- `Potential upside` and `Revenue at risk` render as two independent
  `BlockStack` columns inside a wrapping `InlineStack`; there is no code
  path that sums values across the two, or across different `LeakGroup`
  periods — each group (already period-homogeneous from the backend) is
  rendered and totaled entirely on its own.
- Each group card shows: min–max range (`formatMoney`), currency, period
  label, confidence badge, and an explicit "Estimated range · {period} ·
  {currency}" caption. A collapsible per-item breakdown is available for
  each group.

## 6. Module page integration

`ModuleInsights` is a thin, reusable wrapper around the same
`useInsightsDashboard()` hook, filtered to a module set and de-duplicated by
id (an item can appear in both `opportunities` and `criticalAttention`).
It renders nothing when `authRequired` (deferring to the page's own auth
handling) and nothing on error, so it can never interfere with existing
page behavior. Inserted as the first `<Layout.Section>` on each page,
above all existing content — no existing section was reordered, removed,
or restyled.

## 7. Loading / empty / error states

All states are handled in `InsightsDashboardSections` / `ModuleInsights`,
using only data returned by the hook (no demo/fake data in any branch):

| State | Handling |
|---|---|
| Loading (first load) | Centered `Spinner` in a `Card` |
| Refreshing | Small inline `Spinner` above existing content |
| No opportunities | Empty-state text inside `WhereToFocusToday` |
| Insufficient data / not synced | `executiveSummary.dataReady === false` → informational banner instead of empty sections |
| Endpoint unavailable | Warning `Banner` with a "Try again" button (`reload()`) |
| Authentication required | Critical `Banner` directing the merchant to reopen the app from Shopify Admin |
| Lower plan | Backend `filterInsightsByCapability` already excludes ungated modules; UI simply renders whatever comes back — no client-side plan logic duplicated |

## 8. Accessibility & Polaris compliance

- Polaris components exclusively — no third-party UI library added.
- Toggle buttons use `ariaExpanded`, `ariaControls` (paired via `useId()`),
  and explicit `accessibilityLabel`s that name the insight/group being
  expanded — screen readers announce state and target.
- All expand/collapse controls are real `<Button>` elements (native
  keyboard focus + Enter/Space activation), not click-only `div`s.
- `Collapsible` transitions use Polaris's built-in component, which honors
  `prefers-reduced-motion` at the design-system level; no custom CSS
  animation was added that would bypass it.
- Section headings use semantic `Text as="h2"/"h3"/"h4"` for a consistent
  heading hierarchy inside the existing page structure.
- Badges/text never rely on color alone — every badge is paired with a text
  label (e.g. `"Priority: high"`, `"Confidence: medium"`).

## 9. Responsive verification

- `RevenueLeakDetector`'s two-column layout uses `InlineStack` with `wrap`
  and `Box minWidth="280px" width="48%"` — columns sit side-by-side on
  desktop/tablet and wrap to a single stacked column on narrow viewports
  instead of overflowing.
- All other sections use Polaris `BlockStack`/`InlineStack` with `wrap`,
  which reflow naturally in Polaris's responsive grid; no fixed pixel
  widths outside the leak-detector columns.
- No element sets an explicit width wider than its container; no
  horizontal-scroll container was introduced.

Note: this verification was done by code/layout review (Polaris's
responsive primitives with `wrap` and `minWidth` are the same pattern used
elsewhere in this codebase's existing pages). No live browser
mobile/tablet/desktop pass or screen-reader pass was performed in this
session — see Known Limitations.

## 10. Build gate results

Two passes are recorded: the original implementation pass (commit
`0f71d24`) and the final verification pass after the return-abuse fix
(commit `fix: phase 1 verification corrections`).

| Gate | Implementation pass (`0f71d24`) | Verification pass (post-fix) |
|---|---|---|
| Backend contract tests | 7/7 pass | 9/9 pass (+2 return-abuse regression tests) |
| Phase 1 backend tests (calc + contract) | 33/33 pass | **35/35 pass** |
| Backend TypeScript (`tsc --noEmit`) | 0 errors | 0 errors |
| Backend production build | success | success |
| Full backend suite (`tests/*.test.cjs`) | 100 pass, 6 fail | 102 pass, 6 fail (108 total) |
| Frontend TypeScript (`tsc --noEmit`) | 32 errors — baseline, 0 in Phase 1 files | 32 errors — unchanged |
| Frontend production build (`vite build`) | success (1139 modules) | success (1139 modules) |

The 6 backend test failures are the pre-existing baseline failures
(`deriveConnectionState treats webhook gaps as attention...`,
`launch endpoints expose factual production checks...`,
`app uninstall webhook marks installation as inactive...`,
`oauth reconnect start issues Shopify authorize redirect...`,
`oauth callback persists offline installation...`,
`oauth callback preserves first install timestamp...`) — same test names,
same root cause (the shared Cookie-header integration helper), confirmed
unchanged from the baseline recorded before Phase 1 work began, and
unchanged again after the verification-pass fix.

## 11. Known limitations

**Production blockers:** none identified.

**Recommended improvements** (worth doing before/soon after wider rollout,
not blocking QA):
- Add a small frontend allowlist check on `insight.route` before calling
  `navigateEmbedded()`, as defense-in-depth (Section 0.3). No live
  vulnerability exists today (all routes are backend literals), but the
  type is plain `string`, so nothing currently stops a future change from
  making it data-derived.
- No live browser-based accessibility/responsive pass (screen reader,
  actual mobile/tablet/desktop rendering) was performed in this session —
  verification above is by code/layout review against Polaris's documented
  responsive and accessibility behavior. Recommend a manual pass in Shopify
  Admin (embedded) before merchant-facing rollout.
- No screenshots are included; this session had no attached browser/preview
  tool pointed at an authenticated embedded session. File paths for the new
  UI are listed in Section 2 for manual review instead.

**Future enhancements** (not needed now, only relevant at larger scale):
- Return-abuse currently degrades to "not quantified" once a store's
  90-day order volume exceeds 5,000 orders (Section 0.1), rather than
  computing an exact answer at that scale. A DB-side `groupBy` per
  customer (counts + sums, no raw row load) would let return-abuse stay
  exact at any store size without lifting the bound — worth doing if/when
  a merchant is observed to actually hit this threshold.

**Accepted, out of scope:**
- The 6 pre-existing backend integration-test failures remain (Cookie-header
  issue), as explicitly permitted by the task instructions, unchanged
  before and after this verification pass.

## 13. Final verification summary

**Result: PASS WITH FIXES**

One genuine correctness bug was found and fixed: return-abuse exposure
could silently miscompute for merchants with more than 5,000 orders in
the trailing 90 days, because per-customer grouping was built from a
bounded, truncated row set while only the store-wide baseline counts were
exact. Fixed by detecting the truncation via one additional bounded
`count()` query and suppressing return-abuse insights for that request
instead of emitting numbers that could be wrong, with the condition
surfaced in `dataCoverage`. No unbounded query was introduced. Two
regression tests cover both the truncated and non-truncated cases.

All other verification areas (frontend/backend contract, deep-link
safety, query performance) were reviewed and found correct with no code
changes required. All build gates pass, including the newly expanded
Phase 1 test suite (35/35) and an unchanged frontend TypeScript baseline
(32/32, none from Phase 1 files) and unchanged pre-existing backend
integration-test baseline (6 failures, same tests, same root cause).

## 12. Rollback instructions

All Phase 1 frontend work is isolated to the files listed in Section 2 and
was committed in a single local commit (`0f71d24` — "feat: add phase 1
interactive intelligence UI") on branch `phase-1-intelligence-ui`, on top
of the Phase 1 backend commit (`55ec8c2`). The branch has not been merged
into `main`. To roll back:

```bash
git revert 0f71d24
```

or, since this branch is local-only and unmerged, simply delete it
(`git branch -D phase-1-intelligence-ui`) or reset it to `55ec8c2` to drop
the commit entirely. No database schema,
migration, environment variable, or backend route contract changes are
part of this commit, so rollback carries no data-migration risk.

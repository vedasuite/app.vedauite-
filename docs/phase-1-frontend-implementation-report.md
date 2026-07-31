# Phase 1 Frontend Implementation Report — Interactive Intelligence UI

Repository: `app-repo` (branch `main`, based on commit `55ec8c2` — Phase 1 backend)
Status: Complete, committed locally, **not pushed, not deployed**.

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

| Gate | Result |
|---|---|
| Backend contract tests (`insightsDashboardContract.test.cjs`) | 7/7 pass |
| Phase 1 backend tests (calc + contract) | 33/33 pass |
| Backend TypeScript (`tsc --noEmit`) | 0 errors |
| Backend production build | success |
| Full backend suite (`tests/*.test.cjs`) | 100 pass, 6 fail |
| Frontend TypeScript (`tsc --noEmit`) | 32 errors — identical to recorded baseline; 0 in any Phase 1 file |
| Frontend production build (`vite build`) | success (1139 modules, no errors) |

The 6 backend test failures are the pre-existing baseline failures
(`deriveConnectionState treats webhook gaps as attention...`,
`launch endpoints expose factual production checks...`,
`app uninstall webhook marks installation as inactive...`,
`oauth reconnect start issues Shopify authorize redirect...`,
`oauth callback persists offline installation...`,
`oauth callback preserves first install timestamp...`) — same test names,
same root cause (the shared Cookie-header integration helper), confirmed
unchanged from the baseline recorded before Phase 1 work began.

## 11. Known limitations

- No live browser-based accessibility/responsive pass (screen reader,
  actual mobile/tablet/desktop rendering) was performed in this session —
  verification above is by code/layout review against Polaris's documented
  responsive and accessibility behavior. Recommend a manual pass in Shopify
  Admin (embedded) before merchant-facing rollout.
- No screenshots are included; this session had no attached browser/preview
  tool pointed at an authenticated embedded session. File paths for the new
  UI are listed in Section 2 for manual review instead.
- The 6 pre-existing backend integration-test failures remain (Cookie-header
  issue), as explicitly permitted by the task instructions.

## 12. Rollback instructions

All Phase 1 frontend work is isolated to the files listed in Section 2 and
was committed in a single local commit
(`feat: add phase 1 interactive intelligence UI`) on top of the Phase 1
backend commit (`55ec8c2`). To roll back:

```bash
git revert <phase-1-frontend-commit-sha>
```

or, if not yet pushed/shared, `git reset --hard 55ec8c2` to drop it
entirely (only if no other work has landed on top). No database schema,
migration, environment variable, or backend route contract changes are
part of this commit, so rollback carries no data-migration risk.

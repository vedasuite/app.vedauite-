# Phase 1 Risk Register — Explainability & Prioritization

Date: 2026-07-30
Companion to: `docs/approved-baseline-audit.md`, `docs/phase-1-implementation-plan.md`
Scope: risks introduced by the additive Phase-1 layer on an **already-approved, publicly listed** Shopify app.

Severity = impact if unmitigated. Likelihood = with mitigation applied.

| # | Risk | Area | Severity | Likelihood | Mitigation | Verification |
|---|---|---|---|---|---|---|
| R1 | A change accidentally touches a protected system (auth, billing, webhooks, scopes) and breaks approved behaviour or re-triggers review | Compliance / stability | **Critical** | Low | Hard "must-not-change" file list in the plan; Phase 1 is additive-only; new aggregator reads existing services, writes nothing to protected tables | Diff review vs must-not-change list before commit; regression smoke on auth/billing/install |
| R2 | A schema change is destructive under `prisma db push` and harms production data | Data | **Critical** | Low | Default plan needs **no** schema change; any optional table is additive-only | `prisma migrate diff` must show only `CREATE TABLE`/`ADD COLUMN`; block deploy otherwise |
| R3 | Fabricated/invented numbers presented as fact (e.g. margin without COGS, low-confidence competitor gap) mislead merchants and breach listing honesty | Compliance / trust | High | Low | First-class `insufficient_data` state; impact labeled `isEstimate`; low-confidence excluded from headline ranking | QA matrix: no-COGS store, low-confidence matches, thin history all show insufficient-data |
| R4 | UI implies a prohibited automated action (auto-block/cancel/refund/reprice) or a guarantee | Compliance | High | Low | Recommendations advisory only; buttons deep-link to merchant review, never execute; no guarantee copy | Copy review of every action label + summary text |
| R5 | New endpoint leaks cross-tenant data | Security | High | Low | Reuse `verifyShopifySessionToken` + `resolveAuthenticatedShop`; every query scoped by `storeId`; no new middleware | Test with two shops; confirm shop-scoped results only |
| R6 | New code adds to the 32 pre-existing frontend `tsc` errors or breaks the Vite build | Build / deploy | Medium | Low | New files held to zero-tsc-error bar; build gate in test plan | `tsc --noEmit` diff (no new errors) + `vite build` green before commit |
| R7 | Opportunity Score / revenue-leak math is wrong or unstable across stores | Correctness | Medium | Medium | Pure deterministic functions with unit tests; conservative caps; documented assumptions | Unit tests + manual spot-checks against known store data |
| R8 | Executive Summary as a live LLM call adds latency, non-determinism, or data-egress concerns | Performance / compliance | Medium | Low (design choice) | Summary is deterministic/templated in the request path — no live model call | Design constraint enforced in `explainabilityService` |
| R9 | Deploying to a live published app during iteration disrupts merchants | Stability | High | Low | This pass deploys **nothing** (docs only); feature deploys later are additive + reversible; approved baseline snapshotted (branch/tag/zip) | Explicit "no deploy" in this task; rollback path documented |
| R10 | Absence of a test/lint harness lets regressions through | Quality | Medium | Medium | Introduce additive Node `--test` for new pure functions; manual regression matrix; do not alter existing scripts | New tests run locally before commit |
| R11 | New DB writes (optional recommendation-status) not covered by GDPR redaction | Compliance | Medium | Low | If added, `InsightReviewStatus` has `onDelete: Cascade` to `Store`, so `shop/redact` erases it automatically (consistent with the cascade baseline) | Confirm cascade FK in schema; verify redaction removes rows |
| R12 | Mobile/accessibility regressions in new UI | UX | Low | Low | Polaris-only components (responsive + a11y by default); text-not-colour for status; keyboard/labels | Mobile-width check + a11y review during implementation |

## Standing constraints (apply to every Phase-1 change)

- No new Shopify scopes; no API-version, app-URL, redirect, or webhook change.
- No automatic order blocking, cancellation, refunds, or repricing; no chargeback guarantee; no formal credit-scoring claim; no fake sample results in production.
- No destructive migration; no change to existing DB fields used by approved workflows.
- Do not deploy from the audit/planning pass. Feature work proceeds only after this plan is accepted.

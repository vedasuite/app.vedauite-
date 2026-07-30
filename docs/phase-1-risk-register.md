# Phase 1 Risk Register — Explainability & Prioritization

Date: 2026-07-30 · Amended: 2026-07-30 (see `docs/phase-1-plan-amendment-summary.md`)
Companion to: `docs/approved-baseline-audit.md`, `docs/phase-1-implementation-plan.md`
Scope: risks introduced by the additive, read-only Phase-1 layer on an **already-approved, publicly listed** Shopify app.

Severity = impact if unmitigated. Likelihood = with mitigation applied.

| # | Risk | Area | Severity | Likelihood | Mitigation | Verification |
|---|---|---|---|---|---|---|
| R1 | A change accidentally touches a protected system (auth, billing, webhooks, scopes) and breaks approved behaviour or re-triggers review | Compliance / stability | **Critical** | Low | Hard must-not-change file list; Phase 1 additive-only; aggregator reads existing services, writes nothing | Diff vs must-not-change list before commit; regression smoke on auth/billing/install |
| R2 | A schema change is destructive under `prisma db push` | Data | **Critical** | Very Low | **AMENDMENT 6: no DB change in first release.** No `InsightReviewStatus`, no migration | Confirm zero schema diff before deploy |
| R3 | Combining upside and risk into one number implies a confirmed loss / guaranteed profit and misleads merchants | Compliance / trust | High | Low | **AMENDMENT 2: two separate groups, never summed.** No `totalExposure` field exists; copy frames both as estimated ranges | Review UI: no combined total anywhere; both groups labeled as ranges |
| R4 | A "high priority" is shown when impact or confidence is actually unavailable | Correctness / trust | High | Low | **AMENDMENT 1: missing impact/confidence excludes the item from ranking**, never scores it high; shown in "needs more data" group | Unit test: unquantifiable item is excluded, not top-ranked |
| R5 | Raw customer PII (email, address, IP, device/payment fingerprint, raw payloads) leaks through new evidence responses or logs | Privacy / compliance | **Critical** | Low | **AMENDMENT 4: strict aggregate-only evidence allowlist**; forbidden fields never in responses/logs; identity capped to what the approved module already shows | Grep responses/logs for PII in QA; allowlist unit test |
| R6 | Fabricated numbers where data can't support them (margin w/o COGS, low-confidence competitor gap, stale data) | Compliance / trust | High | Low | First-class `insufficient_data`; **AMENDMENT 3: competitor impact returns `impact_not_quantifiable`** unless all inputs present & fresh; impact shown as bounded range labeled estimate | QA matrix: no-COGS, low-confidence, stale competitor data all show insufficient/ not-quantifiable |
| R7 | Competitor impact overstated (no line-item revenue exists; only a velocity proxy) | Correctness | Medium | Low | Conservative caps: `gapCap=0.15`, `confidenceFactor<1`, `min=0` always; importance-weighted; not-quantifiable fallback | Unit tests on bounds; spot-check against known handles |
| R8 | New endpoint leaks cross-tenant data | Security | High | Low | Reuse `verifyShopifySessionToken` + `resolveAuthenticatedShop`; every query `storeId`-scoped | Two-shop test; shop-scoped results only |
| R9 | New code adds to the 32 pre-existing frontend `tsc` errors or breaks the build | Build / deploy | Medium | Low | **AMENDMENT 5: reproducible TS baseline + comparison gate** (no new signatures, count stays 32, no new Phase-1 file in output, backend 0, build green) | `diff` vs `docs/ts-baseline-frontend.txt` empty; `vite build` green |
| R10 | Aggregate endpoint duplicates work or shows inconsistent timestamps across sections | Performance / correctness | Medium | Low | **AMENDMENT 7: single `GET /api/insights/dashboard`** computes shared reads once, one `generatedAt` | Verify one timestamp; check no duplicate service calls |
| R11 | Opportunity Score math wrong/unstable across stores | Correctness | Medium | Medium | Deterministic normalized factors (35/25/20/10/10) with per-store cap fallback; unit tests | Unit tests + spot-checks |
| R12 | Executive Summary as a live LLM call adds latency/non-determinism/egress | Performance / compliance | Medium | Low | Deterministic/templated summary in request path — no live model call | Design constraint enforced in service |
| R13 | Deploying to a live published app during iteration disrupts merchants | Stability | High | Low | This pass deploys **nothing** (docs only); feature deploys later additive + reversible; baseline snapshotted | "No deploy" this task; rollback documented |
| R14 | Prohibited automated action implied by UI (auto block/cancel/refund/reprice) or a guarantee | Compliance | High | Low | Advisory only; buttons deep-link to review, never execute; no guarantee copy | Copy review of every action label + summary |
| R15 | Mobile / accessibility / motion regressions in new UI | UX / a11y | Low | Low | Polaris-only (responsive + a11y); text-not-colour status; `prefers-reduced-motion`; keyboard | Mobile-width + a11y + reduced-motion review |

## Standing constraints (apply to every Phase-1 change)

- No new Shopify scopes; no API-version, app-URL, redirect, or webhook change.
- No automatic order blocking, cancellation, refunds, or repricing; no chargeback guarantee; no formal credit-scoring claim; no fake sample results in production.
- **No database migration and no new tables in the first release (Amendment 6).**
- **No raw customer PII in explainability responses or logs; aggregate evidence allowlist only (Amendment 4).**
- **Potential upside and revenue-at-risk are never summed or shown as a single confirmed figure (Amendment 2).**
- No change to existing DB fields used by approved workflows. Do not deploy from the audit/planning pass.

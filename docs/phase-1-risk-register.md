# Phase 1 Risk Register — Explainability & Prioritization

Date: 2026-07-30 · Amended: 2026-07-30 · Finalized: 2026-07-31
Companion to: `docs/approved-baseline-audit.md`, `docs/phase-1-implementation-plan.md`, `docs/phase-1-final-readiness-check.md`
Scope: risks from the additive, read-only Phase-1 layer on an **already-approved, publicly listed** Shopify app.

Severity = impact if unmitigated. Likelihood = with mitigation applied.

| # | Risk | Area | Severity | Likelihood | Mitigation | Verification |
|---|---|---|---|---|---|---|
| R1 | Change touches a protected system (auth, billing, webhooks, scopes) | Compliance / stability | **Critical** | Low | Hard must-not-change list; additive-only; aggregator reads, never writes | Diff vs list; regression smoke |
| R2 | Destructive schema change under `db push` | Data | **Critical** | Very Low | **No DB change in first release** (no table, no migration) | Zero schema diff confirmed |
| R3 | Combined upside+risk implies confirmed loss / guaranteed profit | Compliance / trust | High | Low | Two group families, **never summed**; no total field; ranges labeled estimate | UI review: no combined total |
| R4 | "High priority" shown when impact/confidence unavailable | Correctness / trust | High | Low | Excluded from **monetary** ranking; critical items handled by the Critical lane (R16) not by fake scores | Unit test: excluded, not top-ranked |
| R5 | Raw customer PII leaks via evidence responses/logs | Privacy / compliance | **Critical** | Low | Strict aggregate-only allowlist; forbidden fields never emitted; identity capped to approved module | PII grep in QA; allowlist unit test |
| R6 | Fabricated numbers where data can't support them | Compliance / trust | High | Low | First-class `insufficient_data`/`impact_not_quantifiable`; conservative bounded ranges labeled estimate | QA matrix; not-quantifiable paths |
| R7 | **Potential-upside double counting** (same product via PriceHistory + ProfitOptimizationData + margin) | Correctness | **High** | Low | **§7.5 canonical `dedupKey` + source-priority hierarchy**; one contribution per product/window; never sum | 5 dedup unit tests (§14.3) |
| R8 | **Return-abuse monetary estimate misdefined** (totalRefunds is a count, no refund-amount field) | Correctness / trust | High | Low | **§7.3 excess-over-baseline formula** with thresholds, eligibility allowlist, dedupe, hard cap; else not-quantifiable + behavioural finding | Return-abuse unit tests |
| R9 | **Incompatible periods summed** (open exposure added to monthly estimate) | Correctness / trust | High | Low | **§7.6 explicit `ImpactPeriod`**; period-homogeneous groups only; UI shows period beside every amount | Period unit tests; UI check |
| R10 | **Competitor importance double-discounts small SKUs** | Correctness | Medium | Low | **§7.4 importance removed from money**; used only for urgency/cap; velocity-proxy already encodes scale | Boundary tests; math review documented |
| R11 | **Critical non-monetary risk disappears** from "Where to focus" | Safety / trust | **High** | Low | **§7.1 separate Critical attention lane** (Approach A); high-confidence critical surfaces even when `impact_not_quantifiable`; no fabricated score | Critical-lane unit test |
| R12 | Cross-tenant data leak via new endpoint | Security | High | Low | Reuse `verifyShopifySessionToken`+`resolveAuthenticatedShop`; `storeId`-scoped | Two-shop test |
| R13 | New code grows the 32 pre-existing frontend `tsc` errors / breaks build | Build / deploy | Medium | Low | Reproducible baseline + comparison gate; new files tsc-clean | `diff` empty; build green |
| R14 | Aggregate endpoint duplicates work / inconsistent timestamps | Performance / correctness | Medium | Low | Single `GET /api/insights/dashboard`; shared reads once; one `generatedAt` | One-timestamp check |
| R15 | Module-page edits accidentally alter routes/gating/controls | Compliance / stability | High | Low | Additive `ExplainableInsightCard` display only; no route/`ModuleGate`/control change | Diff review of the 3 module files |
| R16 | Executive Summary via live LLM adds latency/non-determinism/egress | Performance / compliance | Medium | Low | Deterministic/templated summary; no live model call | Design constraint enforced |
| R17 | Prohibited automation implied by UI or a guarantee | Compliance | High | Low | Advisory only; deep-links, never execute; no guarantee copy | Copy review |
| R18 | Mobile / a11y / motion regressions | UX / a11y | Low | Low | Polaris-only; text-not-colour; reduced-motion; keyboard | Mobile + a11y + motion review |
| R19 | Deploy disrupts live merchants | Stability | High | Low | This pass deploys nothing; later deploys additive + reversible; baseline snapshotted | "No deploy"; rollback documented |

## Standing constraints

- No new Shopify scopes; no API-version, app-URL, redirect, or webhook change.
- No automatic order blocking, cancellation, refunds, repricing; no chargeback guarantee; no formal credit-scoring claim; no fake sample results.
- **No database migration and no new tables in the first release.**
- **No raw customer PII in explainability responses or logs — aggregate allowlist only.**
- **Never sum potential upside and revenue-at-risk, and never sum incompatible periods.**
- **Never fabricate a monetary score for a non-monetary finding — route it to the Critical attention lane instead.**
- No change to existing DB fields used by approved workflows. Do not deploy from the planning pass.

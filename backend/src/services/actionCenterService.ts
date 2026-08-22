// PART 4 — Unified Action Center.
//
// Normalizes the persisted IntelligenceFindings from Parts 1-3 into a single
// prioritized merchant workflow. Read-only with respect to store data; the only
// writes are lifecycle transitions the merchant explicitly requests, which go
// through the Part 1 service.
//
// SOURCE OF TRUTH
// ---------------
// Every fact, number, severity, confidence and completeness value shown here is
// read from the stored finding snapshot, which was produced by the deterministic
// detectors. This service ranks and groups; it never recomputes or invents a
// value. No LLM is involved in any of it.

import { prisma } from "../db/prismaClient";
import { logEvent } from "./observabilityService";
import { HttpError } from "../lib/httpError";
import {
  FINDING_STATUSES,
  isFindingStatus,
  parseFindingSnapshot,
  transitionFindingStatus,
  type FindingStatus,
} from "./intelligenceFindingService";
import {
  MODULE_CAPABILITY,
  type AggregateEvidence,
  type Confidence,
  type ExplainableInsight,
  type FinancialImpact,
  type InsightModule,
  type Urgency,
} from "./explainabilityCalc";

/** A finding whose lastSeenAt is older than this is flagged stale in the UI. */
export const STALE_AFTER_DAYS = 7;

/**
 * Explicit pilot cap on the feed size.
 *
 * Deliberately not paginated for V1: a store with more than 200 open findings
 * has a data-quality problem, not a browsing problem, and the summary counts
 * remain accurate regardless. The API reports `capReached` so the UI can say so
 * honestly instead of silently truncating.
 */
export const MAX_CARDS = 200;

/**
 * Transparent ranking weights. Every component is derived from a stored,
 * deterministic signal — nothing here is learned, inferred or model-driven, and
 * the per-card breakdown is returned so a merchant (or we) can reproduce it.
 */
export const RANK_WEIGHTS = {
  severity: 40,
  confidence: 20,
  freshness: 15,
  impact: 15,
  completeness: 10,
} as const;

const SEVERITY_SCORE: Record<Urgency, number> = {
  critical: 100,
  high: 75,
  medium: 45,
  low: 20,
};

const CONFIDENCE_SCORE: Record<Confidence, number> = {
  high: 100,
  medium: 60,
  low: 30,
  insufficient_data: 0,
};

export interface ActionCardImpact {
  status: FinancialImpact["status"];
  min?: number;
  max?: number;
  currency?: string;
  period?: string;
  basis?: string;
  reason?: string;
}

export interface ActionCard {
  id: string;
  findingType: string;
  module: InsightModule | string;
  /** Which paid capability gates it, or null when it is never gated. */
  capability: string | null;
  status: FindingStatus;
  severity: Urgency;
  confidence: Confidence;
  title: string;
  /** What happened. */
  whatHappened: string;
  /** Why it matters. */
  whyItMatters: string;
  /** What proves it. */
  evidence: AggregateEvidence[];
  /** Full calculation detail for the drill-down view. */
  methodology: ExplainableInsight["methodology"] | null;
  /** Is the data complete? */
  dataComplete: boolean;
  /**
   * True when the stored snapshot could not be read and only safe row-level
   * facts are shown. Never fabricates severity, evidence or impact.
   */
  degraded?: boolean;
  impact: ActionCardImpact;
  recommendedAction: string;
  /** Safe deep link to an existing VedaSuite page. */
  route: string;
  firstDetectedAt: string;
  lastSeenAt: string;
  detectionCount: number;
  isStale: boolean;
  rank: {
    score: number;
    weights: typeof RANK_WEIGHTS;
    components: {
      severity: number;
      confidence: number;
      freshness: number;
      impact: number;
      completeness: number;
    };
  };
}

/**
 * Impact totals, grouped so incompatible figures are never added together.
 *
 * Two rules, both load-bearing:
 *   1. Only `quantified` impacts contribute. An unquantifiable finding is
 *      counted separately, never as zero inside a total.
 *   2. Totals are grouped by (currency, period). Money in different currencies
 *      or measured over different periods is NOT summed — that would be the
 *      double-counting this structure exists to prevent. There is deliberately
 *      no single grand total field.
 */
export interface ImpactGroup {
  currency: string;
  period: string;
  min: number;
  max: number;
  findingCount: number;
}

export interface ActionCenterSummary {
  totalOpen: number;
  bySeverity: Record<Urgency, number>;
  byStatus: Record<FindingStatus, number>;
  /** Never summed across groups. */
  quantifiedImpact: ImpactGroup[];
  /** Findings whose impact could not be defended as a number. */
  notQuantifiedCount: number;
  staleCount: number;
  incompleteDataCount: number;
  /** Findings whose stored snapshot could not be read — surfaced, never hidden. */
  degradedCount: number;
  /** True when the feed hit MAX_CARDS and may therefore be truncated. */
  capReached: boolean;
  generatedAt: string;
}

function clamp(v: number, lo = 0, hi = 100) {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Freshness: a finding seen today scores 100, decaying linearly to 0 across the
 * staleness window. Deterministic and reproducible from lastSeenAt alone.
 */
function freshnessScore(lastSeenAt: Date, now: Date): number {
  const ageDays = (now.getTime() - lastSeenAt.getTime()) / 86_400_000;
  return clamp(100 * (1 - ageDays / STALE_AFTER_DAYS));
}

/**
 * Impact contributes on a log scale relative to the largest quantified impact
 * in the same (currency, period) group, so one very large finding cannot flatten
 * every other card to zero. Unquantifiable impact scores 0 — it does not
 * penalise severity, which is weighted separately.
 */
function impactScore(impact: FinancialImpact, groupMax: number): number {
  if (impact.status !== "quantified" || groupMax <= 0) return 0;
  const magnitude = Math.abs(impact.max);
  if (magnitude <= 0) return 0;
  return clamp(100 * (Math.log10(1 + magnitude) / Math.log10(1 + groupMax)));
}

function impactKey(impact: FinancialImpact): string | null {
  if (impact.status !== "quantified") return null;
  return `${impact.currency}::${impact.period}`;
}

function toCardImpact(impact: FinancialImpact): ActionCardImpact {
  if (impact.status === "quantified") {
    return {
      status: "quantified",
      min: impact.min,
      max: impact.max,
      currency: impact.currency,
      period: impact.period,
      basis: impact.basis,
    };
  }
  return { status: "impact_not_quantifiable", reason: impact.reason };
}

/**
 * Builds the prioritized feed for one store.
 *
 * Store-scoped by construction. Findings whose snapshot cannot be parsed are
 * skipped rather than rendered with invented content.
 */
export async function getActionCenter(input: {
  storeId: string;
  /** Capability modules the merchant's plan enables. */
  enabledModules: string[];
  status?: string;
  severity?: string;
  module?: string;
  /** Only findings seen since this ISO date. */
  since?: string;
  now?: Date;
}): Promise<{ cards: ActionCard[]; summary: ActionCenterSummary }> {
  const now = input.now ?? new Date();

  if (input.status !== undefined && !isFindingStatus(input.status)) {
    throw new HttpError(400, `Unknown status filter "${input.status}".`);
  }

  const rows = await prisma.intelligenceFinding.findMany({
    where: {
      storeId: input.storeId,
      ...(input.status ? { status: input.status } : {}),
      ...(input.module ? { module: input.module } : {}),
      ...(input.since ? { lastSeenAt: { gte: new Date(input.since) } } : {}),
    },
    orderBy: { lastSeenAt: "desc" },
    take: MAX_CARDS,
  });

  const enabled = new Set(input.enabledModules);
  const draft: Array<{ row: (typeof rows)[number]; snapshot: ExplainableInsight }> = [];
  const degradedRows: Array<(typeof rows)[number]> = [];

  // Defence in depth against duplicate cards. The unique index on
  // (storeId, fingerprint) and the primary key both make this impossible at the
  // database level, but the Action Center is an action INBOX — showing the same
  // item twice would be a visible correctness failure, so it is cheap to
  // guarantee here rather than rely on upstream invariants holding forever.
  const seenIds = new Set<string>();

  for (const row of rows) {
    if (seenIds.has(row.id)) continue;
    seenIds.add(row.id);
    const capability = MODULE_CAPABILITY[row.module as InsightModule] ?? null;
    // Entitlement: null capability (operational/store health) is always visible.
    if (capability !== null && !enabled.has(capability)) continue;

    const snapshot = parseFindingSnapshot(row.snapshotJson);

    if (!snapshot) {
      // A finding whose stored snapshot cannot be parsed has no evidence to
      // render. Silently dropping it would make a real finding disappear with
      // no trace, so instead it becomes a DEGRADED card: the safe row-level
      // facts only (module, type, timestamps), no fabricated content, no
      // impact, and an explicit data-quality warning. Raw snapshot bytes are
      // never surfaced or logged.
      degradedRows.push(row);
      continue;
    }

    if (input.severity && snapshot.urgency !== input.severity) continue;

    draft.push({ row, snapshot });
  }

  // Group maxima for the relative impact component.
  const groupMax = new Map<string, number>();
  for (const { snapshot } of draft) {
    const key = impactKey(snapshot.financialImpact);
    if (!key || snapshot.financialImpact.status !== "quantified") continue;
    const magnitude = Math.abs(snapshot.financialImpact.max);
    groupMax.set(key, Math.max(groupMax.get(key) ?? 0, magnitude));
  }

  const cards: ActionCard[] = draft.map(({ row, snapshot }) => {
    const key = impactKey(snapshot.financialImpact);
    const components = {
      severity: SEVERITY_SCORE[snapshot.urgency] ?? 0,
      confidence: CONFIDENCE_SCORE[snapshot.confidence] ?? 0,
      freshness: freshnessScore(row.lastSeenAt, now),
      impact: impactScore(snapshot.financialImpact, key ? groupMax.get(key) ?? 0 : 0),
      completeness: snapshot.dataQuality === "ok" ? 100 : 40,
    };

    const score =
      (components.severity * RANK_WEIGHTS.severity +
        components.confidence * RANK_WEIGHTS.confidence +
        components.freshness * RANK_WEIGHTS.freshness +
        components.impact * RANK_WEIGHTS.impact +
        components.completeness * RANK_WEIGHTS.completeness) /
      100;

    const ageDays = (now.getTime() - row.lastSeenAt.getTime()) / 86_400_000;

    return {
      id: row.id,
      findingType: row.findingType,
      module: row.module,
      capability: MODULE_CAPABILITY[row.module as InsightModule] ?? null,
      status: row.status as FindingStatus,
      severity: snapshot.urgency,
      confidence: snapshot.confidence,
      title: snapshot.title,
      whatHappened: snapshot.reasons[0] ?? snapshot.title,
      whyItMatters: snapshot.reasons[1] ?? snapshot.methodology?.summary ?? "",
      evidence: snapshot.evidence ?? [],
      methodology: snapshot.methodology ?? null,
      dataComplete: snapshot.dataQuality === "ok",
      degraded: false,
      impact: toCardImpact(snapshot.financialImpact),
      recommendedAction: snapshot.recommendedAction,
      route: snapshot.route,
      firstDetectedAt: row.firstDetectedAt.toISOString(),
      lastSeenAt: row.lastSeenAt.toISOString(),
      detectionCount: row.detectionCount,
      isStale: ageDays > STALE_AFTER_DAYS,
      rank: { score: Math.round(score * 100) / 100, weights: RANK_WEIGHTS, components },
    };
  });

  // Degraded cards for unreadable snapshots. Severity is deliberately "low":
  // we cannot know the real severity without the snapshot, and inventing one
  // would be exactly the fabrication this codebase refuses elsewhere.
  for (const row of degradedRows) {
    if (input.severity && input.severity !== "low") continue;
    cards.push({
      id: row.id,
      findingType: row.findingType,
      module: row.module,
      capability: MODULE_CAPABILITY[row.module as InsightModule] ?? null,
      status: row.status as FindingStatus,
      severity: "low",
      confidence: "insufficient_data",
      title: "A finding could not be displayed",
      whatHappened:
        "VedaSuite recorded this finding, but its stored details could not be read.",
      whyItMatters:
        "The underlying issue may still be real. Re-running Sync Data regenerates the details.",
      evidence: [],
      methodology: null,
      dataComplete: false,
      degraded: true,
      impact: {
        status: "impact_not_quantifiable",
        reason: "Stored finding details are unreadable, so no figure can be shown.",
      },
      recommendedAction:
        "Run Sync Data to regenerate this finding. No automatic action was taken.",
      route: "/app/dashboard",
      firstDetectedAt: row.firstDetectedAt.toISOString(),
      lastSeenAt: row.lastSeenAt.toISOString(),
      detectionCount: row.detectionCount,
      isStale: (now.getTime() - row.lastSeenAt.getTime()) / 86_400_000 > STALE_AFTER_DAYS,
      rank: {
        score: 0,
        weights: RANK_WEIGHTS,
        components: { severity: 0, confidence: 0, freshness: 0, impact: 0, completeness: 0 },
      },
    });
  }

  if (degradedRows.length > 0) {
    // Observable, with no snapshot contents and no PII — ids and types only.
    logEvent("warn", "action_center.unreadable_snapshots", {
      storeId: input.storeId,
      count: degradedRows.length,
      findingTypes: [...new Set(degradedRows.map((r) => r.findingType))],
      reason: "stored snapshot could not be parsed; surfaced as degraded cards",
    });
  }

  // Deterministic ordering. Ties break on severity, then lastSeenAt, then id,
  // so the same data always produces the same order.
  cards.sort((a, b) => {
    if (b.rank.score !== a.rank.score) return b.rank.score - a.rank.score;
    if (b.rank.components.severity !== a.rank.components.severity) {
      return b.rank.components.severity - a.rank.components.severity;
    }
    if (a.lastSeenAt !== b.lastSeenAt) return a.lastSeenAt < b.lastSeenAt ? 1 : -1;
    return a.id < b.id ? -1 : 1;
  });

  return { cards, summary: buildSummary(cards, now) };
}

export function buildSummary(cards: ActionCard[], now: Date): ActionCenterSummary {
  const bySeverity: Record<Urgency, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  const byStatus = Object.fromEntries(
    FINDING_STATUSES.map((s) => [s, 0])
  ) as Record<FindingStatus, number>;

  const groups = new Map<string, ImpactGroup>();
  let notQuantifiedCount = 0;
  let staleCount = 0;
  let incompleteDataCount = 0;
  let degradedCount = 0;

  for (const card of cards) {
    bySeverity[card.severity] = (bySeverity[card.severity] ?? 0) + 1;
    byStatus[card.status] = (byStatus[card.status] ?? 0) + 1;
    if (card.isStale) staleCount += 1;
    if (!card.dataComplete) incompleteDataCount += 1;
    if (card.degraded) degradedCount += 1;

    if (card.impact.status !== "quantified") {
      notQuantifiedCount += 1;
      continue;
    }

    // Grouped by currency AND period — never summed across either.
    const key = `${card.impact.currency}::${card.impact.period}`;
    const existing = groups.get(key);
    if (existing) {
      existing.min += card.impact.min ?? 0;
      existing.max += card.impact.max ?? 0;
      existing.findingCount += 1;
    } else {
      groups.set(key, {
        currency: card.impact.currency as string,
        period: card.impact.period as string,
        min: card.impact.min ?? 0,
        max: card.impact.max ?? 0,
        findingCount: 1,
      });
    }
  }

  for (const group of groups.values()) {
    group.min = Math.round(group.min * 100) / 100;
    group.max = Math.round(group.max * 100) / 100;
  }

  const openStatuses: FindingStatus[] = ["new", "seen", "in_review"];

  return {
    totalOpen: cards.filter((c) => openStatuses.includes(c.status)).length,
    bySeverity,
    byStatus,
    quantifiedImpact: [...groups.values()].sort((a, b) => b.max - a.max),
    notQuantifiedCount,
    staleCount,
    incompleteDataCount,
    degradedCount,
    capReached: cards.length >= MAX_CARDS,
    generatedAt: now.toISOString(),
  };
}

/**
 * Merchant-driven lifecycle change. Delegates to the Part 1 service, which owns
 * the transition rules and store scoping. Nothing about the store is changed —
 * only VedaSuite's own view of the finding.
 */
export async function updateActionStatus(input: {
  storeId: string;
  shopDomain: string;
  findingId: string;
  status: string;
  note?: string | null;
}) {
  const updated = await transitionFindingStatus({
    storeId: input.storeId,
    findingId: input.findingId,
    status: input.status,
    note: input.note ?? null,
    actor: "merchant",
  });

  // Pilot instrumentation. Aggregates only — no customer or order data.
  logEvent("info", "action_center.status_changed", {
    shop: input.shopDomain,
    storeId: input.storeId,
    findingId: input.findingId,
    findingType: updated.findingType,
    module: updated.module,
    nextStatus: input.status,
  });

  return updated;
}

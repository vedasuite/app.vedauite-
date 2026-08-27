// PHASE F — the Dashboard's single source of truth.
//
// THE PROBLEM
// -----------
// The Dashboard used to compute its own numbers. Every KPI came from a module
// overview service, and "Recent insights" came from raw TimelineEvent rows.
// Neither path knew anything about IntelligenceFinding, so the two surfaces
// could — and did — contradict each other:
//
//   * A merchant resolved a finding in Action Center. Action Center said 0 open.
//     The Dashboard still counted it, because `recommendationCount` counts
//     PricingRecommendation rows, which have no lifecycle.
//   * A merchant dismissed a finding. The Dashboard's "Recent insights" kept
//     showing the matching TimelineEvent forever, because a timeline event is an
//     immutable log line and is never retracted.
//   * Competitor changes were counted from stored rows even when the last fetch
//     failed, so the Dashboard implied a fresh market read that Phase D had
//     already proven did not happen.
//   * A critical OPERATIONAL finding ("your Shopify connection is broken") had
//     no Dashboard representation at all, so the most urgent finding VedaSuite
//     can raise was the one the Dashboard was least able to show.
//
// Each of those is the same defect: two surfaces independently manufacturing
// evidence, money, confidence or status about the same store.
//
// THE RULE
// --------
// The Dashboard does not compute. It PROJECTS. Every count and every insight on
// this page is a projection of the open IntelligenceFindings that Action Center
// is already showing, filtered and grouped but never recalculated. If Action
// Center cannot defend a number, the Dashboard cannot show it.
//
// The module workspaces (Fraud, Competitor, Pricing, Profit) are unaffected and
// keep their full detail. They are the place to go deep on a family; the
// Dashboard is only the place that says what needs attention today.
//
// WHY `available` EXISTS
// ----------------------
// When finding persistence is switched off, there are no findings to project.
// Zero findings and "VedaSuite is not currently recording findings" are
// completely different statements, and showing the second as "0" would be the
// fabrication this module exists to prevent. So the view reports availability
// explicitly and the UI renders a dash, not a zero.

import type { Urgency } from "./explainabilityCalc";

/** The KPI tiles the Dashboard shows, and which finding modules feed each. */
export type DashboardKpiKey =
  | "storeHealth"
  | "fraudAlerts"
  | "competitorChanges"
  | "pricingOpportunities"
  | "profitOpportunities"
  | "reconciliation";

/**
 * Module -> tile mapping.
 *
 * `operational` gets its own tile rather than being folded into another one.
 * It is the only family that is never entitlement-gated, and it carries the
 * findings that make every other number untrustworthy when they fire (a broken
 * connection, a sync that has not succeeded in weeks). Burying it was how a
 * critical operational finding stayed invisible on the Dashboard.
 */
export const KPI_MODULES: Record<DashboardKpiKey, readonly string[]> = {
  storeHealth: ["operational"],
  fraudAlerts: ["fraud", "trust", "return_abuse"],
  competitorChanges: ["competitor"],
  pricingOpportunities: ["pricing"],
  profitOpportunities: ["profit"],
  reconciliation: ["reconciliation"],
};

/**
 * Every module that can produce a finding must land on a tile.
 *
 * Reconciliation was missing here, and the effect was precisely the
 * contradiction this file exists to prevent: the Reconciliation workspace
 * counted one open finding, Action Center listed it, and the Dashboard tiles
 * summed to zero because the finding had nowhere to land. A merchant reading
 * the tiles concluded nothing was wrong. Adding a module to `IntelligenceFinding`
 * without adding it here is a silent under-report, so the guard below turns it
 * into a startup failure instead.
 */
const FINDING_MODULES = [
  "operational",
  "fraud",
  "trust",
  "return_abuse",
  "competitor",
  "pricing",
  "profit",
  "reconciliation",
] as const;

export const DASHBOARD_KPI_KEYS = Object.keys(KPI_MODULES) as DashboardKpiKey[];

/** Reverse index, built once. */
const MODULE_TO_KPI = new Map<string, DashboardKpiKey>();
for (const key of DASHBOARD_KPI_KEYS) {
  for (const module of KPI_MODULES[key]) {
    MODULE_TO_KPI.set(module, key);
  }
}

const unmapped = FINDING_MODULES.filter((m) => !MODULE_TO_KPI.has(m));
if (unmapped.length > 0) {
  throw new Error(
    `Finding modules with no Store Overview tile: ${unmapped.join(", ")}. ` +
      "Add them to KPI_MODULES or Store Overview will under-report findings."
  );
}

/** How many findings the Dashboard previews before deferring to Action Center. */
export const MAX_DASHBOARD_INSIGHTS = 5;

/** The minimum a card must expose for the Dashboard to project it. */
export interface ProjectableCard {
  id: string;
  module: string;
  status: string;
  severity: Urgency;
  title: string;
  whatHappened: string;
  recommendedAction: string;
  route: string;
  lastSeenAt: string;
  rank: { score: number };
}

export interface DashboardInsight {
  id: string;
  title: string;
  detail: string;
  severity: string;
  createdAt: string;
  route: string;
}

export interface DashboardFindingsView {
  /** False when findings are not being recorded, so counts mean nothing. */
  available: boolean;
  /** Merchant-readable explanation, set only when `available` is false. */
  unavailableReason: string | null;
  kpis: Record<DashboardKpiKey, number>;
  totalOpen: number;
  bySeverity: Record<Urgency, number>;
  recentInsights: DashboardInsight[];
  /** Headline for the "what needs attention" band. */
  attentionTitle: string;
  attentionDetail: string;
}

const EMPTY_SEVERITY = (): Record<Urgency, number> => ({
  critical: 0,
  high: 0,
  medium: 0,
  low: 0,
});

const EMPTY_KPIS = (): Record<DashboardKpiKey, number> => ({
  storeHealth: 0,
  fraudAlerts: 0,
  competitorChanges: 0,
  pricingOpportunities: 0,
  profitOpportunities: 0,
  reconciliation: 0,
});

/**
 * The statuses that mean "still needs attention".
 *
 * Deliberately duplicated as a local constant ONLY in the sense that it is
 * checked here — the values come from the caller, which reads
 * OPEN_FINDING_STATUSES. Keeping this module free of a prisma-importing
 * dependency is what makes it unit-testable without a database.
 */
export function isOpenStatus(status: string): boolean {
  return status === "new" || status === "seen" || status === "in_review";
}

/**
 * Projects Action Center cards onto the Dashboard.
 *
 * Pure. No database, no clock beyond what is passed in. Given the same cards
 * this ALWAYS produces the same view, which is what makes "the Dashboard cannot
 * contradict Action Center" a property that can be tested rather than a claim.
 */
export function buildDashboardFindingsView(input: {
  cards: ProjectableCard[];
  /** False when ENABLE_INTELLIGENCE_FINDING_PERSISTENCE is off. */
  persistenceEnabled: boolean;
  /** Capability modules the plan enables, for the honest-empty explanation. */
  enabledModules?: string[];
}): DashboardFindingsView {
  if (!input.persistenceEnabled) {
    return {
      available: false,
      unavailableReason:
        "VedaSuite is not currently recording findings for this store, so these counts cannot be shown.",
      kpis: EMPTY_KPIS(),
      totalOpen: 0,
      bySeverity: EMPTY_SEVERITY(),
      recentInsights: [],
      attentionTitle: "Findings are not being recorded",
      attentionDetail:
        "Nothing here is a measurement of your store yet. Contact support if you expected findings to appear.",
    };
  }

  const open = input.cards.filter((card) => isOpenStatus(card.status));

  const kpis = EMPTY_KPIS();
  const bySeverity = EMPTY_SEVERITY();

  for (const card of open) {
    const key = MODULE_TO_KPI.get(card.module);
    if (key) {
      kpis[key] += 1;
    }
    // An unmapped module is still counted in the totals below. Dropping it
    // would make the tiles and the total disagree, which is the exact class of
    // contradiction this module exists to remove.
    bySeverity[card.severity] = (bySeverity[card.severity] ?? 0) + 1;
  }

  // Same ordering rule Action Center uses, so the Dashboard preview is the top
  // of the same list rather than a differently-sorted subset.
  const ranked = [...open].sort((a, b) => {
    if (b.rank.score !== a.rank.score) return b.rank.score - a.rank.score;
    if (a.lastSeenAt !== b.lastSeenAt) return a.lastSeenAt < b.lastSeenAt ? 1 : -1;
    return a.id < b.id ? -1 : 1;
  });

  const recentInsights: DashboardInsight[] = ranked
    .slice(0, MAX_DASHBOARD_INSIGHTS)
    .map((card) => ({
      id: card.id,
      title: card.title,
      // The card's own words. The Dashboard never re-phrases a finding, because
      // a re-phrasing is a second description that can drift from the first.
      detail: card.whatHappened || card.recommendedAction,
      severity: card.severity,
      createdAt: card.lastSeenAt,
      route: card.route,
    }));

  const criticalOrHigh = bySeverity.critical + bySeverity.high;
  const totalOpen = open.length;

  return {
    available: true,
    unavailableReason: null,
    kpis,
    totalOpen,
    bySeverity,
    recentInsights,
    ...buildAttentionHeadline({ totalOpen, criticalOrHigh, storeHealth: kpis.storeHealth }),
  };
}

/**
 * The headline band.
 *
 * Store health leads when it is affected: if the connection is broken, telling
 * the merchant about pricing opportunities first would be advising them from
 * data VedaSuite has already admitted it could not refresh.
 */
function buildAttentionHeadline(input: {
  totalOpen: number;
  criticalOrHigh: number;
  storeHealth: number;
}): { attentionTitle: string; attentionDetail: string } {
  if (input.totalOpen === 0) {
    return {
      attentionTitle: "Nothing needs your attention right now",
      attentionDetail:
        "VedaSuite found no open findings for this store. This is a real result, not a loading state.",
    };
  }

  // ONE NUMBER IN THE HEADLINE, AND IT IS ALWAYS THE TOTAL.
  //
  // The title used to count `criticalOrHigh` while the line directly beneath it
  // counted `totalOpen`. Both were correct and they measured different things,
  // but stacked together, both called "findings", they read as
  //
  //     1 finding needs attention
  //     Open findings: 3
  //
  // — a contradiction to anyone who has not read this file, and disagreeing
  // with the 3 that Reconciliation, Action Center and the tiles all showed.
  //
  // The headline now states the same total every other surface states. Priority
  // becomes a QUALIFIER inside the detail line rather than a second count
  // competing with it.
  const openLabel =
    input.totalOpen === 1 ? "1 open finding" : `${input.totalOpen} open findings`;

  if (input.storeHealth > 0) {
    const health =
      input.storeHealth === 1 ? "1 is a store health issue" : `${input.storeHealth} are store health issues`;
    return {
      attentionTitle: openLabel,
      attentionDetail: `${health} — resolve those first, because store health affects how much of the rest of this page VedaSuite can stand behind.`,
    };
  }

  if (input.criticalOrHigh > 0) {
    const priority =
      input.criticalOrHigh === input.totalOpen
        ? input.totalOpen === 1
          ? "It is high priority."
          : "All of them are high priority."
        : `${input.criticalOrHigh} of them ${
            input.criticalOrHigh === 1 ? "is" : "are"
          } high priority.`;
    return {
      attentionTitle: openLabel,
      attentionDetail: `${priority} The highest-priority ones are listed below.`,
    };
  }

  return {
    attentionTitle: openLabel,
    attentionDetail: "None are critical or high priority. Review them when convenient.",
  };
}

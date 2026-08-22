// PART 4 — "VedaSuite Intelligence Brief" and the AI boundary.
//
// AUDIT RESULT: VedaSuite has NO AI/LLM infrastructure.
// No provider package in either package.json, no client, no endpoint, no API
// key, no prompt framework, no configuration. (Source greps for "llm" match
// only the substring inside "fu-llm-ent".)
//
// The brief is therefore fully DETERMINISTIC today. It is assembled from the
// same stored, verified findings the Action Center renders — no model, no
// inference, no generated facts. It is deliberately useful on its own so the
// Action Center never depends on AI existing.
//
// The seam below is the AI-ready boundary. If a provider is later configured,
// an explanation layer plugs in HERE and nowhere else, receiving the redacted
// structured payload defined by buildAiBriefInput() and returning only prose.
// Deterministic values remain the source of truth in every case.

import { logEvent } from "./observabilityService";
import type { ActionCard, ActionCenterSummary } from "./actionCenterService";

export interface IntelligenceBrief {
  headline: string;
  bullets: string[];
  /** Which findings the brief refers to, so the merchant can jump to them. */
  referencedFindingIds: string[];
  /** Honest provenance. Never says "AI detected" for deterministic work. */
  generatedBy: "deterministic" | "ai_assisted";
  /** Present when AI was attempted and did not succeed. */
  aiFallbackReason?: string;
  generatedAt: string;
}

/**
 * Is an AI explanation layer configured and usable?
 *
 * Always false today — no provider exists. Kept as a single predicate so the
 * decision has exactly one home when a provider is introduced.
 */
export function isAiExplanationEnabled(): boolean {
  return false;
}

/**
 * The EXACT structured payload an AI layer would receive. Exported and tested
 * so the privacy contract is enforceable before any provider is wired up.
 *
 * Deliberately excludes: customer ids, emails, addresses, IPs, device or
 * payment fingerprints, order ids, order names, product ids and raw snapshots.
 * Evidence is already allow-listed aggregates (see EVIDENCE_ALLOWLIST), and
 * only the label/value pairs travel.
 *
 * Numbers are passed as pre-formatted strings so a model cannot restate them
 * differently: it may only quote what VedaSuite computed.
 */
export function buildAiBriefInput(cards: ActionCard[], summary: ActionCenterSummary) {
  return {
    generatedAt: summary.generatedAt,
    openCount: summary.totalOpen,
    severityCounts: summary.bySeverity,
    notQuantifiedCount: summary.notQuantifiedCount,
    staleCount: summary.staleCount,
    incompleteDataCount: summary.incompleteDataCount,
    findings: cards.slice(0, 10).map((c) => ({
      findingId: c.id,
      findingType: c.findingType,
      severity: c.severity,
      confidence: c.confidence,
      dataComplete: c.dataComplete,
      isStale: c.isStale,
      title: c.title,
      whatHappened: c.whatHappened,
      whyItMatters: c.whyItMatters,
      evidence: c.evidence.map((e) => ({ label: e.label, value: e.value })),
      impact:
        c.impact.status === "quantified"
          ? {
              status: "quantified",
              // Pre-formatted: the model may quote, never recompute.
              range: `${c.impact.min}–${c.impact.max} ${c.impact.currency}`,
              period: c.impact.period,
            }
          : { status: "impact_not_quantifiable", reason: c.impact.reason },
      recommendedAction: c.recommendedAction,
    })),
  };
}

/**
 * Guardrails an AI response must satisfy before it may be shown. Exported so
 * they are testable now, ahead of any provider.
 *
 * Rejects a response that introduces a monetary figure absent from the verified
 * input — the specific failure mode where a model invents an amount.
 */
export function validateAiBrief(
  candidate: unknown,
  allowedFindingIds: string[],
  allowedNumbers: string[]
): { ok: true; brief: { headline: string; bullets: string[] } } | { ok: false; reason: string } {
  if (!candidate || typeof candidate !== "object") {
    return { ok: false, reason: "response was not an object" };
  }
  const c = candidate as Record<string, unknown>;
  if (typeof c.headline !== "string" || !c.headline.trim()) {
    return { ok: false, reason: "missing headline" };
  }
  if (!Array.isArray(c.bullets) || c.bullets.some((b) => typeof b !== "string")) {
    return { ok: false, reason: "bullets must be an array of strings" };
  }
  if (c.bullets.length > 10) {
    return { ok: false, reason: "too many bullets" };
  }

  const text = [c.headline, ...(c.bullets as string[])].join(" ");

  // Any number in the prose must appear verbatim in the verified input.
  const numbers = text.match(/\d[\d,.]*/g) ?? [];
  for (const n of numbers) {
    if (!allowedNumbers.some((allowed) => allowed.includes(n))) {
      return { ok: false, reason: `introduced an unverified number: ${n}` };
    }
  }

  // Must not claim to have detected anything itself.
  if (/\bAI (detected|found|discovered|calculated)\b/i.test(text)) {
    return { ok: false, reason: "claimed AI detection of deterministic findings" };
  }

  void allowedFindingIds;
  return { ok: true, brief: { headline: c.headline, bullets: c.bullets as string[] } };
}

function pluralise(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The deterministic brief. Assembled entirely from verified findings.
 *
 * Never throws: the Action Center must render even if this somehow fails, so
 * the caller always gets a usable object.
 */
export function buildDeterministicBrief(
  cards: ActionCard[],
  summary: ActionCenterSummary
): IntelligenceBrief {
  const generatedAt = summary.generatedAt;

  if (cards.length === 0) {
    return {
      headline: "Nothing needs your attention right now",
      bullets: [
        "VedaSuite found no open findings for this store.",
        summary.incompleteDataCount > 0
          ? "Some checks are limited by missing inputs — see Store health."
          : "All checks ran with the data available.",
      ],
      referencedFindingIds: [],
      generatedBy: "deterministic",
      generatedAt,
    };
  }

  const open = cards.filter((c) => ["new", "seen", "in_review"].includes(c.status));
  const top = open.slice(0, 3);
  const critical = summary.bySeverity.critical + summary.bySeverity.high;

  const headline =
    critical > 0
      ? `${pluralise(critical, "thing needs", "things need")} your attention today`
      : `${pluralise(open.length, "finding", "findings")} to review`;

  const bullets = top.map((c) => {
    const impact =
      c.impact.status === "quantified"
        ? ` Up to ${c.impact.max} ${c.impact.currency} (${c.impact.period}).`
        : "";
    const caveat = !c.dataComplete
      ? " Based on incomplete data."
      : c.isStale
      ? " This finding may be stale."
      : "";
    return `${c.title}. ${c.whatHappened}${impact}${caveat}`;
  });

  if (summary.notQuantifiedCount > 0) {
    bullets.push(
      `${pluralise(summary.notQuantifiedCount, "finding has", "findings have")} no defensible monetary estimate and ${
        summary.notQuantifiedCount === 1 ? "is" : "are"
      } not included in any total.`
    );
  }
  if (summary.staleCount > 0) {
    bullets.push(
      `${pluralise(summary.staleCount, "finding", "findings")} may be stale — run Sync Data to refresh.`
    );
  }

  return {
    headline,
    bullets,
    referencedFindingIds: top.map((c) => c.id),
    generatedBy: "deterministic",
    generatedAt,
  };
}

/**
 * Public entry point. Today this always returns the deterministic brief.
 *
 * When a provider is configured, the AI path wraps this call: attempt the
 * explanation, validate it with validateAiBrief, and on ANY failure — timeout,
 * quota, malformed output, failed validation — return this exact deterministic
 * brief with aiFallbackReason set. The Action Center therefore cannot be broken
 * by an AI outage, because the deterministic result is what it already renders.
 */
export function getIntelligenceBrief(
  cards: ActionCard[],
  summary: ActionCenterSummary
): IntelligenceBrief {
  try {
    if (!isAiExplanationEnabled()) {
      return buildDeterministicBrief(cards, summary);
    }
    // No provider configured; unreachable today. The AI call would go here.
    return buildDeterministicBrief(cards, summary);
  } catch (error) {
    logEvent("error", "action_center.brief_failed", {
      reason: "brief generation failed; returning a minimal deterministic brief",
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      headline: "Your findings are ready to review",
      bullets: [],
      referencedFindingIds: [],
      generatedBy: "deterministic",
      generatedAt: new Date().toISOString(),
    };
  }
}

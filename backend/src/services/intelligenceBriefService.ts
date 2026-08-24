// "VedaSuite Intelligence Brief" — the deterministic brief and the controlled
// AI explanation layer that sits ABOVE it.
//
// The brief is always assembled deterministically first, from the same stored,
// verified findings the Action Center renders. When AI is enabled, the model is
// asked to reword that verified material — it never detects, computes or ranks
// anything. On ANY failure (disabled, no key, rate limited, timeout, provider
// error, malformed output, failed validation) the deterministic brief is what
// the merchant sees, so the Action Center cannot be broken by the AI layer.
//
// Provenance is reported honestly: generatedBy is only ever "ai_assisted" when
// a model actually produced the prose that is displayed.

import { logEvent } from "./observabilityService";
import type { ActionCard, ActionCenterSummary } from "./actionCenterService";
import { isOpenFindingStatus } from "./intelligenceFindingService";
import { env } from "../config/env";
import {
  AiBriefError,
  resolveAiBriefProvider,
  type AiBriefProvider,
} from "./ai/aiBriefProvider";
import {
  buildBriefCacheKey,
  isWithinAiRateLimit,
  readCachedBrief,
  recordAiCall,
  writeCachedBrief,
} from "./ai/aiBriefBudget";

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
 * The single home for this decision. Fails closed: the flag must be on AND a
 * server-side key must be present.
 */
export function isAiExplanationEnabled(): boolean {
  return env.ai.enabled && !!env.ai.apiKey;
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
    // OPEN findings only.
    //
    // The Action Center feed deliberately keeps resolved and dismissed findings
    // retrievable, so `cards` is not the list of current problems. Passing all
    // of them here told the model that a resolved issue was still happening,
    // and it duly wrote it up as current — a merchant was shown "synchronisation
    // is currently unreliable" for a problem they had already resolved.
    //
    // The model can only describe what it is given, so this is the enforcement
    // point: a resolved finding never reaches it.
    findings: cards.filter((c) => isOpenFindingStatus(c.status)).slice(0, 10).map((c) => ({
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
export const MAX_AI_BULLETS = 5;
export const MAX_AI_BULLET_CHARS = 320;
export const MAX_AI_HEADLINE_CHARS = 160;

/**
 * Every numeric string the model is permitted to quote, gathered from the
 * verified payload. Anything numeric outside this set is an invented figure.
 */
export function collectAllowedNumbers(payload: {
  openCount: number;
  severityCounts: Record<string, number>;
  notQuantifiedCount: number;
  staleCount: number;
  incompleteDataCount: number;
  findings: Array<Record<string, unknown>>;
}): string[] {
  const allowed = new Set<string>();

  const addFrom = (value: unknown) => {
    if (value === null || value === undefined) return;
    for (const match of String(value).match(/\d[\d,.]*/g) ?? []) {
      allowed.add(match);
    }
  };

  // Summary counts the brief legitimately reports.
  [
    payload.openCount,
    payload.notQuantifiedCount,
    payload.staleCount,
    payload.incompleteDataCount,
    ...Object.values(payload.severityCounts ?? {}),
    // The brief may also count the findings it lists.
    payload.findings.length,
  ].forEach(addFrom);

  // Everything textual the model was shown.
  for (const finding of payload.findings) {
    for (const value of Object.values(finding)) {
      if (Array.isArray(value)) {
        value.forEach((entry) =>
          entry && typeof entry === "object"
            ? Object.values(entry).forEach(addFrom)
            : addFrom(entry)
        );
      } else if (value && typeof value === "object") {
        Object.values(value).forEach(addFrom);
      } else {
        addFrom(value);
      }
    }
  }

  return [...allowed];
}

/**
 * Guardrails an AI response must satisfy before it may be shown.
 *
 * This is the real security boundary, not the prompt: it holds regardless of
 * what the model was told or what the stored finding text tried to tell it.
 */
export function validateAiBrief(
  candidate: unknown,
  allowedFindingIds: string[],
  allowedNumbers: string[]
): { ok: true; brief: { headline: string; bullets: string[] } } | { ok: false; reason: string } {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return { ok: false, reason: "response was not an object" };
  }
  const c = candidate as Record<string, unknown>;

  if (typeof c.headline !== "string" || !c.headline.trim()) {
    return { ok: false, reason: "missing headline" };
  }
  if (c.headline.length > MAX_AI_HEADLINE_CHARS) {
    return { ok: false, reason: "headline too long" };
  }
  if (!Array.isArray(c.bullets) || c.bullets.some((b) => typeof b !== "string")) {
    return { ok: false, reason: "bullets must be an array of strings" };
  }
  if (c.bullets.length > MAX_AI_BULLETS) {
    return { ok: false, reason: "too many bullets" };
  }
  const bullets = c.bullets as string[];
  if (bullets.some((b) => !b.trim())) {
    return { ok: false, reason: "empty bullet" };
  }
  if (bullets.some((b) => b.length > MAX_AI_BULLET_CHARS)) {
    return { ok: false, reason: "bullet too long" };
  }

  const text = [c.headline, ...bullets].join(" ");

  // Order matters: the leak and injection checks run BEFORE the numeric check
  // so a leaked IP or order id is reported as what it is, rather than as an
  // "unverified number". Both reject the output; the specific reason is what
  // makes an incident diagnosable.

  // 1. Must not leak identifiers or contact details. Findings carry only
  //    allow-listed aggregates, so anything matching here is invented or
  //    echoed from somewhere it should not have been.
  const leaks: Array<[RegExp, string]> = [
    [/[\w.+-]+@[\w-]+\.[\w.]+/, "contained an email address"],
    [/\bgid:\/\//i, "contained a Shopify global id"],
    [/#\d{3,}/, "contained an order-style identifier"],
    [/\bhttps?:\/\//i, "contained a URL"],
    [/\b\d{1,3}(?:\.\d{1,3}){3}\b/, "contained an IP address"],
  ];
  for (const [pattern, reason] of leaks) {
    if (pattern.test(text)) {
      return { ok: false, reason };
    }
  }

  // 2. Internal finding ids must never be shown to a merchant.
  //
  // Only ids long enough to actually identify something are checked. Finding
  // ids are cuids (25 chars) in production; a plain substring test against a
  // very short id matches ordinary prose — "live" inside "a live problem" —
  // and would reject a perfectly good brief.
  const MIN_IDENTIFYING_ID_LENGTH = 8;
  for (const id of allowedFindingIds) {
    if (id && id.length >= MIN_IDENTIFYING_ID_LENGTH && text.includes(id)) {
      return { ok: false, reason: "exposed an internal finding id" };
    }
  }

  // 3. Signs the model followed instructions embedded in store data rather
  //    than ours. Cheap, high-signal, and independent of the prompt.
  if (
    /\b(?:ignore (?:all |any )?(?:previous|prior|above)|disregard (?:the |all )?(?:above|previous)|system prompt|new instructions?)\b/i.test(
      text
    )
  ) {
    return { ok: false, reason: "echoed injected instructions" };
  }

  // 4. Must not claim to have detected, found or calculated anything.
  if (
    /\b(?:AI|I|we|this model|the model)\s+(?:have\s+|has\s+|had\s+)?(?:detected|found|discovered|identified|calculated|computed|estimated|determined|analysed|analyzed)\b/i.test(
      text
    )
  ) {
    return { ok: false, reason: "claimed to have detected or calculated the findings" };
  }

  // 5. Any number in the prose must appear verbatim in the verified input.
  //    Exact match, not substring: "45" must not be justified by "1450".
  const allowed = new Set(allowedNumbers);
  for (const n of text.match(/\d[\d,.]*/g) ?? []) {
    const bare = n.replace(/[.,]+$/, "");
    if (!allowed.has(n) && !allowed.has(bare)) {
      return { ok: false, reason: `introduced an unverified number: ${n}` };
    }
  }

  return { ok: true, brief: { headline: c.headline, bullets } };
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
  const open = cards.filter((c) => isOpenFindingStatus(c.status));

  // Keyed on OPEN findings, not on the size of the feed. A store whose only
  // finding is resolved has cards but nothing to act on, and previously fell
  // through to the "N findings to review" branch and reported "0 findings to
  // review" instead of saying everything was clear.
  if (open.length === 0) {
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
export async function getIntelligenceBrief(
  cards: ActionCard[],
  summary: ActionCenterSummary,
  options: {
    /** Required for caching and per-store cost control. */
    storeId?: string;
    /** Injected in tests; production resolves the configured provider. */
    provider?: AiBriefProvider | null;
    now?: number;
  } = {}
): Promise<IntelligenceBrief> {
  // The deterministic brief is computed FIRST and is always the fallback, so
  // no AI failure path can leave the merchant without a brief.
  let deterministic: IntelligenceBrief;
  try {
    deterministic = buildDeterministicBrief(cards, summary);
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

  const withFallback = (reason: string): IntelligenceBrief => ({
    ...deterministic,
    aiFallbackReason: reason,
  });

  try {
    if (!isAiExplanationEnabled()) {
      // Distinguish "deliberately off" from "switched on but unusable".
      //
      // This branch used to return silently in BOTH cases, and the only place
      // that logged a missing key was resolveAiBriefProvider() below — which
      // this early return never reached. A deployment with the flag ON and no
      // usable key therefore produced no signal anywhere, which is exactly how
      // a build reading a different key name went unnoticed.
      if (env.ai.enabled && !env.ai.apiKey) {
        logEvent("warn", "ai.misconfigured", {
          reason:
            "ENABLE_AI_INTELLIGENCE_BRIEF is true but no server-side AI key is set; serving the deterministic brief",
          expectedEnvVar: "OPENAI_API_KEY",
        });
      }
      return deterministic;
    }
    const provider =
      options.provider !== undefined ? options.provider : resolveAiBriefProvider();
    // Not configured is the normal state, not an outage. Setting a fallback
    // reason here would show every merchant a "service unavailable" note on
    // every load, which would be misleading.
    if (!provider) {
      return deterministic;
    }
    // Nothing OPEN to reword; do not spend a call.
    //
    // Checking cards.length would be wrong: the feed keeps resolved and
    // dismissed findings retrievable, so a store whose only finding is resolved
    // still has cards. Calling the provider there produced a brief about a
    // problem that no longer exists.
    if (!cards.some((c) => isOpenFindingStatus(c.status))) {
      return deterministic;
    }

    const storeId = options.storeId;
    if (!storeId) {
      // Without a store we cannot cost-control or cache, so we do not call out.
      // An internal condition, not something to report to the merchant.
      return deterministic;
    }

    const now = options.now ?? Date.now();
    const cacheKey = buildBriefCacheKey(
      cards.map((c) => ({
        id: c.id,
        status: c.status,
        lastSeenAt: c.lastSeenAt,
        severity: c.severity,
      }))
    );

    const cached = readCachedBrief<IntelligenceBrief>(storeId, cacheKey, now);
    if (cached) {
      // Reuse the cached PROSE, but report this response's own timestamp and
      // the current ranking. A cached generatedAt would disagree with the
      // summary rendered beside it, which reads as stale data to a merchant.
      return {
        ...cached,
        referencedFindingIds: deterministic.referencedFindingIds,
        generatedAt: deterministic.generatedAt,
      };
    }

    if (!isWithinAiRateLimit(storeId, now)) {
      logEvent("warn", "ai.rate_limited", { storeId });
      return withFallback("AI usage limit reached for this store");
    }

    const payload = buildAiBriefInput(cards, summary);
    const allowedNumbers = collectAllowedNumbers(payload);
    const allowedIds = payload.findings.map((f) => f.findingId);

    // Counted before the call, so a provider outage cannot be retried in a
    // loop at our expense.
    recordAiCall(storeId, now);

    const candidate = await provider.generate(payload, env.ai.timeoutMs);
    const validated = validateAiBrief(candidate, allowedIds, allowedNumbers);

    if (!validated.ok) {
      logEvent("warn", "ai.brief_rejected", { storeId, reason: validated.reason });
      return withFallback(`AI output rejected: ${validated.reason}`);
    }

    const brief: IntelligenceBrief = {
      headline: validated.brief.headline,
      bullets: validated.brief.bullets,
      // Deterministic values remain the source of truth: the referenced
      // findings come from OUR ranking, never from the model.
      referencedFindingIds: deterministic.referencedFindingIds,
      generatedBy: "ai_assisted",
      generatedAt: deterministic.generatedAt,
    };

    writeCachedBrief(storeId, cacheKey, brief, now);
    logEvent("info", "ai.brief_generated", {
      storeId,
      provider: provider.name,
      bulletCount: brief.bullets.length,
    });
    return brief;
  } catch (error) {
    const kind = error instanceof AiBriefError ? error.kind : "provider_error";
    const message = error instanceof Error ? error.message : String(error);
    logEvent("warn", "ai.brief_failed", {
      storeId: options.storeId ?? null,
      kind,
      // The provider layer never puts credentials in its messages.
      error: message,
    });
    return withFallback(`AI unavailable (${kind})`);
  }
}

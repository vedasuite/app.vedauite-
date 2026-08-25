// Fresh, stale, failed and unreachable competitor evidence are NOT the same
// thing, and production presented them identically.
//
// THE PROBLEM
// -----------
// Render logs repeatedly showed, for merchant-entered domains:
//   competitor.fetch_snapshot -> TypeError: fetch failed
//   retry.failure -> competitor.snapshot_fallback
// while Competitor Intelligence reported "The LATEST ANALYSIS reviewed 3
// websites, matched 8 comparable products, and found 2 competitor changes."
//
// Those counts come from stored CompetitorData rows, not from the failed
// fetches. The wording implied the analysis had just run.
//
// WHAT IS AND IS NOT AVAILABLE
// ----------------------------
// CompetitorData.collectedAt exists, so freshness is derivable with no schema
// change. CompetitorDomain has no fetch-status field, so a failure is not
// recorded anywhere — it is only logged. A domain that produced no rows in the
// most recent attempt is therefore INFERRED to have failed, and is reported as
// "could not be reached" rather than asserted as a hard fact.
//
// No synthetic competitor data is generated anywhere: the fetch fallback
// returns null (shopifyAdminService), so an unreachable domain contributes
// nothing rather than something invented.

/** How current a domain's stored evidence is. */
export type CompetitorEvidenceState =
  | "fresh"
  | "stale"
  | "not_refreshed"
  | "never_collected";

export interface DomainEvidence {
  domain: string;
  state: CompetitorEvidenceState;
  /** Rows stored for this domain, whatever their age. */
  rowCount: number;
  newestCollectedAtIso: string | null;
  ageHours: number | null;
  /** Merchant-facing sentence. Never claims freshness it cannot support. */
  message: string;
}

/** Evidence older than this is stale rather than current. */
export const FRESH_WITHIN_HOURS = 24;

function hoursBetween(nowIso: string, thenIso: string): number {
  return (new Date(nowIso).getTime() - new Date(thenIso).getTime()) / 3_600_000;
}

/**
 * Classifies one merchant-entered domain.
 *
 * `lastSyncStartedAtIso` is when the most recent collection attempt began. If a
 * domain's newest row predates it, that attempt produced nothing for this
 * domain — the strongest available signal that the fetch failed.
 */
export function classifyDomainEvidence(input: {
  domain: string;
  nowIso: string;
  newestCollectedAtIso: string | null;
  rowCount: number;
  lastSyncStartedAtIso: string | null;
}): DomainEvidence {
  const { domain, rowCount, newestCollectedAtIso } = input;

  if (!newestCollectedAtIso || rowCount === 0) {
    return {
      domain,
      state: "never_collected",
      rowCount: 0,
      newestCollectedAtIso: null,
      ageHours: null,
      // Deliberately does not assert the domain is wrong, and never rewrites it.
      message: `${domain} could not be reached, so no competitor data has been collected from it. Check the domain and try again.`,
    };
  }

  const ageHours = hoursBetween(input.nowIso, newestCollectedAtIso);

  // The newest row predates the latest attempt => that attempt yielded nothing.
  const attemptedSince =
    input.lastSyncStartedAtIso !== null &&
    new Date(newestCollectedAtIso).getTime() < new Date(input.lastSyncStartedAtIso).getTime();

  if (attemptedSince) {
    return {
      domain,
      state: "not_refreshed",
      rowCount,
      newestCollectedAtIso,
      ageHours,
      message: `${domain} could not be reached on the last check. The figures below are from earlier data, not a fresh analysis.`,
    };
  }

  if (ageHours <= FRESH_WITHIN_HOURS) {
    return {
      domain,
      state: "fresh",
      rowCount,
      newestCollectedAtIso,
      ageHours,
      message: `${domain} was checked successfully in the last ${FRESH_WITHIN_HOURS} hours.`,
    };
  }

  return {
    domain,
    state: "stale",
    rowCount,
    newestCollectedAtIso,
    ageHours,
    message: `${domain} has not been refreshed for ${Math.round(ageHours / 24)} day(s). The figures below are from stored data.`,
  };
}

export interface CompetitorEvidenceSummary {
  domains: DomainEvidence[];
  freshDomains: number;
  staleDomains: number;
  unreachableDomains: number;
  /** True when NO domain has current evidence. */
  allEvidenceStale: boolean;
  /** Replaces "The latest analysis reviewed..." when nothing is current. */
  headlineQualifier: string;
}

/**
 * Aggregates per-domain states into what the page may claim.
 *
 * The qualifier is the point: counts may still be shown, but the sentence
 * around them must not say "latest analysis" when nothing was analysed.
 */
export function summariseCompetitorEvidence(
  domains: DomainEvidence[]
): CompetitorEvidenceSummary {
  const fresh = domains.filter((d) => d.state === "fresh").length;
  const stale = domains.filter((d) => d.state === "stale").length;
  const unreachable = domains.filter(
    (d) => d.state === "never_collected" || d.state === "not_refreshed"
  ).length;

  const allEvidenceStale = fresh === 0 && domains.length > 0;

  let headlineQualifier: string;
  if (domains.length === 0) {
    headlineQualifier = "No competitor domains have been added yet.";
  } else if (fresh > 0 && unreachable === 0 && stale === 0) {
    headlineQualifier = "Based on a fresh check of all domains.";
  } else if (fresh > 0) {
    headlineQualifier = `Based on a fresh check of ${fresh} of ${domains.length} domains; the rest could not be refreshed.`;
  } else {
    headlineQualifier =
      "Based on stored data. No domain could be checked successfully on the last run, so these figures are not a fresh analysis.";
  }

  return {
    domains,
    freshDomains: fresh,
    staleDomains: stale,
    unreachableDomains: unreachable,
    allEvidenceStale,
    headlineQualifier,
  };
}

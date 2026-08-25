// Why a competitor fetch actually failed, and whether retrying could ever help.
//
// THE PROBLEM
// -----------
// Production logged `competitor.fetch_snapshot -> TypeError: fetch failed`
// repeatedly, then `competitor.snapshot_fallback`, and the UI still claimed
// "the latest analysis reviewed 3 websites". Three separate faults:
//
//   1. "TypeError: fetch failed" is Node's GENERIC wrapper. The real reason —
//      ENOTFOUND, ECONNREFUSED, CERT_HAS_EXPIRED, ETIMEDOUT — lives in
//      error.cause.code and was never read. Every failure looked identical.
//   2. withRetry retried everything. A domain that does not resolve will never
//      resolve on attempt two, so every unresolvable domain burned 2 attempts
//      per product handle for nothing.
//   3. A 200 response whose HTML yields no price is not a failure, but it was
//      indistinguishable from one.
//
// This module turns a thrown error or a response into a specific, merchant-
// readable status, and says whether a retry is worth attempting.

/** The nine states Phase D requires. */
export type CompetitorFetchStatus =
  | "fresh_success"
  | "partial_success"
  | "stale"
  | "dns_unresolvable"
  | "timeout"
  | "http_blocked"
  | "tls_error"
  | "unparseable"
  | "never_collected";

export interface FetchOutcome {
  status: CompetitorFetchStatus;
  /** Retrying can only help for transient conditions. */
  retryable: boolean;
  /** Merchant-readable. Never exposes a raw Node error code. */
  merchantMessage: string;
  /** Kept for logs only — not shown to merchants. */
  technicalDetail: string;
}

/** Node/undici codes that mean the hostname does not resolve. */
const DNS_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "EAI_NONAME"]);
/** Codes that mean a TLS/certificate problem. */
const TLS_CODES = new Set([
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "ERR_SSL_WRONG_VERSION_NUMBER",
]);
/** Codes that mean the connection timed out or was dropped. */
const TIMEOUT_CODES = new Set(["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT"]);
/** Codes that mean the host actively refused or reset the connection. */
const REFUSED_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH"]);

/**
 * Digs the real cause out of a fetch error.
 *
 * `fetch` wraps the underlying socket error, so `error.code` is usually
 * undefined and `error.cause.code` carries the truth. Walks the chain because
 * the cause can itself be wrapped.
 */
export function extractErrorCode(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    const candidate = current as { code?: unknown; cause?: unknown; name?: unknown };
    if (typeof candidate.code === "string" && candidate.code) {
      return candidate.code;
    }
    if (candidate.name === "AbortError" || candidate.name === "TimeoutError") {
      return "ABORT";
    }
    current = candidate.cause;
  }
  return null;
}

/** Classifies a thrown fetch error for one domain. */
export function classifyFetchError(domain: string, error: unknown): FetchOutcome {
  const code = extractErrorCode(error);
  const raw = error instanceof Error ? error.message : String(error);
  const detail = code ? `${code}: ${raw}` : raw;

  if (code && DNS_CODES.has(code)) {
    return {
      status: "dns_unresolvable",
      // A hostname that does not exist will not exist on the next attempt.
      retryable: false,
      merchantMessage: `${domain} could not be found. Check the spelling of the domain and try again.`,
      technicalDetail: detail,
    };
  }

  if (code && TLS_CODES.has(code)) {
    return {
      status: "tls_error",
      retryable: false,
      merchantMessage: `${domain} has a security certificate problem, so VedaSuite could not read it safely.`,
      technicalDetail: detail,
    };
  }

  if (code === "ABORT" || (code && TIMEOUT_CODES.has(code))) {
    return {
      status: "timeout",
      // Transient: the site may simply have been slow.
      retryable: true,
      merchantMessage: `${domain} did not respond in time. VedaSuite will try again on the next sync.`,
      technicalDetail: detail,
    };
  }

  if (code && REFUSED_CODES.has(code)) {
    return {
      status: "http_blocked",
      retryable: false,
      merchantMessage: `${domain} refused the connection. The site may be blocking automated access.`,
      technicalDetail: detail,
    };
  }

  // Unknown cause. Treated as transient so a genuine blip is not written off,
  // but reported honestly rather than as a success.
  return {
    status: "timeout",
    retryable: true,
    merchantMessage: `${domain} could not be reached on the last check. VedaSuite will try again on the next sync.`,
    technicalDetail: detail,
  };
}

/** Classifies an HTTP response that came back but was not usable. */
export function classifyHttpStatus(domain: string, httpStatus: number): FetchOutcome {
  if (httpStatus === 403 || httpStatus === 401 || httpStatus === 429) {
    return {
      status: "http_blocked",
      // 429 is rate limiting, which does ease — but not within one sync.
      retryable: false,
      merchantMessage: `${domain} is blocking automated access, so VedaSuite cannot read its prices.`,
      technicalDetail: `HTTP ${httpStatus}`,
    };
  }
  if (httpStatus >= 500) {
    return {
      status: "timeout",
      retryable: true,
      merchantMessage: `${domain} returned a server error. VedaSuite will try again on the next sync.`,
      technicalDetail: `HTTP ${httpStatus}`,
    };
  }
  return {
    status: "http_blocked",
    retryable: false,
    merchantMessage: `${domain} returned an unexpected response, so VedaSuite could not read its prices.`,
    technicalDetail: `HTTP ${httpStatus}`,
  };
}

/**
 * Classifies a page that loaded but yielded nothing usable.
 *
 * Distinct from a failure: the site is reachable, so the merchant's domain is
 * fine — VedaSuite simply could not find a price on that page.
 */
export function classifyUnparseable(domain: string): FetchOutcome {
  return {
    status: "unparseable",
    retryable: false,
    merchantMessage: `${domain} was reached, but VedaSuite could not find product prices in a format it understands.`,
    technicalDetail: "200 OK, no price signal extracted",
  };
}

/** A successful read. `partial` when the page loaded but the price was inferred. */
export function classifySuccess(domain: string, partial: boolean): FetchOutcome {
  return partial
    ? {
        status: "partial_success",
        retryable: false,
        merchantMessage: `${domain} was reached, but only part of the product information could be confirmed.`,
        technicalDetail: "matched without a confirmed price",
      }
    : {
        status: "fresh_success",
        retryable: false,
        merchantMessage: `${domain} was checked successfully.`,
        technicalDetail: "price confirmed",
      };
}

/** Whether a status means VedaSuite currently holds usable CURRENT evidence. */
export function isCurrentEvidence(status: CompetitorFetchStatus | null | undefined): boolean {
  return status === "fresh_success" || status === "partial_success";
}

/** Whether a status represents a collection failure the merchant should see. */
export function isFailure(status: CompetitorFetchStatus | null | undefined): boolean {
  return (
    status === "dns_unresolvable" ||
    status === "timeout" ||
    status === "http_blocked" ||
    status === "tls_error" ||
    status === "unparseable"
  );
}

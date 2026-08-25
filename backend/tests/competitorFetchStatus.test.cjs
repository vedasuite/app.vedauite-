const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

/**
 * PHASE D — competitor collection honesty.
 *
 * Production logged competitor.fetch_snapshot -> TypeError: fetch failed
 * repeatedly for merchant-entered domains, then competitor.snapshot_fallback,
 * while the UI claimed "the latest analysis reviewed 3 websites".
 *
 * Three faults, all inside VedaSuite's control:
 *   1. "TypeError: fetch failed" is Node's generic wrapper; the real code lives
 *      in error.cause.code and was never read, so every failure looked alike.
 *   2. withRetry retried everything, including domains that can never resolve.
 *   3. A 200 response with no price was indistinguishable from a failure.
 */

const c = require(path.resolve(__dirname, "../dist/services/competitorFetchStatus.js"));

/** The error shape fetch actually throws: generic outer, real cause inside. */
const fetchError = (code) =>
  Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error("underlying"), { code }),
  });

// ===========================================================================
// The root cause: reading the real code
// ===========================================================================

test("ROOT CAUSE: the real code comes from error.cause, not the wrapper", () => {
  assert.equal(c.extractErrorCode(fetchError("ENOTFOUND")), "ENOTFOUND");
  assert.equal(c.extractErrorCode(new TypeError("fetch failed")), null);
});

test("ROOT CAUSE: nested causes are walked", () => {
  const deep = Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error("mid"), {
      cause: Object.assign(new Error("inner"), { code: "ECONNREFUSED" }),
    }),
  });
  assert.equal(c.extractErrorCode(deep), "ECONNREFUSED");
});

// ===========================================================================
// The nine states
// ===========================================================================

test("STATE: an unresolvable domain is dns_unresolvable and NOT retried", () => {
  for (const code of ["ENOTFOUND", "EAI_AGAIN", "EAI_NONAME"]) {
    const out = c.classifyFetchError("addidas.com", fetchError(code));
    assert.equal(out.status, "dns_unresolvable");
    assert.equal(out.retryable, false, "a domain that does not exist will not exist on retry");
    assert.match(out.merchantMessage, /could not be found/i);
    assert.match(out.merchantMessage, /Check the spelling/i);
  }
});

test("STATE: a certificate problem is tls_error and not retried", () => {
  for (const code of ["CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID"]) {
    const out = c.classifyFetchError("shop.example", fetchError(code));
    assert.equal(out.status, "tls_error");
    assert.equal(out.retryable, false);
    assert.match(out.merchantMessage, /security certificate/i);
  }
});

test("STATE: a timeout is retryable", () => {
  const out = c.classifyFetchError("slow.example", fetchError("ETIMEDOUT"));
  assert.equal(out.status, "timeout");
  assert.equal(out.retryable, true, "a slow site may respond next time");
});

test("STATE: an aborted request counts as a timeout", () => {
  const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
  assert.equal(c.classifyFetchError("x.example", abort).status, "timeout");
});

test("STATE: a refused connection is http_blocked and not retried", () => {
  const out = c.classifyFetchError("blocked.example", fetchError("ECONNREFUSED"));
  assert.equal(out.status, "http_blocked");
  assert.equal(out.retryable, false);
});

test("STATE: 401/403/429 block, 5xx is transient", () => {
  for (const status of [401, 403, 429]) {
    const out = c.classifyHttpStatus("x.example", status);
    assert.equal(out.status, "http_blocked");
    assert.equal(out.retryable, false, status + " will block again");
  }
  const server = c.classifyHttpStatus("x.example", 503);
  assert.equal(server.status, "timeout");
  assert.equal(server.retryable, true);
});

test("STATE: a reachable page with no price is unparseable, not a failure", () => {
  const out = c.classifyUnparseable("store.example");
  assert.equal(out.status, "unparseable");
  assert.match(out.merchantMessage, /was reached/i, "the domain itself is fine");
  assert.doesNotMatch(out.merchantMessage, /could not be found/i);
});

test("STATE: success distinguishes fresh from partial", () => {
  assert.equal(c.classifySuccess("x.example", false).status, "fresh_success");
  assert.equal(c.classifySuccess("x.example", true).status, "partial_success");
  assert.match(c.classifySuccess("x.example", true).merchantMessage, /only part/i);
});

// ===========================================================================
// What counts as current evidence
// ===========================================================================

test("CURRENT: only fresh or partial success is current evidence", () => {
  assert.equal(c.isCurrentEvidence("fresh_success"), true);
  assert.equal(c.isCurrentEvidence("partial_success"), true);
  for (const s of [
    "stale",
    "dns_unresolvable",
    "timeout",
    "http_blocked",
    "tls_error",
    "unparseable",
    "never_collected",
    null,
  ]) {
    assert.equal(c.isCurrentEvidence(s), false, s + " must not count as current");
  }
});

test("CURRENT: every failure state is reported as a failure", () => {
  for (const s of ["dns_unresolvable", "timeout", "http_blocked", "tls_error", "unparseable"]) {
    assert.equal(c.isFailure(s), true);
  }
  assert.equal(c.isFailure("fresh_success"), false);
  assert.equal(c.isFailure("never_collected"), false, "never attempted is not a failure");
});

// ===========================================================================
// Merchant safety
// ===========================================================================

test("SAFETY: no merchant message exposes a raw Node error code", () => {
  for (const code of ["ENOTFOUND", "ECONNREFUSED", "CERT_HAS_EXPIRED", "ETIMEDOUT"]) {
    const out = c.classifyFetchError("x.example", fetchError(code));
    assert.doesNotMatch(out.merchantMessage, /ENOTFOUND|ECONN|CERT_|ETIMEDOUT|TypeError/);
    // The detail is still retained, for logs and support only.
    assert.match(out.technicalDetail, new RegExp(code));
  }
});

test("SAFETY: the merchant domain is echoed exactly, never corrected", () => {
  const out = c.classifyFetchError("addidas.com", fetchError("ENOTFOUND"));
  assert.match(out.merchantMessage, /addidas\.com/);
  assert.doesNotMatch(out.merchantMessage, /\badidas\.com/, "no silent auto-correction");
});

test("SAFETY: an unknown cause is reported honestly, not as success", () => {
  const out = c.classifyFetchError("x.example", new Error("something odd"));
  assert.equal(c.isCurrentEvidence(out.status), false);
  assert.equal(out.retryable, true, "unknown is transient, not written off");
});

// ===========================================================================
// Wiring
// ===========================================================================

test("WIRING: the fetch path classifies instead of swallowing", () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, "../src/services/shopifyAdminService.ts"),
    "utf8"
  );
  assert.match(src, /classifyFetchError\(domain, error\)/);
  assert.match(src, /classifyHttpStatus\(domain, response\.status\)/);
  assert.match(src, /classifyUnparseable\(domain\)/);
  assert.match(src, /recordCompetitorFetchSuccess\(domain/);
  assert.match(
    src,
    /if \(!httpOutcome\.retryable\)/,
    "a non-retryable status must short-circuit rather than burn attempts"
  );
});

test("WIRING: the aggressive 4s timeout is gone", () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, "../src/services/shopifyAdminService.ts"),
    "utf8"
  );
  assert.doesNotMatch(src, /controller\.abort\(\), 4000/);
});

test("WIRING: per-domain attempt status is persisted, not inferred", () => {
  const schema = fs.readFileSync(
    path.resolve(__dirname, "../prisma/schema.prisma"),
    "utf8"
  );
  for (const field of ["lastAttemptAt", "lastAttemptStatus", "lastAttemptDetail", "lastSuccessAt"]) {
    assert.match(schema, new RegExp(field), field + " must exist on CompetitorDomain");
  }
});

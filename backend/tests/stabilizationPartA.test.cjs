const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

process.env.SHOPIFY_API_KEY ||= "test-key";
process.env.SHOPIFY_API_SECRET ||= "test-secret";
process.env.SHOPIFY_APP_URL ||= "https://vedasuite-staging.onrender.com";
process.env.SHOPIFY_ADMIN_API_VERSION ||= "2026-01";
process.env.DATABASE_URL ||= "postgresql://example:example@localhost:5432/example";

/**
 * PART A — the three consistency defects found during production smoke testing.
 *
 *   A1. Market Signals said "reviewed 3 websites / Refreshed recently" while
 *       Render logged `addidas.com -> tls_error, retriable:false`.
 *   A2. A card showed "$32.00 -> $34.20" and, in the same card, "May have room
 *       to increase — evidence needed to say how much". Action Center printed
 *       exact figures such as 51.35 for the same rows.
 *   A3. Store Overview said "Needs at least 5 synced orders" when the detector
 *       will not compute a store baseline below 50.
 */

const d = (p) => path.resolve(__dirname, `../dist/${p}`);
const SRC = path.resolve(__dirname, "../src");
const FRONTEND = path.resolve(__dirname, "../../frontend/src");
const read = (p) => fs.readFileSync(p, "utf8");

// ===========================================================================
// A1 — attempted vs refreshed, and no leaked internals
// ===========================================================================

const fetchStatus = require(d("services/competitorFetchStatus.js"));

test("A1 ROOT CAUSE: the per-domain outcome is actually PERSISTED", () => {
  // The schema columns, the classifier and takeCompetitorFetchOutcome all
  // existed. Nothing ever wrote them, so lastAttemptStatus was permanently
  // NULL and every count fell back to "how many domains are configured".
  const src = read(path.join(SRC, "services/competitorService.ts"));
  assert.match(src, /takeCompetitorFetchOutcome\(domain\.domain\)/, "the outcome must be read");
  assert.match(
    src,
    /prisma\.competitorDomain\.update\(\{[\s\S]{0,400}lastAttemptStatus: resolvedStatus/,
    "and written to CompetitorDomain"
  );
  assert.match(
    src,
    /\.\.\.\(refreshed \? \{ lastSuccessAt: new Date\(\) \} : \{\}\)/,
    "lastSuccessAt must move ONLY on a real success"
  );
});

test("A1: a TLS failure is never counted as a refreshed domain", () => {
  assert.equal(fetchStatus.isCurrentEvidence("tls_error"), false);
  assert.equal(fetchStatus.isFailure("tls_error"), true);
  for (const status of ["dns_unresolvable", "timeout", "http_blocked", "unparseable"]) {
    assert.equal(
      fetchStatus.isCurrentEvidence(status),
      false,
      `${status} must not count as refreshed`
    );
    assert.equal(fetchStatus.isFailure(status), true);
  }
  // Only real reads count.
  assert.equal(fetchStatus.isCurrentEvidence("fresh_success"), true);
  assert.equal(fetchStatus.isCurrentEvidence("partial_success"), true);
});

test("A1: an unattempted domain is not counted as refreshed either", () => {
  assert.equal(fetchStatus.isCurrentEvidence(null), false);
  assert.equal(fetchStatus.isCurrentEvidence(undefined), false);
  assert.equal(fetchStatus.isCurrentEvidence("never_collected"), false);
});

test("A1: 'Domains reviewed' now means domains that yielded evidence", () => {
  const src = read(path.join(SRC, "services/competitorService.ts"));
  assert.match(
    src,
    /const refreshedDomains = store\.competitorDomains\.filter\(\(domain\) =>\s*\n?\s*isCurrentEvidence\(domain\.lastAttemptStatus\)/,
    "the refreshed set must be derived from the persisted status"
  );
  assert.match(
    src,
    /const checkedDomainsCount = refreshedDomainsCount;/,
    "the headline count must be the refreshed count"
  );
  assert.doesNotMatch(
    src,
    /checkedDomainsCount =\s*\n?\s*store\.competitorDomains\.length === 0/,
    "the old configured-count fallback must be gone"
  );
});

test("A1: merchant copy states X of Y, never a bare 'reviewed N websites'", () => {
  const src = read(path.join(SRC, "services/competitorService.ts"));
  assert.match(
    src,
    /refreshed \$\{args\.checkedDomainsCount\} of \$\{args\.attemptedDomainsCount\} domains/,
    "the description must state both numbers"
  );
  assert.doesNotMatch(
    src,
    /The latest analysis reviewed \$\{args\.checkedDomainsCount\} websites/,
    "the old wording implied fresh evidence from every configured domain"
  );
});

test("A1: 'Refreshed recently' derives from evidence, not from job status", () => {
  const src = read(path.join(SRC, "services/competitorService.ts"));
  // The job finishes SUCCEEDED_NO_DATA even when every domain failed.
  assert.doesNotMatch(
    src,
    /const lastSuccessAt =\s*\n?\s*latestCompetitorJob &&/,
    "job status must no longer stand in for evidence collection"
  );
  assert.match(
    src,
    /const newestDomainSuccessAt = refreshedDomains\.reduce/,
    "freshness must come from the newest per-domain success"
  );
  // And the label carries the shortfall when some domains failed.
  assert.match(src, /domains refreshed`\s*\n?\s*: baseFreshnessLabel/);
});

test("A1: stale evidence does not become fresh because another run was attempted", () => {
  const src = read(path.join(SRC, "services/competitorService.ts"));
  // With outcomes recorded but no success, lastSuccessAt must be null rather
  // than falling back to the newest stored row.
  assert.match(
    src,
    /store\.competitorDomains\.some\(\(d\) => d\.lastAttemptStatus != null\)\s*\n?\s*\? null/,
    "an attempted-but-failed set must not inherit freshness from stored rows"
  );
});

test("A1: no Node or internal error string can reach a merchant", () => {
  // describeDomainFailure rebuilds the sentence from the STATUS only.
  for (const status of [
    "tls_error",
    "dns_unresolvable",
    "timeout",
    "http_blocked",
    "unparseable",
    "never_collected",
    null,
    "something_unknown",
  ]) {
    const message = fetchStatus.describeDomainFailure("addidas.com", status);
    assert.equal(typeof message, "string");
    assert.ok(message.length > 10, `message too thin for ${status}`);
    for (const leak of [
      "CERT_HAS_EXPIRED",
      "ENOTFOUND",
      "ECONNREFUSED",
      "ETIMEDOUT",
      "TypeError",
      "fetch failed",
      "undici",
      "stack",
    ]) {
      assert.ok(
        !message.includes(leak),
        `"${leak}" leaked into merchant copy for ${status}: ${message}`
      );
    }
  }
});

test("A1: the merchant-entered domain is echoed exactly, never corrected", () => {
  // "addidas.com" is a typo for adidas.com. VedaSuite must not silently fix it.
  const message = fetchStatus.describeDomainFailure("addidas.com", "tls_error");
  assert.match(message, /addidas\.com/);
  assert.ok(!message.includes("adidas.com"), "must not suggest a corrected domain");
});

test("A1: the technical detail is stored but never serialised to the client", () => {
  const src = read(path.join(SRC, "services/competitorService.ts"));
  // Written to the DB...
  assert.match(src, /lastAttemptDetail: outcome\?\.technicalDetail \?\? null/);
  // ...and the payload sends the rebuilt message instead.
  assert.match(src, /message: describeDomainFailure\(domain\.domain, domain\.lastAttemptStatus\)/);
  assert.doesNotMatch(
    src,
    /detail: domain\.lastAttemptDetail|lastAttemptDetail: domain\.lastAttemptDetail/,
    "lastAttemptDetail must never be placed in a client payload"
  );
});

test("A1: the failed domain is VISIBLE to the merchant", () => {
  const page = read(path.join(FRONTEND, "modules/CompetitorIntelligence/CompetitorPage.tsx"));
  assert.match(page, /failedDomains/, "the page must consume the failed list");
  assert.match(
    page,
    /domains refreshed`\}/,
    "and show how many of how many actually refreshed"
  );
  assert.match(page, /\{entry\.message\}/, "rendering the safe explanation");
  assert.doesNotMatch(
    page,
    /\{overview\.competitorState\?\.checkedDomainsCount \?\? 0\}\] *$/m,
    "the bare 'Domains reviewed' count must be gone"
  );
});

test("A1: a non-retryable failure is not retried", () => {
  const src = read(path.join(SRC, "services/shopifyAdminService.ts"));
  assert.match(
    src,
    /shouldRetry: \(error\) => classifyFetchError\(domain, error\)\.retryable/,
    "the retry decision must use the same classifier as the log line"
  );
  // And the classifier is unambiguous about which failures are permanent.
  const tls = require(d("services/competitorFetchStatus.js")).classifyFetchError(
    "addidas.com",
    Object.assign(new TypeError("fetch failed"), {
      cause: { code: "CERT_HAS_EXPIRED" },
    })
  );
  assert.equal(tls.status, "tls_error");
  assert.equal(tls.retryable, false, "an expired certificate is still expired 200ms later");
});

// ===========================================================================
// A2 — ONE rule decides whether an exact target may be shown
// ===========================================================================

const evidenceCalc = require(d("services/pricingEvidenceCalc.js"));

const SUPPORTED = {
  biasApplied: false,
  heuristicCompetitorBlend: false,
  heuristicReturnPenalty: false,
  velocityObserved: true,
  exactTargetSupported: true,
  assumptionTerms: [],
};

test("A2 PRODUCTION REPRO: competitor data alone does NOT license an exact price", () => {
  // The exact production card: competitor-informed, so showExactTarget is true,
  // but the figure was bias-shaped.
  const evidence = evidenceCalc.classifyPricingEvidence({
    competitorReady: true,
    competitorAveragePrice: 30,
    profitReady: false,
    salesVelocityObserved: false,
  });
  assert.equal(evidence.basis, "competitor_informed");
  assert.equal(evidence.showExactTarget, true, "the evidence bar is unchanged");

  const allowed = evidenceCalc.isExactTargetAllowed({
    evidence,
    targetProvenance: {
      biasApplied: true,
      heuristicCompetitorBlend: true,
      exactTargetSupported: false,
      assumptionTerms: ["pricing_bias", "competitor_blend_weight"],
    },
  });
  assert.equal(allowed, false, "no $34.20 may be printed");
});

test("A2: a target with NO recorded provenance is withheld", () => {
  // Rows written before provenance existed. Unknown must never mean "shown".
  const evidence = evidenceCalc.classifyPricingEvidence({
    competitorReady: true,
    competitorAveragePrice: 30,
    profitReady: true,
    salesVelocityObserved: true,
  });
  assert.equal(evidence.showExactTarget, true);
  for (const provenance of [null, undefined, {}, { assumptionTerms: [] }]) {
    assert.equal(
      evidenceCalc.isExactTargetAllowed({ evidence, targetProvenance: provenance }),
      false,
      `provenance ${JSON.stringify(provenance)} must fail closed`
    );
  }
});

test("A2: a genuinely assumption-free target IS still allowed", () => {
  // The capability is gated, not removed.
  const evidence = evidenceCalc.classifyPricingEvidence({
    competitorReady: true,
    competitorAveragePrice: 30,
    profitReady: true,
    salesVelocityObserved: true,
  });
  assert.equal(
    evidenceCalc.isExactTargetAllowed({ evidence, targetProvenance: SUPPORTED }),
    true
  );
});

test("A2: insufficient evidence still blocks a target even with clean provenance", () => {
  const evidence = evidenceCalc.classifyPricingEvidence({
    competitorReady: false,
    competitorAveragePrice: null,
    profitReady: false,
    salesVelocityObserved: false,
  });
  assert.equal(evidence.showExactTarget, false);
  assert.equal(
    evidenceCalc.isExactTargetAllowed({ evidence, targetProvenance: SUPPORTED }),
    false,
    "both conditions are required"
  );
});

test("A2 ROOT CAUSE: every assumption term in the formula is recorded", () => {
  const src = read(path.join(SRC, "services/coreEngineService.ts"));
  // The four terms of baselinePriceRecommendation, and which are observations.
  assert.match(src, /const biasApplied = biasLift !== 0;/);
  assert.match(src, /const heuristicCompetitorBlend = competitorGap !== 0;/);
  assert.match(src, /const heuristicReturnPenalty = returnPenalty !== 0;/);
  assert.match(
    src,
    /exactTargetSupported: assumptionTerms\.length === 0/,
    "eligibility must be DERIVED from the terms, not asserted"
  );
  // And it is persisted alongside the number.
  assert.match(src, /targetProvenance,/);
});

test("A2: a bias of exactly 50 contributes nothing and is not held against it", () => {
  // (50 - 50) / 180 === 0. A term that did not move the number is not an
  // assumption in the number.
  const src = read(path.join(SRC, "services/coreEngineService.ts"));
  assert.match(
    src,
    /A bias of exactly 50 contributes zero and is not held against it/,
    "the rule must be stated where it is implemented"
  );
});

test("A2: unreadable provenance withholds the target rather than assuming it", () => {
  assert.equal(evidenceCalc.readTargetProvenance("not json at all"), null);
  assert.equal(evidenceCalc.readTargetProvenance(null), null);
  assert.equal(evidenceCalc.readTargetProvenance("{}"), null);
  assert.deepEqual(
    evidenceCalc.readTargetProvenance(JSON.stringify({ targetProvenance: SUPPORTED })),
    SUPPORTED
  );
});

test("A2: the withheld-target explanation names the real reason", () => {
  const biasOnly = evidenceCalc.explainWithheldTarget({
    assumptionTerms: ["pricing_bias"],
  });
  assert.match(biasOnly, /Not enough evidence yet to recommend an exact price/);
  assert.match(biasOnly, /pricing strategy setting/, "must name the bias slider");

  const both = evidenceCalc.explainWithheldTarget({
    assumptionTerms: ["pricing_bias", "competitor_blend_weight"],
  });
  assert.match(both, /competitor gap/);

  // No terms recorded at all — a different, honest message.
  const none = evidenceCalc.explainWithheldTarget(null);
  assert.match(none, /not enough about this product to name a figure/);
});

test("A2: BOTH surfaces call the SAME rule", () => {
  const pricing = read(path.join(SRC, "services/pricingProfitService.ts"));
  const actionCenter = read(path.join(SRC, "services/intelligenceDetectorService.ts"));
  for (const [name, src] of [
    ["pricingProfitService", pricing],
    ["intelligenceDetectorService", actionCenter],
  ]) {
    assert.match(
      src,
      /isExactTargetAllowed\(\{/,
      `${name} must call the shared rule rather than re-deriving one`
    );
    assert.match(src, /from "\.\/pricingEvidenceCalc"|pricingEvidenceCalc/);
  }
});

test("A2: Action Center prints a direction, not a two-decimal figure", () => {
  const src = read(path.join(SRC, "services/intelligenceDetectorService.ts"));
  assert.match(
    src,
    /exactTargetAllowed\s*\n?\s*\? \{ label: "Recommended price", value: row\.recommendedPrice\.toFixed\(2\) \}\s*\n?\s*: \{ label: "Suggested direction", value: "Possible " \+ direction \}/,
    "the 51.35 / 61.62 figures must be gated by the same rule"
  );
  assert.doesNotMatch(
    src,
    /evidence: \[\s*\n?\s*\{ label: "Current price"[\s\S]{0,80}\{ label: "Recommended price", value: row\.recommendedPrice\.toFixed\(2\) \},\s*\n?\s*\{ label: "Evidence basis"/,
    "the ungated evidence row must be gone"
  );
});

test("A2: the evidence THRESHOLD was not changed, only the display", () => {
  // The instruction was explicit: do not loosen or tighten thresholds to
  // populate or suppress recommendations. qualifiesAsPricingAction is the
  // evidence bar and still gates on showExactTarget and the 1% noise band.
  const qual = read(path.join(SRC, "services/actionQualification.ts"));
  assert.match(qual, /if \(!input\.showExactTarget\) return false;/);
  assert.match(qual, /return pct >= 0\.01;/, "the 1% noise band is unchanged");
});

test("A2: a card with a withheld target explains itself and shows no arrow", () => {
  const src = read(path.join(SRC, "services/pricingProfitService.ts"));
  assert.match(src, /recommendedPrice: exactTargetAllowed \? item\.recommendedPrice : null/);
  assert.match(
    src,
    /recommendationType: exactTargetAllowed \? actionLabel : "Direction only"/,
    "the badge must not claim an action it cannot name"
  );
  assert.match(src, /\? explainWithheldTarget\(item\.targetProvenance\)/);
  // The page renders current price alone when the target is null.
  const page = read(path.join(FRONTEND, "modules/PricingProfit/PricingProfitPage.tsx"));
  assert.match(page, /item\.recommendedPrice === null/);
  assert.match(page, /Current price \$\$\{item\.currentPrice\.toFixed\(2\)\}/);
});

// ===========================================================================
// A3 — readiness copy derives from the detector's own constants
// ===========================================================================

const { CUSTOMER_LOSS } = require(d("services/customerLossCalc.js"));

test("A3 ROOT CAUSE: the readiness copy no longer carries its own number", () => {
  const src = read(path.join(SRC, "services/explainabilityService.ts"));
  assert.match(
    src,
    /import \{ CUSTOMER_LOSS \} from "\.\/customerLossCalc"/,
    "the surface must import the detector's constants"
  );
  assert.match(
    src,
    /Needs at least \$\{CUSTOMER_LOSS\.minStoreOrders\} synced orders/,
    "the sentence must interpolate the real constant"
  );
  assert.match(
    src,
    /sufficient: orderTotalCount >= CUSTOMER_LOSS\.minStoreOrders/,
    "and the readiness FLAG must use the same constant as the sentence"
  );
  assert.doesNotMatch(
    src,
    /orderTotalCount < 5|orderTotalCount >= 5/,
    "the hardcoded 5 must be gone"
  );
});

test("A3: the real requirement is 50, so the old copy was wrong by 10x", () => {
  assert.equal(CUSTOMER_LOSS.minStoreOrders, 50);
  assert.equal(CUSTOMER_LOSS.minEligibleOrders, 3);
  assert.equal(CUSTOMER_LOSS.minRefundedOrders, 2);
});

test("A3: the THRESHOLD itself is untouched", () => {
  // The instruction was to fix the description, not the detector.
  const calc = read(path.join(SRC, "services/customerLossCalc.ts"));
  assert.match(calc, /minStoreOrders: 50,/);
  assert.match(calc, /minEligibleOrders: 3,/);
  assert.match(calc, /minRefundedOrders: 2,/);
  assert.match(calc, /minObservedLossRatio: 0\.3,/);
});

test("A3: no other active surface carries its own copy of the number", () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      read(full)
        .split(/\r?\n/)
        .forEach((line, index) => {
          const trimmed = line.trim();
          if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
          // A merchant-facing sentence that hardcodes an order count.
          if (/at least \d+ (synced )?(store )?orders?/i.test(line)) {
            offenders.push(`${path.relative(SRC, full)}:${index + 1} ${trimmed}`);
          }
        });
    }
  };
  walk(SRC);
  walk(FRONTEND);
  assert.deepEqual(
    offenders,
    [],
    `these surfaces state an order threshold as a literal:\n${offenders.join("\n")}`
  );
});

test("A3: the staging seed console quotes the constant too", () => {
  const src = read(path.join(SRC, "routes/stagingSeedRoutes.ts"));
  assert.match(src, /\$\{CUSTOMER_LOSS\.minStoreOrders\} store orders/);
});

test("A3: the fraud readiness banner defers to the backend reason", () => {
  // This surface was checked and is CORRECT: it prefers the backend's sentence
  // and its own fallback is deliberately non-numeric, so it cannot drift.
  const src = read(path.join(FRONTEND, "modules/TrustAbuse/fraudReadinessState.ts"));
  assert.match(src, /backendReason \?\?/, "the backend sentence must win");
  const insufficient = src.match(/case "INSUFFICIENT_ACTIVITY":[\s\S]{0,900}?\};/);
  assert.ok(insufficient);
  assert.doesNotMatch(
    insufficient[0],
    /at least \d+/,
    "the fallback must not invent a threshold of its own"
  );
});

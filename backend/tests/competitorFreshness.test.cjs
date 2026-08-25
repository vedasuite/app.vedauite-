const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

/**
 * COMPETITOR EVIDENCE FRESHNESS.
 *
 * PRODUCTION CONTRADICTION: Render logged, repeatedly,
 *   competitor.fetch_snapshot -> TypeError: fetch failed
 *   retry.failure -> competitor.snapshot_fallback
 * for merchant-entered domains including "addidas.com", while Competitor
 * Intelligence reported "The latest analysis reviewed 3 websites, matched 8
 * comparable products, and found 2 competitor changes."
 *
 * The counts were real stored rows. The word "latest" was not.
 */

const calc = require(
  path.resolve(__dirname, "../dist/services/competitorFreshnessCalc.js")
);

const NOW = "2026-08-25T12:00:00.000Z";
const hoursAgo = (h) => new Date(new Date(NOW).getTime() - h * 3_600_000).toISOString();

// ===========================================================================
// The four states must be distinguishable
// ===========================================================================

test("STATE: a domain checked within the window is fresh", () => {
  const d = calc.classifyDomainEvidence({
    domain: "nike.com",
    nowIso: NOW,
    newestCollectedAtIso: hoursAgo(2),
    rowCount: 5,
    lastSyncStartedAtIso: hoursAgo(3),
  });
  assert.equal(d.state, "fresh");
  assert.match(d.message, /checked successfully/i);
});

test("STATE: old-but-successful evidence is stale, not fresh", () => {
  const d = calc.classifyDomainEvidence({
    domain: "nike.com",
    nowIso: NOW,
    newestCollectedAtIso: hoursAgo(96),
    rowCount: 5,
    lastSyncStartedAtIso: hoursAgo(120),
  });
  assert.equal(d.state, "stale");
  assert.match(d.message, /stored data/i);
  assert.doesNotMatch(d.message, /latest analysis/i);
});

test("PROD REPRO: rows exist but the last attempt produced nothing => not_refreshed", () => {
  // Exactly the production case: historical rows plus a failed fetch.
  const d = calc.classifyDomainEvidence({
    domain: "addidas.com",
    nowIso: NOW,
    newestCollectedAtIso: hoursAgo(72),
    rowCount: 8,
    lastSyncStartedAtIso: hoursAgo(1),
  });
  assert.equal(d.state, "not_refreshed");
  assert.match(d.message, /could not be reached on the last check/i);
  assert.match(d.message, /not a fresh analysis/i);
});

test("PROD REPRO: an unreachable domain with no rows is reported clearly", () => {
  const d = calc.classifyDomainEvidence({
    domain: "addidas.com",
    nowIso: NOW,
    newestCollectedAtIso: null,
    rowCount: 0,
    lastSyncStartedAtIso: hoursAgo(1),
  });
  assert.equal(d.state, "never_collected");
  assert.match(d.message, /could not be reached/i);
  assert.match(d.message, /Check the domain and try again/i);
});

test("SAFETY: a merchant-entered domain is never auto-corrected", () => {
  // "addidas.com" is merchant data. It must be echoed exactly, never silently
  // rewritten to "adidas.com".
  for (const rowCount of [0, 8]) {
    const d = calc.classifyDomainEvidence({
      domain: "addidas.com",
      nowIso: NOW,
      newestCollectedAtIso: rowCount ? hoursAgo(72) : null,
      rowCount,
      lastSyncStartedAtIso: hoursAgo(1),
    });
    assert.match(d.message, /addidas\.com/, "the merchant's spelling must be preserved");
    assert.doesNotMatch(d.message, /\badidas\.com/, "must not suggest a corrected domain");
    assert.equal(d.domain, "addidas.com");
  }
});

// ===========================================================================
// The headline claim
// ===========================================================================

test("PROD REPRO: with every domain failing, the headline cannot say 'fresh'", () => {
  const summary = calc.summariseCompetitorEvidence([
    calc.classifyDomainEvidence({
      domain: "addidas.com", nowIso: NOW, newestCollectedAtIso: hoursAgo(72),
      rowCount: 8, lastSyncStartedAtIso: hoursAgo(1),
    }),
    calc.classifyDomainEvidence({
      domain: "b.com", nowIso: NOW, newestCollectedAtIso: null,
      rowCount: 0, lastSyncStartedAtIso: hoursAgo(1),
    }),
  ]);

  assert.equal(summary.freshDomains, 0);
  assert.equal(summary.unreachableDomains, 2);
  assert.equal(summary.allEvidenceStale, true);
  assert.match(summary.headlineQualifier, /stored data/i);
  assert.match(summary.headlineQualifier, /not a fresh analysis/i);
  assert.doesNotMatch(summary.headlineQualifier, /latest analysis/i);
});

test("MIXED: a partial refresh says so rather than implying all are fresh", () => {
  const summary = calc.summariseCompetitorEvidence([
    calc.classifyDomainEvidence({
      domain: "a.com", nowIso: NOW, newestCollectedAtIso: hoursAgo(1),
      rowCount: 3, lastSyncStartedAtIso: hoursAgo(2),
    }),
    calc.classifyDomainEvidence({
      domain: "addidas.com", nowIso: NOW, newestCollectedAtIso: null,
      rowCount: 0, lastSyncStartedAtIso: hoursAgo(2),
    }),
  ]);
  assert.equal(summary.freshDomains, 1);
  assert.match(summary.headlineQualifier, /1 of 2/);
  assert.match(summary.headlineQualifier, /could not be refreshed/i);
});

test("ALL FRESH: the confident wording is still available when earned", () => {
  const summary = calc.summariseCompetitorEvidence([
    calc.classifyDomainEvidence({
      domain: "a.com", nowIso: NOW, newestCollectedAtIso: hoursAgo(1),
      rowCount: 3, lastSyncStartedAtIso: hoursAgo(2),
    }),
  ]);
  assert.match(summary.headlineQualifier, /fresh check of all domains/i);
  assert.equal(summary.allEvidenceStale, false);
});

test("EMPTY: no domains added is not the same as unreachable", () => {
  const summary = calc.summariseCompetitorEvidence([]);
  assert.equal(summary.allEvidenceStale, false);
  assert.match(summary.headlineQualifier, /No competitor domains have been added/i);
});

// ===========================================================================
// No synthetic data
// ===========================================================================

test("SAFETY: a failed fetch returns null and fabricates nothing", () => {
  const admin = fs.readFileSync(
    path.resolve(__dirname, "../src/services/shopifyAdminService.ts"),
    "utf8"
  );
  // Renamed to competitor.fetch_failed in Phase D, and now carries a specific
  // status instead of one undifferentiated fallback line.
  const block = admin.match(/competitor\.fetch_failed[\s\S]{0,300}/);
  assert.ok(block, "the failure path must exist");
  assert.match(block[0], /return null/, "it must return null, never synthetic data");
  assert.match(block[0], /status: outcome\.status/, "and must record WHY it failed");
});

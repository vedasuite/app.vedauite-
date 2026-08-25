const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

/**
 * PHASE J — regressions for what the final repository audit actually found.
 *
 * The audit swept the whole backend and frontend, not only files this
 * programme had touched. Most of what it turned up was already correct. What
 * follows is a test per genuine defect, so none of them can come back quietly.
 *
 * Several are source assertions rather than behavioural ones. That is
 * deliberate: the defect in each case IS the presence of a particular constant
 * or claim in the code, and asserting on the constant is a more direct
 * statement of the rule than reproducing a whole store to observe its effect.
 */

const SRC = path.resolve(__dirname, "../src");
const FRONTEND = path.resolve(__dirname, "../../frontend/src");
const read = (rel) => fs.readFileSync(path.resolve(SRC, rel), "utf8");

/**
 * Source with comment lines stripped.
 *
 * Several of the fixes below carry a comment quoting the constant they
 * removed, because "we used to write `creditScore ?? 55` here" is the most
 * useful thing the next reader can be told. A whole-file regex cannot tell
 * that quotation apart from the real thing, so these assertions run against
 * CODE only.
 */
const codeOnly = (rel) =>
  read(rel)
    .split(/\r?\n/)
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");

// ===========================================================================
// The database default masquerading as an observation
// ===========================================================================

test("J1: a trust score is never reconstructed from a constant baseline", () => {
  // `scoreImpact` is a DELTA. Rebuilding an absolute score from it needs a
  // baseline, and VedaSuite has none for a shopper it never scored — so `60 +
  // scoreImpact` was the missing baseline wearing arithmetic as a disguise.
  // The comment warning about exactly this was already in the file while the
  // code below it still did it.
  const src = codeOnly("services/trustAbuseService.ts");
  assert.doesNotMatch(src, /\b60\s*\+\s*event\.scoreImpact/);
  assert.doesNotMatch(src, /\bMath\.min\(100,\s*60\s*\+/);
});

test("J2: Customer.creditScore's database default is not shown as an observation", () => {
  // The column is `Int @default(50)`, so every customer row has a score whether
  // or not one was ever computed.
  const schema = fs.readFileSync(
    path.resolve(__dirname, "../prisma/schema.prisma"),
    "utf8"
  );
  assert.match(
    schema,
    /creditScore\s+Int\s+@default\(50\)/,
    "if this default ever changes, the guards below need rechecking"
  );

  const src = read("services/trustAbuseService.ts");
  assert.match(
    src,
    /totalOrders\s*>\s*0\s*\|\|\s*customer\.totalRefunds\s*>\s*0/,
    "a score must be treated as observed only when there is activity behind it"
  );
  assert.match(src, /No trust score recorded for this shopper yet/);
});

test("J3: an unscored customer contributes no invented risk to an order", () => {
  const src = codeOnly("services/coreEngineService.ts");
  // The specific fallback that silently added ~4.5 points of "risk" derived
  // from nothing, to a score that sets the High / Medium / Low badge.
  assert.doesNotMatch(src, /creditScore\s*\?\?\s*55/);
  // And the replacement must REDISTRIBUTE the weight rather than drop it,
  // otherwise an unscored customer scores lower — i.e. looks safer — than a
  // well-scored one, which is the same fabrication pointing the other way.
  assert.match(src, /trustObserved/);
  assert.match(src, /rescale/);
});

test("J4: no delta is recorded against a baseline that was never observed", () => {
  const src = codeOnly("services/coreEngineService.ts");
  assert.doesNotMatch(src, /creditScore\s*\?\?\s*50/);
  assert.match(src, /scoreImpact:\s*\r?\n?\s*customer\.totalOrders\s*>\s*0/);
});

// ===========================================================================
// Confidence that was never measured
// ===========================================================================

test("J5: an unmatched competitor catalog row cannot carry medium confidence", () => {
  // "medium" is the exact threshold at which computeCompetitorImpact becomes
  // willing to state money, and these rows say in their own matchReason that
  // no Shopify product match was found.
  const src = codeOnly("services/competitorService.ts");
  assert.doesNotMatch(src, /confidenceScore:\s*64/);

  const observations = src.match(/catalogObservation:\s*true/g) ?? [];
  assert.equal(observations.length, 2, "both catalog ingestion paths must be present");
  const basis =
    src.match(/confidenceBasis:\s*"catalog_observation_without_product_match"/g) ?? [];
  assert.equal(basis.length, 2, "each must record WHY its confidence is low");
  assert.ok((src.match(/confidenceLabel:\s*"low"/g) ?? []).length >= 2);
});

test("J6: standing policy guidance carries no invented confidence percentage", () => {
  // 86 / 71 / 91 were fixed percentages attached to fixed advice. A merchant
  // reads that as a measured certainty about their own store.
  const src = codeOnly("services/creditScoreService.ts");
  assert.doesNotMatch(src, /confidence:\s*(?:86|71|91)\s*,/);
  assert.match(src, /not a measurement of your store/);
});

test("J7: the credit score's model origin is documented as an origin", () => {
  // Audited and KEPT. Unlike every constant this programme removed, this one
  // does not stand in for an unobservable fact: it is the origin of a scale
  // that is then moved entirely by observed inputs, and the output is openly a
  // VedaSuite score rather than a measurement of the merchant's store.
  const src = read("services/creditScoreService.ts");
  assert.match(src, /MODEL ORIGIN, not an observation/);
  assert.match(src, /const base = 70;/);
});

// ===========================================================================
// Claims that did not follow the numbers
// ===========================================================================

test("J8: a competitor comparison states the direction it actually measured", () => {
  // This asserted "a tracked competitor is priced below your product"
  // unconditionally — including when the merchant was the cheaper of the two.
  const src = read("services/explainabilityService.ts");
  assert.match(src, /priced at or above your product/);
  assert.match(src, /competitorIsCheaper/);
});

test("J9: a competitor row with no comparable price is skipped, not zero-filled", () => {
  const src = codeOnly("services/explainabilityService.ts");
  // `ourPrice ?? 0` was safe only because a second parameter happened to carry
  // the same value and was checked first.
  assert.doesNotMatch(src, /ourPrice:\s*ourPrice\s*\?\?\s*0/);
  // The guard is real code; its explanation is a comment, so this half reads
  // the unfiltered file.
  assert.match(src, /if \(ourPrice == null \|\| !\(ourPrice > 0\)\)/);
  assert.match(
    read("services/explainabilityService.ts"),
    /No selling price means no gap to measure/
  );
});

// ===========================================================================
// Positioning: the labels a merchant actually reads
// ===========================================================================

test("J10: no backend merchant-facing string uses a retired module name", () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith(".ts")) continue;
      const text = fs.readFileSync(full, "utf8");
      text.split(/\r?\n/).forEach((line, i) => {
        // Comments are exempt: several deliberately quote the old names to
        // record what the defect was.
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
        if (/AI Pricing Engine|Fraud Intelligence|Competitor Intelligence/.test(line)) {
          offenders.push(`${path.relative(SRC, full)}:${i + 1}`);
        }
      });
    }
  };
  walk(SRC);
  assert.deepEqual(offenders, [], `retired module names still shipped:\n${offenders.join("\n")}`);
});

test("J11: no frontend merchant-facing string uses a retired module name", () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(tsx?|jsx?)$/.test(entry.name)) continue;
      const text = fs.readFileSync(full, "utf8");
      text.split(/\r?\n/).forEach((line, i) => {
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
        if (/AI Pricing Engine|Fraud Intelligence|Competitor Intelligence/.test(line)) {
          offenders.push(`${path.relative(FRONTEND, full)}:${i + 1}`);
        }
      });
    }
  };
  walk(FRONTEND);
  assert.deepEqual(offenders, [], `retired module names still shipped:\n${offenders.join("\n")}`);
});

test("J12: the unreachable frontend modules are gone", () => {
  // Five whole modules and four Dashboard components were routed by nothing and
  // imported by nothing. They were not capabilities — a merchant could not
  // reach any of them — but they were the largest remaining store of
  // merchant-facing copy nobody was maintaining, including a "Wardrobing
  // Detection AI" heading and a chargeback-exposure claim the data model
  // cannot support.
  // Asserted on FILES, not directories: git does not track empty directories,
  // so a leftover empty folder in one working tree would fail this everywhere
  // else for no reason.
  for (const dead of [
    "modules/CreditScore/CreditScorePage.tsx",
    "modules/FraudIntelligence/FraudPage.tsx",
    "modules/PricingStrategy/PricingPage.tsx",
    "modules/ProfitOptimization/ProfitPage.tsx",
    "modules/Reports/ReportsPage.tsx",
    "modules/Dashboard/components/ExecutiveHero.tsx",
    "modules/Dashboard/components/WhereToFocusToday.tsx",
    "modules/Dashboard/components/CriticalAttentionLane.tsx",
    "modules/Dashboard/components/RevenueLeakDetector.tsx",
  ]) {
    assert.equal(
      fs.existsSync(path.resolve(FRONTEND, dead)),
      false,
      `${dead} is unreachable and must not be shipped`
    );
  }
});

test("J13: the dead store-level money and confidence helpers are gone", () => {
  // Dead code that computes a store-wide money total and something called "AI
  // confidence" is an invitation to reintroduce the contradiction Phase F/G
  // just removed.
  const src = fs.readFileSync(path.resolve(FRONTEND, "lib/executiveMetrics.ts"), "utf8");
  for (const gone of [
    "potentialMonthlyRevenue",
    "aiConfidence",
    "expectedReturn",
    "biggestOpportunity",
    "biggestRisk",
    "recommendedModule",
  ]) {
    assert.doesNotMatch(
      src,
      new RegExp(`export function ${gone}\\b`),
      `${gone} fed a removed surface and must not remain`
    );
  }
  // What stays is presentation only.
  assert.match(src, /export function effortFor/);
  assert.match(src, /export function urgencyMix/);
});

// ===========================================================================
// PRODUCT-CONSISTENCY PASS — merchant-facing vocabulary
// ===========================================================================

/**
 * Walks source files and returns offending lines, ignoring comments.
 *
 * Comments are exempt throughout this file because several deliberately quote
 * the old wording to record what the defect was.
 */
function scanForMerchantText(root, pattern, extensions) {
  const fs = require("node:fs");
  const hits = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!extensions.some((ext) => entry.name.endsWith(ext))) continue;
      fs.readFileSync(full, "utf8")
        .split(/\r?\n/)
        .forEach((line, i) => {
          const t = line.trim();
          if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return;
          if (pattern.test(line)) hits.push(`${path.relative(root, full)}:${i + 1}`);
        });
    }
  };
  walk(root);
  return hits;
}

test("P1: no merchant-facing string calls the overview a Dashboard", () => {
  // A merchant clicking "Store Overview" must not land on a page that calls
  // itself a Dashboard, and must not be told to "open the dashboard" anywhere.
  //
  // Internal identifiers are exempt and stay: the /app/dashboard route, the
  // /api/dashboard/* endpoints, DashboardPage, DashboardState, dashboardService
  // and every other symbol. Renaming those would be a cosmetic change with real
  // risk — stored finding snapshots point at /app/dashboard — for no merchant
  // benefit.
  // Prose only. A route or endpoint path is an identifier, not something a
  // merchant reads, so "/app/dashboard" and "/api/dashboard" are excluded by
  // requiring a space or sentence character next to the word.
  // Matching inside the quoted string rather than around it: a leading "/" or
  // a trailing "/" or "-" is what distinguishes an identifier
  // ("/app/dashboard", "dashboard-overview") from prose ("Loading dashboard").
  const WORD_IN_PROSE = /(^|[^/\w-])[Dd]ashboard(?![\w/-])/;
  const merchantPhrase = {
    test: (line) =>
      (line.match(/"([^"]*)"/g) ?? []).some((quoted) =>
        WORD_IN_PROSE.test(quoted.slice(1, -1))
      ),
  };

  const backendHits = scanForMerchantText(
    path.resolve(__dirname, "../src"),
    merchantPhrase,
    [".ts"]
    // shopifyAdminService, launchRoutes and publicRoutes legitimately reference
    // Shopify's own product, the "Partner Dashboard".
  ).filter((hit) => !/shopifyAdminService|launchRoutes|publicRoutes/.test(hit));
  assert.deepEqual(
    backendHits,
    [],
    `backend merchant copy still says Dashboard:\n${backendHits.join("\n")}`
  );

  const frontendHits = scanForMerchantText(FRONTEND, merchantPhrase, [".tsx", ".ts"]);
  assert.deepEqual(
    frontendHits,
    [],
    `frontend merchant copy still says Dashboard:\n${frontendHits.join("\n")}`
  );
});

test("P2: the five workspace names are the merchant-facing vocabulary", async () => {
  const { pathToFileURL } = require("node:url");
  const navUrl = pathToFileURL(
    path.resolve(__dirname, "../../frontend/src/layout/navigationModel.js")
  ).href;
  const { buildNavigationModel } = await import(navUrl);
  const labels = buildNavigationModel({
    fraud: true,
    competitor: true,
    pricing: true,
  }).map((e) => e.label);

  for (const required of [
    "Action Center",
    "Store Overview",
    "Customer Loss",
    "Pricing & Product Profit",
    "Market Signals",
  ]) {
    assert.ok(labels.includes(required), `"${required}" must appear in the navigation`);
  }
  // And the old vocabulary must be gone from it entirely.
  for (const label of labels) {
    assert.doesNotMatch(label, /^Dashboard$/);
    assert.doesNotMatch(label, /Fraud|Competitor Intelligence|AI/i);
  }
});

test("P3: coverage rows are labelled by workspace, not by internal module key", () => {
  const fs = require("node:fs");
  const src = fs.readFileSync(
    path.resolve(FRONTEND, "lib/insightsTypes.ts"),
    "utf8"
  );
  // Every label must lead with one of the five family names, so the page that
  // summarises the new product does not reintroduce the old vocabulary.
  const block = src.match(/export const MODULE_LABEL[\s\S]*?\};/);
  assert.ok(block, "MODULE_LABEL must exist");
  const labels = [...block[0].matchAll(/:\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.equal(labels.length, 7, "all seven internal modules must still be mapped");
  for (const label of labels) {
    assert.match(
      label,
      /^(Customer Loss|Market Signals|Pricing & Product Profit|Store Health)/,
      `"${label}" must lead with a workspace name`
    );
  }
  // The KEYS are entitlement-adjacent identifiers and must not have moved.
  for (const key of [
    "fraud",
    "trust",
    "return_abuse",
    "competitor",
    "pricing",
    "profit",
    "operational",
  ]) {
    // `\\b` deliberately: a single backslash here is a backspace character,
    // not a word boundary, and the assertion then fails for every key.
    assert.match(block[0], new RegExp(`\\b${key}:`), `${key} key must remain`);
  }
});

test("P4: Customer Loss is not described as a fraud module", () => {
  const fs = require("node:fs");
  const offenders = [];
  for (const rel of [
    "modules/TrustAbuse/TrustAbusePage.tsx",
    "modules/TrustAbuse/fraudReadinessState.ts",
  ]) {
    fs.readFileSync(path.resolve(FRONTEND, rel), "utf8")
      .split(/\r?\n/)
      .forEach((line, i) => {
        const t = line.trim();
        if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return;
        // Only merchant-visible strings. Identifiers such as fraudBannerFor,
        // fraudReviewQueue and the `fraud` entitlement key are internal and stay.
        const strings = line.match(/"[^"]{12,}"/g) ?? [];
        for (const s of strings) {
          if (/\bfraud (reviews?|data|intelligence|analysis|checks?|protection)\b/i.test(s)) {
            offenders.push(`${rel}:${i + 1} ${s.slice(0, 60)}`);
          }
        }
      });
  }
  assert.deepEqual(
    offenders,
    [],
    `Customer Loss must be about customer loss, not framed as a fraud module:\n${offenders.join("\n")}`
  );
});

test("P5: empty states say what is missing, not just that something is", () => {
  const fs = require("node:fs");
  // "More store activity is needed" is the placeholder this pass removed: it
  // does not tell the merchant whether VedaSuite wants more orders, more
  // refunds, product cost, a competitor domain, or simply more time.
  const hits = scanForMerchantText(
    path.resolve(__dirname, "../src"),
    /More store activity is needed/,
    [".ts"]
  );
  assert.deepEqual(
    hits,
    [],
    `generic empty-state copy still shipped:\n${hits.join("\n")}`
  );
});

test("P6: one pricing card carries one confidence verdict", () => {
  // The card used to show an evidence label AND a separately-derived confidence
  // label built from different inputs, so a product with observed cost and
  // velocity but no competitor match read as "Profit-informed" and "Baseline
  // estimate" at the same time.
  const src = codeOnly("services/pricingProfitService.ts");
  assert.match(
    src,
    /evidenceBasis:\s*evidence\.basis/,
    "confidence must derive from the same evidence classification as the label"
  );
  assert.doesNotMatch(src, /return "Baseline estimate";/);
  // And the store-level hedge on a per-item figure is gone.
  assert.doesNotMatch(src, /Baseline estimated gain/);
});

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

process.env.SHOPIFY_API_KEY ||= "test-key";
process.env.SHOPIFY_API_SECRET ||= "test-secret";
process.env.SHOPIFY_APP_URL ||= "https://app.vedasuite.in";
process.env.DATABASE_URL ||= "postgresql://example:example@localhost:5432/example";

/**
 * ONE FACT, ONE NUMBER, ONE NOUN.
 *
 * THE DEFECT
 * ----------
 * Store Overview showed, on two lines touching each other:
 *
 *     1 finding needs attention
 *     Open findings: 3
 *
 * while Reconciliation and Action Center both showed 3.
 *
 * Neither number was wrong. The title counted `criticalOrHigh` and the detail
 * counted `totalOpen` — two different quantities, both rendered with the word
 * "finding", stacked with nothing to say they measured different things. To
 * anyone who has not read dashboardFindingsCalc.ts that is a contradiction, and
 * the headline number disagreed with every other surface.
 *
 * The headline now always states the canonical total. Priority is a QUALIFIER
 * inside the detail, never a second count competing with it.
 *
 * These tests fix that as a property rather than as copy: whatever the mix of
 * severities and modules, the number a merchant reads in the headline is the
 * number every other surface shows.
 */

const d = (p) => path.resolve(__dirname, `../dist/${p}`);
const calc = require(d("services/dashboardFindingsCalc.js"));
const model = require(d("services/moduleStateModel.js"));

function card(overrides = {}) {
  return {
    id: "c1",
    module: "reconciliation",
    status: "new",
    severity: "medium",
    title: "A finding",
    whatHappened: "something",
    recommendedAction: "do something",
    route: "/app/reconciliation",
    lastSeenAt: "2026-08-26T12:00:00.000Z",
    rank: { score: 50 },
    ...overrides,
  };
}

/** Every number a merchant can read in the headline band. */
function numbersIn(text) {
  return (text.match(/\d+/g) ?? []).map(Number);
}

test("INVARIANT: the headline number is always the canonical total", () => {
  const severities = ["critical", "high", "medium", "low"];
  const modules = ["reconciliation", "fraud", "operational", "pricing", "competitor"];

  // Every mix of 1..4 cards across severities and modules.
  for (const sev of severities) {
    for (const mod of modules) {
      for (const extra of [0, 1, 2, 3]) {
        const cards = [
          card({ id: "a", severity: sev, module: mod }),
          ...Array.from({ length: extra }, (_, i) =>
            card({ id: `b${i}`, severity: severities[i % severities.length], module: mod })
          ),
        ];
        const view = calc.buildDashboardFindingsView({
          cards,
          persistenceEnabled: true,
          enabledModules: ["fraud", "competitor", "pricing", "profit"],
        });

        const headlineNumbers = numbersIn(view.attentionTitle);
        assert.deepEqual(
          headlineNumbers,
          [view.totalOpen],
          `title "${view.attentionTitle}" must state exactly the total (${view.totalOpen}) — ` +
            `severity=${sev} module=${mod} count=${cards.length}`
        );
      }
    }
  }
});

test("REGRESSION: 3 findings with 1 high never reads as '1 finding needs attention'", () => {
  // The exact staging shape: SKU-A high, SKU-C and SKU-D medium.
  const view = calc.buildDashboardFindingsView({
    cards: [
      card({ id: "a", severity: "high", title: "SKU-A quantity mismatch" }),
      card({ id: "b", severity: "medium", title: "SKU-C missing from file" }),
      card({ id: "c", severity: "medium", title: "SKU-D not in Shopify" }),
    ],
    persistenceEnabled: true,
    enabledModules: [],
  });

  assert.equal(view.totalOpen, 3);
  assert.equal(view.kpis.reconciliation, 3);
  assert.equal(view.attentionTitle, "3 open findings");
  // The priority fact survives — as a qualifier, not a rival count.
  assert.match(view.attentionDetail, /1 of them is high priority/i);
  assert.ok(
    !/Open findings: \d+/.test(view.attentionDetail),
    "the detail must not restate the total as a second number"
  );
});

test("the priority qualifier is accurate, not decorative", () => {
  const view = calc.buildDashboardFindingsView({
    cards: [
      card({ id: "a", severity: "critical" }),
      card({ id: "b", severity: "high" }),
      card({ id: "c", severity: "low" }),
    ],
    persistenceEnabled: true,
    enabledModules: [],
  });
  assert.equal(view.attentionTitle, "3 open findings");
  assert.match(view.attentionDetail, /2 of them are high priority/i);
});

test("all-high says so rather than restating the total", () => {
  const view = calc.buildDashboardFindingsView({
    cards: [card({ id: "a", severity: "high" }), card({ id: "b", severity: "critical" })],
    persistenceEnabled: true,
    enabledModules: [],
  });
  assert.equal(view.attentionTitle, "2 open findings");
  assert.match(view.attentionDetail, /All of them are high priority/i);
});

test("store health still leads, without owning the headline number", () => {
  const view = calc.buildDashboardFindingsView({
    cards: [
      card({ id: "a", module: "operational", severity: "critical" }),
      card({ id: "b", module: "pricing", severity: "high" }),
    ],
    persistenceEnabled: true,
    enabledModules: ["pricing"],
  });
  assert.equal(view.attentionTitle, "2 open findings");
  assert.match(view.attentionDetail, /store health issue/i);
  assert.match(view.attentionDetail, /resolve those first/i);
});

test("VOCABULARY: findings are called findings everywhere a merchant reads them", () => {
  // "items to review" is the REVIEW_ITEM level — orders that have not yet
  // become a finding. Using it for findings collides two different concepts in
  // the merchant's head, which is how "0 open findings / 4 to review" became
  // confusing in the first place.
  const vocab = require(d("services/findingVocabulary.js"));
  assert.equal(vocab.EVIDENCE_LABEL.finding.one, "finding");
  assert.equal(vocab.EVIDENCE_LABEL.finding.many, "findings");
  assert.equal(vocab.EVIDENCE_LABEL.review_item.many, "orders to review");

  const src = fs.readFileSync(
    path.resolve(__dirname, "../src/services/moduleStateModel.ts"),
    "utf8"
  );
  const code = src
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");

  assert.ok(
    !/items? to review/.test(code),
    "findings must not borrow the review-item vocabulary"
  );
  assert.ok(
    !/items? needs? your attention/.test(code),
    "the global headline must count findings, not unnamed 'items'"
  );
});

test("VOCABULARY: a module with findings never reports finding nothing", () => {
  // Already covered per-module elsewhere; asserted here as a property over
  // every module and every non-zero count, since this is the contradiction
  // merchants noticed most.
  const evidence = {
    authFailed: false,
    syncFailed: false,
    syncPartial: false,
    neverSynced: false,
    products: 10,
    variantsWithSku: 10,
    orders: 100,
    eligibleOrders: 100,
    customers: 20,
    competitorDomainsConfigured: 2,
    competitorRowsFresh: 2,
    priceRows: 5,
    profitRowsWithObservedCost: 5,
    reconciliationRuns: 1,
  };
  const entitlements = {
    customerLoss: true,
    pricing: true,
    productProfit: true,
    marketSignals: true,
    reconciliation: true,
  };

  for (const mod of ["customerLoss", "pricing", "productProfit", "marketSignals", "reconciliation"]) {
    for (const count of [1, 3]) {
      const states = model.deriveModuleStates({
        evidence,
        entitlements,
        thresholds: { customerLossMinOrders: 50 },
        findingCounts: { [mod]: count },
      });
      const state = states.find((s) => s.module === mod);
      assert.equal(state.findingCount, count);
      assert.ok(
        !/found nothing/.test(state.reason),
        `${mod} holds ${count} findings but its reason says it found nothing: "${state.reason}"`
      );
      assert.match(
        state.reason,
        new RegExp(`found ${count} open finding`),
        `${mod} must state its count with the canonical noun`
      );
    }
  }
});

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

process.env.SHOPIFY_API_KEY ||= "test-key";
process.env.SHOPIFY_API_SECRET ||= "test-secret";
process.env.SHOPIFY_APP_URL ||= "https://app.vedasuite.in";
process.env.DATABASE_URL ||= "postgresql://example:example@localhost:5432/example";

/**
 * "RECONCILIATION RAN AND FOUND NOTHING" — WHILE IT HELD AN OPEN FINDING.
 *
 * THE DEFECT
 * ----------
 * Staging showed, at the same moment:
 *
 *   Reconciliation ... 3 differences, 1 open reconciliation finding
 *   Action Center .... 1 open finding
 *   Store Overview ... "Reconciliation ran and found nothing."
 *
 * The store had 0 products and 75 orders, so `syncPartial` was true and every
 * module that ran was PARTIAL_DATA. `deriveGlobalHealth` then selected the
 * modules to report as:
 *
 *     const withFindings = expected.filter((s) => s.state === "READY_WITH_FINDINGS");
 *
 * A module running on a partial sync is PARTIAL_DATA whatever it found, so
 * reconciliation — carrying findingCount 1 — was excluded from `withFindings`,
 * skipped the ATTENTION_REQUIRED branch entirely, and was then named in the
 * PARTIAL branch's "… ran and found nothing".
 *
 * One dimension standing in for another: how COMPLETE the data was decided
 * whether anything was FOUND. They are independent, and the finding count is
 * the authority on the second.
 */

const d = (p) => path.resolve(__dirname, `../dist/${p}`);
const model = require(d("services/moduleStateModel.js"));

/** Staging exactly: no products, plenty of orders, one reconciliation file run. */
const STAGING_EVIDENCE = {
  authFailed: false,
  syncFailed: false,
  // 0 products + 75 orders + 12 customers => one Shopify dimension absent.
  syncPartial: true,
  neverSynced: false,
  products: 0,
  variantsWithSku: 0,
  orders: 75,
  eligibleOrders: 75,
  customers: 12,
  competitorDomainsConfigured: 0,
  competitorRowsFresh: 0,
  priceRows: 0,
  profitRowsWithObservedCost: 0,
  reconciliationRuns: 1,
};

const GROWTH_ENTITLEMENTS = {
  customerLoss: true,
  pricing: true,
  productProfit: true,
  marketSignals: true,
  reconciliation: true,
};

function derive(findingCounts) {
  return model.deriveModuleStates({
    evidence: STAGING_EVIDENCE,
    entitlements: GROWTH_ENTITLEMENTS,
    thresholds: { customerLossMinOrders: 50 },
    findingCounts,
  });
}

test("REGRESSION: a partial-data module with a finding is never called empty", () => {
  const states = derive({ reconciliation: 1 });
  const health = model.deriveGlobalHealth(states);

  const recon = states.find((s) => s.module === "reconciliation");
  assert.equal(recon.state, "PARTIAL_DATA", "the sync really was partial");
  assert.equal(recon.findingCount, 1, "and it really did find something");

  // The sentence that was wrong.
  assert.ok(
    !/Reconciliation ran and found nothing/.test(health.headline),
    `Store Overview still says Reconciliation found nothing: "${health.headline}"`
  );
  assert.ok(
    !health.headline.includes("found nothing") ||
      !health.headline.includes("Reconciliation"),
    `"found nothing" must not name Reconciliation: "${health.headline}"`
  );
});

test("REGRESSION: one open finding makes the store need attention", () => {
  const health = model.deriveGlobalHealth(derive({ reconciliation: 1 }));

  assert.equal(
    health.health,
    "ATTENTION_REQUIRED",
    "a store holding an open finding is not PARTIAL-and-fine"
  );
  assert.match(health.headline, /1 open finding needs your attention/);
  assert.match(health.headline, /Reconciliation/);
});

test("the count Store Overview shows equals the count Reconciliation holds", () => {
  for (const count of [1, 2, 5]) {
    const states = derive({ reconciliation: count });
    const health = model.deriveGlobalHealth(states);
    const recon = states.find((s) => s.module === "reconciliation");

    assert.equal(recon.findingCount, count);
    // The Store Overview total is the sum over modules that found something.
    const total = states
      .filter((s) => s.findingCount > 0)
      .reduce((sum, s) => sum + s.findingCount, 0);
    assert.equal(total, count, `Store Overview total must be ${count}`);
    assert.match(
      health.headline,
      new RegExp(`${count} open findings? needs? your attention`)
    );
  }
});

test("incomplete data is still disclosed, not hidden by the finding", () => {
  const states = derive({ reconciliation: 1 });
  const recon = states.find((s) => s.module === "reconciliation");

  // The finding leads, and the incompleteness qualifies it. Neither is dropped.
  assert.match(recon.reason, /found 1 open finding/);
  assert.match(recon.reason, /did not deliver all of your Shopify data/);
});

test("a partial module that genuinely found nothing still says so", () => {
  const states = derive({});
  const health = model.deriveGlobalHealth(states);
  const recon = states.find((s) => s.module === "reconciliation");

  assert.equal(recon.findingCount, 0);
  assert.equal(health.health, "PARTIAL");
  // ...and the headline must disclose that the data was incomplete rather than
  // presenting a partial pass as a clean one.
  assert.match(health.headline, /incomplete Shopify data/);
});

test("no module is ever described as having found nothing while holding findings", () => {
  // Property, not example: for every module and every state that counts as
  // having run, a non-zero finding count must never land in the empty clause.
  const MODULES = ["customerLoss", "pricing", "productProfit", "marketSignals", "reconciliation"];

  for (const target of MODULES) {
    const health = model.deriveGlobalHealth(derive({ [target]: 3 }));
    const emptyClause = health.headline.split("ran and found nothing")[0];
    if (health.headline.includes("ran and found nothing")) {
      const label = {
        customerLoss: "Customer Loss",
        pricing: "Pricing",
        productProfit: "Product Profit",
        marketSignals: "Market Signals",
        reconciliation: "Reconciliation",
      }[target];
      assert.ok(
        !emptyClause.includes(label),
        `${label} holds 3 findings but is named in "ran and found nothing": "${health.headline}"`
      );
    }
  }
});

test("HEALTHY is unreachable while any module holds a finding", () => {
  for (const target of ["customerLoss", "reconciliation", "marketSignals"]) {
    const health = model.deriveGlobalHealth(derive({ [target]: 1 }));
    assert.notEqual(
      health.health,
      "HEALTHY",
      `${target} holds a finding, so the store is not healthy`
    );
  }
});

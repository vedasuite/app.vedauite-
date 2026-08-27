const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

process.env.SHOPIFY_API_KEY ||= "test-key";
process.env.SHOPIFY_API_SECRET ||= "test-secret";
process.env.SHOPIFY_APP_URL ||= "https://vedasuite-staging.onrender.com";
process.env.SHOPIFY_ADMIN_API_VERSION ||= "2026-01";
process.env.DATABASE_URL ||= "postgresql://example:example@localhost:5432/example";
// recordFinding is gated on this flag; Scenario 4 is about what it writes.
process.env.ENABLE_INTELLIGENCE_FINDING_PERSISTENCE = "true";

/**
 * THE FOUR ACCEPTANCE SCENARIOS, run end to end against controlled fixtures.
 *
 * Scenarios 1-3 exercise the real engine from a real CSV. Scenario 4 exercises
 * the persistence path with a Prisma double, because the property under test —
 * that re-running the same discrepancy reconfirms one finding instead of
 * minting a second — lives in the database write, not in the pure calculation.
 */

const d = (p) => path.resolve(__dirname, `../dist/${p}`);
const parsing = require(d("services/spreadsheetParsing.js"));
const mappingCalc = require(d("services/columnMapping.js"));
const importCalc = require(d("services/reconciliationImportCalc.js"));
const checks = require(d("services/reconciliationChecks.js"));
const findingCalc = require(d("services/reconciliationFindingCalc.js"));
const { computeFindingFingerprint } = require(d("services/intelligenceFindingService.js"));

const NOW = "2026-08-26T12:00:00.000Z";

/** Runs a CSV through parse -> suggest -> map -> validate -> check. */
function reconcileFromCsv(input) {
  const parsed = parsing.parseSpreadsheet({
    fileName: input.fileName,
    buffer: Buffer.from(input.csv, "utf8"),
  });

  const proposal = mappingCalc.suggestMapping({
    checkType: input.checkType,
    headers: parsed.headers,
    sampleRows: parsed.rows.slice(0, 25),
  });

  // Whatever the merchant would confirm. Confident suggestions carry through;
  // the test supplies the rest explicitly, exactly as a merchant would.
  const mapping = { ...(input.mapping ?? {}) };
  for (const suggestion of proposal.suggestions) {
    if (
      suggestion.confidence === "confident" &&
      suggestion.suggestedHeader &&
      !mapping[suggestion.field]
    ) {
      mapping[suggestion.field] = suggestion.suggestedHeader;
    }
  }

  const validation = mappingCalc.validateMapping({
    checkType: input.checkType,
    headers: parsed.headers,
    mapping,
  });
  assert.equal(validation.ok, true, `mapping rejected: ${validation.message}`);

  const preview = importCalc.buildImportPreview({
    checkType: input.checkType,
    headers: parsed.headers,
    rows: parsed.rows,
    mapping,
  });

  const external = preview.rows
    .filter((row) => !row.invalidReason)
    .map((row) => ({ ...row }));

  const result = checks.runCheck({
    checkType: input.checkType,
    shopifyInventory: input.shopifyInventory ?? [],
    shopifyOrders: input.shopifyOrders ?? [],
    external,
    nowIso: NOW,
  });

  return { parsed, proposal, mapping, preview, result };
}

const variant = (sku, inventoryQuantity) => ({
  sku,
  inventoryQuantity,
  productHandle: `handle-${sku.toLowerCase()}`,
  variantTitle: sku,
  unitCost: null,
  currency: null,
});

// ===========================================================================
// SCENARIO 1 — INVENTORY
//
//   Shopify:   SKU-A = 20, SKU-B = 8, SKU-C = 5
//   Warehouse: SKU-A = 13, SKU-B = 8, SKU-D = 4
//
//   SKU-A -> mismatch of 7
//   SKU-B -> no finding
//   SKU-C -> missing externally
//   SKU-D -> unmatched / external-only
//   and NO fabricated financial impact.
// ===========================================================================

const SCENARIO_1 = {
  fileName: "warehouse-stock.csv",
  checkType: "inventory",
  csv: ["Item SKU,Available", "SKU-A,13", "SKU-B,8", "SKU-D,4"].join("\n"),
  shopifyInventory: [variant("SKU-A", 20), variant("SKU-B", 8), variant("SKU-C", 5)],
};

test("SCENARIO 1: the mapping is detected without the merchant being asked", () => {
  const { proposal } = reconcileFromCsv(SCENARIO_1);
  assert.equal(proposal.needsConfirmation, false, '"Item SKU" and "Available" are unambiguous');
});

test("SCENARIO 1: SKU-A shows a mismatch of exactly 7", () => {
  const { result } = reconcileFromCsv(SCENARIO_1);
  const mismatch = result.discrepancies.find(
    (item) =>
      item.kind === checks.INVENTORY_KINDS.quantityMismatch && item.subjectKey === "sku-a"
  );
  assert.ok(mismatch, "SKU-A must be reported");
  assert.equal(mismatch.difference, -7);
  assert.equal(mismatch.shopifyValue, "20");
  assert.equal(mismatch.externalValue, "13");
  assert.equal(mismatch.certainty, "confirmed");
  assert.equal(mismatch.matchConfidence, "exact");
});

test("SCENARIO 1: SKU-B produces NO finding of any kind", () => {
  const { result } = reconcileFromCsv(SCENARIO_1);
  const forSkuB = result.discrepancies.filter((item) => item.subjectKey === "sku-b");
  assert.deepEqual(forSkuB, [], "agreement must be silent");
});

test("SCENARIO 1: SKU-C is reported as missing externally", () => {
  const { result } = reconcileFromCsv(SCENARIO_1);
  const found = result.discrepancies.find((item) => item.subjectKey === "sku-c");
  assert.ok(found);
  assert.equal(found.kind, checks.INVENTORY_KINDS.missingExternally);
  assert.equal(found.matchConfidence, "unmatched");
  assert.equal(found.shopifyValue, "5");
  assert.equal(found.externalValue, null);
});

test("SCENARIO 1: SKU-D is reported as external-only", () => {
  const { result } = reconcileFromCsv(SCENARIO_1);
  const found = result.discrepancies.find((item) => item.subjectKey === "sku-d");
  assert.ok(found);
  assert.equal(found.kind, checks.INVENTORY_KINDS.externalOnly);
  assert.equal(found.matchConfidence, "unmatched");
  assert.equal(found.externalValue, "4");
  assert.equal(found.shopifyValue, null);
});

test("SCENARIO 1: NOT ONE discrepancy carries a fabricated financial impact", () => {
  // No cost column, and Shopify sends no product cost. Every impact must be
  // an explicit refusal with a reason, not a zero and not a guess.
  const { result } = reconcileFromCsv(SCENARIO_1);
  assert.ok(result.discrepancies.length >= 3);
  for (const discrepancy of result.discrepancies) {
    assert.equal(
      discrepancy.impact.status,
      "not_quantified",
      `${discrepancy.subjectKey} invented a value`
    );
    assert.ok(discrepancy.impact.reason.length > 20, "and must say why");
    assert.equal(discrepancy.impact.amount, undefined);
  }

  // The grouped findings must not invent one either.
  const findings = findingCalc.buildReconciliationFindings({
    checkType: "inventory",
    discrepancies: result.discrepancies,
  });
  for (const finding of findings) {
    assert.equal(finding.financialImpact.status, "impact_not_quantifiable");
  }
});

test("SCENARIO 1: exactly three subjects are reported, and B is not one", () => {
  const { result } = reconcileFromCsv(SCENARIO_1);
  const subjects = [...new Set(result.discrepancies.map((item) => item.subjectKey))].sort();
  assert.deepEqual(subjects, ["sku-a", "sku-c", "sku-d"]);
});

// ===========================================================================
// SCENARIO 2 — 3PL
//
//   Shopify order exists, expected/reference charge = $8, 3PL bills $11.
//   -> difference = $3 with evidence.
//   WITHOUT a reference rate, $11 must NOT be called an overcharge.
// ===========================================================================

const SHOPIFY_ORDER = {
  orderRef: "#1042",
  status: "paid",
  refunded: false,
  currency: "USD",
  totalAmount: 120,
  createdAtIso: "2026-08-10T00:00:00.000Z",
};

test("SCENARIO 2: with a reference rate, the $3 difference is stated with evidence", () => {
  const { result } = reconcileFromCsv({
    fileName: "3pl-invoice.csv",
    checkType: "3pl_invoice",
    csv: ["Order Number,Amount,Expected Rate,Currency", "1042,11.00,8.00,USD"].join("\n"),
    shopifyOrders: [SHOPIFY_ORDER],
  });

  const found = result.discrepancies.find(
    (item) => item.kind === checks.INVOICE_KINDS.amountDifference
  );
  assert.ok(found, "the difference must be reported");
  assert.equal(found.difference, 3);
  assert.equal(found.impact.status, "quantified");
  assert.equal(found.impact.amount, 3);
  assert.equal(found.impact.currency, "USD");

  // The evidence names both figures and the merchant's own row.
  const labels = Object.fromEntries(found.evidence.map((e) => [e.label, e.value]));
  assert.equal(labels["Billed"], "11");
  assert.equal(labels["Expected rate you supplied"], "8");
  assert.equal(labels["Difference"], "+3");
  assert.equal(labels["Row in your file"], "2");
  assert.match(labels["Matched on"], /order 1042/);
});

test("SCENARIO 2: WITHOUT a reference rate, $11 is never called an overcharge", () => {
  const { result } = reconcileFromCsv({
    fileName: "3pl-invoice.csv",
    checkType: "3pl_invoice",
    csv: ["Order Number,Amount", "1042,11.00"].join("\n"),
    shopifyOrders: [SHOPIFY_ORDER],
  });

  // A charge that matches a real order and has nothing to be checked against
  // is not a finding at all.
  assert.deepEqual(result.discrepancies, []);

  // And the merchant is told WHY nothing was checked, rather than being left
  // to read the silence as approval.
  assert.ok(
    result.warnings.some((warning) =>
      /no expected or contracted rate/.test(warning)
    ),
    "the limitation must be stated"
  );
  for (const warning of result.warnings) {
    assert.doesNotMatch(warning, /overcharge/i);
  }
});

test("SCENARIO 2: the word 'overcharge' appears nowhere the merchant can see it", () => {
  const model = require(d("services/reconciliationModel.js"));
  const { result } = reconcileFromCsv({
    fileName: "3pl-invoice.csv",
    checkType: "3pl_invoice",
    csv: [
      "Order Number,Amount",
      "1042,11.00",
      "9999,42.00",
    ].join("\n"),
    shopifyOrders: [SHOPIFY_ORDER],
  });

  const findings = findingCalc.buildReconciliationFindings({
    checkType: "3pl_invoice",
    discrepancies: result.discrepancies,
  });
  const sentences = [
    ...result.discrepancies.map((item) => item.summary),
    ...result.warnings,
    ...findings.flatMap((finding) => [
      finding.title,
      ...finding.reasons,
      finding.recommendedAction,
    ]),
  ];
  assert.ok(sentences.length > 0);
  for (const sentence of sentences) {
    assert.doesNotMatch(sentence, /overcharg/i, sentence);
    assert.equal(model.containsCausalClaim(sentence), false, sentence);
  }
});

test("SCENARIO 2: an unmatched charge is unverified, not recoverable", () => {
  const { result } = reconcileFromCsv({
    fileName: "3pl-invoice.csv",
    checkType: "3pl_invoice",
    csv: ["Order Number,Amount", "9999,42.00"].join("\n"),
    shopifyOrders: [SHOPIFY_ORDER],
  });
  const found = result.discrepancies.find(
    (item) => item.kind === checks.INVOICE_KINDS.unmatchedCharge
  );
  assert.ok(found);
  assert.equal(found.impact.status, "not_quantified");
  assert.match(found.summary, /does not match any order/);
});

// ===========================================================================
// SCENARIO 3 — SUPPLIER
//
//   Expected SKU-X = 100, received 92 -> an 8-unit discrepancy.
//   And it must NOT say the supplier "lost" 8 units.
// ===========================================================================

const SCENARIO_3 = {
  fileName: "supplier-receipt.csv",
  checkType: "supplier_shipment",
  csv: ["SKU,Ordered Qty,Received Qty", "SKU-X,100,92"].join("\n"),
  shopifyInventory: [variant("SKU-X", 0)],
};

test("SCENARIO 3: the 8-unit discrepancy is found with both figures", () => {
  const { result } = reconcileFromCsv(SCENARIO_3);
  const found = result.discrepancies.find(
    (item) =>
      item.kind === checks.SUPPLIER_KINDS.partialShipment ||
      item.kind === checks.SUPPLIER_KINDS.quantityShortfall
  );
  assert.ok(found, "the shortfall must be reported");
  assert.equal(found.difference, -8);
  assert.equal(found.certainty, "confirmed");

  const labels = Object.fromEntries(found.evidence.map((e) => [e.label, e.value]));
  assert.equal(labels["Expected"], "100");
  assert.equal(labels["Received"], "92");
  assert.equal(labels["Shortfall"], "8 units");
});

test("SCENARIO 3: nothing says the supplier lost anything", () => {
  const model = require(d("services/reconciliationModel.js"));
  const { result } = reconcileFromCsv(SCENARIO_3);
  const findings = findingCalc.buildReconciliationFindings({
    checkType: "supplier_shipment",
    discrepancies: result.discrepancies,
  });

  const sentences = [
    ...result.discrepancies.map((item) => item.summary),
    ...findings.flatMap((finding) => [
      finding.title,
      ...finding.reasons,
      finding.recommendedAction,
    ]),
  ];
  for (const sentence of sentences) {
    assert.doesNotMatch(sentence, /\blost\b/i, sentence);
    assert.equal(model.containsCausalClaim(sentence), false, sentence);
  }
  // It states what the DOCUMENT records, not what happened.
  const shortfall = result.discrepancies.find((item) => item.difference === -8);
  assert.match(shortfall.summary, /Your file records 100 units expected and 92 received/);
});

test("SCENARIO 3: with no unit cost, the 8 units are not turned into money", () => {
  const { result } = reconcileFromCsv(SCENARIO_3);
  const shortfall = result.discrepancies.find((item) => item.difference === -8);
  assert.equal(shortfall.impact.status, "not_quantified");
});

// ===========================================================================
// SCENARIO 4 — ACTION CENTER DEDUPLICATION
//
//   Run the same unresolved discrepancy twice.
//   -> ONE finding, reconfirmed. Not two.
// ===========================================================================

/** Loads intelligenceFindingService with an in-memory Prisma double. */
function loadFindingService() {
  const rows = new Map();
  let sequence = 0;

  const keyOf = (where) =>
    where.storeId_fingerprint
      ? `${where.storeId_fingerprint.storeId}|${where.storeId_fingerprint.fingerprint}`
      : `${where.storeId}|${where.fingerprint}`;

  const applyUpdate = (existing, data) => {
    const { detectionCount, ...rest } = data;
    Object.assign(existing, rest);
    if (detectionCount?.increment != null) {
      existing.detectionCount += detectionCount.increment;
    } else if (typeof detectionCount === "number") {
      existing.detectionCount = detectionCount;
    }
    return existing;
  };

  const prismaDouble = {
    intelligenceFinding: {
      // recordFinding uses upsert on the composite unique. Modelling that
      // faithfully is the point: a double that used findUnique-then-create
      // could pass while the real unique index behaved differently.
      async upsert({ where, update, create }) {
        const key = keyOf(where);
        const existing = rows.get(key);
        if (existing) return applyUpdate(existing, update);
        sequence += 1;
        const record = {
          id: `finding_${sequence}`,
          detectionCount: 1,
          status: "new",
          firstDetectedAt: create.firstDetectedAt ?? new Date(),
          lastSeenAt: create.lastSeenAt ?? new Date(),
          ...create,
        };
        rows.set(key, record);
        return record;
      },
      async update({ where, data }) {
        const existing = where.id
          ? [...rows.values()].find((row) => row.id === where.id)
          : rows.get(keyOf(where));
        if (!existing) throw new Error("not found");
        return applyUpdate(existing, data);
      },
      async findUnique({ where }) {
        return rows.get(keyOf(where)) ?? null;
      },
      async findMany() {
        return [...rows.values()];
      },
      async count() {
        return rows.size;
      },
    },
  };

  const source = path.resolve(__dirname, "../dist/services/intelligenceFindingService.js");
  const code = fs.readFileSync(source, "utf8");
  const mod = new Module(source);
  mod.paths = Module._nodeModulePaths(path.dirname(source));
  const original = mod.require.bind(mod);
  mod.require = (request) => {
    if (request.endsWith("prismaClient")) return { prisma: prismaDouble };
    return original(request);
  };
  mod._compile(code, source);
  return { service: mod.exports, rows };
}

/** The finding a single unresolved SKU-A mismatch produces. */
function scenario4Finding() {
  const { result } = reconcileFromCsv(SCENARIO_1);
  const findings = findingCalc.buildReconciliationFindings({
    checkType: "inventory",
    discrepancies: result.discrepancies.filter((item) => item.subjectKey === "sku-a"),
  });
  assert.equal(findings.length, 1);
  return findings[0];
}

test("SCENARIO 4: the same discrepancy twice yields ONE finding, reconfirmed", async () => {
  const { service, rows } = loadFindingService();
  const storeId = "store_1";
  const finding = scenario4Finding();

  const snapshot = {
    id: "reconciliation:inventory:test",
    storeId,
    module: "reconciliation",
    title: finding.title,
    reasons: finding.reasons,
    evidence: finding.evidence,
    financialImpact: finding.financialImpact,
    confidence: finding.confidence,
    recency: NOW,
    urgency: finding.urgency,
    easeOfAction: "manual",
    recommendedAction: finding.recommendedAction,
    score: { total: 10, components: {}, weights: {}, excludedFromMonetaryRanking: false },
    methodology: { summary: "s", assumptions: [], caps: [] },
    route: "/app/reconciliation",
    dataQuality: "ok",
  };

  const first = await service.recordFinding({
    storeId,
    module: "reconciliation",
    findingType: finding.findingType,
    subjectKey: finding.subjectKey,
    snapshot,
  });

  const second = await service.recordFinding({
    storeId,
    module: "reconciliation",
    findingType: finding.findingType,
    subjectKey: finding.subjectKey,
    snapshot,
  });

  assert.equal(rows.size, 1, "a second run must NOT create a second finding");
  assert.equal(first.id, second.id, "it must be the same row");
  assert.equal(second.detectionCount, 2, "and it must be recorded as seen again");
  assert.deepEqual(
    second.firstDetectedAt,
    first.firstDetectedAt,
    "firstDetectedAt must never move"
  );
});

test("SCENARIO 4: the fingerprint is stable across runs with different counts", () => {
  const storeId = "store_1";
  const finding = scenario4Finding();

  const fingerprint = computeFindingFingerprint({
    storeId,
    module: "reconciliation",
    findingType: finding.findingType,
    subjectKey: finding.subjectKey,
  });

  // A later run where three more SKUs mismatch must produce the SAME key.
  const { result } = reconcileFromCsv(SCENARIO_1);
  const wider = findingCalc.buildReconciliationFindings({
    checkType: "inventory",
    discrepancies: result.discrepancies.filter(
      (item) => item.kind === checks.INVENTORY_KINDS.quantityMismatch
    ),
  });
  const widerFingerprint = computeFindingFingerprint({
    storeId,
    module: "reconciliation",
    findingType: wider[0].findingType,
    subjectKey: wider[0].subjectKey,
  });

  assert.equal(fingerprint, widerFingerprint, "the count must not be in the identity");
});

test("SCENARIO 4: two different stores never share a finding", async () => {
  const { service, rows } = loadFindingService();
  const finding = scenario4Finding();
  const snapshot = {
    id: "x",
    storeId: "store_1",
    module: "reconciliation",
    title: finding.title,
    reasons: finding.reasons,
    evidence: [],
    financialImpact: { status: "impact_not_quantifiable", reason: "r" },
    confidence: "high",
    recency: NOW,
    urgency: "high",
    easeOfAction: "manual",
    recommendedAction: "a",
    score: { total: 1, components: {}, weights: {}, excludedFromMonetaryRanking: false },
    methodology: { summary: "s", assumptions: [], caps: [] },
    route: "/app/reconciliation",
    dataQuality: "ok",
  };

  for (const storeId of ["store_1", "store_2"]) {
    await service.recordFinding({
      storeId,
      module: "reconciliation",
      findingType: finding.findingType,
      subjectKey: finding.subjectKey,
      snapshot: { ...snapshot, storeId },
    });
  }
  assert.equal(rows.size, 2, "the same discrepancy in two stores is two findings");

  // And the fingerprints themselves differ, because storeId is an input.
  const a = computeFindingFingerprint({
    storeId: "store_1",
    module: "reconciliation",
    findingType: finding.findingType,
    subjectKey: finding.subjectKey,
  });
  const b = computeFindingFingerprint({
    storeId: "store_2",
    module: "reconciliation",
    findingType: finding.findingType,
    subjectKey: finding.subjectKey,
  });
  assert.notEqual(a, b);
});

test("SCENARIO 4: a merchant-set status is not reset by a re-run", async () => {
  const { service, rows } = loadFindingService();
  const storeId = "store_1";
  const finding = scenario4Finding();
  const snapshot = {
    id: "x",
    storeId,
    module: "reconciliation",
    title: finding.title,
    reasons: finding.reasons,
    evidence: [],
    financialImpact: { status: "impact_not_quantifiable", reason: "r" },
    confidence: "high",
    recency: NOW,
    urgency: "high",
    easeOfAction: "manual",
    recommendedAction: "a",
    score: { total: 1, components: {}, weights: {}, excludedFromMonetaryRanking: false },
    methodology: { summary: "s", assumptions: [], caps: [] },
    route: "/app/reconciliation",
    dataQuality: "ok",
  };

  await service.recordFinding({
    storeId,
    module: "reconciliation",
    findingType: finding.findingType,
    subjectKey: finding.subjectKey,
    snapshot,
  });
  // The merchant marks it as being worked on.
  const [row] = [...rows.values()];
  row.status = "in_review";

  await service.recordFinding({
    storeId,
    module: "reconciliation",
    findingType: finding.findingType,
    subjectKey: finding.subjectKey,
    snapshot,
  });

  const [after] = [...rows.values()];
  assert.equal(after.status, "in_review", "re-detection must not undo the merchant's decision");
  assert.equal(rows.size, 1);
});

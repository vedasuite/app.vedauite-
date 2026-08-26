const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

process.env.SHOPIFY_API_KEY ||= "test-key";
process.env.SHOPIFY_API_SECRET ||= "test-secret";
process.env.SHOPIFY_APP_URL ||= "https://vedasuite-staging.onrender.com";
process.env.SHOPIFY_ADMIN_API_VERSION ||= "2026-01";
process.env.DATABASE_URL ||= "postgresql://example:example@localhost:5432/example";

/**
 * RECONCILIATION V1 COMPLETION.
 *
 * Acceptance scenarios A–G, plus the regressions for what the completion pass
 * changed: persisted evidence, order line items, rate-card versioning, XLSX
 * sheet selection, and the three-way 3PL comparison.
 */

const d = (p) => path.resolve(__dirname, `../dist/${p}`);
const SRC = path.resolve(__dirname, "../src");
const read = (p) => fs.readFileSync(p, "utf8");
const readCode = (p) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const checks = require(d("services/reconciliationChecks.js"));
const rateCalc = require(d("services/rateCardCalc.js"));
const parsing = require(d("services/spreadsheetParsing.js"));
const importCalc = require(d("services/reconciliationImportCalc.js"));
const mappingCalc = require(d("services/columnMapping.js"));

const NOW = "2026-08-26T12:00:00.000Z";

const row = (over = {}) => ({
  rowNumber: 2,
  sku: null,
  orderRef: null,
  tracking: null,
  location: null,
  quantity: null,
  amount: null,
  expectedAmount: null,
  expectedQuantity: null,
  receivedQuantity: null,
  unitCost: null,
  chargeType: null,
  currency: null,
  observedAtIso: null,
  duplicateOf: null,
  ...over,
});

const order = (orderRef, over = {}) => ({
  orderRef,
  status: "paid",
  refunded: false,
  currency: "USD",
  totalAmount: 200,
  createdAtIso: "2026-08-01T00:00:00.000Z",
  ...over,
});

const line = (orderRef, quantity, over = {}) => ({
  orderRef,
  sku: "SKU-A",
  quantity,
  currentQuantity: quantity,
  refundedQuantity: 0,
  fulfilledQuantity: quantity,
  ...over,
});

const entry = (chargeType, rate, over = {}) => ({
  id: `entry-${chargeType}`,
  chargeKey: rateCalc.chargeKey(chargeType),
  chargeType,
  aliases: [],
  unit: "item",
  rate,
  currency: "USD",
  minQuantity: null,
  maxQuantity: null,
  ...over,
});

// ===========================================================================
// SCENARIO A — persistence after restart
// ===========================================================================

test("SCENARIO A: the process-lifetime evidence cache is GONE", () => {
  const src = readCode(path.join(SRC, "services/reconciliationService.ts"));
  assert.doesNotMatch(src, /derivedRowCache/, "no module-level cache may remain");
  assert.doesNotMatch(src, /cacheDerivedRows/);
  // And the reason is recorded where the next author will read it.
  assert.match(
    read(path.join(SRC, "services/reconciliationService.ts")),
    /THERE IS NO CACHE HERE ANY MORE/
  );
});

test("SCENARIO A: reference values are written to columns, not memory", () => {
  const src = readCode(path.join(SRC, "services/reconciliationService.ts"));
  for (const field of [
    "expectedAmount: row.expectedAmount",
    "expectedQuantity: row.expectedQuantity",
    "receivedQuantity: row.receivedQuantity",
    "unitCost: row.unitCost",
    "chargeType: row.chargeType",
  ]) {
    assert.ok(src.includes(field), `${field} must be persisted`);
  }
  const schema = read(path.resolve(__dirname, "../prisma/schema.prisma"));
  const record = schema.match(/model ReconciliationRecord \{[\s\S]*?\n\}/)[0];
  for (const column of [
    "expectedAmount",
    "expectedQuantity",
    "receivedQuantity",
    "unitCost",
    "chargeType",
    "valueSource",
  ]) {
    assert.match(record, new RegExp(`\\b${column}\\b`), `${column} must be a column`);
  }
});

test("SCENARIO A: the read path has no cache branch at all", () => {
  const src = readCode(path.join(SRC, "services/reconciliationService.ts"));
  const loader = src.match(/async function loadExternalRows[\s\S]*?\n\}/);
  assert.ok(loader, "the loader must exist");
  assert.match(loader[0], /prisma\.reconciliationRecord\.findMany/);
  // The old version returned nulls for these after a restart. Now it reads them.
  assert.match(loader[0], /expectedAmount: row\.expectedAmount/);
  assert.match(loader[0], /unitCost: row\.unitCost/);
  assert.doesNotMatch(loader[0], /expectedAmount: null/, "a restart must not blank them");
  assert.doesNotMatch(loader[0], /cached/);
});

test("SCENARIO A: provenance marks reference values as merchant-supplied", () => {
  const src = readCode(path.join(SRC, "services/reconciliationService.ts"));
  assert.match(src, /valueSource: "merchant_file"/);
  // Nothing writes any OTHER value, so a computed number cannot acquire
  // authoritative provenance by being stored in the same column.
  const writes = src.match(/valueSource: "[^"]+"/g) ?? [];
  assert.deepEqual([...new Set(writes)], ['valueSource: "merchant_file"']);
});

// ===========================================================================
// SCENARIO B — three-way 3PL reconciliation
//
//   Rate card: pick fee = $2.00
//   Shopify:   100 proven qualifying picks
//   Invoice:   100 x $2.50 = $250
//   Expected $200, billed $250, discrepancy $50, evidence-backed.
// ===========================================================================

const SCENARIO_B = () =>
  checks.runInvoiceCheck({
    shopifyOrders: [order("#2001")],
    shopifyLines: [line("#2001", 100)],
    rateCard: { name: "3PL", version: 1, entries: [entry("Pick Fee", 2.0)] },
    external: [
      row({
        rowNumber: 2,
        orderRef: "2001",
        chargeType: "Pick Fee",
        quantity: 100,
        amount: 250,
        currency: "USD",
      }),
    ],
    nowIso: NOW,
  });

test("SCENARIO B: expected 200, billed 250, discrepancy 50", () => {
  const result = SCENARIO_B();
  const found = result.discrepancies.find(
    (item) => item.kind === checks.INVOICE_KINDS.rateDifference
  );
  assert.ok(found, "the rate difference must be reported");
  assert.equal(found.expectedValue, "200");
  assert.equal(found.externalValue, "250");
  assert.equal(found.difference, 50);
  assert.equal(found.impact.status, "quantified");
  assert.equal(found.impact.amount, 50);
  assert.equal(found.impact.currency, "USD");
});

test("SCENARIO B: the evidence shows all three legs", () => {
  const found = SCENARIO_B().discrepancies.find(
    (item) => item.kind === checks.INVOICE_KINDS.rateDifference
  );
  const labels = Object.fromEntries(found.evidence.map((e) => [e.label, e.value]));
  assert.equal(labels["Agreed rate"], "2 USD per item", "leg 1: the contract");
  assert.equal(labels["Shopify order lines account for"], "100", "leg 2: real activity");
  assert.equal(labels["Billed"], "250 USD", "leg 3: the invoice");
  assert.equal(labels["Expected"], "200 USD");
  assert.equal(labels["Difference"], "+50 USD");
  assert.equal(labels["Rate card"], "3PL v1");
  assert.equal(labels["Row in your file"], "2");
});

test("SCENARIO B: the summary states the difference without blaming anyone", () => {
  const model = require(d("services/reconciliationModel.js"));
  for (const discrepancy of SCENARIO_B().discrepancies) {
    assert.equal(
      model.containsCausalClaim(discrepancy.summary),
      false,
      discrepancy.summary
    );
    assert.doesNotMatch(discrepancy.summary, /overcharg/i);
  }
});

// ===========================================================================
// SCENARIO C — billed quantity mismatch
// ===========================================================================

test("SCENARIO C: 90 in Shopify vs 100 billed is shown, without picking a side", () => {
  const result = checks.runInvoiceCheck({
    shopifyOrders: [order("#3001")],
    shopifyLines: [line("#3001", 90)],
    rateCard: { name: "3PL", version: 1, entries: [entry("Pick Fee", 2.0)] },
    external: [
      row({
        rowNumber: 2,
        orderRef: "3001",
        chargeType: "Pick Fee",
        quantity: 100,
        amount: 200,
        currency: "USD",
      }),
    ],
    nowIso: NOW,
  });

  const found = result.discrepancies.find(
    (item) => item.kind === checks.INVOICE_KINDS.quantityMismatch
  );
  assert.ok(found, "the quantity difference must be reported");
  assert.equal(found.shopifyValue, "90");
  assert.equal(found.externalValue, "100");
  assert.equal(found.difference, 10);
  // VedaSuite does not know which side is wrong, so it puts no value on it.
  assert.equal(found.impact.status, "not_quantified");
  assert.match(found.impact.reason, /not assuming which side is correct/i);
  assert.match(found.summary, /billed for 100 units/);
  assert.match(found.summary, /account for 90/);
});

// ===========================================================================
// SCENARIO D — missing rate
// ===========================================================================

test("SCENARIO D: an unmapped charge type produces no overcharge amount", () => {
  const result = checks.runInvoiceCheck({
    shopifyOrders: [order("#4001")],
    shopifyLines: [line("#4001", 50)],
    rateCard: { name: "3PL", version: 1, entries: [entry("Pick Fee", 2.0)] },
    external: [
      row({
        rowNumber: 2,
        orderRef: "4001",
        chargeType: "Special Handling",
        quantity: 50,
        amount: 175,
        currency: "USD",
      }),
    ],
    nowIso: NOW,
  });

  const found = result.discrepancies.find(
    (item) => item.kind === checks.INVOICE_KINDS.unmappedChargeType
  );
  assert.ok(found, "it must be reported as unmapped");
  assert.equal(found.certainty, "insufficient_data", "not a claim of wrongness");
  assert.equal(found.impact.status, "not_quantified");
  assert.equal(found.expectedValue, null, "there is no agreed leg to state");
  assert.match(found.impact.reason, /does not appear on your rate card/);

  // And no rate-difference finding was invented for it.
  assert.equal(
    result.discrepancies.some(
      (item) => item.kind === checks.INVOICE_KINDS.rateDifference
    ),
    false
  );
  for (const discrepancy of result.discrepancies) {
    assert.doesNotMatch(discrepancy.summary, /overcharg/i);
  }
});

test("SCENARIO D: an ambiguous charge type is unmapped, not guessed", () => {
  const match = rateCalc.matchRate({
    billedChargeType: "fee",
    quantity: 10,
    entries: [entry("Pick Fee", 2), entry("Pack Fee", 3)],
  });
  assert.equal(match.confidence, "unmapped");
  assert.equal(match.entry, null);
  assert.match(match.reason, /could match|does not appear/);
});

test("SCENARIO D: a probable match may be shown but may NOT fund a money claim", () => {
  const match = rateCalc.matchRate({
    billedChargeType: "picking",
    quantity: 10,
    entries: [entry("pick", 2)],
  });
  assert.equal(match.confidence, "probable");
  assert.equal(rateCalc.rateSupportsMonetaryClaim("probable"), false);
  const expected = rateCalc.expectedAmountFor({
    match,
    provenQuantity: 10,
    billedCurrency: "USD",
  });
  assert.equal(expected.status, "not_computed", "a maybe cannot produce an amount");
});

test("SCENARIO D: no proven activity means no expected amount", () => {
  const match = rateCalc.matchRate({
    billedChargeType: "Pick Fee",
    quantity: 10,
    entries: [entry("Pick Fee", 2)],
  });
  assert.equal(match.confidence, "exact");
  const expected = rateCalc.expectedAmountFor({
    match,
    provenQuantity: null,
    billedCurrency: "USD",
  });
  assert.equal(expected.status, "not_computed");
  assert.match(expected.reason, /could not prove from your Shopify orders/i);
});

test("SCENARIO D: a currency mismatch is refused, never converted", () => {
  const match = rateCalc.matchRate({
    billedChargeType: "Pick Fee",
    quantity: 10,
    entries: [entry("Pick Fee", 2, { currency: "GBP" })],
  });
  const expected = rateCalc.expectedAmountFor({
    match,
    provenQuantity: 10,
    billedCurrency: "USD",
  });
  assert.equal(expected.status, "not_computed");
  assert.match(expected.reason, /does not convert currencies/i);
});

test("SCENARIO D: a quantity outside a contract band does not borrow that rate", () => {
  const match = rateCalc.matchRate({
    billedChargeType: "Storage",
    quantity: 12,
    entries: [entry("Storage", 1.5, { minQuantity: 100, maxQuantity: null })],
  });
  assert.equal(match.confidence, "unmapped");
  assert.match(match.reason, /only for certain quantities/);
});

test("SCENARIO D: with no rate card at all, nothing is called wrong", () => {
  const result = checks.runInvoiceCheck({
    shopifyOrders: [order("#4002")],
    shopifyLines: [line("#4002", 50)],
    rateCard: null,
    external: [row({ rowNumber: 2, orderRef: "4002", amount: 175, currency: "USD" })],
    nowIso: NOW,
  });
  assert.equal(
    result.discrepancies.some((item) =>
      [
        checks.INVOICE_KINDS.rateDifference,
        checks.INVOICE_KINDS.quantityMismatch,
      ].includes(item.kind)
    ),
    false
  );
  assert.ok(result.warnings.some((warning) => /no rate card is saved/.test(warning)));
});

// ===========================================================================
// SCENARIO E — rate-card versioning
// ===========================================================================

test("SCENARIO E: run 1 at 2.00 and run 2 at 2.20 give different, correct results", () => {
  const invoice = [
    row({
      rowNumber: 2,
      orderRef: "5001",
      chargeType: "Pick Fee",
      quantity: 100,
      amount: 250,
      currency: "USD",
    }),
  ];
  const shared = {
    shopifyOrders: [order("#5001")],
    shopifyLines: [line("#5001", 100)],
    external: invoice,
    nowIso: NOW,
  };

  const run1 = checks.runInvoiceCheck({
    ...shared,
    rateCard: { name: "3PL", version: 1, entries: [entry("Pick Fee", 2.0)] },
  });
  const run2 = checks.runInvoiceCheck({
    ...shared,
    rateCard: { name: "3PL", version: 2, entries: [entry("Pick Fee", 2.2)] },
  });

  const find = (result) =>
    result.discrepancies.find(
      (item) => item.kind === checks.INVOICE_KINDS.rateDifference
    );

  assert.equal(find(run1).expectedValue, "200");
  assert.equal(find(run1).difference, 50);
  assert.equal(find(run1).rateCardVersion, 1);

  assert.equal(find(run2).expectedValue, "220");
  assert.equal(find(run2).difference, 30);
  assert.equal(find(run2).rateCardVersion, 2);
});

test("SCENARIO E: a new upload creates a VERSION, it does not edit the old one", () => {
  const src = readCode(path.join(SRC, "services/rateCardService.ts"));
  assert.match(src, /const version = \(previous\?\.version \?\? 0\) \+ 1;/);
  // The previous version is SUPERSEDED, not deleted and not rewritten.
  assert.match(src, /data: \{ status: "superseded" \}/);
  assert.doesNotMatch(src, /rateCardEntry\.deleteMany|rateCardEntry\.update\b/);
  assert.doesNotMatch(src, /rateCard\.delete\b/);
});

test("SCENARIO E: the run PINS the version it used", () => {
  const src = readCode(path.join(SRC, "services/reconciliationService.ts"));
  assert.match(src, /rateCardId: pinnedRateCardId/);
  assert.match(src, /rateCardVersion: pinnedRateCard\?\.version \?\? null/);
  assert.match(src, /rateCardName: pinnedRateCard\?\.name \?\? null/);
});

test("SCENARIO E: deleting a rate card does NOT delete the runs that used it", () => {
  const schema = read(path.resolve(__dirname, "../prisma/schema.prisma"));
  assert.match(
    schema,
    /rateCard\s+RateCard\? @relation\(fields: \[rateCardId\], references: \[id\], onDelete: SetNull\)/,
    "SetNull, never Cascade"
  );
  const migration = read(
    path.resolve(
      __dirname,
      "../prisma/migrations/20260826_reconciliation_v1_completion/migration.sql"
    )
  );
  assert.match(
    migration,
    /ReconciliationRun_rateCardId_fkey[\s\S]{0,200}ON DELETE SET NULL/
  );
  // And the version survives on the run itself.
  const run = schema.match(/model ReconciliationRun \{[\s\S]*?\n\}/)[0];
  assert.match(run, /rateCardVersion Int\?/);
  assert.match(run, /rateCardName    String\?/);
});

// ===========================================================================
// SCENARIO F — order line items
// ===========================================================================

test("SCENARIO F: 4 billed against a 3-item order is detected from real lines", () => {
  const result = checks.runInvoiceCheck({
    shopifyOrders: [order("#6001")],
    // The order contains three items across two lines.
    shopifyLines: [line("#6001", 2), line("#6001", 1, { sku: "SKU-B" })],
    rateCard: { name: "3PL", version: 1, entries: [entry("Pick Fee", 1.0)] },
    external: [
      row({
        rowNumber: 2,
        orderRef: "6001",
        chargeType: "Pick Fee",
        quantity: 4,
        amount: 4,
        currency: "USD",
      }),
    ],
    nowIso: NOW,
  });

  const found = result.discrepancies.find(
    (item) => item.kind === checks.INVOICE_KINDS.quantityMismatch
  );
  assert.ok(found, "the mismatch must come from actual line items");
  assert.equal(found.shopifyValue, "3");
  assert.equal(found.externalValue, "4");
  assert.equal(found.difference, 1);
});

test("SCENARIO F: with NO line items synced, no quantity claim is made", () => {
  const result = checks.runInvoiceCheck({
    shopifyOrders: [order("#6002")],
    shopifyLines: [],
    rateCard: { name: "3PL", version: 1, entries: [entry("Pick Fee", 1.0)] },
    external: [
      row({
        rowNumber: 2,
        orderRef: "6002",
        chargeType: "Pick Fee",
        quantity: 4,
        amount: 4,
        currency: "USD",
      }),
    ],
    nowIso: NOW,
  });
  assert.equal(
    result.discrepancies.some(
      (item) => item.kind === checks.INVOICE_KINDS.quantityMismatch
    ),
    false,
    "no lines means no proven quantity, so no mismatch may be claimed"
  );
  assert.ok(
    result.warnings.some((warning) => /No Shopify order lines are synced/.test(warning)),
    "and the merchant must be told why"
  );
});

test("SCENARIO F: a refunded line uses currentQuantity, not the original", () => {
  const result = checks.runInvoiceCheck({
    shopifyOrders: [order("#6003")],
    // Ordered 10, 4 refunded, 6 remain.
    shopifyLines: [line("#6003", 10, { currentQuantity: 6, refundedQuantity: 4 })],
    rateCard: { name: "3PL", version: 1, entries: [entry("Pick Fee", 1.0)] },
    external: [
      row({
        rowNumber: 2,
        orderRef: "6003",
        chargeType: "Pick Fee",
        quantity: 10,
        amount: 10,
        currency: "USD",
      }),
    ],
    nowIso: NOW,
  });
  const found = result.discrepancies.find(
    (item) => item.kind === checks.INVOICE_KINDS.quantityMismatch
  );
  assert.ok(found);
  assert.equal(found.shopifyValue, "6", "currentQuantity is the honest basis");
});

test("SCENARIO F: the sync UPSERTS lines and never duplicates them", () => {
  const src = readCode(path.join(SRC, "services/shopifyAdminService.ts"));
  assert.match(src, /prisma\.orderLineItem\.upsert\(\{/);
  assert.match(src, /storeId_shopifyLineItemId: \{/);
  const schema = read(path.resolve(__dirname, "../prisma/schema.prisma"));
  assert.match(
    schema,
    /@@unique\(\[storeId, shopifyLineItemId\]\)/,
    "the database must enforce it too"
  );
});

test("SCENARIO F: line-item pagination is bounded and truncation is reported", () => {
  const src = read(path.join(SRC, "services/shopifyAdminService.ts"));
  assert.match(src, /lineItems\(first: 50\)/);
  assert.match(src, /pageInfo \{ hasNextPage \}/);
  assert.match(src, /lineItemsTruncated \+= 1/, "an over-long order must be reported");
  assert.match(src, /export const LINE_ITEM_PAGE_SIZE = 50;/);
});

test("SCENARIO F: no protected customer field was added to the order query", () => {
  const src = read(path.join(SRC, "services/shopifyAdminService.ts"));
  // Slice from the query opener to the end of its template literal, rather
  // than matching indentation that legitimately changes.
  const start = src.indexOf("orders(first: $first");
  assert.ok(start > 0, "the order query must be findable");
  // GraphQL # comments deliberately NAME the forbidden fields, to stop them
  // being re-added. The assertion is about the SELECTION SET, so they go.
  const orderQuery = [
    src.slice(start, src.indexOf("`", start)).replace(/^\s*#.*$/gm, ""),
  ];
  for (const forbidden of ["email", "phone", "firstName", "lastName", "defaultAddress"]) {
    assert.doesNotMatch(
      orderQuery[0],
      new RegExp(`\\b${forbidden}\\b`),
      `${forbidden} must not be requested`
    );
  }
});

// ===========================================================================
// SCENARIO G — inventory persistence
// ===========================================================================

test("SCENARIO G: uploaded quantities survive a restart because they are columns", () => {
  const schema = read(path.resolve(__dirname, "../prisma/schema.prisma"));
  const record = schema.match(/model ReconciliationRecord \{[\s\S]*?\n\}/)[0];
  assert.match(record, /quantity   Float\?/);
  assert.match(record, /unitCost         Float\?/);
  // And the discrepancy keeps its own evidence, independent of the source rows.
  const discrepancy = schema.match(/model ReconciliationDiscrepancy \{[\s\S]*?\n\}/)[0];
  assert.match(discrepancy, /evidenceJson String\?/);
  assert.match(discrepancy, /shopifyValue  String\?/);
  assert.match(discrepancy, /externalValue String\?/);
});

test("SCENARIO G: a historical run explains itself from the database alone", () => {
  const src = readCode(path.join(SRC, "services/reconciliationService.ts"));
  const workspace = src.match(/export async function getReconciliationWorkspace[\s\S]*?\n\}/);
  assert.ok(workspace);
  // Everything the workspace renders comes from a query, not a cache.
  assert.match(workspace[0], /prisma\.reconciliationDiscrepancy\.findMany/);
  assert.match(workspace[0], /rateCardName: true/);
  assert.match(workspace[0], /rateCardVersion: true/);
  assert.doesNotMatch(workspace[0], /Cache|cached/);
});

// ===========================================================================
// XLSX sheet selection
// ===========================================================================

function crc32(buffer) {
  let crc = ~0;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

/** Builds a genuine multi-sheet workbook. */
function buildWorkbook(sheets) {
  const files = [
    {
      name: "xl/workbook.xml",
      content: Buffer.from(
        `<workbook><sheets>${sheets
          .map(
            (sheet, index) =>
              `<sheet name="${sheet.name}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`
          )
          .join("")}</sheets></workbook>`,
        "utf8"
      ),
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      content: Buffer.from(
        `<Relationships>${sheets
          .map(
            (_, index) =>
              `<Relationship Id="rId${index + 1}" Target="worksheets/sheet${index + 1}.xml"/>`
          )
          .join("")}</Relationships>`,
        "utf8"
      ),
    },
    ...sheets.map((sheet, index) => ({
      name: `xl/worksheets/sheet${index + 1}.xml`,
      content: Buffer.from(sheet.xml, "utf8"),
    })),
  ];

  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const file of files) {
    const nameBuffer = Buffer.from(file.name, "utf8");
    const deflated = zlib.deflateRawSync(file.content);
    const crc = crc32(file.content);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(file.content.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    locals.push(Buffer.concat([local, nameBuffer, deflated]));

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(deflated.length, 20);
    central.writeUInt32LE(file.content.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, nameBuffer]));

    offset += 30 + nameBuffer.length + deflated.length;
  }

  const centralBuffer = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuffer, eocd]);
}

const sheetXml = (header, value) =>
  `<worksheet><sheetData>
    <row r="1"><c r="A1" t="inlineStr"><is><t>${header}</t></is></c></row>
    <row r="2"><c r="A2" t="inlineStr"><is><t>${value}</t></is></c></row>
  </sheetData></worksheet>`;

const MULTI = () =>
  buildWorkbook([
    { name: "Summary", xml: sheetXml("Note", "ignore me") },
    { name: "Stock", xml: sheetXml("SKU", "ABC-1") },
  ]);

test("XLSX: every worksheet is listed, so none is silently ignored", () => {
  const parsed = parsing.parseXlsx(MULTI());
  assert.deepEqual(parsed.availableSheets, ["Summary", "Stock"]);
  assert.equal(parsed.sheetName, "Summary", "the first tab is the default");
});

test("XLSX: the merchant can select a different worksheet", () => {
  const parsed = parsing.parseXlsx(MULTI(), "Stock");
  assert.equal(parsed.sheetName, "Stock");
  assert.deepEqual(parsed.headers, ["SKU"]);
  assert.deepEqual(parsed.rows, [["ABC-1"]]);
});

test("XLSX: an unknown sheet name is refused, and names the real ones", () => {
  assert.throws(
    () => parsing.parseXlsx(MULTI(), "Nope"),
    /no sheet called "Nope"[\s\S]*Summary, Stock/
  );
});

test("XLSX: the sheet part comes from workbook.xml, not the filename", () => {
  // Tab order and part filenames do not have to agree. This workbook lists
  // Stock first while its part is sheet2.xml.
  const workbook = buildWorkbook([
    { name: "First", xml: sheetXml("A", "1") },
    { name: "Second", xml: sheetXml("B", "2") },
  ]);
  const parsed = parsing.parseXlsx(workbook, "Second");
  assert.deepEqual(parsed.headers, ["B"], "the rel target must be honoured");
});

test("XLSX: an empty selected sheet says which OTHER sheets exist", () => {
  const workbook = buildWorkbook([
    { name: "Blank", xml: "<worksheet><sheetData></sheetData></worksheet>" },
    { name: "Stock", xml: sheetXml("SKU", "ABC-1") },
  ]);
  assert.throws(() => parsing.parseXlsx(workbook, "Blank"), /also contains: Stock/);
});

test("XLSX: a CSV reports no sheets rather than a fake one", () => {
  const parsed = parsing.parseCsv("SKU,Qty\nABC-1,5\n");
  assert.deepEqual(parsed.availableSheets, []);
  assert.equal(parsed.sheetName, null);
});

test("XLSX: the chosen sheet is persisted with the upload", () => {
  const src = readCode(path.join(SRC, "services/reconciliationService.ts"));
  assert.match(src, /availableSheetsJson: JSON\.stringify\(parsed\.availableSheets\)/);
  assert.match(src, /sheetName: parsed\.sheetName/);
});

// ===========================================================================
// Rate-card mapping and aliases
// ===========================================================================

test("RATE CARD: charge types are merchant-defined, never a fixed list", () => {
  const src = readCode(path.join(SRC, "services/rateCardCalc.ts"));
  // No hardcoded fee vocabulary anywhere in the matcher.
  for (const fee of ["pick fee", "pack fee", "storage", "receiving", "return handling"]) {
    assert.doesNotMatch(
      src,
      new RegExp(`"${fee}"`, "i"),
      `"${fee}" must not be hardcoded in the matcher`
    );
  }
  // Arbitrary charge types work.
  const match = rateCalc.matchRate({
    billedChargeType: "Gift wrap surcharge",
    quantity: 5,
    entries: [entry("Gift wrap surcharge", 0.5)],
  });
  assert.equal(match.confidence, "exact");
});

test("RATE CARD: a merchant-declared alias matches, and funds a money claim", () => {
  const match = rateCalc.matchRate({
    billedChargeType: "PICKING",
    quantity: 10,
    entries: [entry("Pick Fee", 2, { aliases: ["picking"] })],
  });
  assert.equal(match.confidence, "alias");
  assert.equal(rateCalc.rateSupportsMonetaryClaim("alias"), true);
});

test("RATE CARD: a charge key normalizes case and spacing, nothing else", () => {
  assert.equal(rateCalc.chargeKey("  Pick   Fee "), "pick fee");
  assert.equal(rateCalc.chargeKey("PICK-FEE"), "pick fee");
  assert.equal(rateCalc.chargeKey("Pick_Fee"), "pick fee");
  assert.equal(rateCalc.chargeKey(""), null);
  assert.equal(rateCalc.chargeKey(null), null);
});

test("RATE CARD: duplicate entries for one charge are unmapped, not first-wins", () => {
  const match = rateCalc.matchRate({
    billedChargeType: "Pick Fee",
    quantity: 10,
    entries: [entry("Pick Fee", 2), { ...entry("Pick Fee", 3), id: "b" }],
  });
  assert.equal(match.confidence, "unmapped");
  assert.match(match.reason, /2 entries for/);
});

test("RATE CARD: rows that cannot be used are reported, not dropped", () => {
  const src = readCode(path.join(SRC, "services/rateCardService.ts"));
  assert.match(src, /skippedRows\.push\(\{ rowNumber, reason:/);
  assert.match(src, /could not be read as a number/);
  assert.match(src, /is negative, which VedaSuite cannot use/);
  assert.match(src, /skippedRows: skippedRows\.slice\(0, 20\)/);
});

test("RATE CARD: a banded rate is a separate entry, not a duplicate", () => {
  const src = readCode(path.join(SRC, "services/rateCardService.ts"));
  assert.match(src, /const identity = `\$\{key\}\|\$\{min \?\? ""\}\|\$\{max \?\? ""\}`/);
});

// ===========================================================================
// Regression audit findings
// ===========================================================================

test("AUDIT: the dead refundedUnits accumulator is gone", () => {
  const src = readCode(path.join(SRC, "services/reconciliationChecks.ts"));
  assert.doesNotMatch(
    src,
    /refundedUnits/,
    "an unread total built from nulls-as-zeros must not exist"
  );
});

test("AUDIT: an unreadable external quantity is not printed as 0", () => {
  const result = checks.runInventoryCheck({
    shopify: [],
    external: [row({ rowNumber: 2, sku: "SKU-D", quantity: null })],
    nowIso: NOW,
  });
  const found = result.discrepancies.find(
    (item) => item.kind === checks.INVENTORY_KINDS.externalOnly
  );
  assert.ok(found);
  assert.equal(found.externalValue, null, "null must stay null, not become 0");
  assert.doesNotMatch(found.summary, /with 0 units/);
  const labels = Object.fromEntries(found.evidence.map((e) => [e.label, e.value]));
  assert.equal(labels["In uploaded file"], "Quantity not readable");
});

test("AUDIT: inventoryQuantity IS requested — read_products covers it", () => {
  // CORRECTED. An earlier pass removed this field believing it needed
  // read_inventory. Verified against the 2026-01 ProductVariant reference:
  // the object requires read_products and no field requires anything more.
  // Removing it left inventory reconciliation with no Shopify side at all.
  const src = read(path.join(SRC, "services/shopifyAdminService.ts"));
  const start = src.indexOf("products(first: $first");
  assert.ok(start > 0, "the product query must be findable");
  const productQuery = src
    .slice(start, src.indexOf("`", start))
    .replace(/^\s*#.*$/gm, "");
  assert.match(productQuery, /inventoryQuantity/);
  assert.match(productQuery, /sku/);
  // Per-location InventoryLevel is the part that needs read_inventory, and
  // it is NOT in this query — it is fetched separately and optionally.
  assert.doesNotMatch(productQuery, /inventoryLevels/);
  // Provenance is recorded beside the figure.
  assert.match(src, /inventorySourceFor\(\{/);
});

test("AUDIT: the missing inventory scope is explained, not left blank", () => {
  const src = read(path.join(SRC, "services/reconciliationService.ts"));
  assert.match(src, /does not have permission to read Shopify inventory levels/);
  assert.match(src, /needs an additional Shopify permission and a new app review/);
  // It must be attributed to VedaSuite, not to the merchant's setup.
  assert.doesNotMatch(
    src,
    /your inventory tracking is (broken|off|disabled)/i,
    "a permission we lack is not a fault in their store"
  );
});

test("AUDIT: requested scopes match the verified requirements", () => {
  const toml = read(path.resolve(__dirname, "../../shopify.app.toml"));
  const scopes = /scopes = "([^"]*)"/.exec(toml)[1].split(",");
  // The four that have always been required.
  for (const scope of ["read_products", "read_orders", "write_orders", "read_customers"]) {
    assert.ok(scopes.includes(scope), `${scope} must remain requested`);
  }
  // The two OPTIONAL additions that unlock per-location reconciliation.
  assert.ok(scopes.includes("read_inventory"));
  assert.ok(scopes.includes("read_locations"));
  // Nothing unrelated crept in.
  assert.deepEqual(scopes.slice().sort(), [
    "read_customers",
    "read_inventory",
    "read_locations",
    "read_orders",
    "read_products",
    "write_orders",
  ]);
  // env must agree, or an install would request a different set.
  const envSrc = read(path.join(SRC, "config/env.ts"));
  assert.match(envSrc, /read_inventory,read_locations/);
});

test("AUDIT: location reconciliation stays explicitly unsupported", () => {
  const result = checks.runInventoryCheck({
    shopify: [
      {
        sku: "SKU-A",
        inventoryQuantity: 10,
        productHandle: "h",
        variantTitle: "t",
        unitCost: null,
        currency: null,
      },
    ],
    external: [
      row({ rowNumber: 2, sku: "SKU-A", quantity: 6, location: "LON" }),
      row({ rowNumber: 3, sku: "SKU-A", quantity: 4, location: "BER" }),
    ],
    nowIso: NOW,
  });
  const found = result.discrepancies.find(
    (item) => item.kind === checks.INVENTORY_KINDS.locationMismatch
  );
  assert.ok(found);
  assert.equal(found.certainty, "insufficient_data", "never a claimed mismatch");
  assert.match(found.summary, /Shopify does not tell VedaSuite which location/);
});

// ===========================================================================
// Import wiring for the new field
// ===========================================================================

test("IMPORT: chargeType is mappable and its absence is explained", () => {
  const proposal = mappingCalc.suggestMapping({
    checkType: "3pl_invoice",
    headers: ["Order Number", "Service", "Amount"],
    sampleRows: [["1042", "Pick Fee", "2.50"]],
  });
  const chargeType = proposal.suggestions.find((item) => item.field === "chargeType");
  assert.ok(chargeType, "the field must be offered");
  assert.equal(chargeType.suggestedHeader, "Service");

  const preview = importCalc.buildImportPreview({
    checkType: "3pl_invoice",
    headers: ["Order Number", "Amount"],
    rows: [["1042", "2.50"]],
    mapping: { orderRef: "Order Number", amount: "Amount" },
  });
  const missing = preview.missingOptionalFields.find(
    (field) => field.field === "chargeType"
  );
  assert.ok(missing);
  assert.match(missing.consequence, /cannot check any amount against your saved rate card/);
});

test("IMPORT: chargeType reaches the normalized row", () => {
  const preview = importCalc.buildImportPreview({
    checkType: "3pl_invoice",
    headers: ["Order Number", "Service", "Amount"],
    rows: [["1042", "Pick Fee", "2.50"]],
    mapping: { orderRef: "Order Number", chargeType: "Service", amount: "Amount" },
  });
  assert.equal(preview.rows[0].chargeType, "Pick Fee");
});

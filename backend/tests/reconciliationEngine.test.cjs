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
 * RECONCILIATION ENGINE V1.
 *
 * The engine's whole value is that a merchant can trust what it says. These
 * tests are therefore weighted towards what it must REFUSE to say: no invented
 * money, no invented causes, no certainty beyond the match it rests on, and no
 * partial run presented as a complete one.
 */

const d = (p) => path.resolve(__dirname, `../dist/${p}`);
const SRC = path.resolve(__dirname, "../src");
const FRONTEND = path.resolve(__dirname, "../../frontend/src");
const read = (p) => fs.readFileSync(p, "utf8");

/**
 * Source with comments removed.
 *
 * These assertions are about what the CODE does. A comment explaining why a
 * word is forbidden legitimately contains that word, and matching it would
 * punish the explanation rather than the behaviour.
 */
const readCode = (p) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const model = require(d("services/reconciliationModel.js"));
const checks = require(d("services/reconciliationChecks.js"));
const mapping = require(d("services/columnMapping.js"));
const importCalc = require(d("services/reconciliationImportCalc.js"));
const findingCalc = require(d("services/reconciliationFindingCalc.js"));
const parsing = require(d("services/spreadsheetParsing.js"));

const NOW = "2026-08-26T12:00:00.000Z";

/** Builds an external row with only the fields a test cares about. */
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
  currency: null,
  observedAtIso: null,
  duplicateOf: null,
  ...over,
});

const variant = (sku, inventoryQuantity, over = {}) => ({
  sku,
  inventoryQuantity,
  productHandle: `product-${sku}`,
  variantTitle: `Variant ${sku}`,
  unitCost: null,
  currency: null,
  ...over,
});

// ===========================================================================
// INVENTORY
// ===========================================================================

test("INVENTORY: an exact SKU match with equal quantities produces no finding", () => {
  const result = checks.runInventoryCheck({
    shopify: [variant("SKU-B", 8)],
    external: [row({ rowNumber: 2, sku: "sku-b", quantity: 8 })],
    nowIso: NOW,
  });
  assert.deepEqual(result.discrepancies, [], "agreement is not a discrepancy");
  assert.equal(result.counts.exact, 1);
});

test("INVENTORY: a quantity mismatch is confirmed and states both figures", () => {
  const result = checks.runInventoryCheck({
    shopify: [variant("SKU-A", 20)],
    external: [row({ rowNumber: 2, sku: "SKU-A", quantity: 13 })],
    nowIso: NOW,
  });
  const found = result.discrepancies.find(
    (item) => item.kind === checks.INVENTORY_KINDS.quantityMismatch
  );
  assert.ok(found, "a mismatch must be reported");
  assert.equal(found.certainty, "confirmed");
  assert.equal(found.matchConfidence, "exact");
  assert.equal(found.difference, -7);
  assert.equal(found.shopifyValue, "20");
  assert.equal(found.externalValue, "13");
  assert.match(found.summary, /7 units fewer|fewer/);
  assert.match(found.summary, /Shopify 20/);
  assert.match(found.summary, /file 13/);
});

test("INVENTORY: a SKU only in Shopify is reported as missing externally", () => {
  const result = checks.runInventoryCheck({
    shopify: [variant("SKU-C", 5)],
    external: [],
    nowIso: NOW,
  });
  const found = result.discrepancies.find(
    (item) => item.kind === checks.INVENTORY_KINDS.missingExternally
  );
  assert.ok(found);
  assert.equal(found.matchConfidence, "unmatched");
  // Nothing was compared, so nothing is confirmable.
  assert.equal(found.certainty, "possible");
  assert.equal(found.impact.status, "not_quantified");
});

test("INVENTORY: a SKU only in the file is reported as external-only", () => {
  const result = checks.runInventoryCheck({
    shopify: [],
    external: [row({ rowNumber: 4, sku: "SKU-D", quantity: 4 })],
    nowIso: NOW,
  });
  const found = result.discrepancies.find(
    (item) => item.kind === checks.INVENTORY_KINDS.externalOnly
  );
  assert.ok(found);
  assert.equal(found.matchConfidence, "unmatched");
  assert.ok(found.evidence.some((e) => e.label === "Row in your file" && e.value === "4"));
});

test("INVENTORY: a duplicated SKU downgrades the match and is reported", () => {
  const result = checks.runInventoryCheck({
    shopify: [variant("SKU-A", 20)],
    external: [
      row({ rowNumber: 2, sku: "SKU-A", quantity: 10 }),
      row({ rowNumber: 3, sku: "SKU-A", quantity: 5 }),
    ],
    nowIso: NOW,
  });
  const duplicate = result.discrepancies.find(
    (item) => item.kind === checks.INVENTORY_KINDS.duplicateRow
  );
  assert.ok(duplicate, "the repetition must be surfaced");
  assert.match(duplicate.summary, /rows 2, 3/);

  const mismatch = result.discrepancies.find(
    (item) => item.kind === checks.INVENTORY_KINDS.quantityMismatch
  );
  assert.ok(mismatch);
  assert.equal(mismatch.matchConfidence, "probable", "a repeated key is not an exact match");
  assert.equal(mismatch.certainty, "possible", "and a probable match cannot confirm");
  // The rows are summed, not silently reduced to the first one.
  assert.equal(mismatch.externalValue, "15");
  assert.ok(
    mismatch.evidence.some((e) => e.label === "Why this is not confirmed"),
    "the ambiguity must be explained"
  );
});

test("INVENTORY: an ambiguous match never claims confirmed certainty", () => {
  for (const confidence of ["probable", "unmatched"]) {
    assert.notEqual(model.certaintyFor(confidence), "confirmed");
  }
  assert.equal(model.certaintyFor("exact"), "confirmed");
  // insufficient_data survives regardless of the match quality.
  for (const confidence of ["exact", "probable", "unmatched"]) {
    assert.equal(model.certaintyFor(confidence, "insufficient_data"), "insufficient_data");
  }
});

test("INVENTORY: NULL Shopify inventory is not treated as zero", () => {
  // THE FABRICATION THIS PREVENTS. An untracked variant compared as 0 against a
  // file saying 11 would report an 11-unit surplus that does not exist.
  const result = checks.runInventoryCheck({
    shopify: [variant("SKU-X", null)],
    external: [row({ rowNumber: 2, sku: "SKU-X", quantity: 11 })],
    nowIso: NOW,
  });
  const mismatch = result.discrepancies.find(
    (item) => item.kind === checks.INVENTORY_KINDS.quantityMismatch
  );
  assert.equal(mismatch, undefined, "no mismatch may be invented from a null");

  const untracked = result.discrepancies.find(
    (item) => item.kind === checks.INVENTORY_KINDS.untrackedInShopify
  );
  assert.ok(untracked);
  assert.equal(untracked.certainty, "insufficient_data");
  assert.equal(untracked.shopifyValue, null);
});

test("INVENTORY: missing cost means NO fabricated impact", () => {
  const result = checks.runInventoryCheck({
    shopify: [variant("SKU-A", 20)],
    external: [row({ rowNumber: 2, sku: "SKU-A", quantity: 13 })],
    nowIso: NOW,
  });
  const mismatch = result.discrepancies.find(
    (item) => item.kind === checks.INVENTORY_KINDS.quantityMismatch
  );
  assert.equal(mismatch.impact.status, "not_quantified");
  assert.match(mismatch.impact.reason, /no recorded cost|does not send product cost/i);
  assert.equal(mismatch.impact.amount, undefined, "no amount may exist on an unquantified impact");
});

test("INVENTORY: a cost supplied in the file DOES produce a defensible value", () => {
  const result = checks.runInventoryCheck({
    shopify: [variant("SKU-A", 20)],
    external: [row({ rowNumber: 2, sku: "SKU-A", quantity: 13, unitCost: 4.5, currency: "USD" })],
    nowIso: NOW,
  });
  const mismatch = result.discrepancies.find(
    (item) => item.kind === checks.INVENTORY_KINDS.quantityMismatch
  );
  assert.equal(mismatch.impact.status, "quantified");
  assert.equal(mismatch.impact.amount, 31.5, "7 units x 4.50");
  assert.equal(mismatch.impact.currency, "USD");
  assert.match(mismatch.impact.basis, /7 units x 4\.5 USD/);
  assert.match(mismatch.impact.basis, /cost column in your file/);
});

test("INVENTORY: a cost with no currency is not turned into money", () => {
  const impact = model.quantifyByUnitCost({
    units: 7,
    unitCost: 4.5,
    currency: null,
    costIsObserved: true,
  });
  assert.equal(impact.status, "not_quantified");
  assert.match(impact.reason, /currency/i);
});

test("INVENTORY: a negative quantity is reported, not discarded", () => {
  const result = checks.runInventoryCheck({
    shopify: [variant("SKU-N", 4)],
    external: [row({ rowNumber: 2, sku: "SKU-N", quantity: -3 })],
    nowIso: NOW,
  });
  assert.ok(
    result.discrepancies.some((item) => item.kind === checks.INVENTORY_KINDS.negativeQuantity)
  );
});

test("INVENTORY: SKU-less Shopify variants are reported as unmatchable", () => {
  const result = checks.runInventoryCheck({
    shopify: [variant(null, 10), variant("SKU-A", 5)],
    external: [row({ rowNumber: 2, sku: "SKU-A", quantity: 5 })],
    nowIso: NOW,
  });
  assert.ok(
    result.warnings.some((warning) => /no SKU set/.test(warning)),
    "a merchant must be told why some products were skipped"
  );
});

test("INVENTORY: staleness is only claimed when the file carries a date", () => {
  const undated = checks.runInventoryCheck({
    shopify: [variant("SKU-A", 5)],
    external: [row({ sku: "SKU-A", quantity: 5 })],
    nowIso: NOW,
  });
  assert.equal(
    undated.warnings.filter((warning) => /days old/.test(warning)).length,
    0,
    "no date means no staleness claim"
  );

  const stale = checks.runInventoryCheck({
    shopify: [variant("SKU-A", 5)],
    external: [
      row({ sku: "SKU-A", quantity: 5, observedAtIso: "2026-08-01T00:00:00.000Z" }),
    ],
    nowIso: NOW,
  });
  assert.ok(stale.warnings.some((warning) => /days old/.test(warning)));
});

// ===========================================================================
// 3PL INVOICE
// ===========================================================================

const order = (orderRef, over = {}) => ({
  orderRef,
  status: "paid",
  refunded: false,
  currency: "USD",
  totalAmount: 100,
  createdAtIso: "2026-08-01T00:00:00.000Z",
  ...over,
});

test("3PL: a matched charge with no reference rate raises nothing on its own", () => {
  const result = checks.runInvoiceCheck({
    shopifyOrders: [order("#1042")],
    external: [row({ rowNumber: 2, orderRef: "1042", amount: 11 })],
    nowIso: NOW,
  });
  assert.deepEqual(
    result.discrepancies,
    [],
    "an ordinary charge against a real order is not a discrepancy"
  );
  assert.equal(result.counts.exact, 1, "the # prefix must not prevent the match");
});

test("3PL: a charge against no known order is reported as unmatched", () => {
  const result = checks.runInvoiceCheck({
    shopifyOrders: [order("#1042")],
    external: [row({ rowNumber: 3, orderRef: "9999", amount: 12 })],
    nowIso: NOW,
  });
  const found = result.discrepancies.find(
    (item) => item.kind === checks.INVOICE_KINDS.unmatchedCharge
  );
  assert.ok(found);
  assert.equal(found.impact.status, "not_quantified");
  assert.match(found.impact.reason, /may predate|different reference format/i);
});

test("3PL: two charges on one order are POSSIBLE, never confirmed", () => {
  const result = checks.runInvoiceCheck({
    shopifyOrders: [order("#1042")],
    external: [
      row({ rowNumber: 2, orderRef: "1042", amount: 11 }),
      row({ rowNumber: 3, orderRef: "1042", amount: 11 }),
    ],
    nowIso: NOW,
  });
  const found = result.discrepancies.find(
    (item) => item.kind === checks.INVOICE_KINDS.duplicateCharge
  );
  assert.ok(found);
  assert.equal(found.certainty, "possible", "some contracts legitimately bill twice");
  assert.equal(found.impact.status, "not_quantified");
  assert.match(found.summary, /same amount/);
});

test("3PL: a cancelled order that was charged is reported", () => {
  const result = checks.runInvoiceCheck({
    shopifyOrders: [order("#1042", { status: "cancelled" })],
    external: [row({ rowNumber: 2, orderRef: "1042", amount: 11 })],
    nowIso: NOW,
  });
  const found = result.discrepancies.find(
    (item) => item.kind === checks.INVOICE_KINDS.cancelledOrderCharge
  );
  assert.ok(found);
  assert.equal(found.impact.status, "not_quantified", "no rate means no recoverable claim");
});

test("3PL: a refunded order charge is POSSIBLE and says why", () => {
  const result = checks.runInvoiceCheck({
    shopifyOrders: [order("#1042", { refunded: true })],
    external: [row({ rowNumber: 2, orderRef: "1042", amount: 11 })],
    nowIso: NOW,
  });
  const found = result.discrepancies.find(
    (item) => item.kind === checks.INVOICE_KINDS.refundedOrderCharge
  );
  assert.ok(found);
  assert.equal(found.certainty, "possible");
  assert.match(found.summary, /may still have shipped/);
});

test("3PL: an amount difference is stated ONLY against a supplied rate", () => {
  const result = checks.runInvoiceCheck({
    shopifyOrders: [order("#1042")],
    external: [
      row({ rowNumber: 2, orderRef: "1042", amount: 11, expectedAmount: 8, currency: "USD" }),
    ],
    nowIso: NOW,
  });
  const found = result.discrepancies.find(
    (item) => item.kind === checks.INVOICE_KINDS.amountDifference
  );
  assert.ok(found);
  assert.equal(found.difference, 3);
  assert.equal(found.impact.status, "quantified");
  assert.equal(found.impact.amount, 3);
  assert.match(found.impact.basis, /Billed 11 minus expected 8/);
  assert.match(found.impact.basis, /expected rate column in your file/);
});

test("3PL: WITHOUT a reference rate, nothing is called an overcharge", () => {
  const result = checks.runInvoiceCheck({
    shopifyOrders: [order("#1042", { status: "cancelled" })],
    external: [row({ rowNumber: 2, orderRef: "1042", amount: 11 })],
    nowIso: NOW,
  });
  for (const discrepancy of result.discrepancies) {
    assert.equal(
      model.containsCausalClaim(discrepancy.summary),
      false,
      `causal language in: ${discrepancy.summary}`
    );
  }
  assert.ok(
    result.warnings.some((warning) => /no expected or contracted rate/.test(warning)),
    "the merchant must be told the limitation up front"
  );
});

test("3PL: quantifyByAmountDifference refuses without an expected amount", () => {
  const impact = model.quantifyByAmountDifference({
    billed: 11,
    expected: null,
    currency: "USD",
    expectedSourceLabel: "x",
  });
  assert.equal(impact.status, "not_quantified");
  assert.match(impact.reason, /no expected or contracted rate/i);
  assert.match(impact.reason, /only that it was charged/i);
});

// ===========================================================================
// SUPPLIER SHIPMENT
// ===========================================================================

test("SUPPLIER: expected vs received produces a shortfall with both figures", () => {
  const result = checks.runSupplierCheck({
    shopify: [variant("SKU-X", 0)],
    external: [
      row({ rowNumber: 2, sku: "SKU-X", expectedQuantity: 100, receivedQuantity: 92 }),
    ],
    nowIso: NOW,
  });
  const found = result.discrepancies.find(
    (item) =>
      item.kind === checks.SUPPLIER_KINDS.partialShipment ||
      item.kind === checks.SUPPLIER_KINDS.quantityShortfall
  );
  assert.ok(found);
  assert.equal(found.difference, -8);
  assert.match(found.summary, /100 units expected and 92 received/);
  assert.match(found.summary, /shortfall of 8 units/);
});

test("SUPPLIER: the shortfall never says the supplier lost anything", () => {
  const result = checks.runSupplierCheck({
    shopify: [variant("SKU-X", 0)],
    external: [
      row({ rowNumber: 2, sku: "SKU-X", expectedQuantity: 100, receivedQuantity: 92 }),
    ],
    nowIso: NOW,
  });
  for (const discrepancy of result.discrepancies) {
    assert.equal(
      model.containsCausalClaim(discrepancy.summary),
      false,
      `causal claim: ${discrepancy.summary}`
    );
  }
});

test("SUPPLIER: an overage is reported but never valued as a loss", () => {
  const result = checks.runSupplierCheck({
    shopify: [variant("SKU-X", 0)],
    external: [
      row({ rowNumber: 2, sku: "SKU-X", expectedQuantity: 100, receivedQuantity: 105 }),
    ],
    nowIso: NOW,
  });
  const found = result.discrepancies.find(
    (item) => item.kind === checks.SUPPLIER_KINDS.quantityOverage
  );
  assert.ok(found);
  assert.equal(found.impact.status, "not_quantified");
  assert.match(found.impact.reason, /not a loss/i);
});

test("SUPPLIER: a shortfall IS valued when the file supplies a unit cost", () => {
  const result = checks.runSupplierCheck({
    shopify: [variant("SKU-X", 0)],
    external: [
      row({
        rowNumber: 2,
        sku: "SKU-X",
        expectedQuantity: 100,
        receivedQuantity: 92,
        unitCost: 2.25,
        currency: "GBP",
      }),
    ],
    nowIso: NOW,
  });
  const found = result.discrepancies.find(
    (item) => item.kind === checks.SUPPLIER_KINDS.partialShipment
  );
  assert.equal(found.impact.status, "quantified");
  assert.equal(found.impact.amount, 18);
  assert.equal(found.impact.currency, "GBP");
});

test("SUPPLIER: rows with no SKU are reported, not silently skipped", () => {
  const result = checks.runSupplierCheck({
    shopify: [variant("SKU-X", 0)],
    external: [row({ rowNumber: 5, sku: null, receivedQuantity: 3 })],
    nowIso: NOW,
  });
  const found = result.discrepancies.find(
    (item) => item.kind === checks.SUPPLIER_KINDS.missingSku
  );
  assert.ok(found);
  assert.match(found.evidence.find((e) => e.label === "Rows in your file").value, /5/);
});

test("SUPPLIER: an unexpected SKU is reported", () => {
  const result = checks.runSupplierCheck({
    shopify: [variant("SKU-X", 0)],
    external: [row({ rowNumber: 2, sku: "SKU-ZZ", receivedQuantity: 3 })],
    nowIso: NOW,
  });
  assert.ok(
    result.discrepancies.some((item) => item.kind === checks.SUPPLIER_KINDS.unexpectedSku)
  );
});

test("SUPPLIER: a repeated shipment line is flagged as possible", () => {
  const result = checks.runSupplierCheck({
    shopify: [variant("SKU-X", 0)],
    external: [
      row({ rowNumber: 2, sku: "SKU-X", tracking: "TRK1", receivedQuantity: 10 }),
      row({ rowNumber: 3, sku: "SKU-X", tracking: "TRK1", receivedQuantity: 10 }),
    ],
    nowIso: NOW,
  });
  const found = result.discrepancies.find(
    (item) => item.kind === checks.SUPPLIER_KINDS.duplicateLine
  );
  assert.ok(found);
  assert.equal(found.certainty, "possible");
});

test("SUPPLIER: nothing is ever called late, because no expected date exists", () => {
  const src = readCode(path.join(SRC, "services/reconciliationChecks.ts"));
  assert.doesNotMatch(src, /\blate\b|\bdelayed\b|\boverdue\b/i, "no lateness claim may exist");
  assert.match(
    read(path.join(SRC, "services/reconciliationChecks.ts")),
    /NO INVENTED EXPECTATIONS/,
    "and the reason must be stated where a future author will read it"
  );
});

test("SUPPLIER: no shortfall is claimed when only one quantity is present", () => {
  const result = checks.runSupplierCheck({
    shopify: [variant("SKU-X", 0)],
    external: [row({ rowNumber: 2, sku: "SKU-X", receivedQuantity: 92 })],
    nowIso: NOW,
  });
  assert.equal(
    result.discrepancies.filter(
      (item) =>
        item.kind === checks.SUPPLIER_KINDS.partialShipment ||
        item.kind === checks.SUPPLIER_KINDS.quantityShortfall
    ).length,
    0,
    "one number cannot prove a shortfall"
  );
  assert.ok(result.warnings.some((warning) => /cannot say whether anything is short/.test(warning)));
});

// ===========================================================================
// IMPORT: parsing, mapping, validation
// ===========================================================================

test("IMPORT CSV: quoted fields, embedded commas and CRLF", () => {
  const sheet = parsing.parseCsv(
    'SKU,Description,Qty\r\n"ABC-1","Widget, large",18\r\n"ABC-2","Plain",7\r\n'
  );
  assert.deepEqual(sheet.headers, ["SKU", "Description", "Qty"]);
  assert.deepEqual(sheet.rows, [
    ["ABC-1", "Widget, large", "18"],
    ["ABC-2", "Plain", "7"],
  ]);
});

test("IMPORT CSV: a semicolon export is detected without the merchant knowing", () => {
  const sheet = parsing.parseCsv("SKU;Qty\nABC-1;18\n");
  assert.deepEqual(sheet.headers, ["SKU", "Qty"]);
  assert.deepEqual(sheet.rows, [["ABC-1", "18"]]);
});

test("IMPORT CSV: a doubled quote is an escape, and a BOM is stripped", () => {
  const sheet = parsing.parseCsv('\ufeffSKU,Name\nABC-1,"He said ""hi"""\n');
  assert.deepEqual(sheet.headers, ["SKU", "Name"]);
  assert.deepEqual(sheet.rows, [["ABC-1", 'He said "hi"']]);
});

test("IMPORT: a malformed or empty file is refused with a merchant-readable reason", () => {
  assert.throws(() => parsing.parseCsv("   "), /no rows in it/);
  assert.throws(
    () => parsing.assertFormatMatchesContent("csv", Buffer.from([0x00, 0x01, 0x02])),
    /binary data/
  );
  assert.throws(
    () => parsing.assertFormatMatchesContent("xlsx", Buffer.from("not a zip")),
    /not a valid Excel workbook/
  );
  assert.throws(() => parsing.detectFormat("data.txt"), /reads \.csv and \.xlsx/);
  assert.throws(() => parsing.detectFormat("macros.xlsm"), /Macro-enabled/);
  assert.throws(() => parsing.detectFormat("old.xls"), /older \.xls format/);
});

test("IMPORT: an oversized file is refused before parsing", () => {
  const huge = Buffer.alloc(parsing.MAX_UPLOAD_BYTES + 1, 0x41);
  assert.throws(() => parsing.assertFormatMatchesContent("csv", huge), /larger than/);
});

test("IMPORT: filenames are sanitized, and no path survives", () => {
  assert.equal(parsing.sanitizeFileName("../../etc/passwd"), "passwd");
  assert.equal(parsing.sanitizeFileName("C:\\Users\\me\\stock.csv"), "stock.csv");
  assert.equal(parsing.sanitizeFileName("bad\nname.csv"), "badname.csv");
  assert.equal(parsing.sanitizeFileName(""), "upload");
  assert.equal(parsing.sanitizeFileName("..."), "upload");
  for (const name of ["../x", "a/b/c.csv", "x\\y.csv"]) {
    const cleaned = parsing.sanitizeFileName(name);
    assert.ok(!cleaned.includes("/") && !cleaned.includes("\\"), cleaned);
  }
});

/** Builds a minimal but genuine XLSX so the reader is tested, not a mock. */
function buildXlsx(sheetXml, sharedStringsXml) {
  const files = [
    { name: "xl/worksheets/sheet1.xml", content: Buffer.from(sheetXml, "utf8") },
    ...(sharedStringsXml
      ? [{ name: "xl/sharedStrings.xml", content: Buffer.from(sharedStringsXml, "utf8") }]
      : []),
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

function crc32(buffer) {
  let crc = ~0;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return ~crc >>> 0;
}

test("IMPORT XLSX: a real workbook is read from shared strings and values", () => {
  const shared = `<sst><si><t>SKU</t></si><si><t>Qty</t></si><si><t>ABC-1</t></si></sst>`;
  const sheet = `<worksheet><sheetData>
    <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
    <row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>18</v></c></row>
  </sheetData></worksheet>`;
  const parsed = parsing.parseXlsx(buildXlsx(sheet, shared));
  assert.deepEqual(parsed.headers, ["SKU", "Qty"]);
  assert.deepEqual(parsed.rows, [["ABC-1", "18"]]);
});

test("IMPORT XLSX: a FORMULA is never evaluated — only its cached value is read", () => {
  // The cell carries both a formula and the value Excel last stored. A parser
  // that evaluated the formula could be made to fetch a URL or shell out; this
  // one reads the string and nothing else.
  const shared = `<sst><si><t>SKU</t></si><si><t>Qty</t></si></sst>`;
  const sheet = `<worksheet><sheetData>
    <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
    <row r="2"><c r="A2" t="str"><f>=cmd|'/c calc'!A1</f><v>ABC-1</v></c><c r="B2"><f>SUM(C1:C9)</f><v>42</v></c></row>
    <row r="3"><c r="A3" t="str"><f>=IMPORTXML("http://evil","//a")</f></c><c r="B3"><v>7</v></c></row>
  </sheetData></worksheet>`;
  const parsed = parsing.parseXlsx(buildXlsx(sheet, shared));
  assert.deepEqual(parsed.rows[0], ["ABC-1", "42"], "the cached value, not the formula");
  // A formula with no cached value is empty, not something to compute.
  assert.equal(parsed.rows[1][0], "", "an uncached formula contributes nothing");
  for (const row of parsed.rows) {
    for (const cell of row) {
      assert.ok(!cell.includes("cmd|"), "no formula text may reach a value");
      assert.ok(!cell.includes("IMPORTXML"), "no formula text may reach a value");
    }
  }
});

test("IMPORT XLSX: the reader opens only the parts it needs", () => {
  const src = readCode(path.join(SRC, "services/spreadsheetParsing.ts"));
  assert.match(src, /name === "xl\/sharedStrings\.xml"/);
  // Sheet SELECTION replaced the hardcoded sheet1: the part is resolved from
  // workbook.xml, because part filenames do not reliably match tab order.
  assert.match(src, /name === wantedPart/, "the chosen sheet is read, not sheet1 by name");
  assert.match(src, /name === "xl\/workbook\.xml"/, "the sheet list comes from the workbook");
  assert.doesNotMatch(src, /vbaProject/, "macros are never opened");
  // Formula elements are never parsed out of a cell body.
  assert.doesNotMatch(src, /<f>\(\[\\s\\S\]/, "no formula extraction may exist");
});

test("IMPORT: a zip bomb cannot exhaust memory", () => {
  const src = read(path.join(SRC, "services/spreadsheetParsing.ts"));
  assert.match(src, /totalInflated > 64 \* 1024 \* 1024/, "decompressed size must be bounded");
});

test("MAPPING: exact aliases with the right shape are confident", () => {
  const result = mapping.suggestMapping({
    checkType: "inventory",
    headers: ["Item SKU", "Available", "Warehouse"],
    sampleRows: [["ABC-1", "18", "LON"], ["ABC-2", "7", "LON"]],
  });
  const sku = result.suggestions.find((item) => item.field === "sku");
  const qty = result.suggestions.find((item) => item.field === "quantity");
  assert.equal(sku.confidence, "confident");
  assert.equal(sku.suggestedHeader, "Item SKU");
  assert.equal(qty.confidence, "confident");
  assert.equal(qty.suggestedHeader, "Available");
  assert.equal(result.needsConfirmation, false);
});

test("MAPPING: every listed alias family actually resolves", () => {
  for (const header of ["SKU", "Product SKU", "Item SKU", "Variant SKU"]) {
    const result = mapping.suggestMapping({
      checkType: "inventory",
      headers: [header, "Qty"],
      sampleRows: [["A", "1"]],
    });
    const sku = result.suggestions.find((item) => item.field === "sku");
    assert.equal(sku.suggestedHeader, header, `${header} must map to SKU`);
  }
  for (const header of ["Qty", "Quantity", "Available", "Stock"]) {
    const result = mapping.suggestMapping({
      checkType: "inventory",
      headers: ["SKU", header],
      sampleRows: [["A", "1"]],
    });
    const qty = result.suggestions.find((item) => item.field === "quantity");
    assert.equal(qty.suggestedHeader, header, `${header} must map to quantity`);
  }
  for (const header of ["Order", "Order ID", "Order Number"]) {
    const result = mapping.suggestMapping({
      checkType: "3pl_invoice",
      headers: [header, "Amount"],
      sampleRows: [["1042", "8.00"]],
    });
    const ref = result.suggestions.find((item) => item.field === "orderRef");
    assert.equal(ref.suggestedHeader, header, `${header} must map to order reference`);
  }
});

test("MAPPING: a numeric field over non-numeric values is DOWNGRADED, not accepted", () => {
  // "Quantity" above a column of warehouse names is a mislabelled export.
  const result = mapping.suggestMapping({
    checkType: "inventory",
    headers: ["SKU", "Quantity"],
    sampleRows: [["ABC-1", "London"], ["ABC-2", "Berlin"]],
  });
  const qty = result.suggestions.find((item) => item.field === "quantity");
  assert.equal(qty.confidence, "uncertain");
  assert.match(qty.reason, /do not look like numbers/);
  assert.equal(result.needsConfirmation, true, "a required field in doubt must block");
});

test("MAPPING: two equally plausible columns produce a question, not a pick", () => {
  const result = mapping.suggestMapping({
    checkType: "inventory",
    headers: ["SKU", "Quantity", "Available"],
    sampleRows: [["ABC-1", "18", "12"]],
  });
  const qty = result.suggestions.find((item) => item.field === "quantity");
  assert.equal(qty.confidence, "uncertain");
  assert.equal(qty.suggestedHeader, null, "VedaSuite must not choose between them");
  assert.match(qty.reason, /Choose the one to use/);
});

test("MAPPING: an absent field is reported as absent, not guessed", () => {
  const result = mapping.suggestMapping({
    checkType: "inventory",
    headers: ["SKU", "Qty"],
    sampleRows: [["A", "1"]],
  });
  const cost = result.suggestions.find((item) => item.field === "unitCost");
  assert.equal(cost.confidence, "none");
  assert.equal(cost.suggestedHeader, null);
});

test("MAPPING: a confirmed mapping is validated against the real headers", () => {
  const headers = ["SKU", "Qty"];
  assert.equal(
    mapping.validateMapping({ checkType: "inventory", headers, mapping: { sku: "SKU", quantity: "Qty" } }).ok,
    true
  );

  const missing = mapping.validateMapping({
    checkType: "inventory",
    headers,
    mapping: { sku: "SKU" },
  });
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.missingRequired, ["quantity"]);

  const unknown = mapping.validateMapping({
    checkType: "inventory",
    headers,
    mapping: { sku: "SKU", quantity: "NotAColumn" },
  });
  assert.equal(unknown.ok, false);
  assert.match(unknown.message, /is not a column in this file/);

  const duplicated = mapping.validateMapping({
    checkType: "inventory",
    headers,
    mapping: { sku: "SKU", quantity: "SKU" },
  });
  assert.equal(duplicated.ok, false);
  assert.match(duplicated.message, /more than one field/);
});

test("IMPORT: invalid rows are counted and EXPLAINED", () => {
  const preview = importCalc.buildImportPreview({
    checkType: "inventory",
    headers: ["SKU", "Qty"],
    rows: [
      ["ABC-1", "18"],
      ["", "7"],
      ["ABC-3", "not a number"],
      ["", ""],
    ],
    mapping: { sku: "SKU", quantity: "Qty" },
  });
  assert.equal(preview.validRows, 1);
  assert.equal(preview.invalidRows, 2, "the fully blank row is skipped, not counted");
  const emptySku = preview.rows.find((r) => r.rowNumber === 3);
  assert.match(emptySku.invalidReason, /SKU is empty on this row/);
  const badNumber = preview.rows.find((r) => r.rowNumber === 4);
  assert.match(badNumber.invalidReason, /could not be read as a number/);
});

test("IMPORT: duplicate rows are flagged with the row they repeat", () => {
  const preview = importCalc.buildImportPreview({
    checkType: "inventory",
    headers: ["SKU", "Qty"],
    rows: [["ABC-1", "18"], ["ABC-1", "18"]],
    mapping: { sku: "SKU", quantity: "Qty" },
  });
  assert.equal(preview.duplicateRows, 1);
  assert.equal(preview.rows[1].duplicateOf, 2);
});

test("IMPORT: a missing optional column states its CONSEQUENCE up front", () => {
  const preview = importCalc.buildImportPreview({
    checkType: "inventory",
    headers: ["SKU", "Qty"],
    rows: [["ABC-1", "18"]],
    mapping: { sku: "SKU", quantity: "Qty" },
  });
  const cost = preview.missingOptionalFields.find((f) => f.field === "unitCost");
  assert.ok(cost);
  assert.match(cost.consequence, /units only/);
  assert.match(cost.consequence, /Shopify does not send product cost/);
});

test("IMPORT: an ambiguous date is NOT parsed into a wrong one", () => {
  assert.equal(importCalc.parseObservedAt("03/04/2026"), null, "DD/MM vs MM/DD is a guess");
  assert.equal(importCalc.parseObservedAt(""), null);
  assert.equal(importCalc.parseObservedAt("not a date"), null);
  assert.match(importCalc.parseObservedAt("2026-08-01"), /^2026-08-01/);
  // Excel serial day for 2026-08-01.
  assert.match(importCalc.parseObservedAt("46235"), /^2026-08-0/);
});

test("IMPORT: a currency is never invented", () => {
  assert.equal(importCalc.normalizeCurrency(""), null);
  assert.equal(importCalc.normalizeCurrency("dollars"), null);
  assert.equal(importCalc.normalizeCurrency("usd"), "USD");
  assert.equal(importCalc.normalizeCurrency("$"), "USD");
});

test("IMPORT: numeric parsing handles real exports without inventing values", () => {
  assert.equal(model.parseNumeric("1,234.50"), 1234.5);
  assert.equal(model.parseNumeric("$8.00"), 8);
  assert.equal(model.parseNumeric("(12.50)"), -12.5, "accounting negative");
  assert.equal(model.parseNumeric(""), null);
  assert.equal(model.parseNumeric("n/a"), null);
  assert.equal(model.parseNumeric("12 units"), null, "a partial number is not a number");
});

test("IMPORT: an identifier is normalized for case only, never rewritten", () => {
  assert.equal(model.normalizeKey("  ABC-1 "), "abc-1");
  assert.equal(model.normalizeKey("00123"), "00123", "leading zeros are part of the SKU");
  assert.equal(model.normalizeKey("A-B_C"), "a-b_c", "punctuation is part of the SKU");
  assert.equal(model.normalizeKey(""), null);
  // The one deliberate transformation, applied to BOTH sides.
  assert.equal(model.normalizeOrderRef("#1042"), "1042");
  assert.equal(model.normalizeOrderRef("1042"), "1042");
});

// ===========================================================================
// FINDINGS: grouping, fingerprints, impact
// ===========================================================================

const discrepancy = (over = {}) => ({
  kind: "inventory_quantity_mismatch",
  certainty: "confirmed",
  matchConfidence: "exact",
  subjectKey: "sku-a",
  summary: "Your uploaded file shows 7 units fewer than Shopify for SKU sku-a.",
  shopifyValue: "20",
  externalValue: "13",
  difference: -7,
  impact: { status: "not_quantified", reason: "no cost" },
  evidence: [],
  ...over,
});

test("FINDING: many discrepancies of one kind become ONE finding", () => {
  const findings = findingCalc.buildReconciliationFindings({
    checkType: "inventory",
    discrepancies: [
      discrepancy({ subjectKey: "a" }),
      discrepancy({ subjectKey: "b" }),
      discrepancy({ subjectKey: "c" }),
    ],
  });
  assert.equal(findings.length, 1, "three mismatches are one thing to look at");
  assert.match(findings[0].title, /3 SKUs have inventory mismatches/);
});

test("FINDING: the fingerprint subject carries NO count, amount or timestamp", () => {
  const one = findingCalc.buildReconciliationFindings({
    checkType: "inventory",
    discrepancies: [discrepancy({ subjectKey: "a" })],
  });
  const many = findingCalc.buildReconciliationFindings({
    checkType: "inventory",
    discrepancies: [
      discrepancy({ subjectKey: "a" }),
      discrepancy({ subjectKey: "b", difference: -99 }),
    ],
  });
  assert.equal(
    one[0].subjectKey,
    many[0].subjectKey,
    "a changed count must not mint a new fingerprint"
  );
  assert.doesNotMatch(one[0].subjectKey, /\d{4}-\d{2}-\d{2}|\bT\d{2}:/, "no timestamp");
  assert.equal(one[0].subjectKey, "inventory:inventory_quantity_mismatch");
});

test("FINDING: the group is only as certain as its weakest member", () => {
  assert.equal(
    findingCalc.groupCertainty([discrepancy(), discrepancy({ certainty: "possible" })]),
    "possible"
  );
  assert.equal(
    findingCalc.groupCertainty([
      discrepancy(),
      discrepancy({ certainty: "insufficient_data" }),
    ]),
    "insufficient_data"
  );
  assert.equal(findingCalc.groupCertainty([discrepancy(), discrepancy()]), "confirmed");
});

test("FINDING: an unquantifiable group states no money at all", () => {
  const findings = findingCalc.buildReconciliationFindings({
    checkType: "inventory",
    discrepancies: [discrepancy(), discrepancy({ subjectKey: "b" })],
  });
  assert.equal(findings[0].financialImpact.status, "impact_not_quantifiable");
  assert.equal(findings[0].financialImpact.min, undefined);
});

test("FINDING: a partly quantifiable group says how many rows the figure covers", () => {
  const findings = findingCalc.buildReconciliationFindings({
    checkType: "inventory",
    discrepancies: [
      discrepancy({
        subjectKey: "a",
        impact: { status: "quantified", amount: 31.5, currency: "USD", basis: "x" },
      }),
      discrepancy({ subjectKey: "b" }),
      discrepancy({ subjectKey: "c" }),
    ],
  });
  assert.equal(findings[0].financialImpact.status, "quantified");
  assert.equal(findings[0].financialImpact.min, 31.5);
  assert.match(findings[0].financialImpact.basis, /1 of 3 rows/);
  assert.match(findings[0].financialImpact.basis, /no recorded cost or reference rate/);
});

test("FINDING: mixed currencies are never added together", () => {
  const impact = findingCalc.sumImpact([
    discrepancy({ impact: { status: "quantified", amount: 10, currency: "USD", basis: "x" } }),
    discrepancy({ impact: { status: "quantified", amount: 10, currency: "GBP", basis: "x" } }),
  ]);
  assert.equal(impact.status, "impact_not_quantifiable");
  assert.match(impact.reason, /different currencies/);
});

test("FINDING: every finding answers the five questions", () => {
  const findings = findingCalc.buildReconciliationFindings({
    checkType: "inventory",
    discrepancies: [discrepancy()],
  });
  const finding = findings[0];
  assert.ok(finding.title.length > 10, "WHAT HAPPENED");
  assert.ok(finding.reasons.length >= 2, "WHY IT MATTERS");
  assert.ok(finding.evidence.length >= 3, "WHAT EVIDENCE");
  assert.ok(finding.financialImpact.status, "WHAT IMPACT");
  assert.ok(finding.recommendedAction.length > 10, "WHAT TO DO");
  assert.match(
    finding.recommendedAction,
    /VedaSuite has not changed anything in Shopify|Open each SKU/,
    "and it must be advisory"
  );
});

test("FINDING: a non-confirmed group says so in its own reasons", () => {
  const findings = findingCalc.buildReconciliationFindings({
    checkType: "inventory",
    discrepancies: [discrepancy({ certainty: "possible", matchConfidence: "probable" })],
  });
  assert.equal(findings[0].confidence, "medium");
  assert.ok(
    findings[0].reasons.some((reason) => /not.*full confidence|check rather than.*proven/.test(reason))
  );
});

test("FINDING: no finding copy contains a causal claim", () => {
  const kinds = Object.values({
    ...checks.INVENTORY_KINDS,
    ...checks.INVOICE_KINDS,
    ...checks.SUPPLIER_KINDS,
  });
  for (const kind of kinds) {
    const findings = findingCalc.buildReconciliationFindings({
      checkType: "inventory",
      discrepancies: [discrepancy({ kind })],
    });
    const finding = findings[0];
    for (const sentence of [finding.title, ...finding.reasons, finding.recommendedAction]) {
      assert.equal(
        model.containsCausalClaim(sentence),
        false,
        `causal claim for ${kind}: ${sentence}`
      );
    }
  }
});

test("FINDING: evidence is capped, and the remainder is DECLARED not dropped", () => {
  const many = Array.from({ length: 20 }, (_, index) =>
    discrepancy({ subjectKey: `sku-${index}` })
  );
  const findings = findingCalc.buildReconciliationFindings({
    checkType: "inventory",
    discrepancies: many,
  });
  const notListed = findings[0].evidence.find((e) => e.label === "Not listed here");
  assert.ok(notListed, "silent truncation would read as full coverage");
  assert.match(notListed.value, /12 further rows/);
});

// ===========================================================================
// WIRING: lifecycle, isolation, no Shopify writes
// ===========================================================================

const serviceSrc = read(path.join(SRC, "services/reconciliationService.ts"));
const routeSrc = read(path.join(SRC, "routes/reconciliationRoutes.ts"));

test("WIRING: findings go through the EXISTING lifecycle, not a second one", () => {
  assert.match(serviceSrc, /recordFinding\(\{/, "the shared writer must be used");
  assert.match(serviceSrc, /computeFindingFingerprint\(\{/, "the shared fingerprint must be used");
  // No parallel status vocabulary anywhere.
  assert.doesNotMatch(serviceSrc, /status: "acknowledged"|status: "ignored"|status: "closed"/);
  const findingService = read(path.join(SRC, "services/intelligenceFindingService.ts"));
  assert.match(findingService, /FINDING_STATUSES = \[/);
});

test("WIRING: the same discrepancy twice updates one finding", () => {
  // recordFinding upserts on [storeId, fingerprint] and advances lastSeenAt and
  // detectionCount. The fingerprint is stable, so the second run reconfirms.
  const findingService = read(path.join(SRC, "services/intelligenceFindingService.ts"));
  assert.match(findingService, /detectionCount/, "re-detection must be counted");
  const schema = read(path.resolve(__dirname, "../prisma/schema.prisma"));
  assert.match(schema, /@@unique\(\[storeId, fingerprint\]\)/, "the database must enforce it too");
});

test("WIRING: a disappeared discrepancy is not claimed as merchant-resolved", () => {
  const detectors = read(path.join(SRC, "services/intelligenceDetectorService.ts"));
  const healed = detectors.match(/note: "Automatically closed:[^"]*"/g) ?? [];
  assert.ok(healed.length >= 1, "the healing note must exist");
  for (const note of healed) {
    // Says VedaSuite looked again and the condition has gone. Never that the
    // merchant did anything — nobody observed them doing it.
    assert.match(note, /VedaSuite re-ran this check and the (condition|problem) is no longer present/);
    assert.doesNotMatch(note, /you resolved|merchant resolved|you fixed|resolved by you/i);
  }
});

test("WIRING: every reconciliation query filters on storeId", () => {
  // A join through source would work; the redundancy is deliberate.
  const queries =
    readCode(path.join(SRC, "services/reconciliationService.ts")).match(
      /prisma\.reconciliation\w+\.\w+\(\{[\s\S]*?\n  \}\)/g
    ) ?? [];
  assert.ok(queries.length >= 6, "expected several reconciliation queries");
  for (const query of queries) {
    // A write STAMPS the storeId; a read or an update FILTERS on it. Both are
    // isolation, and both must be present — neither may rely on a join.
    if (/\.create(Many)?\(/.test(query)) {
      assert.match(query, /storeId/, `a write must stamp storeId: ${query.slice(0, 80)}`);
      continue;
    }
    assert.match(
      query,
      /where: \{[\s\S]*?storeId/,
      `query missing a storeId filter: ${query.slice(0, 120)}`
    );
  }
  // Records reachable only through a source still carry their own storeId.
  const schema = read(path.resolve(__dirname, "../prisma/schema.prisma"));
  const record = schema.match(/model ReconciliationRecord \{[\s\S]*?\n\}/);
  assert.match(record[0], /storeId\s+String/, "denormalized for exactly this reason");
});

test("WIRING: the routes trust the SESSION, never a body-supplied shop", () => {
  const routeCode = readCode(path.join(SRC, "routes/reconciliationRoutes.ts"));
  assert.match(routeCode, /function sessionShop/, "a session-only resolver must exist");
  assert.doesNotMatch(
    routeCode,
    /resolveAuthenticatedShop/,
    "the query/body fallback must not be used for upload routes"
  );
  assert.match(routeCode, /shopifySession\?\.shop/);
  // And that resolver reads nothing else.
  const resolver = routeCode.match(/function sessionShop[\s\S]*?\n\}/);
  assert.ok(resolver);
  assert.doesNotMatch(resolver[0], /req\.body|req\.query|req\.params/);
  // Every handler resolves through it.
  const handlers = routeSrc.match(/reconciliationRouter\.(get|post|delete)\(/g) ?? [];
  assert.ok(handlers.length >= 5);
  assert.equal(
    (routeSrc.match(/sessionShop\(req\)/g) ?? []).length >= handlers.length,
    true,
    "each handler must resolve the shop from the session"
  );
});

test("WIRING: the capability gate exists and is one line to reassign", () => {
  assert.match(routeSrc, /capabilities\["reconciliation\.run"\]/);
  const capabilities = read(path.join(SRC, "billing/capabilities.ts"));
  assert.match(capabilities, /"reconciliation\.run"/, "the key must be declared");
  assert.match(
    capabilities,
    /STAGING PLACEHOLDER - THE ONE LINE TO CHANGE WHEN PACKAGING IS DECIDED/,
    "and marked as a placeholder rather than a decision"
  );
});

test("WIRING: existing entitlements are untouched by the new capability", () => {
  const capabilities = read(path.join(SRC, "billing/capabilities.ts"));
  assert.match(capabilities, /const profitModule = isPro;/);
  assert.match(capabilities, /const fraudModule = isStarterTrust \|\| isGrowth \|\| isPro;/);
  assert.match(capabilities, /const pricingModule = isStarterPricing \|\| isGrowth \|\| isPro;/);
});

test("WIRING: nothing in reconciliation writes to Shopify", () => {
  for (const src of [serviceSrc, routeSrc, read(path.join(SRC, "services/reconciliationChecks.ts"))]) {
    assert.doesNotMatch(src, /productUpdate|inventoryAdjust|inventorySetOnHand|orderUpdate/i);
    assert.doesNotMatch(src, /mutation\s/i, "no GraphQL mutation may appear");
  }
  assert.match(serviceSrc, /NO SHOPIFY WRITES/, "and the rule must be stated in the file");
});

test("WIRING: uploaded contents are never logged and never written to disk", () => {
  assert.doesNotMatch(serviceSrc, /writeFile|createWriteStream|mkdtemp|os\.tmpdir/);
  assert.doesNotMatch(routeSrc, /writeFile|createWriteStream|multer|diskStorage/);
  // Log payloads carry SHAPE only: counts and sizes, never a header name and
  // never a cell value. `parsed.headers.length` is a count and is fine;
  // `parsed.headers` would be the merchant's column names.
  const logs = readCode(path.join(SRC, "services/reconciliationService.ts")).match(
    // Terminate at the first closing `});` at ANY indent — these calls sit at
    // two different nesting depths.
    /logEvent\("[^"]+", "[^"]+", \{[\s\S]*?\n\s*\}\);/g
  ) ?? [];
  assert.ok(logs.length >= 4, "expected several log sites");
  for (const entry of logs) {
    for (const forbidden of [
      /headers(?!\.length)/,
      /sampleRows/,
      /contentBase64/,
      // A SIZE is shape; the buffer itself would be content.
      /\bbuffer\b(?!\.length)/i,
      /\brows:/,
      /\bmapping\b/,
      /fileName/,
    ]) {
      assert.doesNotMatch(entry, forbidden, `${forbidden} in: ${entry.slice(0, 120)}`);
    }
  }
});

test("WIRING: no customer identity column exists to carry PII into the engine", () => {
  const schema = read(path.resolve(__dirname, "../prisma/schema.prisma"));
  const recordModel = schema.match(/model ReconciliationRecord \{[\s\S]*?\n\}/);
  assert.ok(recordModel);
  for (const field of ["email", "customerName", "phone", "address", "firstName"]) {
    assert.doesNotMatch(recordModel[0], new RegExp(field, "i"), `${field} must not exist here`);
  }
  const normalized = read(path.join(SRC, "services/reconciliationModel.ts")).match(
    /export interface NormalizedRecord \{[\s\S]*?\n\}/
  );
  assert.ok(normalized);
  for (const field of ["email", "phone", "address", "name:"]) {
    assert.doesNotMatch(normalized[0], new RegExp(field, "i"));
  }
});

test("WIRING: a partial run is never labelled a success", () => {
  assert.match(
    serviceSrc,
    /const status = warnings\.length > 0 \? "completed_with_warnings" : "completed";/
  );
  assert.equal(model.isSuccessfulRunStatus("completed"), true);
  assert.equal(model.isSuccessfulRunStatus("completed_with_warnings"), false);
  assert.equal(model.isSuccessfulRunStatus("failed"), false);
  // Rejected rows always become a warning.
  assert.match(serviceSrc, /rows in this file could not be used and were not reconciled/);
});

test("WIRING: a failed run tells the merchant nothing was changed", () => {
  assert.match(
    serviceSrc,
    /Your uploaded data is unchanged and nothing in Shopify was modified/
  );
  // And the real error never reaches the client.
  assert.match(serviceSrc, /logEvent\("error", "reconciliation\.run_failed"/);
});

test("WIRING: ONE navigation destination, not three", () => {
  const nav = read(path.join(FRONTEND, "layout/navigationModel.js"));
  assert.match(nav, /path: "\/app\/reconciliation"/);
  assert.equal(
    (nav.match(/\/app\/reconciliation/g) ?? []).length >= 2,
    true,
    "registered in NAV_PATHS and the model"
  );
  for (const forbidden of ["3PL Checker", "Inventory Reconciliation", "Supplier Reconciliation"]) {
    assert.ok(!nav.includes(forbidden), `${forbidden} must not be a sidebar entry`);
  }
});

test("WIRING: onboarding explains it without technical language", () => {
  const onboarding = read(path.join(FRONTEND, "modules/Onboarding/OnboardingPage.tsx"));
  assert.match(onboarding, /Compare Shopify with the files you receive from warehouses/);
  const section = onboarding.match(/Check your warehouse and supplier files[\s\S]{0,1200}/);
  assert.ok(section);
  for (const jargon of ["ETL", "pipeline", "normalization", "fingerprint", "reconciliation engine"]) {
    assert.ok(
      !new RegExp(jargon, "i").test(section[0]),
      `"${jargon}" is not merchant language`
    );
  }
});

test("WIRING: the workspace never presents an unquantified row as zero", () => {
  const page = read(path.join(FRONTEND, "modules/Reconciliation/ReconciliationPage.tsx"));
  assert.match(page, /"Not quantified"/);
  assert.match(page, /impactAmount != null/, "the branch must be on presence, not truthiness");
  assert.match(page, /does not determine\s*\n?\s*why they differ/);
});

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const Module = require("node:module");

process.env.SHOPIFY_API_KEY ||= "test-key";
process.env.SHOPIFY_API_SECRET ||= "test-secret";
process.env.SHOPIFY_APP_URL ||= "https://vedasuite-staging.onrender.com";
process.env.SHOPIFY_ADMIN_API_VERSION ||= "2026-01";
process.env.DATABASE_URL ||= "postgresql://example:example@localhost:5432/example";

/**
 * SYSTEM INTEGRITY.
 *
 * Every test here reproduces a failure OBSERVED ON STAGING, not an idealised
 * one. The two that matter most:
 *
 *   - A five-sheet workbook rejected as "That workbook has no rows in it."
 *   - 75 orders, 0 products, and "Everything looks healthy right now."
 */

const d = (p) => path.resolve(__dirname, `../dist/${p}`);
const SRC = path.resolve(__dirname, "../src");
const FRONTEND = path.resolve(__dirname, "../../frontend/src");
const read = (p) => fs.readFileSync(p, "utf8");

const { buildWorkbook, buildSmokeTestWorkbook, zip, sheetXml } = require("./fixtures/buildWorkbook.cjs");
const parsing = require(d("services/spreadsheetParsing.js"));
const stateModel = require(d("services/moduleStateModel.js"));
const capabilities = require(d("billing/capabilities.js"));

// ===========================================================================
// A. THE MULTI-SHEET WORKBOOK — through the REAL HTTP route
// ===========================================================================

/**
 * Mounts the real reconciliation router with the real parser.
 *
 * Only the database layer and the plan lookup are replaced. The upload path,
 * body limits, base64 decoding, format detection and XLSX parsing are all the
 * shipped code — which is the point: the unit tests passed while the route
 * returned 400.
 */
function mountUploadRouter({ plan = "GROWTH", starterModule = null } = {}) {
  const source = path.resolve(__dirname, "../dist/routes/reconciliationRoutes.js");
  const code = fs.readFileSync(source, "utf8");
  const mod = new Module(source);
  mod.filename = source;
  mod.paths = Module._nodeModulePaths(path.dirname(source));
  const original = mod.require.bind(mod);
  const captured = { uploads: [] };

  mod.require = (request) => {
    if (request.endsWith("subscriptionService")) {
      return {
        getCurrentSubscription: async () => ({
          planName: plan,
          starterModule,
          capabilities: capabilities.buildCapabilities(plan, starterModule),
        }),
      };
    }
    if (request.endsWith("reconciliationService")) {
      const real = original(request);
      return {
        ...real,
        // The REAL parser runs; only persistence is replaced.
        uploadReconciliationFile: async (input) => {
          const parsed = original("../services/spreadsheetParsing").parseSpreadsheet({
            fileName: input.fileName,
            buffer: input.buffer,
            sheetName: input.sheetName,
          });
          captured.uploads.push(parsed);
          return {
            sourceId: "src-1",
            fileName: parsed.fileName,
            format: parsed.format,
            headers: parsed.headers,
            sampleRows: parsed.rows.slice(0, 5),
            suggestions: [],
            unmappedHeaders: [],
            needsConfirmation: false,
            totalRows: parsed.rows.length,
            truncated: parsed.truncated,
            availableSheets: parsed.availableSheets,
            sheetName: parsed.sheetName,
          };
        },
        getSourceCheckType: async () => "inventory",
      };
    }
    return original(request);
  };
  mod._compile(code, source);

  const app = express();
  // The same path-scoped limit app.ts installs.
  app.use("/api/reconciliation", express.json({ limit: "8mb" }));
  app.use((req, _res, next) => {
    req.shopifySession = { shop: "integrity-test.myshopify.com" };
    next();
  });
  app.use("/api/reconciliation", mod.exports.reconciliationRouter);
  return { app, captured };
}

function call(app, method, url, body) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, async () => {
      const port = server.address().port;
      try {
        const response = await fetch(`http://127.0.0.1:${port}${url}`, {
          method,
          headers: { "Content-Type": "application/json" },
          body: body ? JSON.stringify(body) : undefined,
        });
        const payload = await response.json().catch(() => ({}));
        server.close(() => resolve({ status: response.status, payload }));
      } catch (error) {
        server.close(() => reject(error));
      }
    });
  });
}

/** Encodes exactly as the browser does, chunked to avoid a stack overflow. */
function encodeLikeBrowser(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return Buffer.from(binary, "binary").toString("base64");
}

test("A: the five-sheet staging workbook uploads through the real route", async () => {
  const { app, captured } = mountUploadRouter();
  const result = await call(app, "POST", "/api/reconciliation/upload", {
    checkType: "inventory",
    fileName: "VedaSuite Reconciliation Samples.xlsx",
    contentBase64: encodeLikeBrowser(buildSmokeTestWorkbook()),
  });

  assert.equal(result.status, 200, JSON.stringify(result.payload));
  assert.deepEqual(result.payload.result.availableSheets, [
    "Inventory",
    "3PL Rate Card",
    "3PL Invoice",
    "Supplier Shipment",
    "README",
  ]);
  assert.equal(result.payload.result.sheetName, "Inventory");
  assert.equal(result.payload.result.totalRows, 3);
  assert.deepEqual(result.payload.result.headers, [
    "Item SKU",
    "Available",
    "Warehouse",
    "Unit Cost",
    "Currency",
  ]);
});

test("A: an instructions-only FIRST sheet no longer rejects the workbook", () => {
  // THE STAGING FAILURE. Tab one was a README, and the whole upload 400'd with
  // "That workbook has no rows in it" while four populated sheets sat beside
  // it — and the 400 gave the merchant no way to pick a different sheet.
  const workbook = buildWorkbook([
    { name: "README", rows: [] },
    { name: "Notes", rows: [] },
    { name: "Inventory", rows: [["SKU", "Qty"], ["SKU-A", 13]] },
  ]);
  const parsed = parsing.parseXlsx(workbook);
  assert.equal(parsed.sheetName, "Inventory", "it must advance to a sheet with rows");
  assert.equal(parsed.rows.length, 1);
  assert.deepEqual(parsed.availableSheets, ["README", "Notes", "Inventory"]);
});

test("A: a NAMESPACED writer is enumerated instead of silently yielding none", async () => {
  // ROOT CAUSE. OOXML permits <sheet> and <x:sheet> to mean the same thing.
  // The unprefixed-only regex matched NOTHING against a prefixed workbook, so
  // enumeration returned zero sheets, `chosen` was null, and the merchant got
  // the exact message reported: "That workbook has no rows in it."
  const shared = [];
  const populated = sheetXml([["SKU", "Qty"], ["SKU-A", 13]], shared).replace(
    /<(\/?)(worksheet|sheetData|row|c|v)/g,
    "<$1x:$2"
  );
  const empty = sheetXml([], []).replace(/<(\/?)(worksheet|sheetData)/g, "<$1x:$2");
  const XML = '<?xml version="1.0"?>';
  const workbook =
    XML +
    '<x:workbook xmlns:x="a" xmlns:r="b"><x:sheets>' +
    '<x:sheet name="README" sheetId="1" r:id="rId1"/>' +
    '<x:sheet name="Inventory" sheetId="2" r:id="rId2"/>' +
    "</x:sheets></x:workbook>";
  const rels =
    XML +
    '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/>' +
    '<Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>';
  const sst =
    XML +
    "<x:sst>" +
    shared.map((v) => `<x:si><x:t>${v}</x:t></x:si>`).join("") +
    "</x:sst>";

  const buffer = zip([
    { name: "[Content_Types].xml", content: "<Types/>", stored: true },
    { name: "xl/workbook.xml", content: workbook },
    { name: "xl/_rels/workbook.xml.rels", content: rels },
    { name: "xl/worksheets/sheet1.xml", content: empty },
    { name: "xl/worksheets/sheet2.xml", content: populated },
    { name: "xl/sharedStrings.xml", content: sst },
  ]);

  const sheets = parsing.listWorksheets(buffer);
  assert.equal(sheets.length, 2, "a prefixed workbook must still enumerate");
  const parsed = parsing.parseXlsx(buffer);
  assert.equal(parsed.sheetName, "Inventory");
  assert.equal(parsed.rows.length, 1);

  // And end to end, over HTTP.
  const { app } = mountUploadRouter();
  const result = await call(app, "POST", "/api/reconciliation/upload", {
    checkType: "inventory",
    fileName: "prefixed.xlsx",
    contentBase64: encodeLikeBrowser(buffer),
  });
  assert.equal(result.status, 200, JSON.stringify(result.payload));
  assert.deepEqual(result.payload.result.availableSheets, ["README", "Inventory"]);
});

test("A: sheet selection works over the real route", async () => {
  const { app } = mountUploadRouter();
  const base64 = encodeLikeBrowser(buildSmokeTestWorkbook());
  const result = await call(app, "POST", "/api/reconciliation/upload", {
    checkType: "inventory",
    fileName: "samples.xlsx",
    contentBase64: base64,
    sheetName: "Supplier Shipment",
  });
  assert.equal(result.status, 200, JSON.stringify(result.payload));
  assert.equal(result.payload.result.sheetName, "Supplier Shipment");
  assert.deepEqual(result.payload.result.headers, [
    "SKU",
    "Ordered Qty",
    "Received Qty",
    "Tracking Number",
  ]);
});

test("A: enumeration falls back to worksheet parts rather than giving up", () => {
  // A writer whose workbook part this reader cannot understand at all. The
  // worksheets are still in the archive, so the merchant gets a usable list
  // instead of an empty-workbook error.
  const shared = [];
  const populated = sheetXml([["SKU", "Qty"], ["A", 1]], shared);
  const buffer = zip([
    { name: "[Content_Types].xml", content: "<Types/>", stored: true },
    { name: "xl/workbook.xml", content: "<nonsense/>" },
    { name: "xl/worksheets/sheet1.xml", content: populated },
    {
      name: "xl/sharedStrings.xml",
      content: "<sst>" + shared.map((v) => `<si><t>${v}</t></si>`).join("") + "</sst>",
    },
  ]);
  const sheets = parsing.listWorksheets(buffer);
  assert.equal(sheets.length, 1, "the parts themselves are the fallback");
  assert.equal(parsing.parseXlsx(buffer).rows.length, 1);
});

test("A: a workbook where NO sheet has rows still fails, and names them", () => {
  assert.throws(
    () =>
      parsing.parseXlsx(
        buildWorkbook([
          { name: "One", rows: [] },
          { name: "Two", rows: [] },
        ])
      ),
    /None of the sheets in that workbook have any rows \(One, Two\)/
  );
});

// ===========================================================================
// B–E, K. THE STATE MODEL — 75 orders, 0 products
// ===========================================================================

const EVIDENCE = {
  authFailed: false,
  syncFailed: false,
  syncPartial: false,
  neverSynced: false,
  products: 0,
  variantsWithSku: 0,
  orders: 0,
  eligibleOrders: 0,
  customers: 0,
  competitorRowsFresh: 0,
  competitorDomainsConfigured: 0,
  priceRows: 0,
  profitRowsWithObservedCost: 0,
  reconciliationRuns: 0,
};

const ALL_ENTITLED = {
  customerLoss: true,
  pricing: true,
  productProfit: true,
  marketSignals: true,
  reconciliation: true,
};

const THRESHOLDS = { customerLossMinOrders: 50 };

const derive = (evidence, entitlements = ALL_ENTITLED, findingCounts = {}) =>
  stateModel.deriveModuleStates({
    evidence: { ...EVIDENCE, ...evidence },
    entitlements,
    thresholds: THRESHOLDS,
    findingCounts,
  });

const stateOf = (states, module) =>
  states.find((s) => s.module === module)?.state;

test("C: 75 orders and 0 products is NOT 'everything healthy'", () => {
  // THE EXACT STAGING STORE.
  const states = derive(
    {
      orders: 75,
      eligibleOrders: 75,
      customers: 40,
      products: 0,
      priceRows: 0,
      syncPartial: true,
    },
    ALL_ENTITLED,
    { customerLoss: 0 }
  );

  assert.equal(stateOf(states, "pricing"), "INSUFFICIENT_DATA");
  assert.equal(stateOf(states, "productProfit"), "INSUFFICIENT_DATA");

  const health = stateModel.deriveGlobalHealth(states);
  assert.notEqual(health.health, "HEALTHY", "this store is not healthy");
  assert.equal(health.health, "PARTIAL");
  assert.doesNotMatch(health.headline, /everything looks healthy/i);
  assert.match(health.headline, /could not be evaluated/);
  // And it NAMES the modules, so the merchant knows what is unaccounted for.
  assert.ok(health.couldNotRun.includes("pricing"));
  assert.ok(health.couldNotRun.includes("productProfit"));
});

test("C: the reason names the ACTUAL missing input", () => {
  const states = derive({ orders: 75, eligibleOrders: 75, customers: 40 });
  const pricing = states.find((s) => s.module === "pricing");
  assert.match(pricing.reason, /no products have synced from Shopify/);
  assert.ok(pricing.missing.includes("no products have synced from Shopify"));
});

test("D: zero products is distinguishable from a FAILED product sync", () => {
  // Genuinely empty catalogue: the check cannot run, but nothing is broken.
  const empty = stateModel.deriveGlobalHealth(
    derive({ orders: 75, eligibleOrders: 75, customers: 40, products: 0 })
  );
  assert.equal(empty.health, "PARTIAL");

  // A failed sync: a different state entirely, and a different remedy.
  const failed = stateModel.deriveGlobalHealth(
    derive({ orders: 75, eligibleOrders: 75, customers: 40, syncFailed: true })
  );
  assert.equal(failed.health, "BLOCKED");
  assert.match(failed.headline, /sync failed/i);
  assert.notEqual(empty.health, failed.health, "these must never be conflated");
});

test("E: an auth failure is distinguishable from missing data", () => {
  const auth = stateModel.deriveGlobalHealth(derive({ authFailed: true, products: 10 }));
  assert.equal(auth.health, "BLOCKED");
  assert.match(auth.headline, /cannot reach Shopify/i);
  assert.equal(stateOf(derive({ authFailed: true }), "pricing"), "AUTH_FAILED");

  // vs the same store with a working connection and no products.
  const data = stateModel.deriveGlobalHealth(derive({ orders: 75, eligibleOrders: 75, customers: 1 }));
  assert.notEqual(data.health, "BLOCKED");
});

test("K: one failing module does not erase the ones that succeeded", () => {
  const states = derive(
    {
      orders: 75,
      eligibleOrders: 75,
      customers: 40,
      products: 0,
      competitorDomainsConfigured: 2,
      competitorRowsFresh: 2,
    },
    ALL_ENTITLED,
    { customerLoss: 3, marketSignals: 0 }
  );

  assert.equal(stateOf(states, "customerLoss"), "READY_WITH_FINDINGS");
  assert.equal(stateOf(states, "marketSignals"), "READY_NO_FINDINGS");
  assert.equal(stateOf(states, "pricing"), "INSUFFICIENT_DATA");

  const health = stateModel.deriveGlobalHealth(states);
  assert.equal(health.health, "ATTENTION_REQUIRED");
  assert.ok(health.ran.includes("customerLoss"), "successes survive");
  assert.ok(health.ran.includes("marketSignals"));
  // And the partial failure is still reported.
  assert.ok(health.couldNotRun.includes("pricing"));
  assert.ok(health.detail.some((d) => /no products have synced/.test(d)));
});

test("HEALTHY requires that every EXPECTED check actually ran", () => {
  const everything = derive({
    orders: 75,
    eligibleOrders: 75,
    customers: 40,
    products: 20,
    variantsWithSku: 20,
    priceRows: 20,
    profitRowsWithObservedCost: 5,
    competitorDomainsConfigured: 1,
    competitorRowsFresh: 1,
    reconciliationRuns: 1,
  });
  const health = stateModel.deriveGlobalHealth(everything);
  assert.equal(health.health, "HEALTHY");
  assert.match(health.headline, /All 5 checks ran successfully/);
  assert.deepEqual(health.couldNotRun, []);
});

test("a plan exclusion does NOT make a store look unhealthy", () => {
  // A Starter merchant has no Reconciliation. That is a boundary, not a fault.
  const states = derive(
    {
      orders: 75,
      eligibleOrders: 75,
      customers: 40,
      products: 20,
      priceRows: 20,
      profitRowsWithObservedCost: 5,
      competitorDomainsConfigured: 1,
      competitorRowsFresh: 1,
    },
    { ...ALL_ENTITLED, reconciliation: false, productProfit: false }
  );
  assert.equal(stateOf(states, "reconciliation"), "FEATURE_NOT_INCLUDED");
  const health = stateModel.deriveGlobalHealth(states);
  assert.equal(health.health, "HEALTHY", "an unsold module is not a failure");
  assert.ok(!health.couldNotRun.includes("reconciliation"));
});

test("NOT_RUN is distinct from INSUFFICIENT_DATA", () => {
  assert.equal(stateOf(derive({ neverSynced: true }), "pricing"), "NOT_RUN");
  assert.equal(
    stateOf(derive({ orders: 75, eligibleOrders: 75, customers: 1 }), "pricing"),
    "INSUFFICIENT_DATA"
  );
});

test("PARTIAL_DATA is reported when a module ran on an incomplete sync", () => {
  const states = derive({
    orders: 75,
    eligibleOrders: 75,
    customers: 0,
    products: 20,
    priceRows: 20,
    syncPartial: true,
  });
  assert.equal(stateOf(states, "pricing"), "PARTIAL_DATA");
  assert.match(
    states.find((s) => s.module === "pricing").reason,
    /did not deliver all of your Shopify data/
  );
});

test("the sync status itself no longer masks a missing dimension", () => {
  const src = read(path.join(SRC, "services/storeOperationalStateService.ts"));
  assert.match(src, /SUMMING THESE WAS THE BUG/);
  assert.match(src, /const partiallyPopulated = rawResourceCount > 0 && dimensionsPresent < 3/);
  assert.match(src, /partiallyPopulated$/m, "the flag must reach the caller");

  const derived = require(d("services/storeOperationalStateService.js")).deriveSyncStatus({
    latestSyncJobStatus: "SUCCEEDED",
    products: 0,
    orders: 75,
    customers: 40,
    priceRows: 0,
    profitRows: 0,
    timelineEvents: 12,
  });
  assert.equal(derived.status, "READY_WITH_DATA", "analysis can still proceed");
  assert.equal(derived.partiallyPopulated, true);
  assert.match(derived.reason, /no products have synced/);
  assert.doesNotMatch(derived.reason, /insights are ready\.$/);
});

// ===========================================================================
// F. ACTION CENTER PROPAGATION
// ===========================================================================

test("F: the brief cannot claim checks ran when they did not", () => {
  const brief = require(d("services/intelligenceBriefService.js"));
  const health = stateModel.deriveGlobalHealth(
    derive({ orders: 75, eligibleOrders: 75, customers: 40 }, ALL_ENTITLED, {})
  );

  const result = brief.buildDeterministicBrief([], {
    totalOpen: 0,
    bySeverity: { critical: 0, high: 0, medium: 0, low: 0 },
    byStatus: {},
    quantifiedImpact: [],
    notQuantifiedCount: 0,
    staleCount: 0,
    incompleteDataCount: 0,
    degradedCount: 0,
    capReached: false,
    moduleHealth: health,
    generatedAt: "2026-08-26T12:00:00.000Z",
  });

  assert.doesNotMatch(
    result.bullets.join(" "),
    /All checks ran with the data available/,
    "this was the false claim"
  );
  assert.match(result.headline, /could not run|No findings from the checks that ran/);
});

test("F: with everything genuinely healthy the brief still says so", () => {
  const brief = require(d("services/intelligenceBriefService.js"));
  const health = stateModel.deriveGlobalHealth(
    derive({
      orders: 75,
      eligibleOrders: 75,
      customers: 40,
      products: 20,
      priceRows: 20,
      profitRowsWithObservedCost: 5,
      competitorDomainsConfigured: 1,
      competitorRowsFresh: 1,
      reconciliationRuns: 1,
    })
  );
  const result = brief.buildDeterministicBrief([], {
    totalOpen: 0,
    bySeverity: { critical: 0, high: 0, medium: 0, low: 0 },
    byStatus: {},
    quantifiedImpact: [],
    notQuantifiedCount: 0,
    staleCount: 0,
    incompleteDataCount: 0,
    degradedCount: 0,
    capReached: false,
    moduleHealth: health,
    generatedAt: "2026-08-26T12:00:00.000Z",
  });
  assert.match(result.headline, /Nothing needs your attention/);
});

test("F: the canonical health is derived ONCE and passed to the feed", () => {
  const route = read(path.join(SRC, "routes/actionCenterRoutes.ts"));
  assert.match(route, /const health = await getStoreHealth\(\{ storeId: store\.id/);
  assert.match(route, /moduleHealth: health\.global/);
  // And exposed, so no surface has to recompute it.
  assert.match(route, /health: \{\s*\n?\s*global: health\.global/);

  const service = read(path.join(SRC, "services/actionCenterService.ts"));
  // The feed does NOT derive readiness itself.
  assert.doesNotMatch(service, /deriveModuleStates|deriveGlobalHealth/);
});

test("F: Customer Loss findings reach the feed through the normal filter", () => {
  const service = read(path.join(SRC, "services/actionCenterService.ts"));
  // Entitlement is the ONLY filter between a stored finding and the feed.
  assert.match(service, /if \(capability !== null && !enabled\.has\(capability\)\) continue;/);
  const { MODULE_CAPABILITY } = require(d("services/explainabilityCalc.js"));
  assert.equal(MODULE_CAPABILITY.fraud, "fraud");
  assert.equal(MODULE_CAPABILITY.return_abuse, "fraud");
  assert.equal(MODULE_CAPABILITY.trust, "fraud");

  // A store health snapshot counts the SAME modules the feed shows, so
  // "Customer Loss has findings" and "Action Center is empty" cannot coexist.
  const health = read(path.join(SRC, "services/storeHealthService.ts"));
  assert.match(health, /fraud: "customerLoss"/);
  assert.match(health, /return_abuse: "customerLoss"/);
  assert.match(health, /status: \{ in: \["new", "seen", "in_review"\] \}/);
});

test("F: a module with findings can never report READY_NO_FINDINGS", () => {
  const states = derive(
    { orders: 75, eligibleOrders: 75, customers: 40 },
    ALL_ENTITLED,
    { customerLoss: 4 }
  );
  const customerLoss = states.find((s) => s.module === "customerLoss");
  assert.equal(customerLoss.state, "READY_WITH_FINDINGS");
  assert.equal(customerLoss.findingCount, 4);
  const health = stateModel.deriveGlobalHealth(states);
  assert.equal(health.health, "ATTENTION_REQUIRED");
  assert.match(health.headline, /4 items need your attention/);
});

// ===========================================================================
// J. A DENIED OPTIONAL SCOPE CANNOT BREAK PRODUCT SYNC
// ===========================================================================

test("J: the product query needs only read_products", () => {
  const scopeState = require(d("services/shopifyScopeState.js"));
  const legacy = "read_products,read_orders,write_orders,read_customers";
  const capability = scopeState.inventoryCapability(legacy);
  assert.equal(capability.storeWide, true, "no reauthorization needed");
  assert.equal(capability.perLocation, false);

  const src = read(path.join(SRC, "services/shopifyAdminService.ts"));
  const start = src.indexOf("products(first: $first");
  const query = src.slice(start, src.indexOf("`", start)).replace(/^\s*#.*$/gm, "");
  assert.match(query, /inventoryQuantity/, "restored: read_products covers it");
  assert.doesNotMatch(query, /inventoryLevels/, "the scoped part stays out");
});

test("J: the per-location sync is isolated and cannot throw", () => {
  const src = read(path.join(SRC, "services/shopifyInventoryLevels.ts"));
  assert.match(src, /NEVER THROWS/);
  assert.doesNotMatch(src, /throw new/);
  const sync = read(path.join(SRC, "services/shopifyAdminService.ts"));
  const call = sync.indexOf("const inventoryLevels = await syncInventoryLevels");
  const persist = sync.indexOf("syncCounts.saved.ordersCreated");
  assert.ok(call > persist, "it runs after the sync has committed");
});

// ===========================================================================
// L. SESSION / STORE SCOPING
// ===========================================================================

test("L: every reconciliation route resolves the shop from the session only", () => {
  const src = read(path.join(SRC, "routes/reconciliationRoutes.ts"));
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(code, /resolveAuthenticatedShop/);
  const resolver = code.match(/function sessionShop[\s\S]*?\n\}/)[0];
  assert.doesNotMatch(resolver, /req\.body|req\.query/);
});

test("L: store health reads are scoped to one store", () => {
  const src = read(path.join(SRC, "services/storeHealthService.ts"));
  const queries = src.match(/prisma\.\w+\.\w+\(\{[\s\S]*?\}\)/g) ?? [];
  assert.ok(queries.length >= 8, "expected several counts");
  for (const query of queries) {
    assert.ok(
      /storeId/.test(query),
      `a store-health query is not scoped: ${query.slice(0, 80)}`
    );
  }
});

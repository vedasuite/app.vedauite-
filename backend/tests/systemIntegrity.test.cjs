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
  // The SAFE wrapper: a health-derivation failure must never blank the
  // page a merchant opens to find out something is wrong.
  assert.match(route, /const health = await getStoreHealthSafe\(\{ storeId: store\.id/);
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
  assert.match(health.headline, /4 open findings need your attention/);
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

// ===========================================================================
// PART TWO — the contradictions from the SECOND round of screenshots
// ===========================================================================

const productResource = require(d("services/productResourceState.js"));
const vocabulary = require(d("services/findingVocabulary.js"));

test("TEST A: 75 orders + product sync FAILED is PARTIAL, never healthy", () => {
  const states = derive(
    { orders: 75, eligibleOrders: 75, customers: 9, products: 0, syncPartial: true },
    ALL_ENTITLED,
    { customerLoss: 0 }
  );
  const health = stateModel.deriveGlobalHealth(states);
  assert.notEqual(health.health, "HEALTHY");
  assert.equal(stateModel.healthyIsPermitted(states), false);

  // Pricing must say the sync FAILED, not that the store has no products.
  const resource = productResource.resolveProductResourceState({
    productsPersisted: 0,
    productResourceStatus: "FAILED",
    everSynced: true,
    authFailed: false,
  });
  assert.equal(resource.state, "PRODUCT_SYNC_FAILED");
  assert.equal(resource.inspected, false, "VedaSuite never saw the catalogue");
  assert.match(resource.message, /not the same as your store having no products/);

  // Reconciliation must NOT claim the products have no SKUs.
  const sku = productResource.describeSkuAvailability({
    product: resource,
    variantsInspected: 0,
    variantsWithSku: 0,
  });
  assert.equal(sku.ready, false);
  assert.match(sku.reason, /could not evaluate Shopify SKUs/);
  assert.doesNotMatch(sku.reason, /have no SKUs/, "that would be an invented fact");

  const inventory = productResource.describeInventoryAvailability({
    product: resource,
    variantsWithInventory: 0,
    permissionMissingReason: null,
  });
  assert.match(inventory.reason, /could not evaluate Shopify stock levels/);
});

test("TEST B: a genuinely empty catalogue is NOT reported as a failure", () => {
  const resource = productResource.resolveProductResourceState({
    productsPersisted: 0,
    productResourceStatus: "SUCCESS_EMPTY",
    everSynced: true,
    authFailed: false,
  });
  assert.equal(resource.state, "NO_PRODUCTS");
  assert.equal(resource.inspected, true, "VedaSuite did look");
  assert.match(resource.message, /Shopify returned no products/);
  assert.doesNotMatch(resource.message, /did not complete|failed/i);

  const sku = productResource.describeSkuAvailability({
    product: resource,
    variantsInspected: 0,
    variantsWithSku: 0,
  });
  assert.match(sku.reason, /catalogue is empty/);
});

test("TEST B: the four causes of zero products are all distinguishable", () => {
  const cases = [
    [{ productResourceStatus: "FAILED", everSynced: true }, "PRODUCT_SYNC_FAILED"],
    [{ productResourceStatus: "SUCCESS_EMPTY", everSynced: true }, "NO_PRODUCTS"],
    [{ productResourceStatus: null, everSynced: false }, "PRODUCT_SYNC_NOT_RUN"],
    [{ productResourceStatus: null, everSynced: true }, "UNKNOWN"],
  ];
  const seen = new Set();
  for (const [input, expected] of cases) {
    const result = productResource.resolveProductResourceState({
      productsPersisted: 0,
      authFailed: false,
      ...input,
    });
    assert.equal(result.state, expected, JSON.stringify(input));
    seen.add(result.message);
  }
  assert.equal(seen.size, 4, "each cause must have its own explanation");

  // And auth failure outranks all of them.
  assert.equal(
    productResource.resolveProductResourceState({
      productsPersisted: 0,
      productResourceStatus: "FAILED",
      everSynced: true,
      authFailed: true,
    }).state,
    "AUTH_FAILED"
  );
});

test("TEST B: SKUs are only ever declared absent after actually looking", () => {
  const present = productResource.resolveProductResourceState({
    productsPersisted: 20,
    productResourceStatus: "SUCCESS",
    everSynced: true,
    authFailed: false,
  });
  const sku = productResource.describeSkuAvailability({
    product: present,
    variantsInspected: 20,
    variantsWithSku: 0,
  });
  // THIS is the only case where the claim is legitimate.
  assert.match(sku.reason, /checked 20 product variants and none of them have a SKU/);
});

test("TEST C: 4 review items + 0 findings is coherent, not contradictory", () => {
  const explanation = vocabulary.explainReviewItemsVersusFindings({
    reviewItems: 4,
    findings: 0,
    findingThresholdDescription: vocabulary.CUSTOMER_LOSS_THRESHOLD_DESCRIPTION,
  });
  assert.match(explanation, /4 orders are worth a look/);
  assert.match(explanation, /none of them add up to a finding/);
  assert.match(explanation, /why Action Center is empty while this list is not/);

  // Only findings reach Action Center. Stated as code.
  assert.equal(vocabulary.appearsInActionCenter("finding"), true);
  assert.equal(vocabulary.appearsInActionCenter("review_item"), false);
  assert.equal(vocabulary.appearsInActionCenter("signal"), false);
});

test("TEST C: the page no longer calls review items actions needing attention", () => {
  const page = read(path.join(FRONTEND, "modules/TrustAbuse/TrustAbusePage.tsx"));
  const code = page.replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
  assert.doesNotMatch(code, /Actions that need attention now/);
  assert.match(code, /Orders to review/);
  assert.match(code, /to review/);
  // And it explains the relationship rather than leaving two counts to clash.
  assert.match(code, /None of them add up to a finding yet/);
});

test("TEST D: a qualifying finding is counted identically everywhere", () => {
  const states = derive(
    { orders: 75, eligibleOrders: 75, customers: 9 },
    ALL_ENTITLED,
    { customerLoss: 1 }
  );
  const customerLoss = states.find((s) => s.module === "customerLoss");
  assert.equal(customerLoss.state, "READY_WITH_FINDINGS");
  assert.equal(customerLoss.findingCount, 1);

  const health = stateModel.deriveGlobalHealth(states);
  assert.equal(health.health, "ATTENTION_REQUIRED");
  assert.match(health.headline, /1 open finding needs your attention/);

  const healthSrc = read(path.join(SRC, "services/storeHealthService.ts"));
  assert.match(healthSrc, /new/);
  assert.match(healthSrc, /in_review/);
});

test("TEST E: no competitor domains is AWAITING_CONFIGURATION, not failed", () => {
  const states = derive({
    orders: 75,
    eligibleOrders: 75,
    customers: 9,
    competitorDomainsConfigured: 0,
  });
  const market = states.find((s) => s.module === "marketSignals");
  assert.equal(market.state, "AWAITING_CONFIGURATION");
  assert.match(market.reason, /waiting for you/);
  assert.match(market.reason, /add a competitor website/);
  assert.equal(stateModel.isFailure(market.state), false, "not a failure");
  assert.equal(stateModel.isAwaitingMerchant(market.state), true);
});

test("TEST F: reconciliation never run is AWAITING_INPUT, not failed", () => {
  const states = derive({ orders: 75, eligibleOrders: 75, customers: 9 });
  const recon = states.find((s) => s.module === "reconciliation");
  assert.equal(recon.state, "AWAITING_INPUT");
  assert.match(recon.reason, /upload a warehouse, supplier or 3PL file/);
  assert.equal(stateModel.isFailure(recon.state), false);
});

test("TEST E+F: awaiting modules are reported separately from broken ones", () => {
  const states = derive(
    { orders: 75, eligibleOrders: 75, customers: 9, products: 0 },
    ALL_ENTITLED,
    { customerLoss: 0 }
  );
  const health = stateModel.deriveGlobalHealth(states);
  assert.ok(health.couldNotRun.includes("pricing"));
  assert.ok(health.awaitingMerchant.includes("marketSignals"));
  assert.ok(health.awaitingMerchant.includes("reconciliation"));
  assert.ok(!health.couldNotRun.includes("marketSignals"));
  assert.match(health.headline, /could not be evaluated/);
  assert.match(health.headline, /waiting for you/);
});

test("a store where everything is merely awaiting setup is not broken", () => {
  const states = derive(
    {
      orders: 75,
      eligibleOrders: 75,
      customers: 9,
      products: 20,
      priceRows: 20,
      profitRowsWithObservedCost: 3,
    },
    { ...ALL_ENTITLED, pricing: false, productProfit: false, customerLoss: false }
  );
  const health = stateModel.deriveGlobalHealth(states);
  assert.equal(health.health, "AWAITING_SETUP");
  assert.match(health.headline, /ready when you are/);
});

test("INVARIANT: HEALTHY is impossible while any entitled module is not READY", () => {
  const blocking = [
    "AUTH_FAILED",
    "SYNC_FAILED",
    "PARTIAL_DATA",
    "INSUFFICIENT_DATA",
    "PERMISSION_LIMITED",
    "NOT_RUN",
    "AWAITING_CONFIGURATION",
    "AWAITING_INPUT",
  ];
  for (const state of blocking) {
    const states = [
      {
        module: "customerLoss",
        state: "READY_NO_FINDINGS",
        reason: "",
        missing: [],
        findingCount: 0,
      },
      { module: "pricing", state, reason: "x", missing: [], findingCount: 0 },
    ];
    assert.equal(
      stateModel.healthyIsPermitted(states),
      false,
      `${state} must block HEALTHY`
    );
    assert.notEqual(
      stateModel.deriveGlobalHealth(states).health,
      "HEALTHY",
      `${state} must block HEALTHY`
    );
  }

  // FEATURE_NOT_INCLUDED is the ONLY state that does not block it.
  const excluded = [
    {
      module: "customerLoss",
      state: "READY_NO_FINDINGS",
      reason: "",
      missing: [],
      findingCount: 0,
    },
    {
      module: "pricing",
      state: "FEATURE_NOT_INCLUDED",
      reason: "",
      missing: [],
      findingCount: 0,
    },
  ];
  assert.equal(stateModel.healthyIsPermitted(excluded), true);
  assert.equal(stateModel.deriveGlobalHealth(excluded).health, "HEALTHY");
});

test("Store Overview renders the canonical verdict, not a diff-derived one", () => {
  const page = read(path.join(FRONTEND, "modules/Dashboard/DashboardPage.tsx"));
  const code = page.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

  assert.doesNotMatch(code, /Everything looks healthy right now/);
  assert.match(code, /canonicalHealth/);
  assert.match(code, /Analysis completed/);
});

test("the dashboard payload carries the canonical verdict", () => {
  const service = read(path.join(SRC, "services/dashboardService.ts"));
  assert.match(service, /const storeHealth = await getStoreHealthSafe\(\{/);
  assert.match(service, /health: storeHealth\.global/);
  assert.match(service, /reason: storeHealth\.global\.headline/);
  // It does NOT derive its own.
  assert.doesNotMatch(service, /deriveModuleStates|deriveGlobalHealth/);
});

test("a product failure cannot be masked by order success", () => {
  const src = read(path.join(SRC, "services/shopifyAdminService.ts"));
  assert.match(src, /A SYNC IS NOT ONE BOOLEAN/);
  assert.match(src, /const resourceStatus: Record</);
  assert.match(src, /shopify\.sync\.products_failed/);
  assert.match(src, /const status = anyResourceFailed/);
  assert.match(src, /SUCCEEDED_PARTIAL/);
});

test("each resource reports its own outcome", () => {
  const src = read(path.join(SRC, "services/shopifyAdminService.ts"));
  for (const resource of [
    "products",
    "orders",
    "customers",
    "lineItems",
    "inventoryLevels",
  ]) {
    assert.match(
      src,
      new RegExp(`resourceStatus\\.${resource}\\.status`),
      `${resource} must carry its own status`
    );
  }
  assert.match(src, /resourcesFailed: resourceFailed\.map/);
});

test("diagnostics answer the 75-orders/0-products question without a database", () => {
  const src = read(path.join(SRC, "routes/syncDiagnosticsRoutes.ts"));
  for (const field of [
    "productsPersisted",
    "variantsPersisted",
    "variantsWithSku",
    "variantsWithInventoryQuantity",
    "ordersPersisted",
    "lineItemsPersisted",
    "customersPersisted",
    "productDiagnosis",
    "resourceStatus",
    "missingRequired",
  ]) {
    assert.ok(src.includes(field), `diagnostics must expose ${field}`);
  }
  for (const code of [
    "PRODUCT_SYNC_NOT_RUN",
    "PRODUCT_SYNC_FAILED",
    "PRODUCTS_PRESENT",
    "NO_PRODUCTS_IN_SHOPIFY",
    "PRODUCT_STATUS_UNKNOWN",
  ]) {
    assert.ok(src.includes(code), `diagnostics must be able to report ${code}`);
  }
});

test("diagnostics expose NO sensitive data", () => {
  const src = read(path.join(SRC, "routes/syncDiagnosticsRoutes.ts"));
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const forbidden of [
    "accessToken",
    "refreshToken",
    "email",
    "phone",
    "defaultAddress",
    "firstName",
    "apiSecret",
  ]) {
    assert.doesNotMatch(
      code,
      new RegExp(forbidden),
      `${forbidden} must never be returned`
    );
  }
  assert.match(code, /function sessionShop/);
  assert.doesNotMatch(code, /req\.query\.shop|req\.body\.shop/);
});

test("diagnostics are store-scoped", () => {
  const src = read(path.join(SRC, "routes/syncDiagnosticsRoutes.ts"));
  const queries = src.match(/prisma\.\w+\.count\(\{[\s\S]*?\}\)/g) ?? [];
  assert.ok(queries.length >= 8);
  for (const query of queries) {
    assert.ok(/storeId/.test(query), `unscoped: ${query.slice(0, 60)}`);
  }
});

test("no active surface uses retired vocabulary", () => {
  const offenders = [];
  const scan = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scan(full);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      const code = read(full)
        .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      for (const [pattern, label] of [
        [/Open dashboard/, "Open dashboard"],
        [/Everything looks healthy/, "Everything looks healthy"],
        [/Fraud Intelligence/, "Fraud Intelligence"],
        [/Trust & Abuse/, "Trust & Abuse"],
      ]) {
        if (pattern.test(code)) {
          offenders.push(`${path.relative(FRONTEND, full)}: ${label}`);
        }
      }
    }
  };
  scan(FRONTEND);
  assert.deepEqual(offenders, [], offenders.join("\n"));
});

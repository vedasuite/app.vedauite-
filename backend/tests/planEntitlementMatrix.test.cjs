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
 * THE CROSS-PLAN MATRIX.
 *
 * FRONTEND HIDING IS NOT SECURITY. Half of this file drives the real Express
 * router with a real HTTP request, because the question that matters is not
 * "does the tile render" but "what happens when a Starter merchant types the
 * URL or curls the endpoint".
 */

const d = (p) => path.resolve(__dirname, `../dist/${p}`);
const SRC = path.resolve(__dirname, "../src");
const FRONTEND = path.resolve(__dirname, "../../frontend/src");
const read = (p) => fs.readFileSync(p, "utf8");

const backend = require(d("billing/capabilities.js"));

/** Every plan/module combination a merchant can actually be in. */
const PERSONAS = {
  none: { plan: "NONE", starterModule: null },
  starterFraud: { plan: "STARTER", starterModule: "fraud" },
  starterCompetitor: { plan: "STARTER", starterModule: "competitor" },
  starterPricing: { plan: "STARTER", starterModule: "pricing" },
  growth: { plan: "GROWTH", starterModule: null },
  pro: { plan: "PRO", starterModule: null },
};

const capsFor = (persona, options) =>
  backend.buildCapabilities(persona.plan, persona.starterModule, options);

// ===========================================================================
// STARTER
// ===========================================================================

test("STARTER: Action Center and store health are never gated", () => {
  const { MODULE_CAPABILITY } = require(d("services/explainabilityCalc.js"));
  // A null capability means always visible — that is what carries store-health
  // findings to every merchant regardless of plan, including no plan at all.
  assert.equal(MODULE_CAPABILITY.operational, null);
  assert.equal(MODULE_CAPABILITY.reconciliation, null);

  const nav = read(path.join(FRONTEND, "layout/navigationModel.js"));
  assert.match(nav, /"\/app\/action-center",/);
  const ungated = nav.match(/export const UNGATED_PATHS = \[[\s\S]*?\]/)[0];
  assert.match(ungated, /\/app\/action-center/);
  assert.match(ungated, /\/app\/dashboard/);
});

test("STARTER: exactly ONE intelligence module, and the others are gated", () => {
  const fraud = capsFor(PERSONAS.starterFraud);
  assert.equal(fraud["module.trustAbuse"], true, "the selected one");
  assert.equal(fraud["module.competitorIntel"], false);
  assert.equal(fraud["module.pricingProfit"], false);

  const competitor = capsFor(PERSONAS.starterCompetitor);
  assert.equal(competitor["module.competitorIntel"], true);
  assert.equal(competitor["module.trustAbuse"], false);
  assert.equal(competitor["module.pricingProfit"], false);

  const pricing = capsFor(PERSONAS.starterPricing);
  assert.equal(pricing["module.pricingProfit"], true);
  assert.equal(pricing["module.trustAbuse"], false);
  assert.equal(pricing["module.competitorIntel"], false);
});

test("STARTER: NO reconciliation of any kind, whichever module is selected", () => {
  for (const key of ["starterFraud", "starterCompetitor", "starterPricing"]) {
    const caps = capsFor(PERSONAS[key]);
    assert.equal(caps["reconciliation.inventory"], false, key);
    assert.equal(caps["reconciliation.supplier"], false, key);
    assert.equal(caps["reconciliation.invoice"], false, key);
    assert.equal(caps["reconciliation.rateCard"], false, key);
  }
});

test("STARTER: no Product Profit intelligence", () => {
  for (const key of ["starterFraud", "starterCompetitor", "starterPricing"]) {
    const caps = capsFor(PERSONAS[key]);
    assert.equal(caps["pricing.profitLeakDetector"], false, key);
    assert.equal(caps["pricing.marginAtRisk"], false, key);
    assert.equal(caps["pricing.dailyActionBoard"], false, key);
  }
});

// ===========================================================================
// GROWTH
// ===========================================================================

test("GROWTH: all three intelligence modules, no selection needed", () => {
  const caps = capsFor(PERSONAS.growth);
  assert.equal(caps["module.trustAbuse"], true);
  assert.equal(caps["module.competitorIntel"], true);
  assert.equal(caps["module.pricingProfit"], true);
});

test("GROWTH: inventory and supplier reconciliation, but NOT 3PL", () => {
  const caps = capsFor(PERSONAS.growth);
  assert.equal(caps["reconciliation.inventory"], true);
  assert.equal(caps["reconciliation.supplier"], true);
  assert.equal(caps["reconciliation.invoice"], false, "3PL auditing is Pro");
  assert.equal(caps["reconciliation.rateCard"], false, "rate cards are Pro");
});

test("GROWTH: no Product Profit intelligence — it stays Pro-only", () => {
  const caps = capsFor(PERSONAS.growth);
  assert.equal(caps["pricing.profitLeakDetector"], false);
  assert.equal(caps["pricing.marginAtRisk"], false);
  assert.equal(caps["pricing.advancedModes"], false);
});

// ===========================================================================
// PRO
// ===========================================================================

test("PRO: everything Growth has, plus 3PL and Product Profit", () => {
  const growth = capsFor(PERSONAS.growth);
  const pro = capsFor(PERSONAS.pro);

  // Pro is a strict superset — no capability is lost by upgrading.
  for (const [key, value] of Object.entries(growth)) {
    if (value === true) {
      assert.equal(pro[key], true, `Pro must not lose ${key}`);
    }
  }

  assert.equal(pro["reconciliation.inventory"], true);
  assert.equal(pro["reconciliation.supplier"], true);
  assert.equal(pro["reconciliation.invoice"], true);
  assert.equal(pro["reconciliation.rateCard"], true);
  assert.equal(pro["pricing.profitLeakDetector"], true);
  assert.equal(pro["pricing.marginAtRisk"], true);
});

test("NO PLAN: no paid capability at all", () => {
  const caps = capsFor(PERSONAS.none);
  for (const key of [
    "reconciliation.inventory",
    "reconciliation.supplier",
    "reconciliation.invoice",
    "reconciliation.rateCard",
    "module.trustAbuse",
    "module.competitorIntel",
    "module.pricingProfit",
  ]) {
    assert.equal(caps[key], false, key);
  }
  // Settings stays open on every plan, including none.
  assert.equal(caps["settings.view"], true);
});

// ===========================================================================
// TRIAL
// ===========================================================================

test("TRIAL: grants the SELECTED plan's entitlements, never all of them", () => {
  // The plan-selected trial model. A Starter trial is a Starter trial.
  const starterTrial = capsFor(PERSONAS.starterFraud, { trialActive: true });
  assert.equal(starterTrial["reconciliation.inventory"], false);
  assert.equal(starterTrial["module.competitorIntel"], false);
  assert.equal(starterTrial["billing.trialActive"], true, "only the copy changes");

  const growthTrial = capsFor(PERSONAS.growth, { trialActive: true });
  assert.equal(growthTrial["reconciliation.inventory"], true);
  assert.equal(growthTrial["reconciliation.invoice"], false);

  const proTrial = capsFor(PERSONAS.pro, { trialActive: true });
  assert.equal(proTrial["reconciliation.invoice"], true);
  assert.equal(proTrial["reconciliation.rateCard"], true);
});

test("TRIAL: a trial never widens a plan's capabilities", () => {
  for (const persona of Object.values(PERSONAS)) {
    const withoutTrial = capsFor(persona);
    const withTrial = capsFor(persona, { trialActive: true });
    for (const [key, value] of Object.entries(withTrial)) {
      if (key === "billing.trialActive") continue;
      assert.equal(
        value,
        withoutTrial[key],
        `${persona.plan}/${persona.starterModule}: ${key} changed under trial`
      );
    }
  }
});

test("TRIAL: a legacy standalone TRIAL plan row collapses to nothing", () => {
  const caps = backend.buildCapabilities("TRIAL", null, { trialActive: true });
  assert.equal(caps["reconciliation.inventory"], false);
  assert.equal(caps["module.trustAbuse"], false);
});

// ===========================================================================
// PLAN SWITCHING
// ===========================================================================

test("SWITCHING: Starter -> Growth -> Pro only ever adds", () => {
  const starter = capsFor(PERSONAS.starterFraud);
  const growth = capsFor(PERSONAS.growth);
  const pro = capsFor(PERSONAS.pro);

  for (const [key, value] of Object.entries(starter)) {
    if (value === true && key !== "billing.moduleSelectionStarter") {
      assert.equal(growth[key], true, `upgrading lost ${key}`);
    }
  }
  for (const [key, value] of Object.entries(growth)) {
    if (value === true) assert.equal(pro[key], true, `upgrading lost ${key}`);
  }
});

test("SWITCHING: Pro -> Growth -> Starter revokes exactly the right things", () => {
  const pro = capsFor(PERSONAS.pro);
  const growth = capsFor(PERSONAS.growth);
  const starter = capsFor(PERSONAS.starterFraud);

  // Downgrading Pro to Growth removes 3PL and Product Profit, nothing else.
  const lostFromPro = Object.keys(pro).filter((key) => pro[key] && !growth[key]);
  assert.deepEqual(
    lostFromPro.sort(),
    [
      "competitor.advancedReports",
      "pricing.advancedAutomation",
      "pricing.advancedModes",
      "pricing.dailyActionBoard",
      "pricing.marginAtRisk",
      "pricing.profitLeakDetector",
      "pricing.scenarioSimulator",
      "reconciliation.invoice",
      "reconciliation.rateCard",
      "trust.advancedAutomation",
      "trust.refundOutcomeSimulator",
      "trust.supportCopilot",
      "trust.trustRecoveryEngine",
    ].sort()
  );

  // Downgrading Growth to Starter removes both reconciliation checks.
  assert.equal(starter["reconciliation.inventory"], false);
  assert.equal(starter["reconciliation.supplier"], false);
});

test("SWITCHING: entitlement is a pure function of plan + module", () => {
  // No caching, no ordering effect: the same inputs give the same answer, so a
  // plan change takes effect on the next request rather than the next deploy.
  const a = capsFor(PERSONAS.growth);
  const b = capsFor(PERSONAS.growth);
  assert.deepEqual(a, b);
  const src = read(path.join(SRC, "billing/capabilities.ts"));
  assert.doesNotMatch(src, /new Map\(|globalThis\.|let cached/);
});

// ===========================================================================
// BACKWARD COMPATIBILITY
// ===========================================================================

test("LEGACY: old starterModule values still resolve", () => {
  // Existing Starter merchants carry "fraud" / "competitor" / "pricing" in the
  // database. The merchant-facing names changed; the stored values must not.
  const src = read(path.join(SRC, "billing/capabilities.ts"));
  assert.match(src, /export type StarterModule = "fraud" \| "competitor" \| "pricing"/);
  assert.match(src, /normalizedStarterModule === "fraud"/);
  assert.match(src, /normalizedStarterModule === "competitor"/);
  assert.match(src, /normalizedStarterModule === "pricing"/);

  for (const [value, capability] of [
    ["fraud", "module.trustAbuse"],
    ["competitor", "module.competitorIntel"],
    ["pricing", "module.pricingProfit"],
  ]) {
    const caps = backend.buildCapabilities("STARTER", value);
    assert.equal(caps[capability], true, `${value} must still grant ${capability}`);
  }
});

test("LEGACY: no existing capability key was renamed or removed", () => {
  // Renaming one would silently revoke access for every current subscriber.
  const caps = capsFor(PERSONAS.pro);
  for (const key of [
    "module.trustAbuse",
    "module.competitorIntel",
    "module.pricingProfit",
    "pricing.basicRecommendations",
    "pricing.profitLeakDetector",
    "pricing.marginAtRisk",
    "competitor.advancedReports",
    "reports.view",
    "reports.export",
    "settings.view",
    "billing.planManagement",
    "billing.moduleSelectionStarter",
  ]) {
    assert.ok(key in caps, `${key} must still exist`);
  }
});

test("LEGACY: no plan price or Shopify identifier changed", () => {
  const src = read(path.join(SRC, "billing/capabilities.ts"));
  // This file assigns capabilities. It must not be where prices live.
  assert.doesNotMatch(src, /price:\s*\d/);
  assert.doesNotMatch(src, /shopifyChargeId/);
});

// ===========================================================================
// API ENFORCEMENT — the real router, over real HTTP
// ===========================================================================

/**
 * Mounts the reconciliation router with a stubbed subscription lookup.
 *
 * The ROUTER is real. The only thing replaced is what plan the shop is on,
 * which is exactly the variable under test.
 */
function mountRouter(persona) {
  const source = path.resolve(__dirname, "../dist/routes/reconciliationRoutes.js");
  const code = fs.readFileSync(source, "utf8");
  const mod = new Module(source);
  // filename must be set or relative requires cannot resolve.
  mod.filename = source;
  mod.paths = Module._nodeModulePaths(path.dirname(source));
  const original = mod.require.bind(mod);

  mod.require = (request) => {
    if (request.endsWith("subscriptionService")) {
      return {
        getCurrentSubscription: async () => ({
          planName: persona.plan,
          starterModule: persona.starterModule,
          capabilities: backend.buildCapabilities(
            persona.plan,
            persona.starterModule
          ),
        }),
      };
    }
    if (request.endsWith("reconciliationService")) {
      // Every handler that gets past the gate is a test failure for a denied
      // persona, so these throw loudly rather than returning plausible data.
      const reached = () => {
        throw new Error("REACHED_SERVICE");
      };
      return {
        getReconciliationWorkspace: async () => ({ ok: true }),
        uploadReconciliationFile: reached,
        confirmMapping: reached,
        runReconciliation: reached,
        deleteReconciliationSource: reached,
        getSourceCheckType: async () => null,
      };
    }
    if (request.endsWith("rateCardService")) {
      const reached = () => {
        throw new Error("REACHED_SERVICE");
      };
      return {
        listRateCards: reached,
        saveRateCard: reached,
        suggestRateCardMapping: reached,
      };
    }
    return original(request);
  };
  mod._compile(code, source);

  const app = express();
  app.use(express.json({ limit: "8mb" }));
  app.use((req, _res, next) => {
    req.shopifySession = { shop: "matrix-test.myshopify.com" };
    next();
  });
  app.use("/api/reconciliation", mod.exports.reconciliationRouter);
  return app;
}

/** Issues a real request against the mounted app. */
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

const UPLOAD = (checkType) => ({
  checkType,
  fileName: "x.csv",
  contentBase64: Buffer.from("SKU,Qty\nA,1\n").toString("base64"),
});

test("API: STARTER is DENIED inventory reconciliation", async () => {
  const app = mountRouter(PERSONAS.starterFraud);
  const result = await call(app, "POST", "/api/reconciliation/upload", UPLOAD("inventory"));
  assert.equal(result.status, 403, "typing the URL must not work");
  assert.equal(result.payload.error.code, "FEATURE_NOT_INCLUDED");
  assert.equal(result.payload.error.requiredPlan, "GROWTH");
  assert.match(result.payload.error.message, /included on Growth and Pro/);
});

test("API: STARTER is DENIED supplier, 3PL and rate cards", async () => {
  const app = mountRouter(PERSONAS.starterPricing);
  for (const checkType of ["supplier_shipment", "3pl_invoice"]) {
    const result = await call(
      app,
      "POST",
      "/api/reconciliation/upload",
      UPLOAD(checkType)
    );
    assert.equal(result.status, 403, checkType);
  }
  const cards = await call(app, "GET", "/api/reconciliation/rate-cards");
  assert.equal(cards.status, 403);
  const save = await call(app, "POST", "/api/reconciliation/rate-card", {
    name: "x",
    fileName: "x.csv",
    contentBase64: "",
    mapping: {},
  });
  assert.equal(save.status, 403);
});

test("API: GROWTH is ALLOWED inventory and supplier", async () => {
  const app = mountRouter(PERSONAS.growth);
  for (const checkType of ["inventory", "supplier_shipment"]) {
    const result = await call(
      app,
      "POST",
      "/api/reconciliation/upload",
      UPLOAD(checkType)
    );
    // Past the gate: the stub throws REACHED_SERVICE, which the router turns
    // into a 500. A 403 here would mean the gate wrongly refused.
    assert.notEqual(result.status, 403, `${checkType} must be allowed on Growth`);
  }
});

test("API: GROWTH is DENIED 3PL invoice and rate cards", async () => {
  const app = mountRouter(PERSONAS.growth);
  const invoice = await call(
    app,
    "POST",
    "/api/reconciliation/upload",
    UPLOAD("3pl_invoice")
  );
  assert.equal(invoice.status, 403, "curling the endpoint must not work");
  assert.equal(invoice.payload.error.requiredPlan, "PRO");

  for (const [method, url, body] of [
    ["GET", "/api/reconciliation/rate-cards", null],
    ["POST", "/api/reconciliation/rate-card/inspect", { fileName: "x.csv", contentBase64: "" }],
    ["POST", "/api/reconciliation/rate-card", { name: "x", fileName: "x.csv", contentBase64: "", mapping: {} }],
  ]) {
    const result = await call(app, method, url, body);
    assert.equal(result.status, 403, `${method} ${url} must be denied on Growth`);
    assert.equal(result.payload.error.requiredPlan, "PRO");
  }
});

test("API: PRO is ALLOWED everything", async () => {
  const app = mountRouter(PERSONAS.pro);
  for (const checkType of ["inventory", "supplier_shipment", "3pl_invoice"]) {
    const result = await call(
      app,
      "POST",
      "/api/reconciliation/upload",
      UPLOAD(checkType)
    );
    assert.notEqual(result.status, 403, checkType);
  }
  const cards = await call(app, "GET", "/api/reconciliation/rate-cards");
  assert.notEqual(cards.status, 403);
});

test("API: a bogus check type is refused rather than defaulted", async () => {
  const app = mountRouter(PERSONAS.pro);
  const result = await call(
    app,
    "POST",
    "/api/reconciliation/upload",
    UPLOAD("something_else")
  );
  assert.equal(result.status, 400);
  assert.match(result.payload.error.message, /not recognised/);
});

test("API: no session means no access, before any plan check", async () => {
  const src = read(path.join(SRC, "routes/reconciliationRoutes.ts"));
  assert.match(src, /REAUTHORIZE_REQUIRED/);
  // The shop is never taken from the body. Comments are stripped because the
  // one explaining WHY resolveAuthenticatedShop is unsuitable names it.
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(code, /resolveAuthenticatedShop/);
  const resolver = code.match(/function sessionShop[\s\S]*?\n\}/)[0];
  assert.doesNotMatch(resolver, /req\.body|req\.query/);
});

test("API: the check type is read from the DATABASE, not the request", async () => {
  // Otherwise a Growth merchant could post checkType:"inventory" alongside a
  // 3PL sourceId and have the gate approve the wrong thing.
  const src = read(path.join(SRC, "routes/reconciliationRoutes.ts"));
  assert.match(src, /const sourceCheckType = await getSourceCheckType\(shop, sourceId\)/);
  const service = read(path.join(SRC, "services/reconciliationService.ts"));
  const fn = service.match(/export async function getSourceCheckType[\s\S]*?\n\}/)[0];
  assert.match(fn, /where: \{ id: sourceId, storeId \}/, "and scoped to the store");
});

// ===========================================================================
// FRONTEND / BACKEND AGREEMENT
// ===========================================================================

test("UI: the frontend mirror agrees with the backend on every persona", () => {
  const frontendSrc = read(path.join(FRONTEND, "lib/billingCapabilities.ts"));
  for (const key of [
    "reconciliation.inventory",
    "reconciliation.supplier",
    "reconciliation.invoice",
    "reconciliation.rateCard",
  ]) {
    assert.match(frontendSrc, new RegExp(`"${key.replace(".", "\\.")}"`), key);
  }
  // Same derivation, so the tile and the endpoint cannot disagree.
  assert.match(frontendSrc, /const reconciliationStandard = isGrowth \|\| isPro;/);
  assert.match(frontendSrc, /const reconciliationAdvanced = isPro;/);
  const backendSrc = read(path.join(SRC, "billing/capabilities.ts"));
  assert.match(backendSrc, /const reconciliationStandard = isGrowth \|\| isPro;/);
  assert.match(backendSrc, /const reconciliationAdvanced = isPro;/);
});

test("UI: the workspace is drawn from the authoritative entitlement", () => {
  const service = read(path.join(SRC, "services/reconciliationService.ts"));
  assert.match(service, /const subscription = await getCurrentSubscription\(shopDomain\)/);
  assert.match(service, /entitled,/);
  assert.match(service, /requiredPlan: entitled \? null : CHECK_REQUIRED_PLAN\[checkType\]/);

  const page = read(path.join(FRONTEND, "modules/Reconciliation/ReconciliationPage.tsx"));
  // The page reads the backend's answer; it does not re-derive one.
  assert.match(page, /entry\?\.entitled !== false/);
  assert.doesNotMatch(page, /planName === "GROWTH"|plan === "PRO"/);
});

test("UI: an unavailable check shows an UPGRADE state, not an empty workspace", () => {
  const page = read(path.join(FRONTEND, "modules/Reconciliation/ReconciliationPage.tsx"));
  assert.match(page, /Upgrade to \$\{/);
  assert.match(page, /url="\/app\/billing"/);
  assert.match(page, /Not included on your plan/);
});

test("UI: rate cards are withheld from the payload without the capability", () => {
  const service = read(path.join(SRC, "services/reconciliationService.ts"));
  assert.match(
    service,
    /subscription\.capabilities\["reconciliation\.rateCard"\] === true\s*\n?\s*\? rateCards\s*\n?\s*: \[\]/
  );
});

test("UI: ONE navigation destination for all three checks", () => {
  const nav = read(path.join(FRONTEND, "layout/navigationModel.js"));
  assert.equal((nav.match(/path: "\/app\/reconciliation"/g) ?? []).length, 1);
  for (const forbidden of ["Inventory Reconciliation", "3PL Checker", "Supplier Reconciliation"]) {
    assert.ok(!nav.includes(forbidden), forbidden);
  }
});

// ===========================================================================
// ACTION CENTER BY PLAN
// ===========================================================================

test("ACTION CENTER: a finding is hidden when its module is not entitled", () => {
  const src = read(path.join(SRC, "services/actionCenterService.ts"));
  assert.match(
    src,
    /if \(capability !== null && !enabled\.has\(capability\)\) continue;/,
    "entitlement must filter the feed"
  );
});

test("ACTION CENTER: store-health and reconciliation findings are never gated", () => {
  const { MODULE_CAPABILITY } = require(d("services/explainabilityCalc.js"));
  assert.equal(MODULE_CAPABILITY.operational, null);
  // Reconciliation findings can only EXIST if the merchant ran a check they
  // were entitled to, so the API gate is what controls them. Gating the
  // finding a second time would hide evidence a paying merchant generated and
  // then downgraded away from, which is worse than showing it.
  assert.equal(MODULE_CAPABILITY.reconciliation, null);
});

// ===========================================================================
// BILLING COPY
// ===========================================================================

const billing = read(path.join(FRONTEND, "modules/SubscriptionPlans/PricingPage.tsx"));

test("BILLING: no phantom feature is advertised", () => {
  for (const phantom of [
    "Multi-store",
    "Priority processing",
    "Priority support",
    "White label",
    "API access",
    "Unlimited",
  ]) {
    assert.ok(
      !new RegExp(phantom, "i").test(billing),
      `"${phantom}" is not implemented and must not be sold`
    );
  }
});

test("BILLING: no retired vocabulary and no AI claim", () => {
  assert.ok(!/Fraud Intelligence/i.test(billing));
  assert.ok(!/Trust & Abuse/.test(billing));
  assert.ok(!/\bAI[- ]/.test(billing), "no unsupported AI claim");
});

test("BILLING: every advertised capability corresponds to a real key", () => {
  // Each plan's bullets name things the capability map actually grants.
  const starter = billing.match(/STARTER: \{[\s\S]*?\n  \},/)[0];
  assert.match(starter, /Action Center/);
  assert.match(starter, /choose one/);
  assert.match(starter, /Reconciliation — Growth/, "Starter must not claim it");
  assert.match(starter, /3PL invoice auditing — Pro/);

  const growth = billing.match(/GROWTH: \{[\s\S]*?\n  \},/)[0];
  assert.match(growth, /Inventory reconciliation — included/);
  assert.match(growth, /Supplier shipment reconciliation — included/);
  assert.match(growth, /3PL invoice auditing — Pro/, "Growth must not claim it");
  assert.match(growth, /Product Profit intelligence — Pro/);

  const pro = billing.match(/PRO: \{[\s\S]*?\n  \},/)[0];
  assert.match(pro, /3PL invoice auditing and rate cards — included/);
  assert.match(pro, /Product Profit intelligence — included/);
});

test("BILLING: prices are unchanged", () => {
  assert.match(billing, /priceLabel: "\$19\/month"/);
  assert.match(billing, /priceLabel: "\$49\/month"/);
  assert.match(billing, /priceLabel: "\$99\/month"/);
});

test("BILLING: nothing is advertised that the API would refuse", () => {
  // The strong form: for each plan, every "— included" bullet must map to a
  // capability that persona actually has.
  const claims = [
    ["growth", "Inventory reconciliation", "reconciliation.inventory"],
    ["growth", "Supplier shipment reconciliation", "reconciliation.supplier"],
    ["pro", "3PL invoice auditing and rate cards", "reconciliation.invoice"],
    ["pro", "Product Profit intelligence", "pricing.profitLeakDetector"],
  ];
  for (const [personaKey, label, capability] of claims) {
    const caps = capsFor(PERSONAS[personaKey]);
    assert.equal(
      caps[capability],
      true,
      `Billing says ${personaKey} gets "${label}" but ${capability} is false`
    );
  }
  // And the converse: Growth is told 3PL is Pro, and it is.
  assert.equal(capsFor(PERSONAS.growth)["reconciliation.invoice"], false);
});

// ===========================================================================
// SETTINGS
// ===========================================================================

test("SETTINGS: uses the shared capability map, not a second matrix", () => {
  const src = read(path.join(FRONTEND, "modules/Settings/SettingsPage.tsx"));
  assert.match(src, /buildCapabilities\(/);
  assert.match(src, /capabilities\["reconciliation\.inventory"\]/);
  // No hand-rolled plan logic in this file.
  assert.doesNotMatch(src, /planName === "GROWTH" \?|plan === "PRO" \?/);
});

test("SETTINGS: reports reconciliation access truthfully", () => {
  const src = read(path.join(FRONTEND, "modules/Settings/SettingsPage.tsx"));
  assert.match(src, /Inventory — included/);
  assert.match(src, /Inventory — Growth/);
  assert.match(src, /3PL invoice — Pro/);
  assert.match(src, /Rate cards — Pro/);
});

// ===========================================================================
// ONBOARDING
// ===========================================================================

test("ONBOARDING: marks upgrade-only checks as such", () => {
  const src = read(path.join(FRONTEND, "modules/Onboarding/OnboardingPage.tsx"));
  assert.match(src, /Inventory and supplier shipment checks are included on Growth/);
  assert.match(src, /3PL invoice auditing[\s\S]{0,80}included\s*\n?\s*on Pro/);
});

test("ONBOARDING: describes the current product without jargon", () => {
  const src = read(path.join(FRONTEND, "modules/Onboarding/OnboardingPage.tsx"));
  assert.match(src, /Compare Shopify with warehouse, supplier and 3PL records/);
  const section = src.match(/VedaSuite finds the differences[\s\S]{0,900}/)[0];
  for (const jargon of ["ETL", "pipeline", "reconciliation engine", "normalization"]) {
    assert.ok(!new RegExp(jargon, "i").test(section), jargon);
  }
});

// ===========================================================================
// SHOPIFY SCOPES AND REAUTHORIZATION
// ===========================================================================

const scopeState = require(d("services/shopifyScopeState.js"));

/** What every existing installed merchant granted, before this pass. */
const LEGACY_GRANT = "read_products,read_orders,write_orders,read_customers";
/** What a merchant who reconnects after this pass grants. */
const UPGRADED_GRANT = `${LEGACY_GRANT},read_inventory,read_locations`;

test("SCOPES: store-wide inventory works on the LEGACY grant", () => {
  // The correction that matters. ProductVariant.inventoryQuantity requires
  // read_products, which every merchant has always granted — so the core
  // Shopify-vs-warehouse comparison needs no reauthorization at all.
  const capability = scopeState.inventoryCapability(LEGACY_GRANT);
  assert.equal(capability.storeWide, true, "no reauthorization needed for this");
  assert.equal(capability.perLocation, false);
  assert.equal(capability.locationIdentity, false);
  assert.deepEqual(capability.missingOptional, ["read_inventory", "read_locations"]);
  assert.equal(capability.upgradeAvailable, true);
});

test("SCOPES: per-location needs the new grants, and says so", () => {
  const upgraded = scopeState.inventoryCapability(UPGRADED_GRANT);
  assert.equal(upgraded.storeWide, true);
  assert.equal(upgraded.perLocation, true);
  assert.equal(upgraded.locationIdentity, true);
  assert.deepEqual(upgraded.missingOptional, []);
  assert.equal(upgraded.upgradeAvailable, false);
});

test("SCOPES: read_inventory alone also unlocks location identity", () => {
  // Documented: Location requires read_locations OR read_inventory.
  const capability = scopeState.inventoryCapability(`${LEGACY_GRANT},read_inventory`);
  assert.equal(capability.perLocation, true);
  assert.equal(capability.locationIdentity, true);
});

test("SCOPES: nothing REQUIRED is missing for an existing merchant", () => {
  // The distinction that decides whether a merchant is pushed to reconnect.
  assert.deepEqual(scopeState.missingRequiredScopes(LEGACY_GRANT), []);
  assert.deepEqual(scopeState.missingRequiredScopes(UPGRADED_GRANT), []);
  // A genuinely broken grant IS reported.
  assert.deepEqual(
    scopeState.missingRequiredScopes("read_orders"),
    ["read_products", "write_orders", "read_customers"]
  );
});

test("SCOPES: the reauthorization prompt is optional and honest", () => {
  const message = scopeState.describeMissingScopes(["read_inventory", "read_locations"]);
  assert.match(message, /total Shopify stock/);
  assert.match(message, /not location by location/);
  assert.match(message, /reconnecting the app/);
  assert.match(message, /Everything else keeps working/);
  // It attributes the gap to VedaSuite, never to the merchant's setup.
  assert.doesNotMatch(message, /your (inventory )?(tracking )?is (broken|off|misconfigured)/i);
  assert.equal(scopeState.describeMissingScopes([]), null, "nothing to say when granted");
});

test("SCOPES: a NULL quantity is distinguished from a missing permission", () => {
  const legacy = scopeState.inventoryCapability(LEGACY_GRANT);
  // Permitted to look, Shopify reported nothing: the merchant does not track it.
  assert.equal(
    scopeState.inventorySourceFor({ capability: legacy, reported: null }),
    "not_tracked"
  );
  // Permitted, and a real figure — including a real ZERO.
  assert.equal(
    scopeState.inventorySourceFor({ capability: legacy, reported: 0 }),
    "ok",
    "zero is a measurement, not an absence"
  );
  assert.equal(
    scopeState.inventorySourceFor({ capability: legacy, reported: 12 }),
    "ok"
  );
  // Not permitted at all.
  const noProducts = scopeState.inventoryCapability("read_orders");
  assert.equal(
    scopeState.inventorySourceFor({ capability: noProducts, reported: null }),
    "scope_missing"
  );
});

test("SCOPES: a missing OPTIONAL permission cannot break the sync", () => {
  const src = read(path.join(SRC, "services/shopifyInventoryLevels.ts"));
  // It runs last, in its own function, and returns a result rather than
  // throwing — the whole reason it is not inside the product query.
  assert.match(src, /NEVER THROWS/);
  assert.match(src, /if \(!capability\.perLocation\) \{/);
  assert.match(src, /return \{\s*\n?\s*attempted: false/);
  assert.match(src, /catch \(error\) \{/);
  assert.doesNotMatch(src, /throw new/, "no path may raise to the caller");

  const sync = read(path.join(SRC, "services/shopifyAdminService.ts"));
  assert.match(sync, /const inventoryLevels = await syncInventoryLevels\(\{/);
  // And it is called AFTER the sync's own work has committed.
  const callIndex = sync.indexOf("const inventoryLevels = await syncInventoryLevels");
  const statusIndex = sync.indexOf('logEvent("info", "shopify.sync.completed"');
  assert.ok(callIndex < statusIndex, "must run before the completion log");
  assert.ok(
    callIndex > sync.indexOf("syncCounts.saved.ordersCreated"),
    "and after the main persistence"
  );
});

test("SCOPES: per-location sync paginates and reports truncation", () => {
  const src = read(path.join(SRC, "services/shopifyInventoryLevels.ts"));
  assert.match(src, /pageInfo \{ hasNextPage endCursor \}/);
  assert.match(src, /pages >= MAX_LEVEL_PAGES/);
  assert.match(src, /truncated = true/);
  assert.match(src, /export const MAX_LEVEL_PAGES/);
});

test("SCOPES: per-location rows are store-isolated and upserted", () => {
  const src = read(path.join(SRC, "services/shopifyInventoryLevels.ts"));
  assert.match(src, /storeId: input\.storeId/);
  assert.match(src, /prisma\.inventoryLevelSnapshot\.upsert\(\{/);
  const schema = read(path.resolve(__dirname, "../prisma/schema.prisma"));
  assert.match(
    schema,
    /@@unique\(\[storeId, shopifyLocationId, shopifyInventoryItemId\]\)/
  );
});

test("SCOPES: per-location sync requests no customer data", () => {
  // The GraphQL selection only. The file's comments name the email field
  // deliberately, because that incident is why this sync is isolated.
  const src = read(path.join(SRC, "services/shopifyInventoryLevels.ts"));
  const start = src.indexOf("query VedaSuiteInventoryLevels");
  assert.ok(start > 0, "the query must be findable");
  const query = src.slice(start, src.indexOf("`", start));
  for (const forbidden of ["customer", "email", "phone", "address", "name:"]) {
    assert.doesNotMatch(query, new RegExp(forbidden, "i"), forbidden);
  }
  // It reads locations, items and quantities — nothing about a buyer.
  assert.match(query, /inventoryLevels\(first: \$levels\)/);
  assert.match(query, /quantities\(names: \["available"\]\)/);
});

test("SCOPES: reconciliation never writes Shopify inventory", () => {
  const src = read(path.join(SRC, "services/shopifyInventoryLevels.ts"));
  assert.doesNotMatch(src, /inventoryAdjust|inventorySetOnHand|mutation\s/i);
});

test("SCOPES: the workspace explains the location limitation truthfully", () => {
  const src = read(path.join(SRC, "services/reconciliationService.ts"));
  assert.match(src, /inventoryAvailable:/);
  assert.match(src, /inventoryReason:/);
  assert.match(src, /does not have permission to read Shopify inventory levels/);
});

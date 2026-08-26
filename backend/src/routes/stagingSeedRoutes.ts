// STAGING-ONLY test-data console.
//
// A click-to-run page so the staging smoke test can be completed without a
// terminal and without anyone handling an Admin API token: the app already
// holds a valid offline token for the installed store, so the operator only
// ever clicks.
//
// SECURE BY DEFAULT — FIVE INDEPENDENT GUARDS
// -------------------------------------------
// 0. PRODUCTION REFUSES UNCONDITIONALLY. Checked first, before the credential,
//    and not overridable by any environment variable, header, query or body.
//    An unidentifiable environment counts as production — it fails closed.
//
//    This exists because guard 3 does not do what it looks like it does: a real
//    merchant's store IS a *.myshopify.com store and would pass it. Before this
//    guard, the only thing between a live merchant and 64 fabricated orders was
//    STAGING_SEED_TOKEN never being set on production — one variable, one
//    mistake away.
//
// 1. STAGING_SEED_TOKEN unset  -> every route here returns 404. Same pattern
//    supportAdminRoutes already uses.
// 2. The token must match exactly, or 404 again. Never "unauthorized", so the
//    console's existence is not discoverable by probing.
// 3. The resolved shop must be a *.myshopify.com store. Necessary, but on its
//    own insufficient — see guard 0.
// 4. Seeding requires a typed confirmation phrase in the request body, so an
//    accidental page load, a bookmark or a browser prefetch cannot create data.
//
// It writes ONLY to Shopify, never to VedaSuite's database, and it creates no
// IntelligenceFinding rows — findings must come from the real sync -> detection
// pipeline or the smoke test proves nothing.
//
// RESUMABLE BY CONSTRUCTION. Work is done in small paced batches, and every
// order carries its own identity tag, so clicking Continue creates only what is
// genuinely missing. Repeated clicks cannot duplicate anything.
//
// TEMPORARY BY DESIGN. Once the smoke test passes, clear STAGING_SEED_TOKEN in
// Render and the console is gone again.

import { type Request, type Response, Router } from "express";
import { prisma } from "../db/prismaClient";
import { logEvent } from "../services/observabilityService";
import { env } from "../config/env";
import {
  buildStagingSeedPlan,
  isProductionRuntime,
  isSeedableShopDomain,
  STAGING_TEST_TAG,
  summariseStagingSeedPlan,
} from "../services/stagingSeedPlan";
import { readSeedState, runSeedBatch } from "../services/stagingSeedService";
import {
  createTestProducts,
  readTestProductState,
} from "../services/stagingTestProductService";
import { STAGING_TEST_PRODUCTS } from "../services/stagingTestProductPlan";
// The console quotes the detector's real bar, never a second copy of it.
import { CUSTOMER_LOSS } from "../services/customerLossCalc";

export const stagingSeedRouter = Router();

const CONFIRM_PHRASE = "SEED STAGING";
/** Deliberately different from the order phrase, so one cannot trigger the other. */
const PRODUCT_CONFIRM_PHRASE = "CREATE TEST PRODUCTS";

function authorize(req: Request, res: Response): boolean {
  // GUARD 0 — the environment itself, checked before anything else and
  // unconditional. Not overridable by any header, body, query or environment
  // variable: on production this console does not exist, full stop, even if
  // STAGING_SEED_TOKEN were set there by mistake.
  //
  // Deliberately first. The token check below is a credential, and credentials
  // can be leaked, copied or set in the wrong place. This one cannot.
  if (isProductionRuntime(env.shopifyAppUrl)) {
    res.status(404).send("Not found");
    return false;
  }

  const expected = process.env.STAGING_SEED_TOKEN;
  if (!expected) {
    res.status(404).send("Not found");
    return false;
  }
  const provided =
    typeof req.query.token === "string"
      ? req.query.token
      : typeof req.body?.token === "string"
      ? req.body.token
      : undefined;
  if (provided !== expected) {
    res.status(404).send("Not found");
    return false;
  }
  return true;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** The development stores this app is installed on. Production stores excluded. */
async function seedableStores() {
  const stores = await prisma.store.findMany({
    select: { shop: true, lastSyncAt: true },
    orderBy: { shop: "asc" },
    take: 50,
  });
  return stores.filter((store) => isSeedableShopDomain(store.shop));
}

/** Shared guard for the action endpoints. */
function resolveAction(
  req: Request,
  res: Response,
  requireConfirm: boolean,
  phrase: string = CONFIRM_PHRASE
) {
  const shop = typeof req.body?.shop === "string" ? req.body.shop : "";
  if (!isSeedableShopDomain(shop)) {
    res.status(400).json({
      ok: false,
      error: `"${shop}" is not a Shopify development store. Only *.myshopify.com dev stores can be seeded.`,
    });
    return null;
  }
  if (requireConfirm && req.body?.confirm !== phrase) {
    res.status(400).json({
      ok: false,
      error: `Type ${phrase} in the confirmation box first.`,
    });
    return null;
  }
  return shop;
}

/** Turns a Shopify failure into something an operator can act on. */
function describeFailure(message: string) {
  if (/throttl|too many attempts|rate limit/i.test(message)) {
    return "Shopify is rate limiting. Nothing already created was lost — wait about a minute and click Create / Continue.";
  }
  if (/write_products|write_inventory/i.test(message)) {
    return "This is a scope refusal, not a bug. VedaSuite does not request product or inventory write access, so Shopify will not let it create products. Create the three products by hand in Shopify admin instead — the values are listed above.";
  }
  if (/access denied|not authorized|scope/i.test(message)) {
    return "The app's Shopify token cannot perform this write. Reinstall the app on the development store so it picks up the required scope.";
  }
  if (/doesn't exist|undefined field|unknown argument|not a valid/i.test(message)) {
    return "This Shopify API version does not accept this order-creation call. Report this message — do NOT weaken the test.";
  }
  return "Report this exact message rather than retrying.";
}

stagingSeedRouter.get("/", async (req: Request, res: Response) => {
  if (!authorize(req, res)) return;

  const token = String(req.query.token);
  const stores = await seedableStores();
  const plan = buildStagingSeedPlan();
  const summary = summariseStagingSeedPlan(plan);

  const rows = summary.shoppers
    .map(
      (s) =>
        `<tr${s.shouldQualify ? ' class="q"' : ""}><td>shopper${s.shopperIndex}</td>` +
        `<td>${s.orders}</td><td>${s.refunds}</td>` +
        `<td>${Math.round(s.refundedShare * 100)}%</td>` +
        `<td>${s.shouldQualify ? "should raise a Customer Loss finding" : ""}</td></tr>`
    )
    .join("");

  const storeOptions = stores
    .map((s) => `<option value="${escapeHtml(s.shop)}">${escapeHtml(s.shop)}</option>`)
    .join("");

  const noStores = `<div class="warn"><strong>No development store found.</strong> This app is not
       installed on any *.myshopify.com store, so there is nothing safe to seed.</div>`;

  const controls = `
<h3>Run it</h3>
<p>Store: <select id="shop">${storeOptions}</select>
   <button id="refresh" class="grey">Check what exists</button></p>
<p>Type <strong>${CONFIRM_PHRASE}</strong> to confirm:<br>
   <input id="confirm" placeholder="${CONFIRM_PHRASE}" autocomplete="off"></p>
<div id="bar"><div id="fill"></div></div>
<p>
  <button id="start">Create / Continue</button>
  <button id="stop" class="grey" disabled>Stop</button>
</p>`;

  res.status(200).send(`<!doctype html>
<html><head><meta charset="utf-8"><title>VedaSuite staging test data</title>
<style>
 body{font:15px/1.55 system-ui,-apple-system,sans-serif;max-width:840px;margin:40px auto;padding:0 20px;color:#202223}
 h1{font-size:22px;margin-bottom:4px} .sub{color:#6d7175;margin-top:0}
 .warn{background:#fff4e4;border:1px solid #ffc453;border-radius:8px;padding:14px 16px;margin:20px 0}
 table{border-collapse:collapse;width:100%;margin:16px 0;font-size:14px}
 th,td{text-align:left;padding:7px 10px;border-bottom:1px solid #e1e3e5}
 tr.q{background:#eafaf1;font-weight:600}
 button{background:#008060;color:#fff;border:0;border-radius:8px;padding:11px 18px;font-size:15px;cursor:pointer;margin-right:8px}
 button.grey{background:#5c5f62}
 button:disabled{background:#8c9196;cursor:not-allowed}
 input,select{padding:9px 11px;font-size:15px;border:1px solid #8c9196;border-radius:8px}
 input{width:260px}
 #bar{height:12px;background:#e1e3e5;border-radius:6px;overflow:hidden;margin:14px 0}
 #fill{height:100%;width:0%;background:#008060;transition:width .3s}
 #out{white-space:pre-wrap;background:#f6f6f7;border-radius:8px;padding:14px;margin-top:6px;min-height:24px;font-family:ui-monospace,monospace;font-size:13px}
 .step{margin:6px 0}
</style></head><body>
<h1>VedaSuite staging test data</h1>
<p class="sub">Creates Shopify orders in a development store so the lifecycle smoke test has something real to act on.<br>
For the Reconciliation inventory test you need products instead &mdash;
<a href="/staging-seed/products?token=${encodeURIComponent(token)}">open the test products page</a>.</p>

<div class="warn">
  <strong>Creates up to ${summary.totalOrders} orders in the selected development store.</strong>
  <div class="step">Every order is tagged <code>${STAGING_TEST_TAG}</code> so you can find and remove them afterwards.</div>
  <div class="step">Each order also carries its own identity tag, so <strong>clicking again never creates duplicates</strong> &mdash; it only fills in what is missing.</div>
  <div class="step">Orders are created slowly, in small batches, because Shopify rate limits. If it pauses, wait a minute and click Continue.</div>
  <div class="step">No findings are created here. They come from Sync Data, exactly as they would for a merchant.</div>
</div>

<h3>The fixture</h3>
<table>
  <tr><th>Shopper</th><th>Orders</th><th>Refunded</th><th>Value returned</th><th></th></tr>
  ${rows}
</table>
<p class="sub">Store baseline: ${summary.totalOrders} orders, ${summary.totalRefunds} refunded
(${Math.round(summary.storeRefundRate * 100)}%). Customer Loss needs at least
${CUSTOMER_LOSS.minStoreOrders} store orders before it will compute a baseline at all.</p>

${stores.length === 0 ? noStores : controls}
<div id="out">Click "Check what exists" to see the current state.</div>

<script>
const token = ${JSON.stringify(token)};
const TOTAL = ${summary.totalOrders};
const out = document.getElementById("out");
const fill = document.getElementById("fill");
const startBtn = document.getElementById("start");
const stopBtn = document.getElementById("stop");
const shopEl = document.getElementById("shop");
const confirmEl = document.getElementById("confirm");
let cancelled = false;

const say = (t) => { out.textContent = t; };
const post = async (path, body) => {
  const r = await fetch(path + "?token=" + encodeURIComponent(token), {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(Object.assign({ token }, body)),
  });
  return r.json();
};

function renderState(s, extra) {
  const have = s.totalPlanned - s.remaining;
  if (fill) fill.style.width = Math.round((have / TOTAL) * 100) + "%";
  say(
    (extra ? extra + "\\n\\n" : "") +
    "Tagged orders in Shopify : " + s.taggedOrderCount + "\\n" +
    "Fixture complete         : " + have + " of " + s.totalPlanned + "\\n" +
    "Refunded so far          : " + s.refundedExisting + "\\n" +
    "Still missing            : " + s.remaining + "\\n\\n" +
    (s.readyToSync ? "READY. " : "NOT READY. ") + s.readyReason
  );
}

document.getElementById("refresh")?.addEventListener("click", async () => {
  say("Checking Shopify ...");
  const r = await post("/staging-seed/state", { shop: shopEl.value });
  if (r.ok) renderState(r.state); else say("Error\\n\\n" + r.error + "\\n\\n" + (r.hint || ""));
});

stopBtn?.addEventListener("click", () => {
  cancelled = true;
  stopBtn.disabled = true;
  say("Stopping after this batch ...");
});

startBtn?.addEventListener("click", async () => {
  cancelled = false;
  startBtn.disabled = true;
  stopBtn.disabled = false;
  let created = 0, refunded = 0, failed = 0;

  try {
    for (let round = 0; round < 40; round += 1) {
      if (cancelled) {
        say("Stopped. Nothing already created was lost — click Create / Continue to resume.");
        break;
      }
      const r = await post("/staging-seed/run", { shop: shopEl.value, confirm: confirmEl.value });
      if (!r.ok) { say("BLOCKED\\n\\n" + r.error); break; }

      created += r.createdThisBatch;
      refunded += r.refundedThisBatch;
      failed += r.failedThisBatch;

      renderState(r.state,
        "Working ... this session: " + created + " created, " + refunded + " refunded, " +
        failed + " failed" + (r.errors.length ? "\\nLast error: " + r.errors[0] : ""));

      if (r.state.remaining === 0) {
        renderState(r.state, "DONE. This session created " + created + " orders.");
        break;
      }
      if (r.createdThisBatch === 0) {
        renderState(r.state,
          "PAUSED — Shopify is still rate limiting.\\n" +
          "Nothing was lost. Wait about a minute, then click Create / Continue." +
          (r.errors.length ? "\\nLast error: " + r.errors[0] : ""));
        break;
      }
      // Breather between batches so Shopify's bucket refills.
      await new Promise((res) => setTimeout(res, 1500));
    }
  } finally {
    startBtn.disabled = false;
    stopBtn.disabled = true;
  }
});
</script>
</body></html>`);
});

/**
 * The three inventory-test products.
 *
 * A separate page from the order seeder because it has a different confirmation
 * phrase, a different failure mode, and a different answer when it refuses.
 */
stagingSeedRouter.get("/products", async (req: Request, res: Response) => {
  if (!authorize(req, res)) return;

  const token = String(req.query.token);
  const stores = await seedableStores();

  const planRows = STAGING_TEST_PRODUCTS.map(
    (p) =>
      `<tr><td><code>${escapeHtml(p.sku)}</code></td><td>${escapeHtml(p.title)}</td>` +
      `<td>${p.quantity}</td></tr>`
  ).join("");

  const storeOptions = stores
    .map((s) => `<option value="${escapeHtml(s.shop)}">${escapeHtml(s.shop)}</option>`)
    .join("");

  const noStores = `<div class="warn"><strong>No development store found.</strong> This app is not
       installed on any *.myshopify.com store.</div>`;

  const controls = `
<h3>Run it</h3>
<p>Store: <select id="shop">${storeOptions}</select>
   <button id="refresh" class="grey">Check what exists</button></p>
<p>Type <strong>${PRODUCT_CONFIRM_PHRASE}</strong> to confirm:<br>
   <input id="confirm" placeholder="${PRODUCT_CONFIRM_PHRASE}" autocomplete="off"></p>
<p><button id="start">Create / Update</button></p>`;

  res.status(200).send(`<!doctype html>
<html><head><meta charset="utf-8"><title>VedaSuite staging test products</title>
<style>
 body{font:15px/1.55 system-ui,-apple-system,sans-serif;max-width:840px;margin:40px auto;padding:0 20px;color:#202223}
 h1{font-size:22px;margin-bottom:4px} .sub{color:#6d7175;margin-top:0}
 .warn{background:#fff4e4;border:1px solid #ffc453;border-radius:8px;padding:14px 16px;margin:20px 0}
 table{border-collapse:collapse;width:100%;margin:16px 0;font-size:14px}
 th,td{text-align:left;padding:7px 10px;border-bottom:1px solid #e1e3e5}
 button{background:#008060;color:#fff;border:0;border-radius:8px;padding:11px 18px;font-size:15px;cursor:pointer;margin-right:8px}
 button.grey{background:#5c5f62}
 button:disabled{background:#8c9196;cursor:not-allowed}
 input,select{padding:9px 11px;font-size:15px;border:1px solid #8c9196;border-radius:8px}
 input{width:300px}
 #out{white-space:pre-wrap;background:#f6f6f7;border-radius:8px;padding:14px;margin-top:6px;min-height:24px;font-family:ui-monospace,monospace;font-size:13px}
 .step{margin:6px 0}
 code{background:#f1f2f3;padding:1px 5px;border-radius:4px}
</style></head><body>
<h1>VedaSuite staging test products</h1>
<p class="sub">Creates the three products the Reconciliation inventory test compares against.</p>

<div class="warn">
  <strong>VedaSuite is expected to be refused here.</strong>
  <div class="step">The app requests <code>read_products</code> only. It does not request
    <code>write_products</code> or <code>write_inventory</code>, and the App Store readiness
    check requires <code>write_products</code> to stay absent.</div>
  <div class="step">If the token lacks those scopes this page will say so exactly and
    create nothing. That is the correct outcome, not a bug to work around —
    <strong>create the three products by hand in Shopify admin</strong> using the table below.</div>
  <div class="step">Writes to Shopify only. No VedaSuite database rows, no findings.
    Findings come from Sync Data, exactly as they would for a merchant.</div>
  <div class="step">Products are upserted on a fixed handle, so clicking twice
    <strong>cannot create duplicates</strong>. Each is tagged <code>${STAGING_TEST_TAG}</code>.</div>
</div>

<h3>What gets created</h3>
<table>
  <tr><th>SKU</th><th>Title</th><th>Inventory</th></tr>
  ${planRows}
</table>
<p class="sub"><strong>SKU-D is intentionally absent.</strong> It must exist only in your
uploaded file so the "external-only" case is a real result rather than a staged one.</p>

${stores.length === 0 ? noStores : controls}
<div id="out">Click "Check what exists" to see the current state.</div>

<script>
const token = ${JSON.stringify(token)};
const out = document.getElementById("out");
const startBtn = document.getElementById("start");
const shopEl = document.getElementById("shop");
const confirmEl = document.getElementById("confirm");

const say = (t) => { out.textContent = t; };
const post = async (path, body) => {
  const r = await fetch(path + "?token=" + encodeURIComponent(token), {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(Object.assign({ token }, body)),
  });
  return r.json();
};

function renderState(s, extra) {
  const lines = s.products.map((p) =>
    "  " + p.sku.padEnd(8) +
    (p.exists ? "exists" : "MISSING").padEnd(9) +
    "stock " + (p.quantity === null ? "unknown" : p.quantity) +
    " (want " + p.expectedQuantity + ")" +
    (p.correct ? "  OK" : "")
  );
  say(
    (extra ? extra + "\\n\\n" : "") +
    "Granted scopes : " + s.scopes.granted.join(", ") + "\\n" +
    "Can create     : " + (s.scopes.verdict.canCreateProducts ? "yes" : "NO") + "\\n" +
    "Can set stock  : " + (s.scopes.verdict.canSetInventory ? "yes" : "NO") + "\\n" +
    "Location       : " + (s.locationName || "none readable") + "\\n\\n" +
    lines.join("\\n") + "\\n\\n" +
    (s.readyToSync ? "READY. " : "NOT READY. ") + s.readyReason
  );
}

document.getElementById("refresh")?.addEventListener("click", async () => {
  say("Checking Shopify ...");
  const r = await post("/staging-seed/products/state", { shop: shopEl.value });
  if (r.ok) renderState(r.state); else say("Error\\n\\n" + r.error + "\\n\\n" + (r.hint || ""));
});

startBtn?.addEventListener("click", async () => {
  startBtn.disabled = true;
  say("Working ...");
  try {
    const r = await post("/staging-seed/products/run",
      { shop: shopEl.value, confirm: confirmEl.value });
    if (!r.ok) { say("BLOCKED\\n\\n" + r.error); return; }
    if (r.blocked) {
      renderState(r.state, "REFUSED BY PERMISSION — nothing was attempted.\\n\\n" + r.blockedReason);
      return;
    }
    renderState(r.state,
      "Done. " + r.created + " created/updated, " + r.failed + " failed." +
      (r.errors.length ? "\\nErrors: " + r.errors.join(" | ") : ""));
  } finally {
    startBtn.disabled = false;
  }
});
</script>
</body></html>`);
});

/** Read-only: which test products exist and what this token may do. */
stagingSeedRouter.post("/products/state", async (req: Request, res: Response) => {
  if (!authorize(req, res)) return;
  const shop = resolveAction(req, res, false);
  if (!shop) return;
  try {
    return res.json({ ok: true, state: await readTestProductState(shop) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return res.status(200).json({ ok: false, error: message, hint: describeFailure(message) });
  }
});

/**
 * Creates or corrects the three products.
 *
 * Returns `blocked: true` with the exact scopes involved rather than attempting
 * a call it knows Shopify will refuse.
 */
stagingSeedRouter.post("/products/run", async (req: Request, res: Response) => {
  if (!authorize(req, res)) return;
  const shop = resolveAction(req, res, true, PRODUCT_CONFIRM_PHRASE);
  if (!shop) return;

  try {
    const result = await createTestProducts(shop);
    return res.json({ ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logEvent("warn", "staging.test_products_failed", { shop, error: message });
    return res
      .status(200)
      .json({ ok: false, error: `${message}\n\n${describeFailure(message)}` });
  }
});

/** Read-only: what already exists. Safe to call at any time. */
stagingSeedRouter.post("/state", async (req: Request, res: Response) => {
  if (!authorize(req, res)) return;
  const shop = resolveAction(req, res, false);
  if (!shop) return;
  try {
    return res.json({ ok: true, state: await readSeedState(shop) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return res.status(200).json({ ok: false, error: message, hint: describeFailure(message) });
  }
});

/**
 * Creates the next batch of MISSING orders only.
 *
 * Safe to call repeatedly: the batch is computed by reading Shopify first, so a
 * retry after a throttle, a crash or a closed tab resumes rather than repeats.
 */
stagingSeedRouter.post("/run", async (req: Request, res: Response) => {
  if (!authorize(req, res)) return;
  const shop = resolveAction(req, res, true);
  if (!shop) return;

  try {
    const result = await runSeedBatch({ shop });
    return res.json({ ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logEvent("warn", "staging.seed_failed", { shop, error: message });
    return res
      .status(200)
      .json({ ok: false, error: `${message}\n\n${describeFailure(message)}` });
  }
});

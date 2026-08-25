// STAGING-ONLY test-data console.
//
// A click-to-run page so the staging smoke test can be completed without a
// terminal and without anyone handling an Admin API token: the app already
// holds a valid offline token for the installed store, so the operator only
// ever clicks.
//
// SECURE BY DEFAULT — FOUR INDEPENDENT GUARDS
// -------------------------------------------
// 1. STAGING_SEED_TOKEN unset  -> every route here returns 404. Production does
//    not set it, so on production this console does not exist. This is the same
//    pattern supportAdminRoutes already uses.
// 2. The token must match exactly, or 404 again. Never "unauthorized", so the
//    console's existence is not discoverable by probing.
// 3. The resolved shop must be a *.myshopify.com DEVELOPMENT store.
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
import {
  buildStagingSeedPlan,
  isSeedableShopDomain,
  STAGING_TEST_TAG,
  summariseStagingSeedPlan,
} from "../services/stagingSeedPlan";
import { readSeedState, runSeedBatch } from "../services/stagingSeedService";

export const stagingSeedRouter = Router();

const CONFIRM_PHRASE = "SEED STAGING";

function authorize(req: Request, res: Response): boolean {
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
function resolveAction(req: Request, res: Response, requireConfirm: boolean) {
  const shop = typeof req.body?.shop === "string" ? req.body.shop : "";
  if (!isSeedableShopDomain(shop)) {
    res.status(400).json({
      ok: false,
      error: `"${shop}" is not a Shopify development store. Only *.myshopify.com dev stores can be seeded.`,
    });
    return null;
  }
  if (requireConfirm && req.body?.confirm !== CONFIRM_PHRASE) {
    res.status(400).json({
      ok: false,
      error: `Type ${CONFIRM_PHRASE} in the confirmation box first.`,
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
  if (/access denied|not authorized|scope/i.test(message)) {
    return "The app's Shopify token cannot create orders. Reinstall the app on the development store so it picks up the write_orders scope.";
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
<p class="sub">Creates Shopify orders in a development store so the lifecycle smoke test has something real to act on.</p>

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
(${Math.round(summary.storeRefundRate * 100)}%). Customer Loss needs at least 50 store
orders before it will compute a baseline at all.</p>

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

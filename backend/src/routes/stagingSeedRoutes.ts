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
import {
  countTaggedTestOrders,
  preflightStagingSeed,
  runStagingSeed,
} from "../services/stagingSeedService";

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

  res.status(200).send(`<!doctype html>
<html><head><meta charset="utf-8"><title>VedaSuite staging test data</title>
<style>
 body{font:15px/1.55 system-ui,-apple-system,sans-serif;max-width:820px;margin:40px auto;padding:0 20px;color:#202223}
 h1{font-size:22px;margin-bottom:4px} .sub{color:#6d7175;margin-top:0}
 .warn{background:#fff4e4;border:1px solid #ffc453;border-radius:8px;padding:14px 16px;margin:20px 0}
 table{border-collapse:collapse;width:100%;margin:16px 0;font-size:14px}
 th,td{text-align:left;padding:7px 10px;border-bottom:1px solid #e1e3e5}
 tr.q{background:#eafaf1;font-weight:600}
 button{background:#008060;color:#fff;border:0;border-radius:8px;padding:11px 18px;font-size:15px;cursor:pointer}
 button:disabled{background:#8c9196;cursor:not-allowed}
 input{padding:9px 11px;font-size:15px;border:1px solid #8c9196;border-radius:8px;width:260px}
 #out{white-space:pre-wrap;background:#f6f6f7;border-radius:8px;padding:14px;margin-top:18px;min-height:24px;font-family:ui-monospace,monospace;font-size:13px}
 .step{margin:6px 0}
</style></head><body>
<h1>VedaSuite staging test data</h1>
<p class="sub">Creates Shopify orders in a development store so the lifecycle smoke test has something real to act on.</p>

<div class="warn">
  <strong>This creates ${summary.totalOrders} real orders in the selected development store.</strong>
  <div class="step">Every order is tagged <code>${STAGING_TEST_TAG}</code> so you can find and remove them afterwards.</div>
  <div class="step">No findings are created here. They come from Sync Data, exactly as they would for a merchant.</div>
</div>

<h3>What will be created</h3>
<table>
  <tr><th>Shopper</th><th>Orders</th><th>Refunded</th><th>Value returned</th><th></th></tr>
  ${rows}
</table>
<p class="sub">Store baseline: ${summary.totalOrders} orders, ${summary.totalRefunds} refunded
(${Math.round(summary.storeRefundRate * 100)}%). Customer Loss needs at least 50 store
orders before it will compute a baseline at all.</p>

${
  stores.length === 0
    ? `<div class="warn"><strong>No development store found.</strong> This app is not
       installed on any *.myshopify.com store, so there is nothing safe to seed.</div>`
    : `
<h3>Run it</h3>
<p>Store: <select id="shop">${storeOptions}</select></p>
<p>Type <strong>${CONFIRM_PHRASE}</strong> to confirm:<br>
   <input id="confirm" placeholder="${CONFIRM_PHRASE}" autocomplete="off"></p>
<p>
  <button id="check">1. Check connection (creates 1 order)</button>
  <button id="seed" disabled>2. Create the rest</button>
  <button id="count">Count tagged orders</button>
</p>`
}
<div id="out">Ready.</div>

<script>
const token = ${JSON.stringify(token)};
const out = document.getElementById("out");
const say = (t) => { out.textContent = t; };
const post = async (path, body) => {
  const r = await fetch(path + "?token=" + encodeURIComponent(token), {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(Object.assign({ token }, body)),
  });
  return r.json();
};
const shopEl = document.getElementById("shop");
const confirmEl = document.getElementById("confirm");
const seedBtn = document.getElementById("seed");

document.getElementById("check")?.addEventListener("click", async () => {
  say("Creating one test order ...");
  const r = await post("/staging-seed/preflight", { shop: shopEl.value, confirm: confirmEl.value });
  if (r.ok) { seedBtn.disabled = false; say("Connection OK. Created " + r.order + ".\\n\\nNow click 2."); }
  else { seedBtn.disabled = true; say("BLOCKED\\n\\n" + r.error + (r.hint ? "\\n\\n" + r.hint : "")); }
});

seedBtn?.addEventListener("click", async () => {
  seedBtn.disabled = true;
  say("Creating the remaining orders. This takes a minute or two — leave this page open ...");
  const r = await post("/staging-seed/run", { shop: shopEl.value, confirm: confirmEl.value });
  if (r.ok) {
    say("DONE\\n\\nOrders created: " + r.created + "\\nRefunded: " + r.refunded +
        "\\nFailed: " + r.failed + (r.firstError ? "\\nFirst error: " + r.firstError : "") +
        "\\n\\nNext: open VedaSuite in Shopify and click Sync Data.");
  } else { say("BLOCKED\\n\\n" + r.error); }
});

document.getElementById("count")?.addEventListener("click", async () => {
  say("Counting ...");
  const r = await post("/staging-seed/count", { shop: shopEl.value });
  say(r.ok ? ("Orders tagged " + ${JSON.stringify(STAGING_TEST_TAG)} + ": " + r.count) : ("Error\\n\\n" + r.error));
});
</script>
</body></html>`);
});

/** Shared guard for the three action endpoints. */
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

stagingSeedRouter.post("/preflight", async (req: Request, res: Response) => {
  if (!authorize(req, res)) return;
  const shop = resolveAction(req, res, true);
  if (!shop) return;

  try {
    const order = await preflightStagingSeed(shop);
    return res.json({ ok: true, order: order.name ?? order.id });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logEvent("warn", "staging.seed_preflight_failed", { shop, error: message });
    return res.status(200).json({
      ok: false,
      error: message,
      hint:
        /access denied|not authorized|scope/i.test(message)
          ? "The app's Shopify token cannot create orders. Reinstall the app on the development store so it picks up the write_orders scope, then try again."
          : /doesn't exist|undefined field|unknown argument|not a valid/i.test(message)
          ? "This Shopify API version does not accept this order-creation call. Report this message — the seed needs adjusting for your API version; do NOT weaken the test."
          : "Report this exact message rather than retrying.",
    });
  }
});

stagingSeedRouter.post("/run", async (req: Request, res: Response) => {
  if (!authorize(req, res)) return;
  const shop = resolveAction(req, res, true);
  if (!shop) return;

  try {
    // The preflight already created the first order; skip it rather than
    // duplicating, so the plan's shape stays exactly as previewed.
    const progress = await runStagingSeed({ shop, skipFirst: true });
    return res.json({ ok: true, ...progress });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logEvent("warn", "staging.seed_failed", { shop, error: message });
    return res.status(200).json({ ok: false, error: message });
  }
});

stagingSeedRouter.post("/count", async (req: Request, res: Response) => {
  if (!authorize(req, res)) return;
  const shop = resolveAction(req, res, false);
  if (!shop) return;

  try {
    const count = await countTaggedTestOrders(shop);
    return res.json({ ok: true, count });
  } catch (error) {
    return res
      .status(200)
      .json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

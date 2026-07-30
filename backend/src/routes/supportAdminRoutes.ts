import { type Request, type Response, Router } from "express";
import {
  listAllTickets,
  updateTicketAsAdmin,
} from "../services/supportService";

// Developer-facing support console. Mounted OUTSIDE /api because the developer
// has no Shopify session token — it is gated instead by SUPPORT_ADMIN_TOKEN.
//
// Secure by default: when SUPPORT_ADMIN_TOKEN is unset the whole console returns
// 404, so leaving it unconfigured exposes nothing. Access with ?token=<value>.
export const supportAdminRouter = Router();

function authorize(req: Request, res: Response): boolean {
  const expected = process.env.SUPPORT_ADMIN_TOKEN;
  if (!expected) {
    res.status(404).send("Not found");
    return false;
  }
  const provided = typeof req.query.token === "string" ? req.query.token : undefined;
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

supportAdminRouter.get("/api/tickets", async (req, res) => {
  if (!authorize(req, res)) return;
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const tickets = await listAllTickets({ status });
  return res.json({ tickets });
});

supportAdminRouter.post("/api/tickets/:id", async (req, res) => {
  if (!authorize(req, res)) return;
  const result = await updateTicketAsAdmin(req.params.id, req.body ?? {});
  if (!result.ok) {
    return res.status(400).json({ error: result.error });
  }
  return res.json({ ok: true });
});

supportAdminRouter.get("/", async (req, res) => {
  if (!authorize(req, res)) return;
  // The token is embedded into the page so its fetch calls carry it. This is an
  // internal console reached only by someone who already holds the token.
  const token = escapeHtml(String(req.query.token));
  res.type("html").send(renderConsole(token));
});

function renderConsole(token: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex,nofollow" />
<title>VedaSuite Support Console</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; background: #f6f6f7; color: #202223; }
  header { background: #1f2937; color: #fff; padding: 16px 24px; }
  header h1 { margin: 0; font-size: 18px; }
  .wrap { padding: 24px; max-width: 1000px; margin: 0 auto; }
  .filters { margin-bottom: 16px; display: flex; gap: 8px; flex-wrap: wrap; }
  .filters button { border: 1px solid #c9cccf; background: #fff; padding: 6px 12px; border-radius: 8px; cursor: pointer; }
  .filters button.active { background: #1f2937; color: #fff; border-color: #1f2937; }
  .ticket { background: #fff; border: 1px solid #e1e3e5; border-radius: 12px; padding: 16px; margin-bottom: 14px; }
  .ticket h3 { margin: 0 0 4px; font-size: 15px; }
  .meta { color: #6d7175; font-size: 13px; margin-bottom: 8px; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; }
  .OPEN { background: #fff1e6; color: #b45309; }
  .IN_PROGRESS { background: #e6f0ff; color: #1d4ed8; }
  .RESOLVED { background: #e6f6ec; color: #087443; }
  .msg { white-space: pre-wrap; background: #f6f6f7; border-radius: 8px; padding: 10px; margin: 8px 0; font-size: 14px; }
  textarea { width: 100%; box-sizing: border-box; min-height: 70px; border: 1px solid #c9cccf; border-radius: 8px; padding: 8px; font: inherit; }
  .row { display: flex; gap: 8px; align-items: center; margin-top: 8px; flex-wrap: wrap; }
  select, .save { padding: 6px 12px; border-radius: 8px; border: 1px solid #c9cccf; font: inherit; }
  .save { background: #1f2937; color: #fff; border: none; cursor: pointer; }
  .empty { color: #6d7175; padding: 40px; text-align: center; }
</style>
</head>
<body>
<header><h1>VedaSuite Support Console</h1></header>
<div class="wrap">
  <div class="filters" id="filters">
    <button data-status="" class="active">All</button>
    <button data-status="OPEN">Open</button>
    <button data-status="IN_PROGRESS">In progress</button>
    <button data-status="RESOLVED">Resolved</button>
  </div>
  <div id="list"><p class="empty">Loading…</p></div>
</div>
<script>
  const TOKEN = ${JSON.stringify(token)};
  let currentStatus = "";
  const esc = (s) => (s ?? "").replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));

  async function load() {
    const url = "api/tickets?token=" + encodeURIComponent(TOKEN) + (currentStatus ? "&status=" + currentStatus : "");
    const res = await fetch(url);
    const data = await res.json();
    render(data.tickets || []);
  }

  function render(tickets) {
    const list = document.getElementById("list");
    if (!tickets.length) { list.innerHTML = '<p class="empty">No tickets.</p>'; return; }
    list.innerHTML = tickets.map((t) => \`
      <div class="ticket" data-id="\${t.id}">
        <span class="badge \${t.status}">\${t.status.replace("_"," ")}</span>
        <h3>\${esc(t.subject)}</h3>
        <div class="meta">\${esc(t.shop)} · \${esc(t.category)} · \${new Date(t.createdAt).toLocaleString()}\${t.contactEmail ? " · " + esc(t.contactEmail) : ""}</div>
        <div class="msg">\${esc(t.message)}</div>
        <textarea placeholder="Reply to the merchant…">\${esc(t.adminResponse || "")}</textarea>
        <div class="row">
          <select>
            <option value="OPEN" \${t.status==="OPEN"?"selected":""}>Open</option>
            <option value="IN_PROGRESS" \${t.status==="IN_PROGRESS"?"selected":""}>In progress</option>
            <option value="RESOLVED" \${t.status==="RESOLVED"?"selected":""}>Resolved</option>
          </select>
          <button class="save">Save</button>
          <span class="saved"></span>
        </div>
      </div>\`).join("");

    list.querySelectorAll(".ticket").forEach((el) => {
      el.querySelector(".save").addEventListener("click", async () => {
        const id = el.getAttribute("data-id");
        const status = el.querySelector("select").value;
        const adminResponse = el.querySelector("textarea").value;
        const savedEl = el.querySelector(".saved");
        savedEl.textContent = "Saving…";
        const res = await fetch("api/tickets/" + encodeURIComponent(id) + "?token=" + encodeURIComponent(TOKEN), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status, adminResponse }),
        });
        savedEl.textContent = res.ok ? "Saved" : "Error";
        if (res.ok) setTimeout(load, 500);
      });
    });
  }

  document.getElementById("filters").addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    currentStatus = btn.getAttribute("data-status");
    document.querySelectorAll("#filters button").forEach((b) => b.classList.toggle("active", b === btn));
    load();
  });

  load();
</script>
</body>
</html>`;
}

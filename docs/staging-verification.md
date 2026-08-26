# Staging verification — no database access needed

Everything below is done in a browser. Roughly fifteen minutes.

You will need one thing that is not obvious: the **diagnostics URL**. It is a
protected API route, so open it in the same browser tab that already has
VedaSuite loaded from your Shopify admin, or it will return 401.

---

## Step 1 — Find out what actually happened to your products

This is the step that answers "75 orders but 0 products".

1. Open VedaSuite from your Shopify admin.
2. Open **Store Overview** and click **Refresh** to run a fresh sync. Wait for
   it to finish.
3. In the same browser, change the URL to:

   `https://vedasuite-staging.onrender.com/api/diagnostics/sync`

4. You will get a JSON page. Find the `productDiagnosis` block near the bottom.

**Read the `code`. It is one of five answers:**

| `code` | What it means | What to do |
|---|---|---|
| `PRODUCTS_PRESENT` | Products synced fine | Nothing — go to Step 3 |
| `NO_PRODUCTS_IN_SHOPIFY` | Sync worked, your catalogue is genuinely empty | Add a product in Shopify, re-sync |
| `PRODUCT_SYNC_FAILED` | Shopify returned products, VedaSuite could not save them | **Send me this whole JSON page** |
| `PRODUCT_SYNC_NOT_RUN` | No sync has run yet | Run one from Store Overview |
| `PRODUCT_STATUS_UNKNOWN` | The last sync predates this tracking | Re-sync and reload this page |

Also worth reading on that page:

- `persisted` — the real counts: `productsPersisted`, `variantsWithSku`,
  `variantsWithInventoryQuantity`, `ordersPersisted`, `lineItemsPersisted`
- `latestSync.resourceStatus` — per-resource outcome. Products can say `FAILED`
  while orders say `SUCCESS`; that is the whole point
- `scopes.granted` — what this store has actually authorised
- `scopes.reauthorizationWouldAdd` — `read_inventory` / `read_locations` if you
  have not reconnected since those were added

There is no customer data, no token and no raw Shopify payload on this page. It
is counts and statuses only.

---

## Step 2 — Confirm Store Overview and Action Center now agree

1. Open **Store Overview**.
2. Read the summary line at the top.
3. Open **Action Center**.
4. Read its headline.

**They must say the same thing.** With the current staging store you should see
something like:

> Customer Loss ran and found nothing. Pricing recommendations could not be
> evaluated; Market Signals, Reconciliation are waiting for you.

**It must NOT say "Everything looks healthy right now."** That sentence has been
removed from the product. If you see it anywhere, that is a bug — screenshot it.

Check the wording distinguishes two different things:

- **"could not be evaluated"** — VedaSuite has a problem (e.g. no products)
- **"waiting for you"** — you have not set it up yet (no competitor domains, no
  reconciliation file uploaded)

Market Signals and Reconciliation should be in the second group, not the first.

---

## Step 3 — Confirm Customer Loss is coherent

1. Open **Customer Loss**.
2. Look at the section that used to say *"Actions that need attention now"*.

**It should now say "Orders to review"**, with a badge reading *"4 to review"*
rather than *"4 open"*.

3. Above the list there should be a blue box explaining, in plain English, that
   these orders do not add up to a finding yet and that this is why Action
   Center can be empty.

4. Scroll to the findings section at the top. If it says **0 open findings** and
   the review list says **4 orders**, that is now correct and explained — not a
   contradiction.

**What would be a bug:** the page calling both of them "things that need
attention", or Action Center showing a number that disagrees with the findings
count here.

---

## Step 4 — The multi-sheet workbook

1. Open **Reconciliation**.
2. Upload your five-sheet `.xlsx` (Inventory / 3PL Rate Card / 3PL Invoice /
   Supplier Shipment / README).

**Expected:** all five sheet names listed in the Worksheet dropdown, and
VedaSuite lands on a sheet that has rows in it.

3. Try switching the worksheet to **Supplier Shipment**. The column list should
   change to that sheet's headers.
4. Switch back to **Inventory**, map SKU and Quantity, click **Check this file**.

**Expected:** "3 usable rows", 0 unusable.

5. Click **Reconcile now**.

**What to check in the result:** if your Shopify products did not sync (Step 1
told you), the result must say VedaSuite could not compare against Shopify —
**not** that every SKU is "missing from Shopify". A file-only discrepancy list
when the Shopify side is unavailable would be a false positive; tell me if you
see one.

---

## Step 5 — Reconciliation and Pricing must not invent facts

Open **Pricing & Product Profit** and **Reconciliation**, and read their empty
states against what Step 1 told you.

| Step 1 said | Pricing must say | Reconciliation must say |
|---|---|---|
| `NO_PRODUCTS_IN_SHOPIFY` | your store has no products | your catalogue is empty |
| `PRODUCT_SYNC_FAILED` | the product sync did not complete | it **could not evaluate** SKUs |
| `PRODUCT_SYNC_NOT_RUN` | no sync has run yet | it has not synced products yet |

**What would be a bug:** Reconciliation saying *"Your Shopify products have no
SKUs yet"* when Step 1 reported `PRODUCT_SYNC_FAILED`. That would be claiming a
fact about your Shopify setup that VedaSuite never actually checked.

---

## Step 6 — Plan gating still holds

Only if you have a Growth test store:

1. Open **Reconciliation**. Inventory and Supplier Shipment should be usable.
2. 3PL Invoice should show an **Upgrade to Pro** button, not a file picker.
3. There should be no rate-card section at all.

---

## What to send back

- The full JSON from Step 1 (it is safe to share — no customer data or tokens).
- A screenshot of any two surfaces that disagree about whether a check ran,
  whether a finding exists, or whether your store is healthy.
- Any sentence that states something about your Shopify store that VedaSuite
  could not actually have checked.

Those three are what this pass was for.

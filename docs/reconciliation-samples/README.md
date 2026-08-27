# Reconciliation staging smoke test

Four sample files and the exact clicks to run them. No terminal, no tokens, no
setup. About ten minutes.

Everything here is **read-only**. Reconciliation never changes anything in
Shopify.

---

## Before you start

Open VedaSuite from your Shopify admin and click **Reconciliation** in the left
menu.

If a yellow banner says your products have no SKUs, run a Shopify sync first
(**Store Overview → Refresh**). Reconciliation matches on SKU, so it has nothing
to compare against until at least one product has one.

The sample files use `SKU-A`, `SKU-B`, `SKU-D` and so on. Your staging store
almost certainly uses different SKUs — that is fine and expected. You will see
"no matching Shopify product" findings rather than quantity mismatches, and that
is the correct answer. If you want real matches, open
`inventory-warehouse-stock.csv` in Excel and replace the SKUs with three real
ones from your store.

---

## Test 1 — Inventory

**File:** `inventory-warehouse-stock.csv`

1. On the Reconciliation page, **Inventory** is already selected.
2. Click **Choose File** and pick `inventory-warehouse-stock.csv`.
3. VedaSuite reads the columns and shows what it thinks each one is.
   - **Expected:** SKU and Quantity are already filled in. Unit Cost, Currency
     and Snapshot Date are filled in too.
   - Anything VedaSuite is unsure about is left **blank on purpose**. Pick the
     right column from the dropdown if so.
4. Click **Check this file**.
   - **Expected:** 3 usable rows, 0 unusable, 0 repeated.
5. Click **Reconcile now**.

**What you should see**

- A results table listing each SKU that differed.
- Findings appear in **Action Center** under Reconciliation.
- Because the file has a Unit Cost column, quantity differences carry a money
  value. Remove that column and re-run, and they will read **"Not quantified"** —
  that is the engine refusing to invent a cost, not a bug.

---

## Test 2 — 3PL invoice with a rate card

This is the three-way check: **what you agreed** vs **what your orders actually
contained** vs **what you were billed**.

### Step A — save the rate card

**File:** `3pl-rate-card.csv`

1. In the Reconciliation page's rate-card section, click **Upload rate card**.
2. Choose `3pl-rate-card.csv`.
3. Confirm the columns (Charge Type and Agreed Rate are required).
4. Give it a name — `Test 3PL` — and save.

**Expected:** saved as **version 1**, 4 rates.

### Step B — reconcile the invoice

**File:** `3pl-invoice.csv`

1. Choose the **3PL invoice** check.
2. Upload `3pl-invoice.csv`.
3. Map **Service** to *Charge type* if it is not already.
4. Check the file, then **Reconcile now**.

**What you should see**

| Invoice row | What VedaSuite should say |
|---|---|
| `1001` Pick Fee, 4 items, $10.00 | Compared against your agreed $2.00/item and the real line items on order 1001 |
| `1002` Pack Fee | Priced per **order**, so one charge is expected |
| `1003` Special Handling | **"Could not be matched to your rate card"** — not an overcharge, because you never agreed a rate for it |
| `9999` | **"Does not match any Shopify order"** |

The important one is row `1003`. VedaSuite has no agreed rate for "Special
Handling", so it says it cannot check it. It does **not** call $18.00 an
overcharge. That is the rule.

### Step C — rate-card versioning

1. Open `3pl-rate-card.csv` in Excel, change Pick Fee from `2.00` to `2.20`,
   save.
2. Upload it again with the **same name** (`Test 3PL`).

**Expected:** saved as **version 2**. Version 1 still exists.

3. Reconcile the same invoice again.

**Expected:** the new run uses $2.20. **Your first run still shows $2.00.**
Look at the History table — each run names the rate-card version it used. An
older reconciliation must never change because you renegotiated later.

---

## Test 3 — Supplier shipment

**File:** `supplier-shipment.csv`

1. Choose the **Supplier shipment** check.
2. Upload `supplier-shipment.csv`, confirm the columns, check, reconcile.

**What you should see**

- `SKU-A`: 100 expected, 92 received — an **8-unit shortfall**, valued at
  $36.00 because the file supplies a unit cost.
- `SKU-B`: 50 and 50 — **no finding**. Agreement is silent.
- `SKU-ZZ`: reported as having no matching Shopify product.

Read the SKU-A wording. It should say your **file records** 100 expected and 92
received. It must **not** say the supplier lost, stole or mislaid anything —
the file does not contain evidence for any of that.

---

## Test 4 — Restart safety

This checks the thing that used to be broken.

1. After running Test 1, note the number of findings.
2. Ask for a staging redeploy, or simply wait for the next one.
3. Come back to Reconciliation and run the **same upload** again — do not
   re-upload the file, use the existing one from the sources list.

**Expected:** the same evidence and the same findings as before. Money values
that appeared the first time still appear.

Previously the reference values lived only in memory, so after a restart the
second run silently produced fewer findings and still said "completed". If you
see fewer findings than the first run, that is a real bug — tell me.

---

## Test 5 — Multi-sheet Excel (optional)

1. Open any sample CSV in Excel.
2. Add a second worksheet with anything in it.
3. Save as `.xlsx` and upload.

**Expected:** VedaSuite lists **both** sheet names and tells you which one it
read. You can pick the other one. It must never quietly read one and ignore the
other.

---

## What to send back

- Screenshots of anything that reads wrongly or confusingly.
- Any place a number appears without an explanation of where it came from.
- Any place VedaSuite says something is *wrong* rather than *different* or
  *unchecked*.

Those three are what this feature lives or dies on.

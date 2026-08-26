# Staging inventory test — click by click

Two parts. The products have to exist in Shopify before the reconciliation
check has anything to compare against.

**Read this first:** VedaSuite almost certainly cannot create the products for
you. The app requests `read_products` and deliberately never `write_products` —
the App Store readiness check requires that scope to stay absent. The console
below will tell you exactly that and create nothing. Part 1B is the three
minutes of manual work that unblocks you.

---

## Part 1A — Try the console first (30 seconds)

1. Open, in any browser:

   `https://vedasuite-staging.onrender.com/staging-seed/products?token=YOUR_STAGING_SEED_TOKEN`

   That is the same `STAGING_SEED_TOKEN` you already use for the order seeder.
   Without it the page returns 404, and on production it returns 404 no matter
   what token you supply.

2. Pick your development store in the **Store** dropdown.
3. Click **Check what exists**.

Read the `Can create` and `Can set stock` lines.

| What you see | What it means | Do this |
|---|---|---|
| `Can create: NO` | Expected. The token has no `write_products` | Go to Part 1B |
| `Can create: yes`, `Can set stock: NO` | Products only, no stock — refused on purpose | Go to Part 1B |
| both `yes` | Scopes were widened at some point | Type `CREATE TEST PRODUCTS`, click **Create / Update**, then skip to Part 2 |

Clicking **Create / Update** twice is safe either way — products are upserted on
a fixed handle, so it corrects them rather than creating duplicates.

---

## Part 1B — Create the three products by hand (about 3 minutes)

In **Shopify admin → Products → Add product**, three times:

| Title | SKU | Inventory | Price |
|---|---|---|---|
| VedaSuite Test Product A | `SKU-A` | **20** | 25.00 |
| VedaSuite Test Product B | `SKU-B` | **8** | 40.00 |
| VedaSuite Test Product C | `SKU-C` | **5** | 12.50 |

For each one:

1. Type the **Title**.
2. Scroll to **Inventory**. Put the SKU in the **SKU** field.
3. Tick **Track quantity**, and set **Available** to the number above.
4. In **Tags**, add `vedasuite-test-data` so you can find and delete them later.
5. **Save**.

**Do not create SKU-D.** It has to be missing from Shopify — that is the whole
point of the fourth test case.

---

## Part 2 — Run the test

1. Open VedaSuite from your Shopify admin.
2. **Store Overview → Refresh**. Wait for the sync to finish.
3. Confirm the products arrived: open
   `https://vedasuite-staging.onrender.com/api/diagnostics/sync` in the same
   browser tab and check `persisted.variantsWithSku` is at least 3.

   If it is 0, stop — the products did not sync, and every reconciliation result
   after this would be a false positive. Send me that JSON page.

4. Open **Reconciliation**.
5. Upload your inventory `.xlsx`, containing:

   | SKU | Quantity |
   |---|---|
   | SKU-A | 13 |
   | SKU-B | 8 |
   | SKU-D | 4 |

   SKU-C is absent from the file on purpose.

6. Choose the worksheet, map **SKU** and **Quantity**, click **Check this file**.
   Expect *3 usable rows, 0 unusable*.
7. Click **Reconcile now**.

### What must come back

| SKU | Shopify | File | Expected result |
|---|---|---|---|
| SKU-A | 20 | 13 | **Quantity mismatch**, difference of 7 |
| SKU-B | 8 | 8 | **Exact match** — no discrepancy |
| SKU-C | 5 | — | **Missing externally** |
| SKU-D | — | 4 | **External-only** |

Four rows in, four different outcomes. If SKU-B appears as a discrepancy, or if
SKU-C and SKU-D are described the same way, that is a bug — screenshot it.

---

## Part 3 — The three numbers that used to disagree

This is what the fix in `376ae90` was for. After the reconcile, check all three
in one sitting:

1. **Reconciliation** — the open-findings line near the top.
2. **Action Center** — its headline count.
3. **Store Overview** — the **Reconciliation** tile (new; it did not exist
   before, which is exactly why this read 0).

**All three must show the same number.** Previously Reconciliation showed 1
while both others showed 0, because a reconciliation finding was projected onto
no Store Overview tile.

Also worth a glance while you are on Store Overview:

- The old **Fraud alerts** tile now reads **Customer Loss**.
- The old **Competitor changes** tile now reads **Market Signals**.

---

## Cleaning up

Shopify admin → Products → filter by the tag `vedasuite-test-data` → select all
→ Delete. The reconciliation findings resolve themselves on the next sync once
the mismatch is gone.

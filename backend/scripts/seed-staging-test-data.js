#!/usr/bin/env node
/**
 * STAGING-ONLY test data, created through Shopify's own Admin API.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every staging screenshot so far has been of an empty store: zero products,
 * orders, customers, pricing rows and competitor rows. That exercises the
 * empty-data path and nothing else. Every failure this stabilization programme
 * fixed — a resolved finding still counted, a dismissed problem still
 * described, a re-detection resurrecting closed work — needs a finding to exist
 * before it can happen at all.
 *
 * So the lifecycle gate cannot be closed without real orders. This creates
 * them the way a merchant's store would have them: as genuine Shopify orders in
 * a development store, read back by the normal sync.
 *
 * WHAT IT CREATES, AND WHY EACH PART
 * ----------------------------------
 * The shape is dictated by the DOCUMENTED thresholds in customerLossCalc.ts.
 * Nothing here is tuned to squeeze past a gate; it is sized to clear each one
 * honestly, and if a threshold is ever raised the answer is a bigger fixture:
 *
 *   CUSTOMER_LOSS.minStoreOrders     = 50  -> 60 baseline orders
 *   CUSTOMER_LOSS.minEligibleOrders  = 3   -> the lossy customer gets 4
 *   CUSTOMER_LOSS.minRefundedOrders  = 2   -> 3 of those 4 are refunded
 *   CUSTOMER_LOSS.minObservedLossRatio = 0.3 -> 3/4 of value refunded = 0.75
 *
 * It also spreads orders across ~8 customers so the store baseline is a real
 * distribution rather than one repeated shopper, and keeps the store's own
 * refund rate low (3 of 60) so the lossy customer stands out against it
 * legitimately rather than because the baseline is degenerate.
 *
 * SAFETY PROPERTIES
 * -----------------
 * 1. It refuses to run without an explicit confirmation env var, so it can
 *    never execute as a side effect of a build or a deploy.
 * 2. It refuses any shop domain that is not a *.myshopify.com development
 *    store, and refuses the production app domain outright.
 * 3. It requires SEED_SHOP and SEED_ACCESS_TOKEN to be passed explicitly. It
 *    reads no production configuration and touches no production database.
 * 4. It writes ONLY to Shopify, never to VedaSuite's database. In particular it
 *    creates no IntelligenceFinding rows: findings must be produced by the real
 *    sync -> detection pipeline, or the test proves nothing.
 * 5. It never prints the access token.
 * 6. Orders are tagged `vedasuite-test-data` so every row it created is
 *    identifiable and removable afterwards.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * --------------------------------
 * It does not create products. The app's granted scopes are
 * read_products,read_orders,write_orders,read_customers — there is no
 * write_products, so product creation is not available to this token and
 * inventing a workaround would mean asking for a scope the app does not need.
 * Orders therefore use custom line items, which Shopify allows without a
 * product record. See "PRODUCT COST" below for what this means for the pricing
 * engines.
 *
 * PRODUCT COST
 * ------------
 * Shopify does not expose product cost to this app, and no supported test
 * mechanism changes that. Pricing & Product Profit will therefore still report
 * that it cannot quantify margin — which is the CORRECT result, not a gap in
 * this fixture. Do not add a fake cost to make that screen populate.
 *
 * USAGE
 *   SEED_CONFIRM=seed-staging-test-data \
 *   SEED_SHOP=your-dev-store.myshopify.com \
 *   SEED_ACCESS_TOKEN=shpua_... \
 *     node scripts/seed-staging-test-data.js
 *
 * Add --dry-run to print the plan without creating anything.
 *
 * EXIT CODES
 *   0  seed completed (or dry run printed)
 *   1  Shopify rejected part of the seed
 *   2  refused to run (missing gate, bad shop, missing token)
 */

const REQUIRED_CONFIRMATION = "seed-staging-test-data";
const TEST_TAG = "vedasuite-test-data";
const API_VERSION = process.env.SHOPIFY_ADMIN_API_VERSION || "2026-01";

/** Thresholds this fixture is sized against. Kept in sync with customerLossCalc.ts. */
const TARGET = {
  baselineOrders: 60,
  baselineRefunds: 3,
  lossyCustomerOrders: 4,
  lossyCustomerRefunds: 3,
  customerCount: 8,
  orderValue: 100,
  lossyOrderValue: 200,
};

function refuse(message) {
  console.error(`[REFUSED] ${message}`);
  process.exit(2);
}

function assertSafeShop(shop) {
  if (!shop) {
    refuse("SEED_SHOP is required. Pass the development store's *.myshopify.com domain.");
  }
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(shop)) {
    refuse(
      `"${shop}" is not a *.myshopify.com store domain. This script only seeds development stores.`
    );
  }
  // Belt and braces: the production app domain is not a store domain, but an
  // operator pasting the wrong value should hit a wall rather than a 404.
  if (/vedasuite\.in$/i.test(shop) || /app\.vedasuite/i.test(shop)) {
    refuse("That is the VedaSuite app domain, not a Shopify store. Refusing.");
  }
}

async function shopifyRest(shop, token, method, resource, body) {
  const response = await fetch(
    `https://${shop}/admin/api/${API_VERSION}/${resource}`,
    {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
      },
      body: body ? JSON.stringify(body) : undefined,
    }
  );

  const text = await response.text();
  if (!response.ok) {
    // The token is never echoed, including in failures.
    throw new Error(`Shopify ${method} ${resource} -> ${response.status}: ${text.slice(0, 400)}`);
  }
  return text ? JSON.parse(text) : null;
}

/** One customer's identity. Stable so re-running does not fan out new shoppers. */
function customerFor(index) {
  return {
    first_name: "Test",
    last_name: `Shopper${index}`,
    email: `vedasuite.test.shopper${index}@example.com`,
  };
}

/**
 * Builds the order payloads.
 *
 * `created_at` is set explicitly so the orders land inside the detector's
 * 365-day observation window rather than all on today — a store whose entire
 * history happened in one minute is not a realistic baseline.
 */
function buildPlan() {
  const orders = [];
  const now = Date.now();
  const daysAgo = (n) => new Date(now - n * 86_400_000).toISOString();

  for (let i = 0; i < TARGET.baselineOrders; i += 1) {
    const customerIndex = i % TARGET.customerCount;
    orders.push({
      label: `baseline-${i}`,
      customerIndex,
      amount: TARGET.orderValue,
      // Keep the store's own refund rate low so the lossy customer stands out
      // against a healthy baseline, not a degenerate one.
      refund: i < TARGET.baselineRefunds,
      createdAt: daysAgo(30 + (i % 90)),
    });
  }

  for (let i = 0; i < TARGET.lossyCustomerOrders; i += 1) {
    orders.push({
      label: `loss-${i}`,
      // A dedicated shopper index outside the baseline range.
      customerIndex: TARGET.customerCount,
      amount: TARGET.lossyOrderValue,
      refund: i < TARGET.lossyCustomerRefunds,
      createdAt: daysAgo(10 + i),
    });
  }

  return orders;
}

function summarisePlan(orders) {
  const byCustomer = new Map();
  for (const o of orders) {
    const entry = byCustomer.get(o.customerIndex) ?? { orders: 0, refunds: 0, value: 0, refunded: 0 };
    entry.orders += 1;
    entry.value += o.amount;
    if (o.refund) {
      entry.refunds += 1;
      entry.refunded += o.amount;
    }
    byCustomer.set(o.customerIndex, entry);
  }

  console.log(`\nPLAN: ${orders.length} orders across ${byCustomer.size} customers`);
  for (const [index, e] of [...byCustomer.entries()].sort((a, b) => a[0] - b[0])) {
    const ratio = e.value > 0 ? (e.refunded / e.value) : 0;
    const qualifies =
      e.orders >= 3 && e.refunds >= 2 && ratio >= 0.3
        ? "  <-- should qualify for a Customer Loss finding"
        : "";
    console.log(
      `  shopper${index}: ${e.orders} orders, ${e.refunds} refunded, ` +
        `${Math.round(ratio * 100)}% of value returned${qualifies}`
    );
  }
  const totalRefunds = orders.filter((o) => o.refund).length;
  console.log(
    `\n  store baseline: ${orders.length} orders, ${totalRefunds} refunded ` +
      `(${Math.round((totalRefunds / orders.length) * 100)}%)`
  );
  console.log(`  every order tagged: ${TEST_TAG}\n`);
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");

  if (process.env.SEED_CONFIRM !== REQUIRED_CONFIRMATION) {
    refuse(
      "This script creates data in a Shopify store and will not run without an " +
        `explicit confirmation, so it cannot execute as a side effect of a build.\n` +
        `          Set SEED_CONFIRM=${REQUIRED_CONFIRMATION} to proceed.`
    );
  }

  const shop = process.env.SEED_SHOP;
  assertSafeShop(shop);

  const token = process.env.SEED_ACCESS_TOKEN;
  if (!token && !dryRun) {
    refuse(
      "SEED_ACCESS_TOKEN is required. Use the development store's Admin API access " +
        "token for an app with write_orders. It is never printed or stored."
    );
  }

  const plan = buildPlan();
  summarisePlan(plan);

  if (dryRun) {
    console.log("DRY RUN — nothing was created.");
    return;
  }

  console.log(`Seeding ${shop} ...`);
  let created = 0;
  let refunded = 0;

  for (const item of plan) {
    const customer = customerFor(item.customerIndex);

    // A custom line item (title + price, no variant_id) is how Shopify allows
    // an order without a product record — which matters because this app has
    // no write_products scope.
    const order = await shopifyRest(shop, token, "POST", "orders.json", {
      order: {
        line_items: [
          {
            title: `VedaSuite test item (${item.label})`,
            price: item.amount.toFixed(2),
            quantity: 1,
          },
        ],
        customer,
        financial_status: "paid",
        created_at: item.createdAt,
        tags: TEST_TAG,
        // Suppresses order confirmation email to the fake address.
        send_receipt: false,
        send_fulfillment_receipt: false,
        inventory_behaviour: "bypass",
        test: true,
      },
    });

    created += 1;
    const orderId = order?.order?.id;

    if (item.refund && orderId) {
      // Refund the full amount so displayFinancialStatus becomes REFUNDED,
      // which is what the sync reads to set `refunded` on the order row.
      await shopifyRest(shop, token, "POST", `orders/${orderId}/refunds.json`, {
        refund: {
          notify: false,
          note: "VedaSuite staging test data",
          shipping: { full_refund: true },
          refund_line_items: (order.order.line_items ?? []).map((li) => ({
            line_item_id: li.id,
            quantity: li.quantity,
            restock_type: "no_restock",
          })),
        },
      });
      refunded += 1;
    }

    if (created % 10 === 0) {
      console.log(`  ${created}/${plan.length} orders created ...`);
    }
  }

  console.log(`\nDONE: ${created} orders created, ${refunded} refunded.`);
  console.log("\nNEXT: run Sync Data in VedaSuite, then work through the smoke test.");
  console.log(
    `CLEANUP: every order carries the tag "${TEST_TAG}". Filter on it in the ` +
      "Shopify admin to review or remove them."
  );
}

// Exported so the plan can be PROVEN before anyone runs it against a real
// store: tests/seedPlanQualifies.test.cjs feeds this exact shape through the
// real detector and asserts it produces a Customer Loss finding. A fixture
// nobody has verified is just a hope.
module.exports = { buildPlan, customerFor, TARGET, TEST_TAG };

if (require.main === module) {
  main().catch((error) => {
    console.error(`\n[FAILED] ${error.message}`);
    process.exit(1);
  });
}

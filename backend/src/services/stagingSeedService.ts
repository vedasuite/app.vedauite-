// Creates staging test orders in a Shopify DEVELOPMENT store.
//
// WHY THIS EXISTS AS A SERVICE, NOT ONLY A SCRIPT
// -----------------------------------------------
// The CLI script requires an Admin API token to be handled by whoever runs it.
// This path does not: the app already holds a valid offline token for the store
// the merchant installed it on, so the operator never sees, copies or pastes a
// credential. That is strictly safer than the alternative, and it is the whole
// reason the click-to-run console exists.
//
// WHAT IT WILL NOT DO
// -------------------
//   * It never writes an IntelligenceFinding. Findings must be produced by the
//     real sync -> detection pipeline or the smoke test proves nothing.
//   * It never touches a store that is not a *.myshopify.com development store.
//   * It never runs unless STAGING_SEED_TOKEN is configured (see the router),
//     so on production — where that variable is unset — none of this exists.
//
// WHY orderCreate AND NOT refundCreate
// ------------------------------------
// A refunded order is created directly with financialStatus: REFUNDED rather
// than created-then-refunded. The sync reads `displayFinancialStatus` and marks
// the order refunded from that string, so a second mutation would add moving
// parts and a partial-failure mode for no gain.

import { shopifyGraphQL } from "./shopifyAdminService";
import { logEvent } from "./observabilityService";
import {
  buildStagingSeedPlan,
  isSeedableShopDomain,
  STAGING_TEST_TAG,
  type StagingSeedOrder,
} from "./stagingSeedPlan";

export interface SeedProgress {
  created: number;
  refunded: number;
  failed: number;
  firstError: string | null;
}

type OrderCreateResponse = {
  orderCreate: {
    order: { id: string; name: string; displayFinancialStatus: string } | null;
    userErrors: Array<{ field?: string[] | null; message: string }>;
  };
};

/**
 * Creates one order.
 *
 * GraphQL rather than REST: Shopify has been retiring REST Admin endpoints, and
 * `orderCreate` is the supported path on current API versions. `inventoryBehaviour:
 * BYPASS` keeps a test order from moving real stock, and `sendReceipt: false`
 * means no email reaches the example.com addresses.
 */
async function createSeedOrder(shop: string, order: StagingSeedOrder) {
  const amount = order.amount.toFixed(2);

  const data = await shopifyGraphQL<OrderCreateResponse>(
    shop,
    `
      mutation SeedOrderCreate($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
        orderCreate(order: $order, options: $options) {
          order {
            id
            name
            displayFinancialStatus
          }
          userErrors {
            field
            message
          }
        }
      }
    `,
    {
      order: {
        email: order.email,
        processedAt: order.processedAt,
        // The tag is what makes every row this created findable and removable.
        tags: [STAGING_TEST_TAG],
        financialStatus: order.refunded ? "REFUNDED" : "PAID",
        lineItems: [
          {
            title: `VedaSuite staging test item (${order.label})`,
            quantity: 1,
            priceSet: {
              shopMoney: { amount, currencyCode: "USD" },
            },
          },
        ],
      },
      options: {
        sendReceipt: false,
        sendFulfillmentReceipt: false,
        inventoryBehaviour: "BYPASS",
      },
    },
    { timeoutMs: 30000 }
  );

  const payload = data.orderCreate;
  if (payload.userErrors?.length) {
    throw new Error(payload.userErrors.map((e) => e.message).join("; "));
  }
  if (!payload.order?.id) {
    throw new Error("Shopify accepted the request but returned no order.");
  }
  return payload.order;
}

/**
 * Creates exactly ONE order and reports what happened.
 *
 * Which Admin API capabilities a store exposes varies by API version and by how
 * the app was created, and that could not be verified without a live store. So
 * rather than assume and loop sixty-four times, the console proves it in a
 * single call first — a wrong API version then fails on order one with a
 * readable message instead of leaving a store half-seeded.
 */
export async function preflightStagingSeed(shop: string) {
  if (!isSeedableShopDomain(shop)) {
    throw new Error(`${shop} is not a Shopify development store. Refusing.`);
  }
  const plan = buildStagingSeedPlan();
  const order = await createSeedOrder(shop, plan[0]);
  logEvent("warn", "staging.seed_preflight", {
    shop,
    orderName: order.name,
    financialStatus: order.displayFinancialStatus,
  });
  return order;
}

/**
 * Creates the full plan.
 *
 * `skipFirst` exists so the preflight order is reused rather than duplicated.
 * Failures are counted and the first message kept, so a partial run reports
 * honestly instead of appearing to succeed.
 */
export async function runStagingSeed(input: {
  shop: string;
  skipFirst?: boolean;
  onProgress?: (progress: SeedProgress) => void;
}): Promise<SeedProgress> {
  if (!isSeedableShopDomain(input.shop)) {
    throw new Error(`${input.shop} is not a Shopify development store. Refusing.`);
  }

  const plan = buildStagingSeedPlan();
  const progress: SeedProgress = { created: 0, refunded: 0, failed: 0, firstError: null };

  logEvent("warn", "staging.seed_started", {
    shop: input.shop,
    orders: plan.length,
    tag: STAGING_TEST_TAG,
  });

  for (const [index, order] of plan.entries()) {
    if (index === 0 && input.skipFirst) {
      progress.created += 1;
      if (order.refunded) progress.refunded += 1;
      continue;
    }

    try {
      await createSeedOrder(input.shop, order);
      progress.created += 1;
      if (order.refunded) progress.refunded += 1;
    } catch (error) {
      progress.failed += 1;
      if (!progress.firstError) {
        progress.firstError = error instanceof Error ? error.message : String(error);
      }
    }

    input.onProgress?.(progress);
  }

  logEvent("warn", "staging.seed_finished", { shop: input.shop, ...progress });
  return progress;
}

type TaggedOrdersResponse = {
  orders: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    edges: Array<{ node: { id: string; name: string } }>;
  };
};

/**
 * Counts the orders this tool created, so the operator can confirm the seed
 * landed and later confirm cleanup finished. Read-only.
 */
export async function countTaggedTestOrders(shop: string): Promise<number> {
  if (!isSeedableShopDomain(shop)) {
    throw new Error(`${shop} is not a Shopify development store. Refusing.`);
  }

  let total = 0;
  let after: string | null = null;
  for (let page = 0; page < 20; page += 1) {
    const data: TaggedOrdersResponse = await shopifyGraphQL<TaggedOrdersResponse>(
      shop,
      `
        query TaggedTestOrders($first: Int!, $after: String, $query: String!) {
          orders(first: $first, after: $after, query: $query) {
            pageInfo { hasNextPage endCursor }
            edges { node { id name } }
          }
        }
      `,
      { first: 250, after, query: `tag:'${STAGING_TEST_TAG}'` },
      { timeoutMs: 30000 }
    );
    total += data.orders.edges.length;
    if (!data.orders.pageInfo.hasNextPage) break;
    after = data.orders.pageInfo.endCursor;
  }
  return total;
}

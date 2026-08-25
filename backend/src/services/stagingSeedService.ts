// Creates staging test orders in a Shopify DEVELOPMENT store.
//
// WHY THIS EXISTS AS A SERVICE, NOT ONLY A SCRIPT
// -----------------------------------------------
// The app already holds a valid offline token for the store the merchant
// installed it on, so the operator never sees, copies or pastes a credential.
//
// WHAT IT WILL NOT DO
// -------------------
//   * It never writes an IntelligenceFinding. Findings must be produced by the
//     real sync -> detection pipeline or the smoke test proves nothing.
//   * It never touches a store that is not a *.myshopify.com development store.
//   * It never runs unless STAGING_SEED_TOKEN is configured (see the router),
//     so on production — where that variable is unset — none of this exists.
//
// THROTTLING: WHAT WENT WRONG THE FIRST TIME
// ------------------------------------------
// The first run created 10 orders and failed 54 with "Too many attempts. Please
// try again later." The loop fired `orderCreate` as fast as the event loop
// allowed, with no pacing and no retry, so it emptied Shopify's leaky bucket in
// a few seconds and then burned every remaining order against a closed door.
//
// Three separate faults, all fixed here:
//   1. No pacing        -> a fixed delay between creations keeps the bucket fed.
//   2. No throttle      -> 429s and GraphQL THROTTLED are now detected, and
//      detection            Retry-After is honoured when Shopify sends it.
//   3. No resume        -> a failed order was lost. Orders now carry a per-order
//                          identity tag, so a re-run creates only what is
//                          genuinely missing and can never duplicate.
//
// WHY A LOCAL CLIENT AND NOT shopifyGraphQL
// -----------------------------------------
// The shared client discards response headers, so `Retry-After` is unreachable
// through it — and it is the production sync path, which this work is not
// allowed to touch. The client below is staging-only and self-contained.
//
// WHY orderCreate AND NOT refundCreate
// ------------------------------------
// A refunded order is created directly with financialStatus: REFUNDED rather
// than created-then-refunded. The sync reads `displayFinancialStatus` and marks
// the order refunded from that string, so a second mutation would add moving
// parts and a partial-failure mode for no gain.

import { env } from "../config/env";
import { resolveOfflineInstallation } from "./shopifyConnectionService";
import { logEvent } from "./observabilityService";
import {
  buildStagingSeedPlan,
  isSeedableShopDomain,
  seedLabelTag,
  labelFromSeedTag,
  STAGING_TEST_TAG,
  type StagingSeedOrder,
} from "./stagingSeedPlan";

/** Orders created per HTTP request, so no single request runs for minutes. */
export const SEED_BATCH_SIZE = 12;
/** Pacing between creations. Shopify's bucket refills continuously; this stays under it. */
export const SEED_DELAY_MS = 700;
/** Attempts per order before it is recorded as failed and the batch moves on. */
export const SEED_MAX_ATTEMPTS = 5;
/** First backoff step. Doubles each attempt, capped below. */
export const SEED_BACKOFF_BASE_MS = 2000;
export const SEED_BACKOFF_CAP_MS = 30000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The timing knobs, injectable ONLY so tests need not sleep for real.
 *
 * Production always uses DEFAULT_TIMING. A test that had to wait 40 real
 * seconds to prove idempotency would either be deleted or made to run rarely,
 * and a regression test nobody runs protects nothing — so the bulk tests inject
 * zero delays, while a dedicated test asserts these defaults are what ships.
 */
export interface SeedTiming {
  delayMs: number;
  maxAttempts: number;
  /** Upper bound on any single backoff wait. 0 disables waiting entirely. */
  backoffMs: number;
}

export const DEFAULT_TIMING: SeedTiming = {
  delayMs: SEED_DELAY_MS,
  maxAttempts: SEED_MAX_ATTEMPTS,
  backoffMs: SEED_BACKOFF_CAP_MS,
};

/** A throttle response, with however long Shopify asked us to wait. */
class ThrottledError extends Error {
  constructor(readonly retryAfterMs: number | null) {
    super("Shopify throttled the request.");
    this.name = "ThrottledError";
  }
}

/**
 * Recognises throttling in all the shapes Shopify uses.
 *
 * Exported for tests: this is the judgement the whole retry loop rests on, and
 * getting it wrong in either direction is expensive — treat a real throttle as
 * a hard failure and the run dies; treat a hard failure as a throttle and it
 * retries something that will never succeed.
 */
export function isThrottleMessage(message: string): boolean {
  return /throttled|too many attempts|rate limit|exceeded .*calls|429/i.test(message);
}

/** Parses Retry-After, which Shopify sends in seconds. */
export function parseRetryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  // Bounded: a malformed or hostile value must not park the run for an hour.
  return Math.min(Math.round(seconds * 1000), SEED_BACKOFF_CAP_MS);
}

/** Backoff for attempt N, with jitter so parallel operators do not sync up. */
export function backoffMs(attempt: number, random = Math.random): number {
  const exponential = Math.min(
    SEED_BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1),
    SEED_BACKOFF_CAP_MS
  );
  return Math.round(exponential * (0.75 + random() * 0.5));
}

type GraphQLBody = {
  data?: unknown;
  errors?: Array<{ message: string; extensions?: { code?: string } }>;
};

/**
 * Staging-only Shopify client.
 *
 * Distinguishes three outcomes the shared client collapses into one: success,
 * throttled (retryable, possibly with a Retry-After), and a hard error.
 */
async function stagingGraphQL<T>(
  shop: string,
  query: string,
  variables: Record<string, unknown>
): Promise<T> {
  const installation = (await resolveOfflineInstallation(shop)) as {
    shop: string;
    accessToken: string | null;
  };

  const response = await fetch(
    `https://${installation.shop}/admin/api/${env.shopifyAdminApiVersion}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": installation.accessToken ?? "",
      },
      body: JSON.stringify({ query, variables }),
    }
  );

  if (response.status === 429) {
    throw new ThrottledError(parseRetryAfterMs(response.headers.get("retry-after")));
  }

  const text = await response.text();

  if (!response.ok) {
    // Shopify also returns the abuse message with a non-429 status.
    if (isThrottleMessage(text)) {
      throw new ThrottledError(parseRetryAfterMs(response.headers.get("retry-after")));
    }
    throw new Error(`Shopify ${response.status}: ${text.slice(0, 300)}`);
  }

  const payload = JSON.parse(text) as GraphQLBody;
  if (payload.errors?.length) {
    const message = payload.errors.map((e) => e.message).join("; ");
    // GraphQL throttling arrives as HTTP 200 with a THROTTLED extension code.
    const throttled =
      payload.errors.some((e) => e.extensions?.code === "THROTTLED") ||
      isThrottleMessage(message);
    if (throttled) {
      throw new ThrottledError(parseRetryAfterMs(response.headers.get("retry-after")));
    }
    throw new Error(message);
  }

  return payload.data as T;
}

type OrderCreateResponse = {
  orderCreate: {
    order: { id: string; name: string; displayFinancialStatus: string } | null;
    userErrors: Array<{ field?: string[] | null; message: string }>;
  };
};

/**
 * Creates one order, retrying only on throttling.
 *
 * A hard error (bad input, missing scope, unsupported API version) is returned
 * immediately: retrying it five times wastes the batch and buries the real
 * message under a timeout.
 */
async function createSeedOrder(
  shop: string,
  order: StagingSeedOrder,
  timing: SeedTiming = DEFAULT_TIMING
) {
  let lastThrottle: ThrottledError | null = null;

  for (let attempt = 1; attempt <= timing.maxAttempts; attempt += 1) {
    try {
      const data = await stagingGraphQL<OrderCreateResponse>(
        shop,
        `
          mutation SeedOrderCreate($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
            orderCreate(order: $order, options: $options) {
              order { id name displayFinancialStatus }
              userErrors { field message }
            }
          }
        `,
        {
          order: {
            email: order.email,
            processedAt: order.processedAt,
            // TWO tags. The first makes every seeded order findable and
            // removable as a group; the second is this order's stable identity,
            // which is what makes the run resumable and duplicate-proof.
            tags: [STAGING_TEST_TAG, seedLabelTag(order.label)],
            financialStatus: order.refunded ? "REFUNDED" : "PAID",
            lineItems: [
              {
                title: `VedaSuite staging test item (${order.label})`,
                quantity: 1,
                priceSet: {
                  shopMoney: { amount: order.amount.toFixed(2), currencyCode: "USD" },
                },
              },
            ],
          },
          options: {
            sendReceipt: false,
            sendFulfillmentReceipt: false,
            inventoryBehaviour: "BYPASS",
          },
        }
      );

      const payload = data.orderCreate;
      if (payload.userErrors?.length) {
        throw new Error(payload.userErrors.map((e) => e.message).join("; "));
      }
      if (!payload.order?.id) {
        throw new Error("Shopify accepted the request but returned no order.");
      }
      return payload.order;
    } catch (error) {
      if (!(error instanceof ThrottledError)) throw error;
      lastThrottle = error;
      if (attempt === timing.maxAttempts) break;
      // Shopify's own Retry-After wins over our guess when it sends one.
      await sleep(
        timing.backoffMs > 0
          ? Math.min(error.retryAfterMs ?? backoffMs(attempt), timing.backoffMs)
          : 0
      );
    }
  }

  throw new Error(
    `Shopify kept throttling this order after ${timing.maxAttempts} attempts. ` +
      `Wait a minute and click Continue — nothing already created will be repeated.` +
      (lastThrottle?.retryAfterMs ? ` Shopify asked for ${lastThrottle.retryAfterMs}ms.` : "")
  );
}

type TaggedOrdersResponse = {
  orders: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    edges: Array<{ node: { id: string; name: string; tags: string[] } }>;
  };
};

export interface SeedState {
  /** Plan labels already present in Shopify. */
  existingLabels: string[];
  /** Total orders carrying the group tag, including any not in the plan. */
  taggedOrderCount: number;
  totalPlanned: number;
  remaining: number;
  /** Refunded orders the plan expects that already exist. */
  refundedExisting: number;
  /** True when the store has enough valid fixture orders for the smoke test. */
  readyToSync: boolean;
  readyReason: string;
}

/**
 * Reads back what already exists.
 *
 * This is what makes the run resumable AND duplicate-proof: identity lives in
 * Shopify, not in this process, so it survives a crash, a redeploy, a closed
 * browser tab and any number of repeated clicks.
 */
export async function readSeedState(shop: string): Promise<SeedState> {
  if (!isSeedableShopDomain(shop)) {
    throw new Error(`${shop} is not a Shopify development store. Refusing.`);
  }

  const found = new Set<string>();
  let taggedOrderCount = 0;
  let after: string | null = null;

  for (let page = 0; page < 20; page += 1) {
    const data: TaggedOrdersResponse = await stagingGraphQL<TaggedOrdersResponse>(
      shop,
      `
        query TaggedTestOrders($first: Int!, $after: String, $query: String!) {
          orders(first: $first, after: $after, query: $query) {
            pageInfo { hasNextPage endCursor }
            edges { node { id name tags } }
          }
        }
      `,
      { first: 250, after, query: `tag:'${STAGING_TEST_TAG}'` }
    );

    for (const edge of data.orders.edges) {
      taggedOrderCount += 1;
      for (const tag of edge.node.tags ?? []) {
        const label = labelFromSeedTag(tag);
        if (label) found.add(label);
      }
    }

    if (!data.orders.pageInfo.hasNextPage) break;
    after = data.orders.pageInfo.endCursor;
  }

  const plan = buildStagingSeedPlan();
  const existingLabels = plan.map((o) => o.label).filter((l) => found.has(l));
  const refundedExisting = plan.filter((o) => o.refunded && found.has(o.label)).length;

  return {
    existingLabels,
    taggedOrderCount,
    totalPlanned: plan.length,
    remaining: plan.length - existingLabels.length,
    refundedExisting,
    ...assessReadiness(plan, found, taggedOrderCount),
  };
}

/**
 * Whether the store actually has enough fixture data for the smoke test.
 *
 * This gates the "now click Sync Data" message. The first run finished with 10
 * of 64 orders and still said the store was ready — which would have sent the
 * operator to an empty Action Center with no way to tell whether the FIXTURE or
 * the PRODUCT was at fault. Two conditions, both required:
 *
 *   * at least 50 orders, because CUSTOMER_LOSS refuses to compute a store
 *     baseline below that;
 *   * every one of the lossy shopper's orders, because that shopper IS the
 *     finding the smoke test is looking for. 49 baseline orders and no lossy
 *     shopper is a store with nothing to find.
 */
export function assessReadiness(
  plan: StagingSeedOrder[],
  found: Set<string>,
  taggedOrderCount: number
): { readyToSync: boolean; readyReason: string } {
  const MIN_STORE_ORDERS = 50;
  const lossLabels = plan.filter((o) => o.label.startsWith("loss-")).map((o) => o.label);
  const missingLoss = lossLabels.filter((l) => !found.has(l));

  if (taggedOrderCount < MIN_STORE_ORDERS) {
    return {
      readyToSync: false,
      readyReason:
        `Only ${taggedOrderCount} of ${plan.length} test orders exist. Customer Loss will ` +
        `not compute a store baseline below ${MIN_STORE_ORDERS} orders, so syncing now ` +
        `would show an empty Action Center and prove nothing. Click Continue.`,
    };
  }

  if (missingLoss.length > 0) {
    return {
      readyToSync: false,
      readyReason:
        `${taggedOrderCount} orders exist, but ${missingLoss.length} of the repeat-refund ` +
        `shopper's orders are missing. That shopper is the finding this test looks for. ` +
        `Click Continue.`,
    };
  }

  return {
    readyToSync: true,
    readyReason:
      `${taggedOrderCount} test orders are in place, including the full repeat-refund ` +
      `shopper. Open VedaSuite in Shopify and click Sync Data.`,
  };
}

export interface BatchResult {
  createdThisBatch: number;
  refundedThisBatch: number;
  failedThisBatch: number;
  errors: string[];
  state: SeedState;
  /** True while orders remain and the last batch made progress. */
  moreToDo: boolean;
}

/**
 * Creates the next batch of MISSING orders.
 *
 * Deliberately bounded per call: 64 sequential paced creations plus throttle
 * backoff can run for minutes, and a single HTTP request that long is at the
 * mercy of every proxy between the browser and Render. The page calls this
 * repeatedly instead, which also gives the operator live progress and a natural
 * resume point.
 */
export async function runSeedBatch(input: {
  shop: string;
  batchSize?: number;
  /** Injectable ONLY so tests need not sleep for real. Production uses the defaults. */
  timing?: Partial<SeedTiming>;
}): Promise<BatchResult> {
  const timing: SeedTiming = { ...DEFAULT_TIMING, ...(input.timing ?? {}) };
  if (!isSeedableShopDomain(input.shop)) {
    throw new Error(`${input.shop} is not a Shopify development store. Refusing.`);
  }

  const before = await readSeedState(input.shop);
  const done = new Set(before.existingLabels);
  const plan = buildStagingSeedPlan();
  const todo = plan.filter((o) => !done.has(o.label)).slice(0, input.batchSize ?? SEED_BATCH_SIZE);

  logEvent("warn", "staging.seed_batch_started", {
    shop: input.shop,
    alreadyPresent: before.existingLabels.length,
    batch: todo.length,
    remaining: before.remaining,
  });

  let createdThisBatch = 0;
  let refundedThisBatch = 0;
  let failedThisBatch = 0;
  const errors: string[] = [];

  for (const [index, order] of todo.entries()) {
    if (index > 0 && timing.delayMs > 0) await sleep(timing.delayMs);
    try {
      await createSeedOrder(input.shop, order, timing);
      createdThisBatch += 1;
      if (order.refunded) refundedThisBatch += 1;
    } catch (error) {
      failedThisBatch += 1;
      const message = error instanceof Error ? error.message : String(error);
      if (errors.length < 3 && !errors.includes(message)) errors.push(message);
      // A throttle that survived five attempts means the bucket is genuinely
      // empty. Stop the batch rather than burning the rest against a closed
      // door — which is exactly what produced 54 failures the first time.
      if (/throttl/i.test(message)) break;
    }
  }

  const state = await readSeedState(input.shop);
  logEvent("warn", "staging.seed_batch_finished", {
    shop: input.shop,
    createdThisBatch,
    failedThisBatch,
    remaining: state.remaining,
  });

  return {
    createdThisBatch,
    refundedThisBatch,
    failedThisBatch,
    errors,
    state,
    moreToDo: state.remaining > 0 && createdThisBatch > 0,
  };
}

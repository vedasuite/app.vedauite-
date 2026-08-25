// The staging test-data plan. ONE definition, shared by the CLI script and the
// click-to-run staging console, so the two can never drift.
//
// WHY THIS SHAPE
// --------------
// It is dictated by the DOCUMENTED thresholds in customerLossCalc.ts. Nothing
// here is tuned to squeeze past a gate; it is sized to clear each one honestly,
// and if a threshold is ever raised the answer is a BIGGER FIXTURE, never a
// smaller threshold:
//
//   CUSTOMER_LOSS.minStoreOrders       = 50  -> 60 baseline orders
//   CUSTOMER_LOSS.minEligibleOrders    = 3   -> the lossy shopper gets 4
//   CUSTOMER_LOSS.minRefundedOrders    = 2   -> 3 of those 4 are refunded
//   CUSTOMER_LOSS.minObservedLossRatio = 0.3 -> 3/4 of value refunded = 0.75
//
// Orders are spread across several shoppers so the store baseline is a real
// distribution rather than one repeated customer, and the store's own refund
// rate is kept low so the lossy shopper stands out against a HEALTHY baseline
// rather than a degenerate one.
//
// NO FINDINGS ARE CREATED ANYWHERE IN THIS PATH. Findings must come from the
// real sync -> detection pipeline, or the smoke test proves nothing.

/** Every order this plan creates carries this tag, so it is findable and removable. */
export const STAGING_TEST_TAG = "vedasuite-test-data";

/**
 * Prefix for the PER-ORDER identity tag.
 *
 * The group tag above answers "did this tool create it". This one answers
 * "which planned order is it", and that is what makes a seed run resumable and
 * duplicate-proof: identity lives in Shopify rather than in the process that
 * created it, so it survives a throttle, a crash, a redeploy, a closed browser
 * tab and any number of repeated clicks.
 */
export const STAGING_SEED_LABEL_PREFIX = "vedasuite-seed-";

/** The identity tag for one planned order. */
export function seedLabelTag(label: string): string {
  return `${STAGING_SEED_LABEL_PREFIX}${label}`;
}

/** Recovers a plan label from a tag, or null if it is not an identity tag. */
export function labelFromSeedTag(tag: string): string | null {
  if (!tag.startsWith(STAGING_SEED_LABEL_PREFIX)) return null;
  const label = tag.slice(STAGING_SEED_LABEL_PREFIX.length);
  return label.length > 0 ? label : null;
}

export const STAGING_SEED_TARGET = {
  baselineOrders: 60,
  baselineRefunds: 3,
  lossyShopperOrders: 4,
  lossyShopperRefunds: 3,
  shopperCount: 8,
  orderValue: 100,
  lossyOrderValue: 200,
  currency: "USD",
} as const;

export interface StagingSeedOrder {
  label: string;
  shopperIndex: number;
  amount: number;
  refunded: boolean;
  /** ISO timestamp, inside the detector's 365-day observation window. */
  processedAt: string;
  email: string;
}

/** Stable per shopper, so re-running does not fan out new customers. */
export function stagingSeedEmail(shopperIndex: number): string {
  return `vedasuite.test.shopper${shopperIndex}@example.com`;
}

/**
 * Builds the plan.
 *
 * `nowMs` is injectable purely so tests are deterministic; the CLI and console
 * both pass the real clock.
 */
export function buildStagingSeedPlan(nowMs: number = Date.now()): StagingSeedOrder[] {
  const orders: StagingSeedOrder[] = [];
  const daysAgo = (n: number) => new Date(nowMs - n * 86_400_000).toISOString();
  const T = STAGING_SEED_TARGET;

  for (let i = 0; i < T.baselineOrders; i += 1) {
    const shopperIndex = i % T.shopperCount;
    orders.push({
      label: `baseline-${i}`,
      shopperIndex,
      amount: T.orderValue,
      refunded: i < T.baselineRefunds,
      // Spread across ~3 months so the store's history is not one instant.
      processedAt: daysAgo(30 + (i % 90)),
      email: stagingSeedEmail(shopperIndex),
    });
  }

  for (let i = 0; i < T.lossyShopperOrders; i += 1) {
    const shopperIndex = T.shopperCount; // dedicated index, outside the baseline
    orders.push({
      label: `loss-${i}`,
      shopperIndex,
      amount: T.lossyOrderValue,
      refunded: i < T.lossyShopperRefunds,
      processedAt: daysAgo(10 + i),
      email: stagingSeedEmail(shopperIndex),
    });
  }

  return orders;
}

export interface ShopperSummary {
  shopperIndex: number;
  orders: number;
  refunds: number;
  value: number;
  refundedValue: number;
  refundedShare: number;
  shouldQualify: boolean;
}

/** Human-readable summary, used by both the CLI preview and the console page. */
export function summariseStagingSeedPlan(plan: StagingSeedOrder[]) {
  const byShopper = new Map<number, ShopperSummary>();

  for (const order of plan) {
    const entry =
      byShopper.get(order.shopperIndex) ??
      ({
        shopperIndex: order.shopperIndex,
        orders: 0,
        refunds: 0,
        value: 0,
        refundedValue: 0,
        refundedShare: 0,
        shouldQualify: false,
      } as ShopperSummary);
    entry.orders += 1;
    entry.value += order.amount;
    if (order.refunded) {
      entry.refunds += 1;
      entry.refundedValue += order.amount;
    }
    byShopper.set(order.shopperIndex, entry);
  }

  const shoppers = [...byShopper.values()].sort((a, b) => a.shopperIndex - b.shopperIndex);
  for (const s of shoppers) {
    s.refundedShare = s.value > 0 ? s.refundedValue / s.value : 0;
    // Mirrors CUSTOMER_LOSS. Stated here only to PREVIEW what should happen —
    // the detector remains the authority, and this never influences it.
    s.shouldQualify = s.orders >= 3 && s.refunds >= 2 && s.refundedShare >= 0.3;
  }

  const totalRefunds = plan.filter((o) => o.refunded).length;
  return {
    shoppers,
    totalOrders: plan.length,
    totalRefunds,
    storeRefundRate: plan.length > 0 ? totalRefunds / plan.length : 0,
    qualifyingShoppers: shoppers.filter((s) => s.shouldQualify).length,
  };
}

/**
 * Whether THIS DEPLOYMENT is production.
 *
 * WHY THIS IS THE PRIMARY GUARD, NOT THE THIRD ONE
 * ------------------------------------------------
 * The other guards protect against misuse. This one protects against a mistake
 * nobody would notice: the shop-domain check below refuses anything that is not
 * a *.myshopify.com store, but a REAL MERCHANT'S STORE IS a *.myshopify.com
 * store. It would pass. So before this existed, the single thing standing
 * between a live merchant and 64 fabricated orders was STAGING_SEED_TOKEN never
 * being set on the production service — one environment variable, one mistake
 * away.
 *
 * FAILS CLOSED. An absent, blank or unparseable SHOPIFY_APP_URL is treated as
 * production. An environment we cannot identify is one we must not seed: the
 * cost of being wrong in that direction is a wasted staging trip, and in the
 * other direction it is fake orders in a merchant's real store.
 *
 * Matching the whole vedasuite.in zone rather than one exact host means a new
 * production or customer-facing subdomain is covered the day it appears,
 * without anyone remembering to update this list.
 */
export function isProductionRuntime(appUrl: string | null | undefined): boolean {
  if (!appUrl || !appUrl.trim()) return true;

  let host: string;
  try {
    host = new URL(appUrl.trim()).hostname.toLowerCase();
  } catch {
    return true;
  }

  if (!host) return true;
  return host === "vedasuite.in" || host.endsWith(".vedasuite.in");
}

/**
 * Whether a shop domain may be seeded.
 *
 * Development stores only. A production storefront is never a valid target,
 * and the VedaSuite app domain is not a store at all — an operator pasting the
 * wrong value should hit a wall, not a confusing 404 from Shopify.
 *
 * NOTE: this does NOT distinguish a development store from a live merchant's
 * store — both are *.myshopify.com. isProductionRuntime above is what makes
 * that distinction, and it is why this check alone was never sufficient.
 */
export function isSeedableShopDomain(shop: string | null | undefined): boolean {
  if (!shop) return false;
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(shop)) return false;
  if (/vedasuite\.in$/i.test(shop)) return false;
  return true;
}

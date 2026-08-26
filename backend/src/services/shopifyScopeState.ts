// What Shopify permissions this app asks for, what a given merchant actually
// granted, and what VedaSuite may therefore read.
//
// PURE. No database, no network.
//
// TWO DIFFERENT FACTS
// -------------------
// `env.shopifyScopes` is what the app REQUESTS today. `Store.grantedScopes` is
// what a particular merchant agreed to when they last authorized. They diverge
// the moment a new scope is added, and they stay diverged until that merchant
// reauthorizes — which is their decision, not ours.
//
// Conflating the two is how a feature "works on my machine and fails for every
// existing install". Every capability question below is answered against the
// GRANTED set.
//
// WHAT THE 2026-01 ADMIN API ACTUALLY REQUIRES
// --------------------------------------------
// Verified against the versioned documentation rather than recalled:
//
//   ProductVariant (incl. inventoryQuantity, sku, inventoryItem)
//                        -> read_products
//   InventoryItem        -> read_inventory OR read_products
//   InventoryLevel       -> read_inventory            (per-location quantities)
//   Location             -> read_locations OR read_inventory OR read_markets_home
//
// So STORE-WIDE inventory needs nothing beyond read_products, which this app
// has always had. Only PER-LOCATION inventory needs anything new.

/** Scopes the app requests. Kept as a list so drift is comparable. */
export const REQUIRED_SCOPES = [
  "read_products",
  "read_orders",
  "write_orders",
  "read_customers",
] as const;

/**
 * Scopes that unlock additional capability but are NOT required to run.
 *
 * A merchant who has not granted these gets a working app with per-location
 * reconciliation switched off and an honest explanation — never a broken sync
 * and never a forced reauthorization prompt on login.
 */
export const OPTIONAL_SCOPES = ["read_inventory", "read_locations"] as const;

export type OptionalScope = (typeof OPTIONAL_SCOPES)[number];

export function parseScopes(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((scope) => scope.trim().toLowerCase())
    .filter(Boolean);
}

export function hasScope(granted: string | null | undefined, scope: string): boolean {
  return parseScopes(granted).includes(scope.toLowerCase());
}

/**
 * Why a Shopify inventory figure is or is not available.
 *
 * Four states, deliberately distinct. "We are not allowed to look",
 * "the merchant does not track this variant" and "there are none" are three
 * different facts, and a bare NULL cannot tell them apart.
 */
export type InventorySource =
  | "ok"
  | "scope_missing"
  | "not_tracked"
  | "unavailable";

export interface InventoryCapability {
  /** Store-wide quantity per variant. Needs only read_products. */
  storeWide: boolean;
  /** Per-location quantities. Needs read_inventory. */
  perLocation: boolean;
  /** Location names and identity. Needs read_locations or read_inventory. */
  locationIdentity: boolean;
  /** Optional scopes this merchant has not granted. */
  missingOptional: OptionalScope[];
  /** True when reauthorizing would unlock something real. */
  upgradeAvailable: boolean;
}

/**
 * What VedaSuite may read for one merchant, from what they granted.
 *
 * Note `storeWide` is gated on read_products, NOT read_inventory. That is the
 * documented requirement, and getting it wrong in the other direction is
 * expensive: an earlier pass removed inventoryQuantity from the product sync on
 * the belief that it needed read_inventory, which left inventory reconciliation
 * with no Shopify side to compare against at all.
 */
export function inventoryCapability(
  grantedScopes: string | null | undefined
): InventoryCapability {
  const granted = parseScopes(grantedScopes);
  const has = (scope: string) => granted.includes(scope);

  const storeWide = has("read_products");
  const perLocation = has("read_inventory");
  const locationIdentity = has("read_locations") || has("read_inventory");
  const missingOptional = OPTIONAL_SCOPES.filter((scope) => !has(scope));

  return {
    storeWide,
    perLocation,
    locationIdentity,
    missingOptional,
    upgradeAvailable: missingOptional.length > 0,
  };
}

/** Resolves why a variant has no quantity, given the capability. */
export function inventorySourceFor(input: {
  capability: InventoryCapability;
  /** What Shopify returned for this variant. */
  reported: number | null | undefined;
}): InventorySource {
  if (!input.capability.storeWide) return "scope_missing";
  if (typeof input.reported === "number") return "ok";
  // Shopify returns null for a variant whose inventory is not tracked. That is
  // a fact about the merchant's setup, not about our permissions, and it is
  // emphatically not zero.
  return "not_tracked";
}

/**
 * Merchant-facing explanation of a missing optional permission.
 *
 * Attributes the gap to VedaSuite, never to the merchant's store setup: a
 * permission we did not ask for is not a fault in their configuration.
 */
export function describeMissingScopes(missing: OptionalScope[]): string | null {
  if (missing.length === 0) return null;
  const wantsLocations =
    missing.includes("read_inventory") || missing.includes("read_locations");
  if (!wantsLocations) return null;
  return (
    "VedaSuite can compare your total Shopify stock against an uploaded file, " +
    "but not location by location. Comparing per location needs additional " +
    "Shopify permissions, which you can grant by reconnecting the app. " +
    "Everything else keeps working either way."
  );
}

/**
 * Whether a granted set is missing anything REQUIRED.
 *
 * Distinct from the optional case: this one genuinely breaks features, and is
 * the only situation in which a merchant should be pushed to reauthorize.
 */
export function missingRequiredScopes(
  grantedScopes: string | null | undefined
): string[] {
  const granted = parseScopes(grantedScopes);
  return REQUIRED_SCOPES.filter((scope) => !granted.includes(scope));
}

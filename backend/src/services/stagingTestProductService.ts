// STAGING-ONLY creation of the three inventory-test products.
//
// Writes to Shopify and nowhere else. It creates no VedaSuite rows: the
// products must travel through the real Sync Data path or the inventory test
// proves nothing about the product.
//
// IDEMPOTENT BY CONSTRUCTION. `productSet` upserts on a fixed handle, so
// clicking twice updates the same three products rather than creating six. The
// state endpoint reads Shopify first, so a half-finished run resumes.
//
// It never bypasses a permission problem. If the token cannot write products or
// inventory, it reports the exact scopes involved and attempts nothing — a
// product created without stock would make every SKU read as a mismatch and
// would be worse than no test data at all.

import { stagingGraphQL } from "./stagingSeedService";
import { logEvent } from "./observabilityService";
import {
  judgeScopes,
  STAGING_TEST_PRODUCTS,
  tagsFor,
  type ScopeVerdict,
  type StagingTestProduct,
} from "./stagingTestProductPlan";

export interface ObservedProduct {
  sku: string;
  title: string;
  exists: boolean;
  /** Null when the variant exists but the token cannot read a quantity. */
  quantity: number | null;
  expectedQuantity: number;
  correct: boolean;
}

export interface TestProductState {
  scopes: {
    granted: string[];
    verdict: ScopeVerdict;
  };
  locationId: string | null;
  locationName: string | null;
  products: ObservedProduct[];
  allPresent: boolean;
  allCorrect: boolean;
  readyToSync: boolean;
  readyReason: string;
}

type ScopeResponse = {
  currentAppInstallation: { accessScopes: Array<{ handle: string }> } | null;
};

/** What this token is actually allowed to do. Needs no scope of its own. */
async function readGrantedScopes(shop: string): Promise<string[]> {
  const data = await stagingGraphQL<ScopeResponse>(
    shop,
    `query StagingGrantedScopes {
      currentAppInstallation {
        accessScopes { handle }
      }
    }`,
    {}
  );
  return (data.currentAppInstallation?.accessScopes ?? []).map((s) => s.handle);
}

type LocationResponse = {
  locations: { nodes: Array<{ id: string; name: string }> };
};

/**
 * The location stock is set at.
 *
 * Requires read_locations, which VedaSuite does request. Returns null rather
 * than throwing so the console can still report the scope verdict — the missing
 * write scopes are the more useful message.
 */
async function readPrimaryLocation(
  shop: string
): Promise<{ id: string; name: string } | null> {
  try {
    const data = await stagingGraphQL<LocationResponse>(
      shop,
      `query StagingPrimaryLocation {
        locations(first: 1, includeInactive: false) {
          nodes { id name }
        }
      }`,
      {}
    );
    return data.locations.nodes[0] ?? null;
  } catch (error) {
    logEvent("warn", "staging.test_products_location_unreadable", {
      shop,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

type ProductLookupResponse = {
  productByIdentifier: {
    id: string;
    title: string;
    variants: {
      nodes: Array<{ sku: string | null; inventoryQuantity: number | null }>;
    };
  } | null;
};

/** Reads one planned product by its fixed handle. */
async function observeProduct(
  shop: string,
  planned: StagingTestProduct
): Promise<ObservedProduct> {
  const data = await stagingGraphQL<ProductLookupResponse>(
    shop,
    `query StagingTestProduct($handle: String!) {
      productByIdentifier(identifier: { handle: $handle }) {
        id
        title
        variants(first: 5) {
          nodes { sku inventoryQuantity }
        }
      }
    }`,
    { handle: planned.handle }
  );

  const product = data.productByIdentifier;
  if (!product) {
    return {
      sku: planned.sku,
      title: planned.title,
      exists: false,
      quantity: null,
      expectedQuantity: planned.quantity,
      correct: false,
    };
  }

  const variant =
    product.variants.nodes.find((v) => v.sku === planned.sku) ??
    product.variants.nodes[0] ??
    null;
  const quantity = variant?.inventoryQuantity ?? null;

  return {
    sku: planned.sku,
    title: product.title,
    exists: true,
    quantity,
    expectedQuantity: planned.quantity,
    correct: quantity === planned.quantity && variant?.sku === planned.sku,
  };
}

/** Read-only. Safe at any time, and the basis for resuming a partial run. */
export async function readTestProductState(shop: string): Promise<TestProductState> {
  const granted = await readGrantedScopes(shop);
  const verdict = judgeScopes(granted);
  const location = await readPrimaryLocation(shop);

  const products: ObservedProduct[] = [];
  for (const planned of STAGING_TEST_PRODUCTS) {
    products.push(await observeProduct(shop, planned));
  }

  const allPresent = products.every((p) => p.exists);
  const allCorrect = products.every((p) => p.correct);

  let readyReason: string;
  if (allCorrect) {
    readyReason =
      "All three products exist with the expected stock. Run Sync Data in VedaSuite, then upload your inventory file.";
  } else if (allPresent) {
    readyReason =
      "All three products exist but at least one stock level differs from the plan. Click Create / Update to correct it.";
  } else if (!verdict.canCreateProducts || !verdict.canSetInventory) {
    readyReason = verdict.reason;
  } else {
    readyReason = "Some products are missing. Click Create / Update.";
  }

  return {
    scopes: { granted, verdict },
    locationId: location?.id ?? null,
    locationName: location?.name ?? null,
    products,
    allPresent,
    allCorrect,
    readyToSync: allCorrect,
    readyReason,
  };
}

type ProductSetResponse = {
  productSet: {
    product: { id: string; handle: string } | null;
    userErrors: Array<{ field?: string[] | null; message: string; code?: string | null }>;
  };
};

/**
 * Upserts one product, its SKU and its stock level in a single call.
 *
 * `productSet` with a handle identifier is an upsert, so this is safe to repeat:
 * the second call converges the same product on the same values instead of
 * creating another one.
 */
async function upsertProduct(
  shop: string,
  planned: StagingTestProduct,
  locationId: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const data = await stagingGraphQL<ProductSetResponse>(
    shop,
    `mutation StagingSetTestProduct($input: ProductSetInput!) {
      productSet(synchronous: true, input: $input) {
        product { id handle }
        userErrors { field message code }
      }
    }`,
    {
      input: {
        handle: planned.handle,
        title: planned.title,
        status: "ACTIVE",
        tags: tagsFor(planned),
        productOptions: [
          { name: "Title", values: [{ name: "Default Title" }] },
        ],
        variants: [
          {
            sku: planned.sku,
            price: planned.price,
            optionValues: [{ optionName: "Title", name: "Default Title" }],
            inventoryItem: { tracked: true },
            inventoryQuantities: [
              { locationId, name: "available", quantity: planned.quantity },
            ],
          },
        ],
      },
    }
  );

  const errors = data.productSet.userErrors;
  if (errors.length > 0) {
    return { ok: false, error: errors.map((e) => e.message).join("; ") };
  }
  if (!data.productSet.product) {
    return { ok: false, error: "Shopify accepted the call but returned no product." };
  }
  return { ok: true };
}

export interface CreateResult {
  blocked: boolean;
  blockedReason: string | null;
  created: number;
  failed: number;
  errors: string[];
  state: TestProductState;
}

/**
 * Creates or corrects the three test products.
 *
 * Refuses before touching Shopify when the token lacks the write scopes, and
 * reports which ones. That refusal is the correct outcome for VedaSuite's
 * intended scope set, not a failure to work around.
 */
export async function createTestProducts(shop: string): Promise<CreateResult> {
  const before = await readTestProductState(shop);
  const verdict = before.scopes.verdict;

  if (!verdict.canCreateProducts || !verdict.canSetInventory) {
    logEvent("info", "staging.test_products_blocked_by_scope", {
      shop,
      missing: verdict.missing,
    });
    return {
      blocked: true,
      blockedReason: verdict.reason,
      created: 0,
      failed: 0,
      errors: [],
      state: before,
    };
  }

  if (!before.locationId) {
    return {
      blocked: true,
      blockedReason:
        "No active Shopify location was readable, so there is nowhere to place stock. " +
        "Check that the development store has at least one active location and that read_locations is granted.",
      created: 0,
      failed: 0,
      errors: [],
      state: before,
    };
  }

  let created = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const planned of STAGING_TEST_PRODUCTS) {
    try {
      const result = await upsertProduct(shop, planned, before.locationId);
      if (result.ok) created += 1;
      else {
        failed += 1;
        errors.push(`${planned.sku}: ${result.error}`);
      }
    } catch (error) {
      failed += 1;
      errors.push(`${planned.sku}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  logEvent("info", "staging.test_products_run", { shop, created, failed });

  return {
    blocked: false,
    blockedReason: null,
    created,
    failed,
    errors,
    state: await readTestProductState(shop),
  };
}

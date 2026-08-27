import { prisma } from "../db/prismaClient";
import { env } from "../config/env";
import { shopifyInt, shopifyFloat } from "../lib/shopifyScalars";
import { logEvent, withRetry } from "./observabilityService";
import {
  classifyFetchError,
  classifyHttpStatus,
  classifySuccess,
  classifyUnparseable,
  type FetchOutcome,
} from "./competitorFetchStatus";
import {
  forceRefreshOfflineAccessToken,
  isShopifyAuthRejection,
  normalizeShopDomain,
  resolveOfflineInstallation,
  updateConnectionDiagnostics,
} from "./shopifyConnectionService";
import {
  inventoryCapability,
  inventorySourceFor,
} from "./shopifyScopeState";
import { syncInventoryLevels } from "./shopifyInventoryLevels";

const SHOPIFY_API_VERSION = env.shopifyAdminApiVersion;

type GraphQLResponse<T> = {
  data?: T;
  errors?: Array<{ message: string }>;
};

function formatBillingPermissionMessage(message: string) {
  if (/without a public distribution/i.test(message)) {
    return "Shopify Billing API is blocked for this app because the app is not set to Public distribution. In Shopify Partner Dashboard, open this app, go to Distribution, choose Public distribution, save, then reinstall or reauthorize the app and retry billing.";
  }

  if (/access denied|not authorized|forbidden|scope/i.test(message)) {
    return `${message} Reinstall or reauthorize the app, confirm billing is allowed for this app in Shopify Partner Dashboard, then retry billing.`;
  }

  return message;
}

/**
 * Turns a GraphQL error array into ONE actionable message.
 *
 * WHY THIS EXISTS
 * ---------------
 * A forbidden field is reported per NODE, not per query. Asking 250 orders for
 * `customer { email }` without the field-level approval produced 250 identical
 * execution errors, which the old code joined with ", " into a single enormous
 * string — and which tripped Shopify's own ceiling, so the response came back
 * as "Too many execution errors, max error limit reached. Results truncated".
 *
 * The operator saw a wall of duplicate text and a truncation warning. What they
 * needed was one line naming the field.
 *
 * So: deduplicate, cap, say how many were collapsed, and recognise the
 * protected-field case specifically — it is a permissions problem with a
 * concrete remedy, not a transient API failure to be retried.
 */
export function summarizeGraphQLErrors(
  errors: Array<{ message: string }>,
  maxDistinct = 3
): string {
  const messages = errors.map((error) => error.message).filter(Boolean);

  // The protected-field case, named precisely. Shopify's wording is
  // "This app is not approved to use the <field> field".
  const protectedField = messages
    .map((m) => m.match(/not approved to use the (\w+) field/i)?.[1])
    .find(Boolean);

  if (protectedField) {
    return (
      `Shopify rejected this request because the app is not approved to read the ` +
      `"${protectedField}" field on protected customer data. VedaSuite must stop ` +
      `requesting that field — approval is not required for anything it currently ` +
      `does. (${errors.length} identical errors collapsed.)`
    );
  }

  const distinct = [...new Set(messages)];
  const shown = distinct.slice(0, maxDistinct).join("; ");

  if (distinct.length === 1 && errors.length > 1) {
    return `${shown} (repeated ${errors.length} times)`;
  }
  if (distinct.length > maxDistinct) {
    return `${shown} (+${distinct.length - maxDistinct} more distinct errors, ${errors.length} total)`;
  }
  return shown || "Shopify returned an unspecified GraphQL error.";
}

/**
 * Maps Shopify's `displayFinancialStatus` onto VedaSuite's SALE status.
 *
 * WHY THIS IS NOT JUST `.toLowerCase()`
 * -------------------------------------
 * Shopify's field conflates two orthogonal facts: whether the order was a
 * completed sale, and whether money later came back. VedaSuite models them
 * separately — `Order.status` for the sale, `Order.refunded` for the refund —
 * and the analysis layer depends on that separation.
 *
 * Lowercasing the raw value gave a refunded order `status: "refunded"`, which
 * is not in ELIGIBLE_ORDER_STATUSES. So every refunded order was excluded from
 * the eligible set — and `customerLossCalc` counts refunds WITHIN that set.
 * `minRefundedOrders: 2` could therefore never be satisfied by any real store:
 * the moment an order was refunded it stopped being countable as a refund.
 *
 * Customer Loss was unreachable for a second, independent reason.
 *
 * A refunded order WAS a paid sale — that is precisely what makes it a loss —
 * so it maps to "paid" and `refunded` carries the rest. VOIDED and EXPIRED are
 * NOT mapped to paid: no money ever changed hands, so they are correctly
 * ineligible.
 *
 * Exported for tests.
 */
export function mapFinancialStatusToSaleStatus(displayFinancialStatus: string): string {
  const raw = (displayFinancialStatus || "").trim().toLowerCase();

  // A completed sale, whether or not money later came back.
  if (raw === "paid" || raw === "refunded" || raw === "partially_refunded") {
    return "paid";
  }
  // Authorized but not captured — the codebase's existing "approved".
  if (raw === "authorized") {
    return "approved";
  }
  // pending / partially_paid / voided / expired and anything Shopify adds later
  // pass through unchanged, and are ineligible — which is correct: no completed
  // sale means nothing to measure a refund against.
  return raw;
}

function extractLegacyId(gid?: string | null) {
  if (!gid) return null;
  const match = gid.match(/\/(\d+)$/);
  return match?.[1] ?? null;
}

async function getStoreAccess(shopDomain: string) {
  const normalizedShop = normalizeShopDomain(shopDomain);
  if (!normalizedShop) {
    throw new Error("Missing Shopify shop domain.");
  }

  const access = await resolveOfflineInstallation(normalizedShop);

  return {
    id: access.id,
    shop: access.shop,
    accessToken: access.accessToken,
    pricingBias: access.pricingBias,
    profitGuardrail: access.profitGuardrail,
    // What THIS merchant granted at their last authorization. Distinct from
    // env.shopifyScopes, which is what the app requests today — the two diverge
    // for every existing install the moment a scope is added.
    grantedScopes: access.grantedScopes ?? null,
  };
}

export async function shopifyGraphQL<T>(
  shopDomain: string,
  query: string,
  variables?: Record<string, unknown>,
  options: { timeoutMs?: number; _retriedAuth?: boolean } = {}
) {
  const store = await getStoreAccess(shopDomain);
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 20000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(
      `https://${store.shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": store.accessToken ?? "",
        },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      }
    );

    if (!response.ok) {
      const text = await response.text();
      if (isShopifyAuthRejection(response.status, text)) {
        if (!options._retriedAuth) {
          try {
            await forceRefreshOfflineAccessToken(shopDomain);
            return shopifyGraphQL<T>(shopDomain, query, variables, {
              timeoutMs,
              _retriedAuth: true,
            });
          } catch {
            // fall through to structured auth failure below
          }
        }

        await updateConnectionDiagnostics(shopDomain, {
          lastConnectionStatus: "SHOPIFY_AUTH_REQUIRED",
          lastConnectionError: `Stored Shopify access token is invalid for ${shopDomain}.`,
          authErrorCode: "SHOPIFY_AUTH_REQUIRED",
          authErrorMessage: `Stored Shopify access token is invalid for ${shopDomain}. Reauthorize the app and retry.`,
        });

        throw new Error(
          `Stored Shopify access token is invalid for ${shopDomain}. Reauthorize the app and retry.`
        );
      }

      throw new Error(`Shopify GraphQL request failed: ${response.status} ${text}`);
    }

    const payload = (await response.json()) as GraphQLResponse<T>;
    if (payload.errors?.length) {
      throw new Error(summarizeGraphQLErrors(payload.errors));
    }

    return payload.data as T;
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === "AbortError" ||
        /aborted|network request failed|fetch failed/i.test(error.message))
    ) {
      throw new Error(
        `Shopify API request timed out for ${shopDomain}. Retry in a few seconds. If this keeps happening, reconnect the app and retry.`
      );
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function createAppSubscription(params: {
  shopDomain: string;
  name: string;
  price: number;
  returnUrl: string;
  trialDays?: number;
  test?: boolean;
}) {
  const data = await shopifyGraphQL<{
    appSubscriptionCreate: {
      confirmationUrl: string | null;
      appSubscription?: {
        id: string;
      } | null;
      userErrors: Array<{ field?: string[]; message: string }>;
    };
  }>(
    params.shopDomain,
    `
      mutation AppSubscriptionCreate(
        $name: String!
        $returnUrl: URL!
        $trialDays: Int
        $test: Boolean
        $lineItems: [AppSubscriptionLineItemInput!]!
      ) {
        appSubscriptionCreate(
          name: $name
          returnUrl: $returnUrl
          trialDays: $trialDays
          test: $test
          replacementBehavior: STANDARD
          lineItems: $lineItems
        ) {
          confirmationUrl
          appSubscription {
            id
          }
          userErrors {
            field
            message
          }
        }
      }
    `,
    {
      name: params.name,
      returnUrl: params.returnUrl,
      trialDays: params.trialDays ?? 0,
      test: params.test ?? false,
      lineItems: [
        {
          plan: {
            appRecurringPricingDetails: {
              interval: "EVERY_30_DAYS",
              price: {
                amount: params.price,
                currencyCode: "USD",
              },
            },
          },
        },
      ],
    },
    { timeoutMs: 60000 }
  );

  const payload = data.appSubscriptionCreate;
  if (payload.userErrors.length) {
    throw new Error(
      formatBillingPermissionMessage(
        payload.userErrors.map((error) => error.message).join(", ")
      )
    );
  }

  if (!payload.confirmationUrl) {
    throw new Error("Shopify did not return a billing confirmation URL.");
  }

  return payload;
}

export async function getActiveAppSubscription(shopDomain: string) {
  const data = await shopifyGraphQL<{
    currentAppInstallation: {
      activeSubscriptions: Array<{
        id: string;
        name: string;
        status: string;
        createdAt: string;
        currentPeriodEnd?: string | null;
      }>;
    } | null;
  }>(
    shopDomain,
    `
      query CurrentAppInstallation {
        currentAppInstallation {
          activeSubscriptions {
            id
            name
            status
            createdAt
            currentPeriodEnd
          }
        }
      }
    `
  );

  const subscriptions =
    data.currentAppInstallation?.activeSubscriptions
      ?.filter((subscription) =>
        ["ACTIVE", "ACCEPTED", "PENDING"].includes(
          subscription.status?.toUpperCase?.() ?? subscription.status
        )
      )
      .sort(
        (left, right) =>
          new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime()
      ) ?? [];

  return subscriptions[0] ?? null;
}

export async function cancelAppSubscription(
  shopDomain: string,
  subscriptionId: string,
  prorate = false
) {
  const data = await shopifyGraphQL<{
    appSubscriptionCancel: {
      userErrors: Array<{ message: string }>;
      appSubscription?: {
        id: string;
        status: string;
      } | null;
    };
  }>(
    shopDomain,
    `
      mutation AppSubscriptionCancel($id: ID!, $prorate: Boolean) {
        appSubscriptionCancel(id: $id, prorate: $prorate) {
          userErrors {
            message
          }
          appSubscription {
            id
            status
          }
        }
      }
    `,
    {
      id: subscriptionId,
      prorate,
    },
    { timeoutMs: 60000 }
  );

  const payload = data.appSubscriptionCancel;
  if (payload.userErrors.length) {
    throw new Error(
      formatBillingPermissionMessage(
        payload.userErrors.map((error) => error.message).join(", ")
      )
    );
  }

  return payload.appSubscription ?? null;
}

export async function registerSyncWebhooks(shopDomain: string, appUrl: string) {
  const normalizedShop = normalizeShopDomain(shopDomain);
  if (!normalizedShop) {
    throw new Error("Missing shop.");
  }
  const callbackBaseUrl = new URL("/webhooks/shopify", appUrl).toString();
  const desiredTopics = [
    "ORDERS_CREATE",
    "ORDERS_UPDATED",
    "CUSTOMERS_CREATE",
    "CUSTOMERS_UPDATE",
    "APP_SUBSCRIPTIONS_UPDATE",
    "APP_UNINSTALLED",
  ];

  const existing = await shopifyGraphQL<{
    webhookSubscriptions: {
      edges: Array<{
        node: {
          topic: string;
          endpoint: {
            __typename: string;
            callbackUrl?: string | null;
          };
        };
      }>;
    };
  }>(
    normalizedShop,
    `
      query ExistingWebhooks {
        webhookSubscriptions(first: 50) {
          edges {
            node {
              topic
              endpoint {
                __typename
                ... on WebhookHttpEndpoint {
                  callbackUrl
                }
              }
            }
          }
        }
      }
    `,
    undefined,
    { timeoutMs: 45000 }
  );

  const existingKeys = new Set(
    existing.webhookSubscriptions.edges.map((edge) => {
      const callbackUrl = edge.node.endpoint.callbackUrl ?? "";
      return `${edge.node.topic}|${callbackUrl}`;
    })
  );

  const created: string[] = [];
  for (const topic of desiredTopics) {
    const callbackUrl = `${callbackBaseUrl}/${topic.toLowerCase()}`;
    const key = `${topic}|${callbackUrl}`;
    if (existingKeys.has(key)) {
      logEvent("info", "shopify.webhook.registration_skipped", {
        shop: normalizedShop,
        topic,
        callbackUrl,
        reason: "already_registered",
      });
      continue;
    }

    logEvent("info", "shopify.webhook.registration_attempt", {
      shop: normalizedShop,
      topic,
      callbackUrl,
    });

    const createdWebhook = await shopifyGraphQL<{
      webhookSubscriptionCreate: {
        userErrors: Array<{ message: string }>;
      };
    }>(
      normalizedShop,
      `
        mutation CreateWebhook($topic: WebhookSubscriptionTopic!, $callbackUrl: URL!) {
          webhookSubscriptionCreate(
            topic: $topic
            webhookSubscription: {
              callbackUrl: $callbackUrl
              format: JSON
            }
          ) {
            userErrors {
              message
            }
          }
        }
      `,
      {
        topic,
        callbackUrl,
      },
      { timeoutMs: 45000 }
    );

    if (createdWebhook.webhookSubscriptionCreate.userErrors.length) {
      const failureMessage = createdWebhook.webhookSubscriptionCreate.userErrors
        .map((error) => error.message)
        .join(", ");

      logEvent("error", "shopify.webhook.registration_failed", {
        shop: normalizedShop,
        topic,
        callbackUrl,
        reason: failureMessage,
      });

      await updateConnectionDiagnostics(normalizedShop, {
        lastWebhookRegistrationStatus: "FAILED",
        lastConnectionStatus: "WEBHOOK_REGISTRATION_FAILED",
        lastConnectionError: failureMessage,
        authErrorCode: "WEBHOOK_REGISTRATION_FAILED",
        authErrorMessage: failureMessage,
      });

      throw new Error(failureMessage);
    }

    created.push(topic);
    logEvent("info", "shopify.webhook.registration_succeeded", {
      shop: normalizedShop,
      topic,
      callbackUrl,
    });
  }

  await prisma.store.update({
    where: { shop: normalizedShop },
    data: {
      webhooksRegisteredAt: new Date(),
      lastWebhookRegistrationStatus: "SUCCEEDED",
      lastConnectionCheckAt: new Date(),
      lastConnectionStatus: "OK",
      lastConnectionError: null,
      authErrorCode: null,
      authErrorMessage: null,
    },
  });

  return {
    created,
    totalTracked: desiredTopics.length,
  };
}

export async function getSyncWebhookStatus(shopDomain: string, appUrl: string) {
  const normalizedShop = normalizeShopDomain(shopDomain);
  if (!normalizedShop) {
    throw new Error("Missing shop.");
  }
  const callbackBaseUrl = new URL("/webhooks/shopify", appUrl).toString();
  const desiredTopics = [
    "ORDERS_CREATE",
    "ORDERS_UPDATED",
    "CUSTOMERS_CREATE",
    "CUSTOMERS_UPDATE",
    "APP_SUBSCRIPTIONS_UPDATE",
    "APP_UNINSTALLED",
  ];

  const existing = await shopifyGraphQL<{
    webhookSubscriptions: {
      edges: Array<{
        node: {
          topic: string;
          endpoint: {
            __typename: string;
            callbackUrl?: string | null;
          };
        };
      }>;
    };
  }>(
    normalizedShop,
    `
      query ExistingWebhooks {
        webhookSubscriptions(first: 50) {
          edges {
            node {
              topic
              endpoint {
                __typename
                ... on WebhookHttpEndpoint {
                  callbackUrl
                }
              }
            }
          }
        }
      }
    `,
    undefined,
    { timeoutMs: 45000 }
  );

  const webhooks = desiredTopics.map((topic) => {
    const callbackUrl = `${callbackBaseUrl}/${topic.toLowerCase()}`;
    const registered = existing.webhookSubscriptions.edges.some(
      (edge) =>
        edge.node.topic === topic && edge.node.endpoint.callbackUrl === callbackUrl
    );

    return {
      topic,
      callbackUrl,
      registered,
    };
  });

  return {
    registeredCount: webhooks.filter((webhook) => webhook.registered).length,
    totalTracked: desiredTopics.length,
    webhooks,
  };
}

/**
 * SYNC PAGINATION BOUNDS.
 *
 * THE DEFECT THESE REPLACE
 * ------------------------
 * The sync query was `products(first: 20)` and `orders(first: 20)` with no
 * pagination anywhere. Twenty orders was the entire dataset VedaSuite ever had
 * about a store, no matter how large that store was.
 *
 * That is not a tuning problem, it is a structural one. CUSTOMER_LOSS requires
 * `storeEligibleOrderCount >= 50` before it will compute a baseline at all —
 * deliberately, so a refund rate is never compared against too little history.
 * With a hard ceiling of 20 synced orders that gate could never open, which
 * made the entire Customer Loss family unreachable for every merchant on every
 * plan. Product Profit had the same problem at 20 products, and
 * explainabilityService reads with READ_CAPS.orders = 5000 — a cap written for
 * a dataset the sync could never deliver.
 *
 * The engines were correct. They were being starved.
 *
 * WHY THESE NUMBERS
 * -----------------
 * 250 is Shopify's maximum page size, so this is the fewest round trips for a
 * given volume. The page ceilings bound worst-case time, memory and API cost
 * for a very large store: 20 order pages = 5000 orders, which is exactly
 * READ_CAPS.orders, so the sync now delivers precisely what the analysis layer
 * is already bounded to consume. Products are capped lower because pricing and
 * profit work per product and 2000 is far beyond any threshold in the codebase.
 *
 * Reaching a ceiling is reported, never silent — see `truncated` in the sync
 * counts. A store that exceeds it has more history than VedaSuite analysed, and
 * saying so is the difference between a bound and a lie.
 */
/**
 * Keeps an unset SKU as NULL.
 *
 * Shopify returns "" for a variant with no SKU. Storing that empty string
 * would make every SKU-less variant share one key, and reconciliation would
 * then happily "match" them all to each other.
 */
function normalizeSku(value: string | null | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length > 0 ? trimmed : null;
}

export const SYNC_PAGE_SIZE = 250;
export const MAX_ORDER_PAGES = 20;
export const MAX_PRODUCT_PAGES = 8;

type PageInfo = { hasNextPage: boolean; endCursor: string | null };

type ProductNode = {
  id: string;
  handle: string;
  title: string;
  status: string;
  variants: {
    edges: Array<{
      node: {
        id: string;
        title: string;
        price: string;
        // Product data, NOT protected customer data - no field-level approval
        // is involved, unlike the `email` field this sync had to drop.
        sku?: string | null;
        inventoryQuantity?: number | null;
      };
    }>;
  };
};

type OrderNode = {
  id: string;
  legacyResourceId: string;
  name: string;
  createdAt: string;
  displayFinancialStatus: string;
  displayFulfillmentStatus?: string | null;
  currentTotalPriceSet: {
    shopMoney: {
      amount: string;
      currencyCode: string;
    };
  };
  customer?: {
    id: string;
    /** The stable Shopify customer ID — VedaSuite's only customer identity. */
    legacyResourceId: string;
    numberOfOrders: string | number;
    // No `email`, and no name/phone/address. Those are protected fields this
    // app is not approved for; requesting one fails the whole sync. Removing
    // it from the TYPE as well as the query is what stops it being quietly
    // read again by a later change.
  } | null;
  tags: string[];
  lineItems?: {
    pageInfo: { hasNextPage: boolean };
    edges: Array<{
      node: {
        id: string;
        sku?: string | null;
        title?: string | null;
        quantity: number;
        /** Quantity remaining after refunds/removals. */
        currentQuantity?: number | null;
        refundableQuantity?: number | null;
        unfulfilledQuantity?: number | null;
        variant?: { id: string } | null;
        product?: { id: string } | null;
        originalUnitPriceSet?: {
          shopMoney: { amount: string; currencyCode: string };
        } | null;
      };
    }>;
  } | null;
};

/**
 * Line items fetched per order, inside the order page.
 *
 * Nested rather than paged separately, so the order sync's existing pagination
 * and page ceilings continue to bound the whole operation — there is no second
 * cursor to get wrong and no extra round trip per order. An order with more
 * lines than this is reported as truncated, never silently under-counted.
 */
export const LINE_ITEM_PAGE_SIZE = 50;

/**
 * INVENTORY SCOPE — see shopifyScopeState.ts for the verified requirements.
 *
 * Store-wide inventoryQuantity needs read_products only. Per-location
 * InventoryLevel needs read_inventory, and Location identity needs
 * read_locations or read_inventory. Both of the latter are OPTIONAL: a
 * merchant who has not granted them keeps a fully working sync.
 */
export { type InventorySource } from "./shopifyScopeState";

type ProductPageResponse = {
  shop: { name: string };
  products: { pageInfo: PageInfo; edges: Array<{ node: ProductNode }> };
};

type OrderPageResponse = {
  orders: { pageInfo: PageInfo; edges: Array<{ node: OrderNode }> };
};


function computeRecommendedPrice(currentPrice: number, pricingBias: number) {
  const lift = Math.max(0.01, (pricingBias - 45) / 250);
  return Number((currentPrice * (1 + lift)).toFixed(2));
}

export async function fetchCompetitorSnapshot(
  domain: string,
  productHandle: string,
  fallbackPrice: number
): Promise<{
  competitorUrl: string;
  price: number | null;
  promotion: string | null;
  stockStatus: string;
  source: string;
  adCopy: string | null;
  confidenceScore: number;
  confidenceLabel: "high" | "medium" | "low";
  matchReason: string;
  usedFallbackPrice: boolean;
} | null> {
  try {
    return await withRetry(
      async () => {
        const controller = new AbortController();
        // 4s aborted legitimately slow cold sites and looked like a hard failure.
        const timeout = setTimeout(() => controller.abort(), 10000);

        try {
          const response = await fetch(
            `https://${domain}/products/${productHandle}`,
            {
              signal: controller.signal,
              headers: {
                "User-Agent": "VedaSuiteAI/1.0 competitor-ingestion",
              },
            }
          );

          // A 404/410 means the competitor simply doesn't carry this product —
          // the expected outcome for most handles, not a failure. Returning
          // instead of throwing avoids two pointless retries and an
          // error-level log line for every unmatched product.
          if (response.status === 404 || response.status === 410) {
            return null;
          }

          if (!response.ok) {
            const httpOutcome = classifyHttpStatus(domain, response.status);
            lastFetchOutcome.set(domain, httpOutcome);
            // Only a transient status is worth another attempt. A 403 block
            // blocks again; retrying it wasted two requests per product.
            if (!httpOutcome.retryable) {
              return null;
            }
            throw new Error(httpOutcome.technicalDetail);
          }

          const html = await response.text();
          const lowerHtml = html.toLowerCase();
          const priceMatch =
            html.match(/\$([0-9]+(?:\.[0-9]{1,2})?)/i) ??
            html.match(/"price"\s*:\s*"([0-9]+(?:\.[0-9]{1,2})?)"/i) ??
            html.match(
              /property="product:price:amount"\s+content="([0-9]+(?:\.[0-9]{1,2})?)"/i
            );

          const promotionDetected = /sale|discount|bundle|offer/.test(lowerHtml);
          const stockStatus = /out of stock/.test(lowerHtml)
            ? "out_of_stock"
            : /low stock/.test(lowerHtml)
            ? "low_stock"
            : "in_stock";
          const extractedPrice = priceMatch ? Number(priceMatch[1]) : null;
          const usedFallbackPrice = extractedPrice == null && fallbackPrice > 0;
          const signalScore =
            (extractedPrice != null ? 48 : 0) +
            (promotionDetected ? 18 : 0) +
            (stockStatus !== "in_stock" ? 14 : 0) +
            (lowerHtml.includes(productHandle.toLowerCase()) ? 12 : 0);
          const confidenceScore = Math.max(
            18,
            Math.min(96, signalScore + (usedFallbackPrice ? 6 : 0))
          );

          if (extractedPrice == null && !promotionDetected && stockStatus === "in_stock") {
            // Reachable, but no price signal found. Distinct from a failure:
            // the merchant's domain is fine — VedaSuite could not parse it.
            lastFetchOutcome.set(domain, classifyUnparseable(domain));
            return null;
          }

          recordCompetitorFetchSuccess(domain, extractedPrice == null);

          return {
            competitorUrl: `https://${domain}/products/${productHandle}`,
            price: extractedPrice ?? (usedFallbackPrice ? fallbackPrice : null),
            promotion: promotionDetected ? "Live promo detected" : null,
            stockStatus,
            source: "website_live",
            adCopy: null,
            confidenceScore,
            confidenceLabel:
              confidenceScore >= 80
                ? "high"
                : confidenceScore >= 60
                ? "medium"
                : "low",
            matchReason:
              extractedPrice != null
                ? "Product page and live price were confirmed on the competitor domain."
                : promotionDetected
                ? "Product page matched by handle and a live promotion signal was detected."
                : "Product page matched by handle, but price confirmation relied on limited page signals.",
            usedFallbackPrice,
          };
        } finally {
          clearTimeout(timeout);
        }
      },
      {
        attempts: 2,
        delayMs: 200,
        operationName: "competitor.fetch_snapshot",
        context: {
          domain,
          productHandle,
        },
        // Classify BEFORE deciding to retry, not after.
        //
        // The classifier already knew a certificate error is permanent, but it
        // only ran in the outer catch — after this loop had spent both attempts.
        // Production logged attempt 1 and attempt 2 for `addidas.com`, then
        // `status: "tls_error", retriable: false`: the verdict was right and
        // arrived too late to act on. An expired certificate is still expired
        // 200ms later, and so is an unresolvable hostname.
        //
        // The SAME classifier decides both, so the log line and the retry
        // behaviour can no longer disagree.
        shouldRetry: (error) => classifyFetchError(domain, error).retryable,
      }
    );
  } catch (error) {
    // Classify the REAL cause. `TypeError: fetch failed` is Node's generic
    // wrapper; the code lives in error.cause.code and was previously discarded,
    // so an unresolvable domain, a blocked site and a slow site all looked
    // identical — and all were retried, including the ones that can never
    // succeed.
    const outcome = classifyFetchError(domain, error);
    logEvent(outcome.retryable ? "warn" : "info", "competitor.fetch_failed", {
      domain,
      productHandle,
      status: outcome.status,
      retryable: outcome.retryable,
      detail: outcome.technicalDetail,
    });
    lastFetchOutcome.set(domain, outcome);
    return null;
  }
}

/**
 * Outcome of the most recent attempt per domain, for the caller to persist.
 *
 * In-process and intentionally simple: the sync writes it to CompetitorDomain
 * immediately after the batch, so nothing depends on this surviving a restart.
 */
const lastFetchOutcome = new Map<string, FetchOutcome>();

/** Reads and clears the recorded outcome for a domain. */
export function takeCompetitorFetchOutcome(domain: string): FetchOutcome | null {
  const outcome = lastFetchOutcome.get(domain) ?? null;
  lastFetchOutcome.delete(domain);
  return outcome;
}

/** Records a successful or partial read so the caller can persist it. */
export function recordCompetitorFetchSuccess(domain: string, partial: boolean) {
  lastFetchOutcome.set(domain, classifySuccess(domain, partial));
}

export async function syncShopifyStoreData(shopDomain: string) {
  const normalizedShop = normalizeShopDomain(shopDomain);
  if (!normalizedShop) {
    throw new Error("Missing shop.");
  }
  const syncStartedAt = new Date();
  logEvent("info", "shopify.sync.started", {
    shop: normalizedShop,
    startedAt: syncStartedAt.toISOString(),
  });

  const store = await getStoreAccess(normalizedShop);

  // ---- PAGINATED FETCH ----------------------------------------------------
  // Products and orders are pulled page by page up to their documented
  // ceilings, instead of the single 20-row page this used to take. See the
  // SYNC_PAGE_SIZE block above for why a 20-row ceiling made whole engine
  // families unreachable.
  const products: ProductNode[] = [];
  let productCursor: string | null = null;
  let productPages = 0;
  let productsTruncated = false;
  let shopName = "";

  for (;;) {
    const page: ProductPageResponse = await shopifyGraphQL<ProductPageResponse>(
      normalizedShop,
      `
        query SyncStoreProducts($first: Int!, $after: String) {
          shop { name }
          products(first: $first, after: $after, sortKey: UPDATED_AT, reverse: true) {
            pageInfo { hasNextPage endCursor }
            edges {
              node {
                id
                handle
                title
                status
                # inventoryQuantity needs only read_products. VERIFIED against
                # the 2026-01 ProductVariant reference, which states exactly one
                # object-level requirement — read_products — and no per-field
                # requirements at all.
                #
                # An earlier pass removed this field believing it needed
                # read_inventory. It does not, and removing it left inventory
                # reconciliation with no Shopify side to compare against, which
                # is the entire point of the feature.
                #
                # read_inventory is required for InventoryLevel — PER-LOCATION
                # quantities — which is fetched separately and is optional.
                variants(first: 25) {
                  edges {
                    node {
                      id
                      title
                      price
                      sku
                      inventoryQuantity
                    }
                  }
                }
              }
            }
          }
        }
      `,
      { first: SYNC_PAGE_SIZE, after: productCursor },
      { timeoutMs: 60000 }
    );

    shopName = page.shop.name;
    for (const edge of page.products.edges) products.push(edge.node);
    productPages += 1;

    if (!page.products.pageInfo.hasNextPage) break;
    if (productPages >= MAX_PRODUCT_PAGES) {
      // The store has more products than this sync analysed. Recorded, never
      // silent: a bound the merchant is not told about reads as completeness.
      productsTruncated = true;
      break;
    }
    productCursor = page.products.pageInfo.endCursor;
  }

  // ---- PROTECTED CUSTOMER DATA ------------------------------------------
  //
  // The order query below requests NO protected customer field, and must not
  // start doing so. Shopify gates email, name, phone and address behind a
  // field-level approval this app does not hold and does not need.
  //
  // What happened when it did: `customer { email }` is validated per NODE, so
  // one page of 250 orders produced 250 identical execution errors. That tripped
  // Shopify's own error ceiling and the response came back as "Too many
  // execution errors, max error limit reached. Results truncated". A single
  // unapproved field did not degrade the sync — it destroyed it, and the real
  // cause was buried under a wall of duplicate messages.
  //
  // Nothing downstream needs email. Customer identity throughout VedaSuite is
  // `legacyResourceId`, the stable Shopify customer ID stored as
  // `Customer.shopifyCustomerId`, and that is what every repeat-customer
  // analysis groups by — including Customer Loss. Email only ever fed display
  // labels, all of which already mask identities and already have a non-PII
  // fallback.
  //
  // If a future feature genuinely needs a protected field, it needs Shopify's
  // approval first. It does not get to be added here speculatively.
  const orders: OrderNode[] = [];
  let orderCursor: string | null = null;
  let orderPages = 0;
  let ordersTruncated = false;
  let lineItemsSaved = 0;
  /** Orders carrying more than LINE_ITEM_PAGE_SIZE lines. Reported, not hidden. */
  let lineItemsTruncated = 0;

  for (;;) {
    const page: OrderPageResponse = await shopifyGraphQL<OrderPageResponse>(
      normalizedShop,
      `
        query SyncStoreOrders($first: Int!, $after: String) {
          orders(first: $first, after: $after, sortKey: CREATED_AT, reverse: true) {
            pageInfo { hasNextPage endCursor }
            edges {
              node {
                id
                legacyResourceId
                name
                createdAt
                displayFinancialStatus
                currentTotalPriceSet {
                  shopMoney {
                    amount
                    currencyCode
                  }
                }
                # No email/name/phone/address here — see PROTECTED CUSTOMER
                # DATA above this query. Do not add one.
                customer {
                  id
                  legacyResourceId
                  numberOfOrders
                }
                tags
                displayFulfillmentStatus
                # LINE ITEMS. Needed so a 3PL invoice claiming "4 items picked"
                # can be compared against what the order actually contained —
                # an order total says nothing about how many things were in it.
                #
                # Nested inside the order page, so this adds NO extra round
                # trips and no separate cursor. 50 covers essentially every
                # real order; LINE_ITEM_PAGE_SIZE documents the bound, and a
                # longer order is reported as truncated rather than silently
                # under-counted.
                #
                # Every field here is order data. There is no customer field of
                # any kind, protected or otherwise.
                lineItems(first: 50) {
                  pageInfo { hasNextPage }
                  edges {
                    node {
                      id
                      sku
                      title
                      quantity
                      currentQuantity
                      refundableQuantity
                      unfulfilledQuantity
                      variant { id }
                      product { id }
                      originalUnitPriceSet {
                        shopMoney { amount currencyCode }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      `,
      { first: SYNC_PAGE_SIZE, after: orderCursor },
      { timeoutMs: 60000 }
    );

    for (const edge of page.orders.edges) orders.push(edge.node);
    orderPages += 1;

    if (!page.orders.pageInfo.hasNextPage) break;
    if (orderPages >= MAX_ORDER_PAGES) {
      ordersTruncated = true;
      break;
    }
    orderCursor = page.orders.pageInfo.endCursor;
  }

  logEvent("info", "shopify.sync.fetched", {
    shop: normalizedShop,
    products: products.length,
    productPages,
    productsTruncated,
    orders: orders.length,
    orderPages,
    ordersTruncated,
  });

  const data = { shop: { name: shopName } };
  // A SYNC IS NOT ONE BOOLEAN.
  //
  // Orders persist BEFORE products in this function. A throw inside the
  // product loop therefore left 75 committed orders and zero products, and
  // every downstream reader saw a store with data. Nothing recorded that one
  // resource had failed while another succeeded, so Pricing could only report
  // "no products synced" without knowing whether that meant an empty
  // catalogue or a broken sync.
  //
  // Each resource now carries its own outcome, and success in one can never
  // stand for success in another.
  const resourceStatus: Record<
    string,
    {
      status: string;
      count: number;
      errorClass?: string | null;
      safeMessage?: string | null;
      /** How many Shopify returned, so fetched-vs-stored is always comparable. */
      fetched?: number;
      skipped?: number;
      skippedReasons?: Record<string, number>;
    }
  > = {
    products: { status: "NOT_ATTEMPTED", count: 0 },
    orders: { status: "NOT_ATTEMPTED", count: 0 },
    customers: { status: "NOT_ATTEMPTED", count: 0 },
    lineItems: { status: "NOT_ATTEMPTED", count: 0 },
    inventoryLevels: { status: "NOT_ATTEMPTED", count: 0 },
  };

  const syncCounts = {
    fetched: {
      products: products.length,
      orders: orders.length,
      customers: orders.filter((order) => !!order.customer?.legacyResourceId).length,
      variants: products.reduce(
        (sum, product) => sum + product.variants.edges.length,
        0
      ),
      /** True when the store has more history than this sync read. */
      productsTruncated,
      ordersTruncated,
      productPages,
      orderPages,
    },
    saved: {
      productsCreated: 0,
      productsUpdated: 0,
      variantsCreated: 0,
      variantsUpdated: 0,
      ordersCreated: 0,
      ordersUpdated: 0,
      customersCreated: 0,
      customersUpdated: 0,
      priceRowsCreated: 0,
      priceRowsUpdated: 0,
    },
    skipped: {
      products: 0,
      variants: 0,
      /** Products stored, but with no pricing baseline because price is 0. */
      priceBaselines: 0,
    },
    // WHY something was skipped, not just how many. A single `skipped` count
    // that no surface read is how three fetched products became "your
    // catalogue is empty".
    skippedReasons: {
      noHandle: 0,
      noVariants: 0,
    },
  };

  for (const orderNode of orders) {
    let customerId: string | null = null;

    if (orderNode.customer?.legacyResourceId) {
      const existingCustomer = await prisma.customer.findFirst({
        where: {
          storeId: store.id,
          shopifyCustomerId: orderNode.customer.legacyResourceId,
        },
      });

      // `email` is deliberately absent from both branches — see the query.
      // The update does not null out an email an existing row already has:
      // that value may have arrived through a GDPR webhook, which is a
      // separate and legitimately approved path, and the sync has no business
      // erasing it. It simply stops being something the sync supplies.
      const customer = existingCustomer
        ? await prisma.customer.update({
            where: { id: existingCustomer.id },
            data: {
              totalOrders: shopifyInt(orderNode.customer.numberOfOrders),
            },
          })
        : await prisma.customer.create({
            data: {
              storeId: store.id,
              // The stable Shopify customer ID. This, not email, is how every
              // repeat-customer analysis in VedaSuite identifies a shopper.
              shopifyCustomerId: orderNode.customer.legacyResourceId,
              totalOrders: shopifyInt(orderNode.customer.numberOfOrders),
            },
          });

      if (existingCustomer) {
        syncCounts.saved.customersUpdated += 1;
      } else {
        syncCounts.saved.customersCreated += 1;
      }

      customerId = customer.id;
    }

    // Two orthogonal facts, kept separate — see mapFinancialStatusToSaleStatus.
    // `refunded` is still derived from the RAW Shopify value, because that is
    // the only place the refund fact lives.
    const rawFinancialStatus = orderNode.displayFinancialStatus.toLowerCase();
    const normalizedStatus = mapFinancialStatusToSaleStatus(orderNode.displayFinancialStatus);
    const refunded =
      rawFinancialStatus.includes("refunded") ||
      rawFinancialStatus.includes("partially_refunded");
    const refundRequested = refunded || orderNode.tags.some((tag) => /refund/i.test(tag));

    const displayOrderId = orderNode.name || orderNode.legacyResourceId || orderNode.id;
    const existingOrder = await prisma.order.findFirst({
      where: {
        storeId: store.id,
        OR: [
          { shopifyOrderGid: orderNode.id },
          { shopifyLegacyOrderId: orderNode.legacyResourceId },
          { shopifyOrderId: displayOrderId },
        ],
      },
      select: { id: true },
    });

    if (existingOrder) {
      await prisma.order.update({
        where: { id: existingOrder.id },
        data: {
          customerId,
          shopifyOrderId: displayOrderId,
          shopifyOrderGid: orderNode.id,
          shopifyLegacyOrderId: orderNode.legacyResourceId,
          orderName: orderNode.name,
          totalAmount: shopifyFloat(orderNode.currentTotalPriceSet.shopMoney.amount),
          currency: orderNode.currentTotalPriceSet.shopMoney.currencyCode,
          status: normalizedStatus,
          refunded,
          refundRequested,
        },
      });
    } else {
      await prisma.order.create({
        data: {
          storeId: store.id,
          customerId,
          shopifyOrderId: displayOrderId,
          shopifyOrderGid: orderNode.id,
          shopifyLegacyOrderId: orderNode.legacyResourceId,
          orderName: orderNode.name,
          totalAmount: shopifyFloat(orderNode.currentTotalPriceSet.shopMoney.amount),
          currency: orderNode.currentTotalPriceSet.shopMoney.currencyCode,
          status: normalizedStatus,
          refunded,
          refundRequested,
          createdAt: new Date(orderNode.createdAt),
        },
      });
    }

    if (existingOrder) {
      syncCounts.saved.ordersUpdated += 1;
    } else {
      syncCounts.saved.ordersCreated += 1;
    }

    // --- LINE ITEMS ------------------------------------------------------
    //
    // UPSERT on [storeId, shopifyLineItemId], so a repeat sync updates the
    // same rows rather than accumulating duplicates - the same discipline the
    // order write above already follows.
    //
    // REFUND SEMANTICS ARE PRESERVED, NOT REINTERPRETED. Order.refunded stays
    // exactly as it was; these columns add the per-line detail an order-level
    // boolean cannot express, which is what makes a partial refund visible to
    // reconciliation. Nothing here feeds Customer Loss.
    const savedOrder =
      existingOrder ??
      (await prisma.order.findFirst({
        where: { storeId: store.id, shopifyOrderGid: orderNode.id },
        select: { id: true },
      }));

    if (savedOrder && orderNode.lineItems) {
      if (orderNode.lineItems.pageInfo?.hasNextPage) {
        lineItemsTruncated += 1;
      }
      for (const edge of orderNode.lineItems.edges) {
        const line = edge.node;
        const unitPrice = line.originalUnitPriceSet?.shopMoney;
        const data = {
          orderId: savedOrder.id,
          storeId: store.id,
          shopifyLineItemId: line.id,
          shopifyVariantId: line.variant?.id ?? null,
          shopifyProductId: line.product?.id ?? null,
          sku: normalizeSku(line.sku),
          title: line.title ?? null,
          quantity: shopifyInt(line.quantity),
          currentQuantity:
            typeof line.currentQuantity === "number" ? line.currentQuantity : null,
          // Shopify reports what remains refundable and what remains
          // unfulfilled. The refunded and fulfilled counts are DERIVED from
          // the original quantity, and only when the source figure exists -
          // a missing figure stays NULL rather than becoming zero.
          refundedQuantity:
            typeof line.refundableQuantity === "number"
              ? Math.max(0, shopifyInt(line.quantity) - line.refundableQuantity)
              : null,
          fulfilledQuantity:
            typeof line.unfulfilledQuantity === "number"
              ? Math.max(0, shopifyInt(line.quantity) - line.unfulfilledQuantity)
              : null,
          fulfillableQuantity:
            typeof line.unfulfilledQuantity === "number" ? line.unfulfilledQuantity : null,
          price: unitPrice ? shopifyFloat(unitPrice.amount) : null,
          currency: unitPrice?.currencyCode ?? null,
          syncedAt: new Date(),
        };
        await prisma.orderLineItem.upsert({
          where: {
            storeId_shopifyLineItemId: {
              storeId: store.id,
              shopifyLineItemId: line.id,
            },
          },
          create: data,
          update: data,
        });
        lineItemsSaved += 1;
      }
    }
  }

  const customers = await prisma.customer.findMany({
    where: { storeId: store.id },
    include: {
      orders: true,
      fraudSignals: true,
    },
  });

  for (const customer of customers) {
    const totalOrders = customer.orders.length;
    const totalRefunds = customer.orders.filter((order) => order.refunded).length;
    const refundRate = totalOrders === 0 ? 0 : totalRefunds / totalOrders;
    const fraudSignalsCount = customer.fraudSignals.length;
    const successfulOrders = customer.orders.filter(
      (order) => order.status === "paid" || order.status === "approved"
    ).length;
    const paymentReliability =
      totalOrders === 0 ? 0 : Number(((successfulOrders / totalOrders) * 20).toFixed(1));

    const score = Math.max(
      0,
      Math.min(
        100,
        Math.round(78 - refundRate * 55 - fraudSignalsCount * 6 + paymentReliability)
      )
    );
    const creditCategory =
      score >= 80 ? "Trusted Buyer" : score >= 50 ? "Normal Buyer" : "Risky Buyer";

    await prisma.customer.update({
      where: { id: customer.id },
      data: {
        totalOrders,
        totalRefunds,
        refundRate,
        fraudSignalsCount,
        paymentReliability,
        creditScore: score,
        creditCategory,
      },
    });
  }

  // What THIS merchant granted, not what the app requests. The two diverge for
  // every existing install the moment a scope is added.
  const inventoryAccess = inventoryCapability(store.grantedScopes);

  // Products fetched successfully; persistence is what follows.
  resourceStatus.products.status = "FETCHED";
  resourceStatus.products.count = products.length;
  try {
  for (const product of products) {
    const variants = product.variants.edges.map((edge) => edge.node);
    const firstVariant = variants[0];
    const currentPrice = shopifyFloat(firstVariant?.price ?? 0);

    // A PRODUCT IS NOT DISCARDED FOR HAVING NO PRICE.
    //
    // This guard used to include `!currentPrice`, so any product priced 0.00 —
    // a free item, a sample, a gift, or a hand-made test product whose price
    // field was simply left alone — was dropped before it was ever stored. It
    // was counted only in an internal `skipped` tally that no surface read, so
    // Shopify returned products, VedaSuite persisted none, and Pricing said
    // "No products synced yet" while Reconciliation had no Shopify side to
    // compare a warehouse file against.
    //
    // Price is a fact ABOUT a product, not what makes it a product. Identity is
    // the handle and its variants; SKU and inventory live on the variants and
    // have nothing to do with price. The pricing baseline further down is the
    // only thing that genuinely needs a non-zero price — it divides by it — so
    // that is where the price condition now lives.
    if (!product.handle) {
      syncCounts.skipped.products += 1;
      syncCounts.skippedReasons.noHandle += 1;
      continue;
    }
    if (variants.length === 0) {
      // No variant means no SKU and no inventory, so there is nothing any
      // module could match on. Recorded distinctly rather than as one number.
      syncCounts.skipped.products += 1;
      syncCounts.skippedReasons.noVariants += 1;
      continue;
    }

    const existingProduct = await prisma.productSnapshot.findUnique({
      where: {
        storeId_shopifyProductId: {
          storeId: store.id,
          shopifyProductId: product.id,
        },
      },
      select: { id: true },
    });

    const savedProduct = await prisma.productSnapshot.upsert({
      where: {
        storeId_shopifyProductId: {
          storeId: store.id,
          shopifyProductId: product.id,
        },
      },
      create: {
        storeId: store.id,
        shopifyProductId: product.id,
        handle: product.handle,
        title: product.title,
        status: product.status.toLowerCase(),
        variantCount: variants.length,
        currentPrice,
        currency: orders[0]?.currentTotalPriceSet.shopMoney.currencyCode ?? null,
        syncedAt: new Date(),
      },
      update: {
        handle: product.handle,
        title: product.title,
        status: product.status.toLowerCase(),
        variantCount: variants.length,
        currentPrice,
        currency: orders[0]?.currentTotalPriceSet.shopMoney.currencyCode ?? null,
        syncedAt: new Date(),
      },
    });

    if (existingProduct) {
      syncCounts.saved.productsUpdated += 1;
    } else {
      syncCounts.saved.productsCreated += 1;
    }

    for (const variant of variants) {
      if (!variant.id || !variant.title) {
        syncCounts.skipped.variants += 1;
        continue;
      }

      const existingVariant = await prisma.variantSnapshot.findUnique({
        where: {
          productSnapshotId_shopifyVariantId: {
            productSnapshotId: savedProduct.id,
            shopifyVariantId: variant.id,
          },
        },
        select: { id: true },
      }).catch(() => null);

      await prisma.variantSnapshot.upsert({
        where: {
          productSnapshotId_shopifyVariantId: {
            productSnapshotId: savedProduct.id,
            shopifyVariantId: variant.id,
          },
        },
        create: {
          productSnapshotId: savedProduct.id,
          shopifyVariantId: variant.id,
          title: variant.title,
          price: shopifyFloat(variant.price),
          currency: orders[0]?.currentTotalPriceSet.shopMoney.currencyCode ?? null,
          // An empty SKU stays NULL rather than becoming "", so an unset SKU
          // is unmatchable instead of matching every other unset SKU.
          sku: normalizeSku(variant.sku),
          // The real figure, with WHY beside it. A null here means Shopify did
          // not report a tracked quantity for this variant - never zero, and
          // never a permissions problem, which inventorySource distinguishes.
          inventoryQuantity:
            typeof variant.inventoryQuantity === "number"
              ? variant.inventoryQuantity
              : null,
          inventorySource: inventorySourceFor({
            capability: inventoryAccess,
            reported: variant.inventoryQuantity,
          }),
        },
        update: {
          title: variant.title,
          price: shopifyFloat(variant.price),
          currency: orders[0]?.currentTotalPriceSet.shopMoney.currencyCode ?? null,
          sku: normalizeSku(variant.sku),
          inventoryQuantity:
            typeof variant.inventoryQuantity === "number"
              ? variant.inventoryQuantity
              : null,
          inventorySource: inventorySourceFor({
            capability: inventoryAccess,
            reported: variant.inventoryQuantity,
          }),
        },
      });

      if (existingVariant) {
        syncCounts.saved.variantsUpdated += 1;
      } else {
        syncCounts.saved.variantsCreated += 1;
      }
    }

    // THE PRICING BASELINE IS THE ONLY PART THAT NEEDS A PRICE.
    //
    // `expectedMarginDelta` divides by `currentPrice`, so a zero price yields
    // NaN and Prisma rejects it — which is why the old guard sat at the top of
    // the loop and threw the whole product away. Skipping only the baseline
    // keeps the product, its variants, its SKU and its inventory, and simply
    // declines to state a pricing recommendation it cannot compute.
    if (currentPrice <= 0) {
      syncCounts.skipped.priceBaselines += 1;
      continue;
    }

    const recommendedPrice = computeRecommendedPrice(currentPrice, store.pricingBias);
    const existingPriceRows = await prisma.priceHistory.count({
      where: {
        storeId: store.id,
        productHandle: product.handle,
      },
    });

    await prisma.priceHistory.deleteMany({
      where: {
        storeId: store.id,
        productHandle: product.handle,
      },
    });

    await prisma.priceHistory.create({
      data: {
        storeId: store.id,
        productHandle: product.handle,
        currentPrice,
        recommendedPrice,
        expectedMarginDelta: Number(
          (((recommendedPrice - currentPrice) / currentPrice) * 100).toFixed(2)
        ),
        expectedProfitGain: null,
        rationaleJson: JSON.stringify({
          source: "shopify_sync_baseline",
          productTitle: product.title,
          shopifyProductGid: product.id,
          shopifyVariantGid: firstVariant?.id ?? null,
          status: "baseline",
          syncedAt: new Date().toISOString(),
          demandTrend: "insufficient history",
          demandSignals: [
            "This baseline pricing target uses the current Shopify catalog price and merchant pricing settings.",
            "Projected profit impact is not shown until enough live order and margin history is available.",
            `Pricing bias is ${store.pricingBias}/100 and profit guardrail is ${store.profitGuardrail}%.`,
          ],
          evidenceSignals: [
            "Current product price from Shopify catalog",
            "Merchant pricing bias setting",
            "Merchant profit guardrail setting",
          ],
          competitorPressure: "not_available",
        }),
      },
    });

    if (existingPriceRows > 0) {
      syncCounts.saved.priceRowsUpdated += 1;
    } else {
      syncCounts.saved.priceRowsCreated += 1;
    }
  }
    const productsSaved =
      syncCounts.saved.productsCreated + syncCounts.saved.productsUpdated;

    // FETCHING IS NOT SAVING.
    //
    // "SUCCESS" here used to mean only "the loop did not throw". A sync that
    // pulled three products from Shopify and stored none of them reported
    // SUCCESS with count 0, and the diagnostics endpoint read that as proof the
    // merchant's catalogue was empty. It was not empty — every product had been
    // discarded — and the tester was told the opposite of what happened.
    //
    // These are now three different outcomes, and none of them can stand in for
    // another.
    if (products.length === 0) {
      resourceStatus.products.status = "SUCCESS_EMPTY";
    } else if (productsSaved === 0) {
      resourceStatus.products.status = "FETCHED_NONE_PERSISTED";
      resourceStatus.products.safeMessage =
        `Shopify returned ${products.length} products and VedaSuite stored none of them.`;
    } else if (productsSaved < products.length) {
      resourceStatus.products.status = "SUCCESS_PARTIAL";
      resourceStatus.products.safeMessage =
        `Shopify returned ${products.length} products and VedaSuite stored ${productsSaved}.`;
    } else {
      resourceStatus.products.status = "SUCCESS";
    }
    resourceStatus.products.count = productsSaved;
    resourceStatus.products.fetched = products.length;
    resourceStatus.products.skipped = syncCounts.skipped.products;
    resourceStatus.products.skippedReasons = { ...syncCounts.skippedReasons };
  } catch (error) {
    // PRODUCTS FAILED, ORDERS DID NOT.
    //
    // Orders are already committed at this point. Rethrowing would discard a
    // successful order sync; swallowing silently would leave the store looking
    // like it simply has no products. Neither is acceptable, so the failure is
    // RECORDED against the product resource and the sync continues.
    resourceStatus.products.status = "FAILED";
    resourceStatus.products.errorClass =
      error instanceof Error ? error.name : "UnknownError";
    // Merchant-safe. The full error goes to the log, never to a client.
    resourceStatus.products.safeMessage =
      "Shopify product data could not be saved during the last sync.";
    logEvent("error", "shopify.sync.products_failed", {
      shop: normalizedShop,
      productsFetched: products.length,
      productsSavedBeforeFailure:
        syncCounts.saved.productsCreated + syncCounts.saved.productsUpdated,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // Orders and customers completed before the product loop began.
  resourceStatus.orders.status = orders.length > 0 ? "SUCCESS" : "SUCCESS_EMPTY";
  resourceStatus.orders.count =
    syncCounts.saved.ordersCreated + syncCounts.saved.ordersUpdated;
  resourceStatus.customers.status =
    syncCounts.fetched.customers > 0 ? "SUCCESS" : "SUCCESS_EMPTY";
  resourceStatus.customers.count =
    syncCounts.saved.customersCreated + syncCounts.saved.customersUpdated;
  resourceStatus.lineItems.status = lineItemsTruncated > 0
    ? "PARTIAL"
    : lineItemsSaved > 0
    ? "SUCCESS"
    : "SUCCESS_EMPTY";
  resourceStatus.lineItems.count = lineItemsSaved;

  const savedTotal =
    syncCounts.saved.productsCreated +
    syncCounts.saved.productsUpdated +
    syncCounts.saved.variantsCreated +
    syncCounts.saved.variantsUpdated +
    syncCounts.saved.ordersCreated +
    syncCounts.saved.ordersUpdated +
    syncCounts.saved.customersCreated +
    syncCounts.saved.customersUpdated +
    syncCounts.saved.priceRowsCreated +
    syncCounts.saved.priceRowsUpdated;

  const fetchedTotal =
    syncCounts.fetched.products +
    syncCounts.fetched.orders +
    syncCounts.fetched.customers +
    syncCounts.fetched.variants;

  if (fetchedTotal > 0 && savedTotal === 0) {
    throw new Error(
      "Shopify sync fetched records but nothing was persisted. Check mapping and upserts."
    );
  }

  // A failed resource is never reported as an unqualified success. This is
  // the line that stopped a broken product sync looking like a clean one.
  const anyResourceFailed = Object.entries(resourceStatus).some(
    ([key, value]) => value.status === "FAILED" && key !== "inventoryLevels"
  );
  const status = anyResourceFailed
    ? "SUCCEEDED_PARTIAL"
    : syncCounts.fetched.products === 0 &&
      syncCounts.fetched.orders === 0 &&
      syncCounts.fetched.customers === 0
    ? "SUCCEEDED_NO_DATA"
    : "SUCCEEDED";

  // PER-LOCATION STOCK, LAST AND OPTIONAL.
  //
  // Deliberately after everything above has committed, and deliberately unable
  // to throw: it needs a scope this app only recently began requesting, and no
  // existing merchant has granted it. A permission failure here must leave the
  // sync exactly as successful as it already was.
  const inventoryLevels = await syncInventoryLevels({
    shopDomain: normalizedShop,
    storeId: store.id,
    grantedScopes: store.grantedScopes,
  });

  resourceStatus.inventoryLevels.status = !inventoryLevels.attempted
    ? "PERMISSION_LIMITED"
    : inventoryLevels.succeeded
    ? "SUCCESS"
    : "FAILED";
  resourceStatus.inventoryLevels.count = inventoryLevels.levels;
  resourceStatus.inventoryLevels.safeMessage = inventoryLevels.reason;

  // THE OVERALL VERDICT IS AN AGGREGATE, not a single boolean. A resource
  // that failed makes the job PARTIAL even when every other one succeeded.
  const resourceFailed = Object.entries(resourceStatus).filter(
    ([key, value]) => value.status === "FAILED" && key !== "inventoryLevels"
  );

  logEvent("info", "shopify.sync.completed", {
    shop: normalizedShop,
    startedAt: syncStartedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    status,
    counts: syncCounts,
    resourceStatus,
    lineItemsSaved,
    lineItemsTruncated,
    inventoryLevels: {
      attempted: inventoryLevels.attempted,
      succeeded: inventoryLevels.succeeded,
      locations: inventoryLevels.locations,
      levels: inventoryLevels.levels,
    },
  });

  return {
    startedAt: syncStartedAt.toISOString(),
    syncedAt: new Date().toISOString(),
    status,
    productsSynced: products.length,
    ordersSynced: orders.length,
    customersSynced: orders.filter((order) => order.customer?.legacyResourceId).length,
    counts: syncCounts,
    // Per-resource outcomes, so a caller never has to infer which part of
    // the sync worked from the presence or absence of rows.
    resourceStatus,
    resourcesFailed: resourceFailed.map(([key]) => key),
    lineItemsSaved,
    lineItemsTruncated,
    inventoryLevels,
  };
}

export async function tagShopifyOrder(
  shopDomain: string,
  orderReference: {
    shopifyOrderGid?: string | null;
    shopifyLegacyOrderId?: string | null;
    orderName?: string | null;
  },
  tags: string[]
) {
  const orderGid =
    orderReference.shopifyOrderGid && orderReference.shopifyOrderGid.startsWith("gid://shopify/Order/")
      ? orderReference.shopifyOrderGid
      : orderReference.shopifyLegacyOrderId && /^\d+$/.test(orderReference.shopifyLegacyOrderId)
      ? `gid://shopify/Order/${orderReference.shopifyLegacyOrderId}`
      : null;

  if (!orderGid) {
    return {
      updated: false,
      reason:
        "Review status saved in VedaSuite. Shopify tagging will be available after the order is fully synced.",
    };
  }
  const mutation = await shopifyGraphQL<{
    tagsAdd: {
      userErrors: Array<{ message: string }>;
    };
  }>(
    shopDomain,
    `
      mutation AddOrderTags($id: ID!, $tags: [String!]!) {
        tagsAdd(id: $id, tags: $tags) {
          userErrors {
            message
          }
        }
      }
    `,
    {
      id: orderGid,
      tags,
    }
  );

  const errors = mutation.tagsAdd.userErrors;
  if (errors.length) {
    return { updated: false, reason: errors.map((error) => error.message).join(", ") };
  }

  return { updated: true, shopifyOrderGid: orderGid, tags };
}

export { extractLegacyId };

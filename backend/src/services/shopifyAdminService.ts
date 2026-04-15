import { prisma } from "../db/prismaClient";
import { env } from "../config/env";
import { logEvent, withRetry } from "./observabilityService";
import {
  forceRefreshOfflineAccessToken,
  normalizeShopDomain,
  resolveOfflineInstallation,
  updateConnectionDiagnostics,
} from "./shopifyConnectionService";

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
      if (
        response.status === 401 ||
        /invalid api key|invalid access token|unrecognized login|wrong password/i.test(
          text
        )
      ) {
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
      throw new Error(payload.errors.map((error) => error.message).join(", "));
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

type SyncQueryResponse = {
  shop: {
    name: string;
    products: {
      edges: Array<{
        node: {
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
              };
            }>;
          };
        };
      }>;
    };
    orders: {
      edges: Array<{
        node: {
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
            legacyResourceId: string;
            email?: string | null;
            numberOfOrders: number;
          } | null;
          tags: string[];
        };
      }>;
    };
  };
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
        const timeout = setTimeout(() => controller.abort(), 4000);

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

          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
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
            return null;
          }

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
      }
    );
  } catch {
    logEvent("warn", "competitor.snapshot_fallback", {
      domain,
      productHandle,
    });
    return null;
  }
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
  const data = await shopifyGraphQL<SyncQueryResponse>(
    normalizedShop,
    `
      query SyncStoreData {
        shop {
          name
          products(first: 20, sortKey: UPDATED_AT, reverse: true) {
            edges {
              node {
                id
                handle
                title
                status
                variants(first: 25) {
                  edges {
                    node {
                      id
                      title
                      price
                    }
                  }
                }
              }
            }
          }
          orders(first: 20, sortKey: CREATED_AT, reverse: true) {
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
                customer {
                  id
                  legacyResourceId
                  email
                  numberOfOrders
                }
                tags
                displayFulfillmentStatus
              }
            }
          }
        }
      }
    `,
    undefined,
    { timeoutMs: 60000 }
  );

  const products = data.shop.products.edges.map((edge) => edge.node);
  const orders = data.shop.orders.edges.map((edge) => edge.node);
  const syncCounts = {
    fetched: {
      products: products.length,
      orders: orders.length,
      customers: orders.filter((order) => !!order.customer?.legacyResourceId).length,
      variants: products.reduce(
        (sum, product) => sum + product.variants.edges.length,
        0
      ),
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

      const customer = existingCustomer
        ? await prisma.customer.update({
            where: { id: existingCustomer.id },
            data: {
              email: orderNode.customer.email ?? existingCustomer.email,
              totalOrders: orderNode.customer.numberOfOrders,
            },
          })
        : await prisma.customer.create({
            data: {
              storeId: store.id,
              shopifyCustomerId: orderNode.customer.legacyResourceId,
              email: orderNode.customer.email,
              totalOrders: orderNode.customer.numberOfOrders,
            },
          });

      if (existingCustomer) {
        syncCounts.saved.customersUpdated += 1;
      } else {
        syncCounts.saved.customersCreated += 1;
      }

      customerId = customer.id;
    }

    const normalizedStatus = orderNode.displayFinancialStatus.toLowerCase();
    const refunded =
      normalizedStatus.includes("refunded") ||
      normalizedStatus.includes("partially_refunded");
    const refundRequested = refunded || orderNode.tags.some((tag) => /refund/i.test(tag));

    const existingOrder = await prisma.order.findUnique({
      where: { shopifyOrderId: orderNode.legacyResourceId },
      select: { id: true },
    });

    await prisma.order.upsert({
      where: { shopifyOrderId: orderNode.legacyResourceId },
      create: {
        storeId: store.id,
        customerId,
        shopifyOrderId: orderNode.legacyResourceId,
        totalAmount: Number(orderNode.currentTotalPriceSet.shopMoney.amount),
        currency: orderNode.currentTotalPriceSet.shopMoney.currencyCode,
        status: normalizedStatus,
        refunded,
        refundRequested,
        createdAt: new Date(orderNode.createdAt),
      },
      update: {
        customerId,
        totalAmount: Number(orderNode.currentTotalPriceSet.shopMoney.amount),
        currency: orderNode.currentTotalPriceSet.shopMoney.currencyCode,
        status: normalizedStatus,
        refunded,
        refundRequested,
      },
    });

    if (existingOrder) {
      syncCounts.saved.ordersUpdated += 1;
    } else {
      syncCounts.saved.ordersCreated += 1;
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

  for (const product of products) {
    const variants = product.variants.edges.map((edge) => edge.node);
    const firstVariant = variants[0];
    const currentPrice = Number(firstVariant?.price ?? 0);
    if (!product.handle || variants.length === 0 || !currentPrice) {
      syncCounts.skipped.products += 1;
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
          price: Number(variant.price),
          currency: orders[0]?.currentTotalPriceSet.shopMoney.currencyCode ?? null,
        },
        update: {
          title: variant.title,
          price: Number(variant.price),
          currency: orders[0]?.currentTotalPriceSet.shopMoney.currencyCode ?? null,
        },
      });

      if (existingVariant) {
        syncCounts.saved.variantsUpdated += 1;
      } else {
        syncCounts.saved.variantsCreated += 1;
      }
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

  const status =
    syncCounts.fetched.products === 0 &&
    syncCounts.fetched.orders === 0 &&
    syncCounts.fetched.customers === 0
      ? "SUCCEEDED_NO_DATA"
      : "SUCCEEDED";

  logEvent("info", "shopify.sync.completed", {
    shop: normalizedShop,
    startedAt: syncStartedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    status,
    counts: syncCounts,
  });

  return {
    startedAt: syncStartedAt.toISOString(),
    syncedAt: new Date().toISOString(),
    status,
    productsSynced: products.length,
    ordersSynced: orders.length,
    customersSynced: orders.filter((order) => order.customer?.legacyResourceId).length,
    counts: syncCounts,
  };
}

export async function tagShopifyOrder(
  shopDomain: string,
  shopifyOrderId: string,
  tags: string[]
) {
  if (!/^\d+$/.test(shopifyOrderId)) {
    return {
      updated: false,
      reason: "Order does not have a Shopify numeric order id yet.",
    };
  }

  const orderGid = `gid://shopify/Order/${shopifyOrderId}`;
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

  return { updated: true, shopifyOrderId, tags };
}

export { extractLegacyId };

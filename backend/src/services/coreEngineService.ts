import { prisma } from "../db/prismaClient";
import { logEvent } from "./observabilityService";

type StoreSnapshot = {
  id: string;
  shop: string;
  pricingBias: number;
  profitGuardrail: number;
  orders: Array<{
    id: string;
    shopifyOrderId: string;
    totalAmount: number;
    currency: string;
    status: string;
    refunded: boolean;
    refundRequested: boolean;
    fraudScore: number;
    fraudRiskLevel: string;
    createdAt: Date;
    customerId: string | null;
    customer: {
      id: string;
      email: string | null;
      totalOrders: number;
      totalRefunds: number;
      refundRate: number;
      fraudSignalsCount: number;
      paymentReliability: number;
      creditScore: number;
      creditCategory: string;
    } | null;
    fraudSignals: Array<{
      id: string;
      riskScore: number;
      riskLevel: string;
      sharedNetworkHash: string | null;
      createdAt: Date;
    }>;
  }>;
  customers: Array<{
    id: string;
    email: string | null;
    totalOrders: number;
    totalRefunds: number;
    refundRate: number;
    fraudSignalsCount: number;
    paymentReliability: number;
    creditScore: number;
    creditCategory: string;
    orders: Array<{
      id: string;
      totalAmount: number;
      refunded: boolean;
      refundRequested: boolean;
      fraudScore: number;
      createdAt: Date;
    }>;
    fraudSignals: Array<{
      id: string;
      riskScore: number;
      riskLevel: string;
      createdAt: Date;
    }>;
  }>;
  competitorData: Array<{
    id: string;
    productHandle: string;
    competitorName: string;
    source: string;
    price: number | null;
    promotion: string | null;
    stockStatus: string | null;
    collectedAt: Date;
  }>;
  priceHistory: Array<{
    id: string;
    productHandle: string;
    currentPrice: number;
    recommendedPrice: number;
    expectedMarginDelta: number;
    expectedProfitGain: number | null;
    rationaleJson: string | null;
    createdAt: Date;
  }>;
  profitData: Array<{
    id: string;
    productHandle: string;
    productCost: number;
    sellingPrice: number;
    competitorAveragePrice: number | null;
    advertisingSpend: number | null;
    shippingCost: number | null;
    returnRate: number | null;
    salesVelocity: number | null;
    optimalPrice: number | null;
    projectedMarginIncrease: number | null;
    projectedMonthlyProfit: number | null;
    bundleSuggestionsJson: string | null;
    discountStrategyJson: string | null;
    createdAt: Date;
  }>;
};

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function roundMoney(value: number) {
  return Number(value.toFixed(2));
}

function safeJsonParse<T>(value: string | null | undefined, fallback: T): T {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function calculateTrustScore(customer: StoreSnapshot["customers"][number]) {
  const ordersCount = customer.orders.length;
  const refunds = customer.orders.filter((order) => order.refunded || order.refundRequested).length;
  const refundRate = ordersCount > 0 ? refunds / ordersCount : customer.refundRate;
  const completedOrders = customer.orders.filter((order) => !order.refunded).length;
  const successfulOrderRatio = ordersCount > 0 ? completedOrders / ordersCount : 0.5;
  const avgOrderValue =
    ordersCount > 0
      ? customer.orders.reduce((sum, order) => sum + order.totalAmount, 0) / ordersCount
      : 0;
  const recentSignals = customer.fraudSignals.length;
  const paymentReliability = customer.paymentReliability || successfulOrderRatio * 20;

  const score = clamp(
    Math.round(
      58 +
        Math.min(18, ordersCount * 2.5) +
        Math.min(10, avgOrderValue / 40) +
        paymentReliability -
        refundRate * 42 -
        recentSignals * 8
    ),
    0,
    100
  );

  const category =
    score >= 80 ? "Trusted Buyer" : score >= 55 ? "Standard Buyer" : "Review Buyer";

  const reasons: string[] = [];
  if (ordersCount <= 1) {
    reasons.push("New shopper profile with limited historical behavior.");
  }
  if (refundRate >= 0.35) {
    reasons.push("Refund frequency is materially above the store baseline.");
  }
  if (recentSignals > 0) {
    reasons.push("Fraud and abuse signals are present in recent order history.");
  }
  if (successfulOrderRatio >= 0.85 && ordersCount >= 2) {
    reasons.push("Successful fulfillment history supports higher trust.");
  }
  if (reasons.length === 0) {
    reasons.push("Current behavior is within the store's normal trust range.");
  }

  return {
    score,
    category,
    refundRate,
    paymentReliability: Number(paymentReliability.toFixed(1)),
    reasons,
  };
}

function calculateReturnAbuseScore(customer: StoreSnapshot["customers"][number]) {
  const ordersCount = customer.orders.length;
  const refunds = customer.orders.filter((order) => order.refunded || order.refundRequested).length;
  const refundRate = ordersCount > 0 ? refunds / ordersCount : customer.refundRate;
  const quickRefundSignals = customer.orders.filter(
    (order) =>
      (order.refunded || order.refundRequested) &&
      Date.now() - order.createdAt.getTime() <= 14 * 24 * 60 * 60 * 1000
  ).length;

  const score = clamp(
    Math.round(
      refundRate * 65 +
        quickRefundSignals * 8 +
        customer.fraudSignals.length * 6 +
        (ordersCount >= 4 && refunds >= 2 ? 10 : 0)
    ),
    0,
    100
  );

  const reasons: string[] = [];
  if (refundRate >= 0.4) {
    reasons.push("Refund rate is elevated and suggests repeat post-purchase friction.");
  }
  if (quickRefundSignals >= 2) {
    reasons.push("Multiple refund requests arrived quickly after recent orders.");
  }
  if (customer.fraudSignals.length > 0) {
    reasons.push("Abuse score is reinforced by linked fraud or review signals.");
  }
  if (reasons.length === 0) {
    reasons.push("No strong return-abuse pattern is visible yet.");
  }

  return { score, reasons };
}

function buildOrderRisk(order: StoreSnapshot["orders"][number]) {
  const customerRefundRate = order.customer?.refundRate ?? 0;
  const customerTrustScore = order.customer?.creditScore ?? 55;
  const signalPressure =
    order.fraudSignals.reduce((sum, signal) => sum + signal.riskScore, 0) /
    Math.max(1, order.fraudSignals.length);

  const score = clamp(
    Math.round(
      Math.max(order.fraudScore, 0) * 0.45 +
        signalPressure * 0.25 +
        customerRefundRate * 100 * 0.2 +
        (100 - customerTrustScore) * 0.1 +
        (order.refundRequested ? 8 : 0)
    ),
    0,
    100
  );

  const riskLevel = score >= 75 ? "High" : score >= 45 ? "Medium" : "Low";
  return { score, riskLevel };
}

function baselinePriceRecommendation(args: {
  currentPrice: number;
  pricingBias: number;
  competitorAveragePrice?: number | null;
  returnRate?: number | null;
  salesVelocity?: number | null;
}) {
  const competitorGap =
    args.competitorAveragePrice != null
      ? args.competitorAveragePrice - args.currentPrice
      : 0;
  const returnPenalty = (args.returnRate ?? 0) * args.currentPrice * 0.12;
  const salesLift = Math.min(4, (args.salesVelocity ?? 8) / 6);
  const biasLift = (args.pricingBias - 50) / 180;
  const recommendedPrice = roundMoney(
    Math.max(
      1,
      args.currentPrice +
        args.currentPrice * biasLift +
        competitorGap * 0.35 -
        returnPenalty * 0.08 +
        salesLift
    )
  );

  return recommendedPrice;
}

function buildTimelineEvents(store: StoreSnapshot) {
  const events: Array<{
    storeId: string;
    customerId: string | null;
    orderId: string | null;
    category: string;
    eventType: string;
    title: string;
    detail: string;
    severity: string;
    scoreImpact?: number;
    metadataJson?: string;
    createdAt: Date;
  }> = [];

  for (const customer of store.customers) {
    const trust = calculateTrustScore(customer);
    events.push({
      storeId: store.id,
      customerId: customer.id,
      orderId: null,
      category: "trust",
      eventType: "trust_profile_scored",
          title: `Trust profile updated for shopper ${customer.id.slice(-4)}`,
          detail: `Trust score ${trust.score} with ${customer.totalOrders} orders and ${customer.totalRefunds} refunds.`,
          severity: trust.score >= 80 ? "success" : trust.score >= 55 ? "info" : "warning",
          scoreImpact: trust.score - (customer.creditScore ?? 50),
          metadataJson: JSON.stringify({
            customerEmail: customer.email,
            score: trust.score,
            category: trust.category,
            refundRate: trust.refundRate,
            reasons: trust.reasons,
          }),
      createdAt: new Date(),
    });

    const abuse = calculateReturnAbuseScore(customer);
    if (abuse.score >= 35) {
      events.push({
        storeId: store.id,
        customerId: customer.id,
        orderId: null,
        category: "abuse",
        eventType: "return_abuse_assessed",
        title: `Return-abuse score refreshed for shopper ${customer.id.slice(-4)}`,
        detail: `Return-abuse score ${abuse.score} based on refund behavior and recent claims.`,
        severity: abuse.score >= 70 ? "critical" : "warning",
        scoreImpact: -Math.round(abuse.score / 10),
        metadataJson: JSON.stringify({ score: abuse.score, reasons: abuse.reasons }),
        createdAt: new Date(),
      });
    }
  }

  for (const order of store.orders.slice(0, 25)) {
    const risk = buildOrderRisk(order);
    events.push({
      storeId: store.id,
      customerId: order.customerId,
      orderId: order.id,
      category: "orders",
      eventType: order.refundRequested ? "refund_requested" : "order_synced",
      title: order.refundRequested
        ? `Refund review on order ${order.shopifyOrderId}`
        : `Order ${order.shopifyOrderId} synced`,
      detail: order.refundRequested
        ? `Refund-related activity plus risk score ${risk.score} triggered review guidance.`
        : `Order amount ${order.totalAmount.toFixed(2)} ${order.currency} with ${risk.riskLevel.toLowerCase()} risk posture.`,
      severity:
        risk.riskLevel === "High"
          ? "critical"
          : risk.riskLevel === "Medium"
          ? "warning"
          : "info",
      scoreImpact: risk.riskLevel === "High" ? -8 : risk.riskLevel === "Medium" ? -3 : 2,
      metadataJson: JSON.stringify({
        riskScore: risk.score,
        riskLevel: risk.riskLevel,
        refunded: order.refunded,
        refundRequested: order.refundRequested,
      }),
      createdAt: order.createdAt,
    });
  }

  return events
    .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
    .slice(0, 80);
}

export async function recomputeStoreDerivedData(shopDomain: string) {
  const store = await prisma.store.findUnique({
    where: { shop: shopDomain },
    include: {
      orders: {
        include: {
          customer: true,
          fraudSignals: true,
        },
        orderBy: { createdAt: "desc" },
      },
      customers: {
        include: {
          orders: true,
          fraudSignals: true,
        },
      },
      competitorData: {
        orderBy: { collectedAt: "desc" },
      },
      priceHistory: {
        orderBy: { createdAt: "desc" },
      },
      profitData: {
        orderBy: { createdAt: "desc" },
      },
    },
  });

  if (!store) {
    throw new Error("Store not found");
  }

  const customerUpdates = store.customers.map((customer) => {
    const trust = calculateTrustScore(customer);
    return prisma.customer.update({
      where: { id: customer.id },
      data: {
        totalOrders: customer.orders.length,
        totalRefunds: customer.orders.filter((order) => order.refunded || order.refundRequested).length,
        refundRate: trust.refundRate,
        fraudSignalsCount: customer.fraudSignals.length,
        paymentReliability: trust.paymentReliability,
        creditScore: trust.score,
        creditCategory: trust.category,
      },
    });
  });

  const orderUpdates = store.orders.map((order) => {
    const risk = buildOrderRisk(order);
    return prisma.order.update({
      where: { id: order.id },
      data: {
        fraudScore: risk.score,
        fraudRiskLevel: risk.riskLevel,
      },
    });
  });

  const baselineProducts = new Set<string>();
  const pricingCreates: ReturnType<typeof prisma.priceHistory.create>[] = [];
  const profitCreates: ReturnType<typeof prisma.profitOptimizationData.create>[] = [];

  for (const row of store.priceHistory) {
    baselineProducts.add(row.productHandle);
  }
  for (const row of store.profitData) {
    baselineProducts.add(row.productHandle);
  }
  for (const row of store.competitorData) {
    baselineProducts.add(row.productHandle);
  }

  const storeReturnRate =
    store.orders.length > 0
      ? store.orders.filter((order) => order.refunded || order.refundRequested).length /
        store.orders.length
      : 0.08;

  for (const productHandle of baselineProducts) {
    const latestPrice =
      store.priceHistory.find((row) => row.productHandle === productHandle) ?? null;
    const latestProfit =
      store.profitData.find((row) => row.productHandle === productHandle) ?? null;
    const competitorRows = store.competitorData.filter((row) => row.productHandle === productHandle);

    const currentPrice =
      latestPrice?.currentPrice ??
      latestProfit?.sellingPrice ??
      roundMoney(
        competitorRows.find((row) => row.price != null)?.price ?? 49
      );
    const competitorAveragePrice =
      competitorRows.filter((row) => row.price != null).length > 0
        ? roundMoney(
            competitorRows
              .filter((row) => row.price != null)
              .reduce((sum, row) => sum + (row.price ?? 0), 0) /
              competitorRows.filter((row) => row.price != null).length
          )
        : latestProfit?.competitorAveragePrice ?? null;

    const recommendedPrice = baselinePriceRecommendation({
      currentPrice,
      pricingBias: store.pricingBias,
      competitorAveragePrice,
      returnRate: latestProfit?.returnRate ?? storeReturnRate,
      salesVelocity: latestProfit?.salesVelocity ?? 8,
    });
    const expectedMarginDelta = roundMoney(((recommendedPrice - currentPrice) / currentPrice) * 100);
    const expectedProfitGain = roundMoney(
      Math.max(0, recommendedPrice - currentPrice) * (latestProfit?.salesVelocity ?? 8) * 6
    );

    if (!latestPrice || Math.abs(latestPrice.recommendedPrice - recommendedPrice) > 0.01) {
      pricingCreates.push(
        prisma.priceHistory.create({
          data: {
            storeId: store.id,
            productHandle,
            currentPrice,
            recommendedPrice,
            expectedMarginDelta,
            expectedProfitGain,
            rationaleJson: JSON.stringify({
              source: "core_engine",
              syncedAt: new Date().toISOString(),
              fallbackUsed: competitorAveragePrice == null,
              demandScore: clamp(
                Math.round((latestProfit?.salesVelocity ?? 8) * 5 + (100 - store.profitGuardrail)),
                25,
                95
              ),
              demandTrend:
                (latestProfit?.salesVelocity ?? 8) >= 14
                  ? "strong"
                  : (latestProfit?.salesVelocity ?? 8) >= 8
                  ? "stable"
                  : "softening",
              demandSignals: [
                competitorAveragePrice != null
                  ? `Competitor average price is ${competitorAveragePrice.toFixed(2)}.`
                  : "No competitor price data yet, so VedaSuite used a store-level baseline.",
                `Pricing bias is ${store.pricingBias}/100.`,
                `Return rate pressure applied at ${Math.round((latestProfit?.returnRate ?? storeReturnRate) * 100)}%.`,
              ],
              competitorPressure:
                competitorAveragePrice != null && competitorAveragePrice < currentPrice
                  ? "high"
                  : competitorAveragePrice != null
                  ? "medium"
                  : "baseline_only",
            }),
          },
        })
      );
    }

    const productCost = latestProfit?.productCost ?? roundMoney(currentPrice * 0.58);
    const salesVelocity = latestProfit?.salesVelocity ?? Math.max(4, store.orders.length / Math.max(1, baselineProducts.size));
    const optimalPrice = roundMoney(
      Math.max(
        currentPrice,
        recommendedPrice + currentPrice * (store.profitGuardrail / 1000)
      )
    );
    const projectedMarginIncrease = roundMoney(((optimalPrice - currentPrice) / currentPrice) * 100);
    const projectedMonthlyProfit = roundMoney(
      Math.max(0, optimalPrice - productCost - (latestProfit?.shippingCost ?? currentPrice * 0.06) - (latestProfit?.advertisingSpend ?? currentPrice * 0.1)) *
        salesVelocity *
        4
    );

    if (!latestProfit || Math.abs((latestProfit.optimalPrice ?? 0) - optimalPrice) > 0.01) {
      profitCreates.push(
        prisma.profitOptimizationData.create({
          data: {
            storeId: store.id,
            productHandle,
            productCost,
            sellingPrice: currentPrice,
            competitorAveragePrice,
            advertisingSpend: latestProfit?.advertisingSpend ?? roundMoney(currentPrice * 0.1),
            shippingCost: latestProfit?.shippingCost ?? roundMoney(currentPrice * 0.06),
            returnRate: latestProfit?.returnRate ?? storeReturnRate,
            salesVelocity,
            optimalPrice,
            projectedMarginIncrease,
            projectedMonthlyProfit,
            bundleSuggestionsJson: JSON.stringify([
              `Bundle ${productHandle} with a complementary item to defend margin.`,
              `Use ${productHandle} in a premium-value offer before discounting directly.`,
            ]),
            discountStrategyJson: JSON.stringify({
              fallbackUsed: competitorAveragePrice == null,
              strategy:
                competitorAveragePrice != null && competitorAveragePrice < currentPrice
                  ? "Selective response"
                  : "Hold and monitor",
              marginGuardrail: store.profitGuardrail,
            }),
          },
        })
      );
    }
  }

  const timelineEvents = buildTimelineEvents(store);
  const fraudSignalsGenerated = timelineEvents.filter(
    (event) => event.category === "abuse" || event.severity === "critical"
  ).length;

  await prisma.$transaction([
    ...customerUpdates,
    ...orderUpdates,
    ...pricingCreates,
    ...profitCreates,
    prisma.timelineEvent.deleteMany({ where: { storeId: store.id } }),
    ...timelineEvents.map((event) => prisma.timelineEvent.create({ data: event })),
  ]);

  logEvent("info", "core_engine.recomputed", {
    shop: shopDomain,
    customers: store.customers.length,
    orders: store.orders.length,
    products: baselineProducts.size,
    timelineEvents: timelineEvents.length,
  });

  return {
    customersRecomputed: store.customers.length,
    ordersRecomputed: store.orders.length,
    productOutputsUpdated: baselineProducts.size,
    timelineEventsCreated: timelineEvents.length,
    fraudSignalsGenerated,
  };
}

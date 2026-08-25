import { HttpError } from "../lib/httpError";
import { prisma } from "../db/prismaClient";
import { logEvent } from "./observabilityService";
import {
  formatMerchantInsightDetail,
  formatMerchantInsightTitle,
  getMerchantOrderLabelOrNull,
} from "../lib/merchantLabels";

type StoreSnapshot = {
  id: string;
  shop: string;
  pricingBias: number;
  profitGuardrail: number;
  orders: Array<{
    id: string;
    shopifyOrderId: string;
    shopifyLegacyOrderId?: string | null;
    orderName?: string | null;
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
    productCost: number | null;
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
  const signalPressure =
    order.fraudSignals.reduce((sum, signal) => sum + signal.riskScore, 0) /
    Math.max(1, order.fraudSignals.length);

  // PHASE J — the trust term contributes only when a trust score was OBSERVED.
  //
  // This used to read `order.customer?.creditScore ?? 55`, so an order from a
  // customer VedaSuite had never scored silently contributed 4.5 points of
  // "risk" derived from nothing. That number then set the High / Medium / Low
  // badge a merchant acts on.
  //
  // Dropping the term to zero would be just as wrong in the other direction: a
  // scoreless customer would look SAFER than a well-scored one. So the weight
  // is REDISTRIBUTED — the remaining observed components are rescaled to fill
  // the missing 0.1 — and the score stays a weighted average of things
  // VedaSuite actually knows.
  //
  // `creditScore` is Int @default(50), so a bare non-null check would let the
  // database default back in. Activity is what makes the score an observation.
  const customer = order.customer;
  const trustObserved =
    !!customer && ((customer.totalOrders ?? 0) > 0 || (customer.totalRefunds ?? 0) > 0);

  const observedWeights = trustObserved
    ? { fraud: 0.45, pressure: 0.25, refund: 0.2, trust: 0.1 }
    : { fraud: 0.45, pressure: 0.25, refund: 0.2, trust: 0 };
  const weightSum =
    observedWeights.fraud +
    observedWeights.pressure +
    observedWeights.refund +
    observedWeights.trust;
  const rescale = 1 / weightSum;

  const score = clamp(
    Math.round(
      (Math.max(order.fraudScore, 0) * observedWeights.fraud +
        signalPressure * observedWeights.pressure +
        customerRefundRate * 100 * observedWeights.refund +
        (trustObserved ? (100 - customer!.creditScore) * observedWeights.trust : 0)) *
        rescale +
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
  // No observed velocity means no velocity term at all. Substituting 8 added a
  // constant ~1.33 to every recommended price for no measured reason, and that
  // constant was visible in the merchant-facing target.
  const salesLift =
    args.salesVelocity != null && Number.isFinite(args.salesVelocity)
      ? Math.min(4, args.salesVelocity / 6)
      : 0;
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
    // Nullable: the column is `Int?`, and null means "no prior score to
    // measure a movement against" rather than "no movement".
    scoreImpact?: number | null;
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
      title: formatMerchantInsightTitle({
        category: "trust",
        eventType: "trust_profile_scored",
      }),
      detail: formatMerchantInsightDetail({
        category: "trust",
        eventType: "trust_profile_scored",
        detail: `Trust score ${trust.score} with ${customer.totalOrders} orders and ${customer.totalRefunds} refunds.`,
      }),
      severity: trust.score >= 80 ? "success" : trust.score >= 55 ? "info" : "warning",
      // PHASE J. A delta needs something to be a delta FROM. `creditScore` is
      // Int @default(50), so for a customer who has never been scored this
      // computed `trust.score - 50` and stored it as a real movement — and the
      // trust workspace then rebuilt an absolute score from it. Null when there
      // is no prior assessment: no baseline, no delta.
      scoreImpact:
        customer.totalOrders > 0 || customer.totalRefunds > 0
          ? trust.score - customer.creditScore
          : null,
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
        title: formatMerchantInsightTitle({
          category: "abuse",
          eventType: "return_abuse_assessed",
        }),
        detail: formatMerchantInsightDetail({
          category: "abuse",
          eventType: "return_abuse_assessed",
          detail: `Return-abuse score ${abuse.score} based on refund behavior and recent claims.`,
        }),
        severity: abuse.score >= 70 ? "critical" : "warning",
        scoreImpact: -Math.round(abuse.score / 10),
        metadataJson: JSON.stringify({ score: abuse.score, reasons: abuse.reasons }),
        createdAt: new Date(),
      });
    }
  }

  for (const order of store.orders.slice(0, 25)) {
    const risk = buildOrderRisk(order);
    const orderLabel = getMerchantOrderLabelOrNull(order);
    // GDPR invariant: customerId here can be null (guest orders), and
    // customers/redact erases a customer's timeline rows by customerId. So this
    // event must NEVER carry customer PII (email, name, address) in
    // title/detail/metadataJson — a null-customerId row would survive redaction.
    // It currently carries only order label, amounts and risk scores. Keep it
    // that way, or move the PII onto the customer-scoped trust event instead.
    events.push({
      storeId: store.id,
      customerId: order.customerId,
      orderId: order.id,
      category: "orders",
      eventType: order.refundRequested ? "refund_requested" : "order_synced",
      title: formatMerchantInsightTitle({
        category: "orders",
        eventType: order.refundRequested ? "refund_requested" : "order_synced",
        orderLabel,
        severity: risk.riskLevel,
      }),
      detail: formatMerchantInsightDetail({
        category: "orders",
        eventType: order.refundRequested ? "refund_requested" : "order_synced",
        orderLabel,
        detail: order.refundRequested
          ? `Refund-related activity plus risk score ${risk.score} triggered review guidance.`
          : `Order amount ${order.totalAmount.toFixed(2)} ${order.currency} with ${risk.riskLevel.toLowerCase()} risk posture.`,
      }),
      severity:
        risk.riskLevel === "High"
          ? "critical"
          : risk.riskLevel === "Medium"
          ? "warning"
          : "info",
      scoreImpact: risk.riskLevel === "High" ? -8 : risk.riskLevel === "Medium" ? -3 : 2,
      metadataJson: JSON.stringify({
        orderLabel,
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
    throw new HttpError(404, "Store not found.");
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

    // A product with no real price of its own cannot be priced. The previous
    // `?? 49` invented a base price out of nothing and then built an entire
    // recommendation, margin delta and profit projection on top of it.
    const observedCurrentPrice =
      latestPrice?.currentPrice ??
      latestProfit?.sellingPrice ??
      competitorRows.find((row) => row.price != null)?.price ??
      null;
    if (observedCurrentPrice == null) {
      continue;
    }
    const currentPrice = roundMoney(observedCurrentPrice);

    // PROVENANCE. Assumptions are still used for INTERNAL ranking, but they are
    // no longer persisted as if they were observations.
    //
    // A prior value only counts as observed if it was RECORDED as observed.
    // Neither input is observable today — there is no Shopify cost feed and no
    // order line items — so in practice both resolve to "assumed", and the
    // stored column is left NULL rather than filled with a guess.
    const costObserved = latestProfit?.costSource === "observed" && latestProfit.productCost != null;
    const velocityObserved =
      latestProfit?.velocitySource === "observed" && latestProfit.salesVelocity != null;

    const observedProductCost = costObserved ? (latestProfit!.productCost as number) : null;
    const observedSalesVelocity = velocityObserved ? (latestProfit!.salesVelocity as number) : null;

    // Internal-only heuristics. They may drive ranking and ordering; they may
    // never qualify a monetary claim as evidence-backed.
    const assumedProductCost = roundMoney(currentPrice * 0.58);
    const assumedSalesVelocity = Math.max(4, store.orders.length / Math.max(1, baselineProducts.size));

    const productCost = observedProductCost ?? assumedProductCost;
    const salesVelocity = observedSalesVelocity ?? assumedSalesVelocity;
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
      // NULL when unobserved. baselinePriceRecommendation omits its velocity
      // term entirely rather than substituting 8, so a displayed target is
      // never partly an assumption.
      salesVelocity: observedSalesVelocity,
    });
    const expectedMarginDelta = roundMoney(((recommendedPrice - currentPrice) / currentPrice) * 100);
    // NULL unless velocity was observed. This figure is delta x velocity x 6;
    // with an assumed velocity it is fiction, and it must not be persisted for
    // a later reader to present as money.
    const expectedProfitGain = velocityObserved
      ? roundMoney(
          Math.max(0, recommendedPrice - currentPrice) *
            (observedSalesVelocity as number) *
            6
        )
      : null;

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
              // demandScore is NULL when velocity was never observed.
              //
              // It used to be clamp(round((salesVelocity ?? 8) * 5 + ...), 25, 95),
              // which was always non-null and always partly the assumption. Downstream
              // code treats a non-null demandScore as evidence of observed demand, so
              // that made an assumption look measured — the same laundering this
              // programme exists to remove.
              demandScore: velocityObserved
                ? clamp(
                    Math.round(
                      (observedSalesVelocity as number) * 5 + (100 - store.profitGuardrail)
                    ),
                    25,
                    95
                  )
                : null,
              demandTrend: !velocityObserved
                ? "insufficient history"
                : (observedSalesVelocity as number) >= 14
                ? "strong"
                : (observedSalesVelocity as number) >= 8
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
            // UNKNOWN STAYS UNKNOWN. Only an observed value is persisted; the
            // internal heuristic above is used for ranking and never written,
            // so a later reader cannot mistake it for merchant data.
            productCost: observedProductCost,
            costSource: costObserved ? "observed" : "assumed",
            salesVelocity: observedSalesVelocity,
            velocitySource: velocityObserved ? "observed" : "assumed",
            sellingPrice: currentPrice,
            competitorAveragePrice,
            // Also assumptions. Left NULL rather than persisted as fact; the
            // columns are already nullable.
            advertisingSpend: latestProfit?.advertisingSpend ?? null,
            shippingCost: latestProfit?.shippingCost ?? null,
            returnRate: latestProfit?.returnRate ?? storeReturnRate,
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

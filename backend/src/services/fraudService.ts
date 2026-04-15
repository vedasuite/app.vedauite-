import { createHash } from "crypto";
import { prisma } from "../db/prismaClient";
import { maskCustomerIdentity } from "../lib/maskCustomerIdentity";
import { tagShopifyOrder } from "./shopifyAdminService";

export type FraudSignalInput = {
  ipAddress?: string;
  email?: string;
  shippingAddress?: string;
  deviceFingerprint?: string;
  paymentFingerprint?: string;
  refundHistoryScore?: number;
  orderFrequencyScore?: number;
};

function mapScoreToRisk(score: number): "Low" | "Medium" | "High" {
  if (score <= 30) return "Low";
  if (score <= 70) return "Medium";
  return "High";
}

function buildSharedNetworkHash(signals: FraudSignalInput) {
  const fingerprintSeed = [
    signals.email?.trim().toLowerCase(),
    signals.deviceFingerprint?.trim(),
    signals.paymentFingerprint?.trim(),
    signals.shippingAddress?.trim().toLowerCase(),
  ]
    .filter(Boolean)
    .join("|");

  if (!fingerprintSeed) {
    return null;
  }

  return createHash("sha256").update(fingerprintSeed).digest("hex");
}

function buildFraudReasons(signals: FraudSignalInput, score: number) {
  const reasons: string[] = [];

  if ((signals.refundHistoryScore ?? 0) >= 18) {
    reasons.push("Refund history is elevated for this shopper profile.");
  }
  if ((signals.orderFrequencyScore ?? 0) >= 15) {
    reasons.push("Order frequency is abnormal for the recent order window.");
  }
  if (signals.ipAddress?.startsWith("10.")) {
    reasons.push("IP address falls into an internal or low-trust range.");
  }
  if (signals.email?.endsWith("+fraud@test.com")) {
    reasons.push("Email pattern matches a known test or abuse format.");
  }
  if (signals.deviceFingerprint && !signals.paymentFingerprint) {
    reasons.push("Device is known but payment identity is incomplete.");
  }

  if (reasons.length === 0) {
    reasons.push(
      score >= 71
        ? "Multiple order signals combined into a high-risk fraud profile."
        : "Current order signals remain inside normal operating thresholds."
    );
  }

  return reasons;
}

function buildFraudConfidence(score: number, reasonCount: number) {
  return Math.max(
    46,
    Math.min(96, Math.round(score * 0.55 + reasonCount * 9))
  );
}

function buildFraudRecommendedAction(score: number) {
  if (score >= 85) {
    return "Block order";
  }
  if (score >= 71) {
    return "Send to manual review";
  }
  if (score >= 45) {
    return "Flag order";
  }
  return "Allow order";
}

function buildAutomationPosture(score: number, riskLevel: "Low" | "Medium" | "High") {
  if (score >= 85) {
    return {
      mode: "eligible",
      title: "Auto-block candidate",
      detail:
        "This signal is strong enough to support an automated block rule after merchant approval.",
    };
  }
  if (riskLevel === "High") {
    return {
      mode: "review_required",
      title: "Review before automation",
      detail:
        "Route to manual review first, then promote the pattern into an automation if it repeats.",
    };
  }
  if (riskLevel === "Medium") {
    return {
      mode: "monitor",
      title: "Monitor for repeat pattern",
      detail:
        "Track this pattern and only automate when a second or third matching signal appears.",
    };
  }
  return {
    mode: "safe",
    title: "Low automation pressure",
    detail:
      "This order is safe to approve manually and does not need a new automation rule.",
  };
}

function buildWardrobingReasons(customer: {
  refundRate: number;
  totalRefunds: number;
  totalOrders: number;
  paymentReliability: number;
}) {
  const reasons: string[] = [];
  if (customer.refundRate >= 0.45) {
    reasons.push("Refund rate is materially above the store average.");
  }
  if (customer.totalRefunds >= 3) {
    reasons.push("Multiple refunds have been recorded across recent orders.");
  }
  if (customer.totalOrders >= 4 && customer.totalRefunds >= 2) {
    reasons.push("The buy-use-return pattern is repeating across multiple orders.");
  }
  if (customer.paymentReliability <= 8) {
    reasons.push("Payment reliability is weak relative to the shopper's order volume.");
  }
  if (reasons.length === 0) {
    reasons.push("Wardrobing risk is elevated from combined return-behavior signals.");
  }
  return reasons;
}

export async function scoreOrderFraud(
  shopDomain: string,
  orderId: string,
  signals: FraudSignalInput
) {
  const store = await prisma.store.findUnique({
    where: { shop: shopDomain },
  });
  if (!store) {
    throw new Error("Store not found");
  }

  let score = 10;

  if (signals.refundHistoryScore) score += signals.refundHistoryScore;
  if (signals.orderFrequencyScore) score += signals.orderFrequencyScore;

  if (signals.ipAddress?.startsWith("10.")) score += 10;
  if (signals.email?.endsWith("+fraud@test.com")) score += 15;

  if (store.fraudSensitivity === "high") {
    score = Math.min(100, Math.floor(score * 1.2));
  }

  score = Math.max(0, Math.min(100, score));
  const riskLevel = mapScoreToRisk(score);

  const sharedNetworkHash = buildSharedNetworkHash(signals);
  const reasons = buildFraudReasons(signals, score);
  const confidence = buildFraudConfidence(score, reasons.length);
  const recommendedAction = buildFraudRecommendedAction(score);

  const order = await prisma.order.update({
    where: { id: orderId },
    data: {
      fraudScore: score,
      fraudRiskLevel: riskLevel,
    },
  });

  await prisma.fraudSignal.create({
    data: {
      storeId: store.id,
      orderId: order.id,
      customerId: order.customerId,
      ipAddress: signals.ipAddress,
      email: signals.email,
      shippingAddress: signals.shippingAddress,
      deviceFingerprint: signals.deviceFingerprint,
      paymentFingerprint: signals.paymentFingerprint,
      refundHistory: signals.refundHistoryScore?.toString(),
      orderFrequency: signals.orderFrequencyScore?.toString(),
      riskScore: score,
      riskLevel,
      sharedNetworkHash: store.sharedFraudNetwork ? sharedNetworkHash : null,
    },
  });

  return {
    orderId: order.id,
    fraudScore: score,
    riskLevel,
    confidence,
    recommendedAction,
    reasons,
    automationPosture: buildAutomationPosture(score, riskLevel),
  };
}

export async function listRecentFraudOrders(shopDomain: string) {
  const store = await prisma.store.findUnique({
    where: { shop: shopDomain },
  });
  if (!store) {
    throw new Error("Store not found");
  }

  const orders = await prisma.order.findMany({
    where: { storeId: store.id },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  return orders;
}

export async function applyFraudAction(
  shopDomain: string,
  orderId: string,
  action: "allow" | "flag" | "block" | "manual_review"
) {
  const store = await prisma.store.findUnique({
    where: { shop: shopDomain },
  });
  if (!store) {
    throw new Error("Store not found");
  }

  const nextStatus =
    action === "allow"
      ? "approved"
      : action === "block"
      ? "blocked"
      : action === "flag"
      ? "flagged"
      : "manual_review";

  const order = await prisma.order.update({
    where: { id: orderId },
    data: {
      status: nextStatus,
    },
  });

  const tags = [
    "VedaSuite AI",
    `vedasuite:${action}`,
    `fraud-risk:${order.fraudRiskLevel.toLowerCase()}`,
  ];
  const shopifyTagResult = await tagShopifyOrder(
    shopDomain,
    order.shopifyOrderId,
    tags
  );

  return {
    ...order,
    shopifyTagResult,
  };
}

export async function getFraudIntelligenceOverview(shopDomain: string) {
  const store = await prisma.store.findUnique({
    where: { shop: shopDomain },
    include: {
      orders: {
        orderBy: { createdAt: "desc" },
        take: 100,
      },
      customers: {
        orderBy: [{ refundRate: "desc" }, { updatedAt: "desc" }],
        take: 50,
      },
      fraudSignals: {
        orderBy: { createdAt: "desc" },
        take: 200,
      },
    },
  });

  if (!store) {
    throw new Error("Store not found");
  }

  const sharedHashCounts = new Map<string, number>();
  for (const signal of store.fraudSignals) {
    if (signal.sharedNetworkHash) {
      sharedHashCounts.set(
        signal.sharedNetworkHash,
        (sharedHashCounts.get(signal.sharedNetworkHash) ?? 0) + 1
      );
    }
  }

  const networkMatches = store.fraudSignals
    .filter(
      (signal) =>
        !!signal.sharedNetworkHash &&
        (sharedHashCounts.get(signal.sharedNetworkHash) ?? 0) > 1
    )
    .slice(0, 5)
    .map((signal) => {
      const repeatSignals = sharedHashCounts.get(signal.sharedNetworkHash!) ?? 1;
      const reasons = [
        repeatSignals >= 4
          ? "Fingerprint has repeated across multiple stored fraud events."
          : "Fingerprint is recurring inside the current merchant history.",
        signal.email
          ? "Email-linked behavior is contributing to the shared match."
          : "Identity overlap comes from non-email behavioral fingerprints.",
      ];
      const confidence = Math.min(97, 52 + repeatSignals * 10);

      return {
        id: signal.id,
        orderId: signal.orderId,
        customerId: signal.customerId,
        riskLevel: signal.riskLevel,
        repeatSignals,
        email: maskCustomerIdentity(
          signal.email,
          `shopper-${(signal.customerId ?? signal.id).slice(-4)}`
        ),
        confidence,
        recommendedAction:
          signal.riskLevel === "High" ? "Manual review" : "Flag for repeat watch",
        reasons,
        automationPosture:
          repeatSignals >= 3
            ? "Eligible for shared-network automation rules"
            : "Monitor until the match repeats again",
      };
    });

  const wardrobingSignals = store.customers
    .filter((customer) => customer.totalOrders >= 3)
    .map((customer) => {
      const score = Math.min(
        100,
        Math.round(
          customer.refundRate * 70 +
            Math.min(18, customer.totalRefunds * 4) +
            Math.max(0, 12 - customer.paymentReliability / 2)
        )
      );
      const reasons = buildWardrobingReasons(customer);
      const likely =
        customer.refundRate >= 0.45 && customer.totalRefunds >= 2 && score >= 65;

      return {
        id: customer.id,
        email: maskCustomerIdentity(customer.email, `shopper-${customer.id.slice(-4)}`),
        wardrobingScore: score,
        refundRate: Number((customer.refundRate * 100).toFixed(1)),
        totalRefunds: customer.totalRefunds,
        totalOrders: customer.totalOrders,
        likely,
        confidence: Math.max(48, Math.min(95, score - 4 + reasons.length * 5)),
        recommendedAction: likely
          ? "Tighten refund exceptions"
          : "Monitor repeat return behavior",
        reasons,
        automationPosture: likely
          ? "Use score as a refund-review trigger"
          : "Wait for one more repeat pattern before automating",
      };
    })
    .filter((customer) => customer.wardrobingScore >= 45)
    .sort((a, b) => b.wardrobingScore - a.wardrobingScore)
    .slice(0, 5);

  const highRiskCount = store.orders.filter((order) => order.fraudScore >= 71).length;
  const manualReviewCount = store.orders.filter(
    (order) => order.status === "manual_review"
  ).length;
  const returnAbuseCount = store.customers.filter(
    (customer) => customer.refundRate >= 0.35
  ).length;

  const chargebackCandidates = store.orders
    .filter((order) => order.fraudScore >= 60 || order.refundRequested)
    .slice(0, 5)
    .map((order) => ({
      id: order.id,
      shopifyOrderId: order.shopifyOrderId,
      chargebackRiskScore: Math.min(
        100,
        Math.round(order.fraudScore * 0.75 + (order.refundRequested ? 18 : 0))
      ),
      reasons: [
        order.refundRequested
          ? "Refund or post-purchase friction increases chargeback exposure."
          : "Fraud score remains elevated for this order.",
        order.status === "manual_review"
          ? "Manual review indicates unresolved trust questions."
          : `Current order status is ${order.status}.`,
      ],
    }));

  const returnAbuseSignals = store.customers
    .filter((customer) => customer.refundRate >= 0.25)
    .slice(0, 5)
    .map((customer) => ({
      id: customer.id,
      email: maskCustomerIdentity(customer.email, `shopper-${customer.id.slice(-4)}`),
      abuseScore: Math.min(
        100,
        Math.round(customer.refundRate * 75 + customer.totalRefunds * 6)
      ),
      reasons: [
        `${customer.totalRefunds} refunds across ${customer.totalOrders} orders.`,
        `${Number((customer.refundRate * 100).toFixed(1))}% refund rate recorded.`,
      ],
    }));

  const automationReadiness =
    store.sharedFraudNetwork && highRiskCount >= 3
      ? "Ready for stricter shared-network automations"
      : store.sharedFraudNetwork
      ? "Collecting enough network evidence for automation"
      : "Enable shared network to unlock stronger automation coverage";

  return {
    summary: {
      sharedFraudNetworkEnabled: store.sharedFraudNetwork,
      networkMatches: networkMatches.length,
      wardrobingSuspects: wardrobingSignals.filter((item) => item.likely).length,
      highRiskOrders: highRiskCount,
      manualReviewCount,
      returnAbuseProfiles: returnAbuseCount,
      automationReadiness,
      chargebackCandidates: chargebackCandidates.length,
    },
    automationRules: [
      {
        id: "block_repeated_high_risk",
        title: "Auto-block repeat high-risk fingerprints",
        status:
          store.sharedFraudNetwork && networkMatches.some((item) => item.repeatSignals >= 3)
            ? "Ready"
            : "Warm-up",
        detail:
          "Promote repeated shared-network matches into an automated block or manual-review rule once the pattern is stable.",
      },
      {
        id: "wardrobe_refund_gate",
        title: "Route likely wardrobing profiles into refund review",
        status:
          wardrobingSignals.some((item) => item.likely) ? "Ready" : "Monitor",
        detail:
          "Use wardrobing scores to require manual review before granting policy exceptions on repeat returners.",
      },
    ],
    networkMatches,
    wardrobingSignals,
    chargebackCandidates,
    returnAbuseSignals,
    scoreBands: {
      low: "0-30",
      medium: "31-70",
      high: "71-100",
    },
  };
}

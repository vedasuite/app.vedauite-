import { prisma } from "../db/prismaClient";
import { maskCustomerIdentity } from "../lib/maskCustomerIdentity";

function classifyCredit(score: number): string {
  if (score >= 80) return "Trusted Buyer";
  if (score >= 50) return "Normal Buyer";
  return "Risky Buyer";
}

function mapCustomer(customer: {
  id: string;
  email: string | null;
  totalOrders: number;
  totalRefunds: number;
  refundRate: number;
  fraudSignalsCount: number;
  paymentReliability: number;
  creditScore: number;
  creditCategory: string;
  shopifyCustomerId?: string | null;
}) {
  const refundRatePercent = Number((customer.refundRate * 100).toFixed(1));
  const orderCompletionRate =
    customer.totalOrders === 0
      ? 0
      : Number(
          (
            ((customer.totalOrders - customer.totalRefunds) / customer.totalOrders) *
            100
          ).toFixed(1)
        );

  const reasons: string[] = [];
  if (refundRatePercent >= 35) {
    reasons.push("Refund behavior is materially above the store baseline.");
  }
  if (customer.fraudSignalsCount >= 2) {
    reasons.push("Fraud signal count is elevated for this shopper.");
  }
  if (customer.paymentReliability <= 10) {
    reasons.push("Payment reliability is weak and needs closer review.");
  }
  if (orderCompletionRate >= 90 && customer.creditScore >= 80) {
    reasons.push("Order completion is strong, supporting fast-lane handling.");
  }
  if (reasons.length === 0) {
    reasons.push("Current shopper behavior remains within normal trust thresholds.");
  }

  return {
    id: customer.id,
    email: maskCustomerIdentity(customer.email, `shopper-${customer.id.slice(-4)}`),
    shopifyCustomerId: customer.shopifyCustomerId ?? null,
    totalOrders: customer.totalOrders,
    totalRefunds: customer.totalRefunds,
    refundRate: customer.refundRate,
    fraudSignalsCount: customer.fraudSignalsCount,
    paymentReliability: customer.paymentReliability,
    creditScore: customer.creditScore,
    creditCategory: customer.creditCategory,
    orderCompletionRate,
    confidence: Math.max(
      42,
      Math.min(
        96,
        Math.round(
          customer.creditScore * 0.6 +
            Math.min(18, customer.totalOrders * 2) -
            customer.fraudSignalsCount * 3
        )
      )
    ),
    automationPosture:
      customer.creditScore >= 80
        ? "Eligible for trusted-buyer fast-lane"
        : customer.creditScore < 50
        ? "Route into review-first trust controls"
        : "Use standard handling with monitoring",
    reasons,
  };
}

export async function listCustomerScores(shopDomain: string) {
  const store = await prisma.store.findUnique({
    where: { shop: shopDomain },
  });
  if (!store) throw new Error("Store not found");

  const customers = await prisma.customer.findMany({
    where: { storeId: store.id },
    orderBy: { updatedAt: "desc" },
    take: 100,
  });
  return customers.map(mapCustomer);
}

export async function getCustomerScore(shopDomain: string, customerId: string) {
  const store = await prisma.store.findUnique({
    where: { shop: shopDomain },
  });
  if (!store) throw new Error("Store not found");

  const customer = await prisma.customer.findFirst({
    where: { id: customerId, storeId: store.id },
  });
  if (!customer) throw new Error("Customer not found");

  return mapCustomer(customer);
}

export async function recomputeCustomerScore(customerId: string) {
  const customer = await prisma.customer.findUnique({
    where: { id: customerId },
  });
  if (!customer) throw new Error("Customer not found");

  const base = 70;
  const refundPenalty = Math.min(40, customer.refundRate * 100);
  const fraudPenalty = Math.min(30, customer.fraudSignalsCount * 5);
  const paymentBonus = Math.min(20, customer.paymentReliability);

  let score = base - refundPenalty - fraudPenalty + paymentBonus;
  score = Math.max(0, Math.min(100, Math.round(score)));

  const category = classifyCredit(score);

  const updated = await prisma.customer.update({
    where: { id: customerId },
    data: { creditScore: score, creditCategory: category },
  });

  return mapCustomer(updated);
}

export async function getTrustOperatingLayer(shopDomain: string) {
  const store = await prisma.store.findUnique({
    where: { shop: shopDomain },
  });
  if (!store) throw new Error("Store not found");

  const customers = await prisma.customer.findMany({
    where: { storeId: store.id },
    orderBy: [{ creditScore: "asc" }, { refundRate: "desc" }],
    take: 100,
  });

  const mappedCustomers = customers.map(mapCustomer);
  const segments = {
    trusted: mappedCustomers.filter((customer) => customer.creditScore >= 80).length,
    normal: mappedCustomers.filter(
      (customer) => customer.creditScore >= 50 && customer.creditScore < 80
    ).length,
    risky: mappedCustomers.filter((customer) => customer.creditScore < 50).length,
  };

  const policyRecommendations = [
    {
      id: "trusted_fast_lane",
      title: "Trusted buyer fast-lane",
      audience: "Trusted buyers (80-100)",
      recommendation:
        "Offer lower-friction post-purchase support and prioritize fulfillment confidence.",
      operationalAction: "Use trusted buyers as the lowest-friction service segment.",
      automationMode: "Low-touch automation",
      confidence: 86,
    },
    {
      id: "normal_watch",
      title: "Normal buyer watch layer",
      audience: "Normal buyers (50-79)",
      recommendation:
        "Maintain standard refund handling while monitoring for rising refund or fraud patterns.",
      operationalAction: "Escalate only when fraud signals or refund frequency increase.",
      automationMode: "Advisory automation",
      confidence: 71,
    },
    {
      id: "risky_controls",
      title: "Risky buyer controls",
      audience: "Risky buyers (0-49)",
      recommendation:
        "Pair refund decisions with fraud review and consider tighter verification before fulfillment.",
      operationalAction: "Route risky buyers into fraud review before policy exceptions.",
      automationMode: "Review-first automation",
      confidence: 91,
    },
  ];

  const priorityProfiles = mappedCustomers.slice(0, 5).map((customer) => ({
    id: customer.id,
    email: maskCustomerIdentity(customer.email, `shopper-${customer.id.slice(-4)}`),
    shopifyCustomerId: customer.shopifyCustomerId,
    creditScore: customer.creditScore,
    creditCategory: customer.creditCategory,
    refundRate: Number((customer.refundRate * 100).toFixed(1)),
    fraudSignalsCount: customer.fraudSignalsCount,
    paymentReliability: customer.paymentReliability,
    operationalTag:
      customer.creditScore < 50
        ? "Review before refund exception"
        : customer.creditScore >= 80
        ? "Trusted handling candidate"
        : "Standard monitoring",
    reasons: customer.reasons,
    confidence: customer.confidence,
    automationPosture: customer.automationPosture,
  }));

  const automationRules = [
    {
      id: "trusted_refund_fast_lane",
      title: "Trusted refund fast-lane",
      status: segments.trusted > 0 ? "Ready" : "Warm-up",
      detail:
        "Trusted buyers can bypass low-value refund escalations when fraud signals remain quiet.",
    },
    {
      id: "risky_exception_gate",
      title: "Risky shopper exception gate",
      status: segments.risky > 0 ? "Ready" : "Monitor",
      detail:
        "Require fraud review before approving manual refund or fulfillment exceptions for risky buyers.",
    },
  ];

  return {
    segments,
    policyRecommendations,
    priorityProfiles,
    automationRules,
  };
}

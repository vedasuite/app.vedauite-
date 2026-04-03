import { prisma } from "../db/prismaClient";

type DecisionItem = {
  id: string;
  title: string;
  module: string;
  severity: string;
  rationale: string;
  route: string;
  confidence: number;
  recommendedAction: string;
  explanationPoints: string[];
  automationPosture: string;
};

export async function getUnifiedDecisionCenter(shopDomain: string) {
  const store = await prisma.store.findUnique({
    where: { shop: shopDomain },
  });

  if (!store) {
    throw new Error("Store not found");
  }

  const [highRiskOrder, riskyCustomer, competitorSignal, pricingMove, profitMove] =
    await Promise.all([
      prisma.order.findFirst({
        where: { storeId: store.id },
        orderBy: [{ fraudScore: "desc" }, { createdAt: "desc" }],
      }),
      prisma.customer.findFirst({
        where: { storeId: store.id },
        orderBy: [{ creditScore: "asc" }, { refundRate: "desc" }],
      }),
      prisma.competitorData.findFirst({
        where: { storeId: store.id },
        orderBy: { collectedAt: "desc" },
      }),
      prisma.priceHistory.findFirst({
        where: { storeId: store.id },
        orderBy: { createdAt: "desc" },
      }),
      prisma.profitOptimizationData.findFirst({
        where: { storeId: store.id },
        orderBy: { projectedMonthlyProfit: "desc" },
      }),
    ]);

  const decisions: DecisionItem[] = [];

  if (highRiskOrder) {
    decisions.push({
      id: "fraud_order",
      title: `Review order ${highRiskOrder.shopifyOrderId}`,
      module: "Trust & Abuse",
      severity: highRiskOrder.fraudScore >= 71 ? "High" : "Medium",
      rationale: `Fraud score is ${highRiskOrder.fraudScore} with status ${highRiskOrder.status}.`,
      route: "/trust-abuse?focus=high-risk",
      confidence: Math.max(52, Math.min(97, highRiskOrder.fraudScore)),
      recommendedAction:
        highRiskOrder.fraudScore >= 85 ? "Block or send to review" : "Manual review",
      explanationPoints: [
        `Current fraud band is ${highRiskOrder.fraudRiskLevel}.`,
        `Order status is ${highRiskOrder.status}.`,
        "Use the fraud queue to confirm whether refund history and identity signals support the action.",
      ],
      automationPosture:
        highRiskOrder.fraudScore >= 85
          ? "Candidate for review-first fraud automation"
          : "Keep in analyst review until the pattern repeats",
    });
  }

  if (riskyCustomer) {
    decisions.push({
      id: "trust_customer",
      title: `Check shopper trust for ${riskyCustomer.email ?? "customer"}`,
      module: "Trust & Abuse",
      severity: riskyCustomer.creditScore < 50 ? "High" : "Medium",
      rationale: `Credit score is ${riskyCustomer.creditScore} with ${(riskyCustomer.refundRate * 100).toFixed(1)}% refund rate.`,
      route: "/trust-abuse?focus=timeline",
      confidence: Math.max(
        48,
        Math.min(
          94,
          100 - riskyCustomer.creditScore + Math.round(riskyCustomer.refundRate * 35)
        )
      ),
      recommendedAction:
        riskyCustomer.creditScore < 50
          ? "Apply risky-buyer trust controls"
          : "Monitor trust drift",
      explanationPoints: [
        `${riskyCustomer.totalRefunds} refunds recorded across ${riskyCustomer.totalOrders} orders.`,
        `${riskyCustomer.fraudSignalsCount} fraud signals tied to this shopper profile.`,
        "Use shopper trust to guide refund exceptions and support handling.",
      ],
      automationPosture:
        riskyCustomer.creditScore < 50
          ? "Eligible for trust-based exception gates"
          : "Advisory trust monitoring only",
    });
  }

  if (competitorSignal) {
    decisions.push({
      id: "competitor_signal",
      title: `Respond to ${competitorSignal.productHandle} market pressure`,
      module: "Competitor Intelligence",
      severity: competitorSignal.promotion ? "High" : "Medium",
      rationale: competitorSignal.promotion
        ? `Promotion detected from ${competitorSignal.competitorName}.`
        : `Recent competitor movement detected for ${competitorSignal.productHandle}.`,
      route: "/competitor?focus=strategy",
      confidence: competitorSignal.promotion ? 82 : 68,
      recommendedAction: competitorSignal.promotion
        ? "Run a competitor response play"
        : "Hold and monitor",
      explanationPoints: [
        `Source: ${competitorSignal.source}.`,
        competitorSignal.stockStatus
          ? `Stock posture is ${competitorSignal.stockStatus}.`
          : "No material stock-pressure signal yet.",
        "Compare the market move with current margin exposure before reacting.",
      ],
      automationPosture: competitorSignal.promotion
        ? "Ready for approval-led response automation"
        : "Advisory competitor watch mode",
    });
  }

  if (pricingMove) {
    decisions.push({
      id: "pricing_move",
      title: `Approve pricing on ${pricingMove.productHandle}`,
      module: "Pricing & Profit",
      severity:
        (pricingMove.expectedProfitGain ?? 0) >= 100 ? "High" : "Medium",
      rationale: `Recommended move from ${pricingMove.currentPrice.toFixed(2)} to ${pricingMove.recommendedPrice.toFixed(2)}.`,
      route: "/pricing-profit?focus=pricing",
      confidence: Math.max(
        56,
        Math.min(
          95,
          Math.round(
            62 +
              Math.min(18, pricingMove.expectedMarginDelta * 8) +
              Math.min(12, (pricingMove.expectedProfitGain ?? 0) / 15)
          )
        )
      ),
      recommendedAction: "Validate and publish price recommendation",
      explanationPoints: [
        `Expected margin delta is ${pricingMove.expectedMarginDelta.toFixed(1)} points.`,
        `Projected profit gain is $${(pricingMove.expectedProfitGain ?? 0).toFixed(2)}.`,
        "Use merchant approval before pushing the change into Shopify.",
      ],
      automationPosture: "Approval-led pricing automation",
    });
  }

  if (profitMove) {
    decisions.push({
      id: "profit_move",
      title: `Protect margin on ${profitMove.productHandle}`,
      module: "Pricing & Profit",
      severity:
        (profitMove.projectedMonthlyProfit ?? 0) >= 1000 ? "High" : "Medium",
      rationale: `Projected monthly profit gain is $${(profitMove.projectedMonthlyProfit ?? 0).toFixed(2)}.`,
      route: "/pricing-profit?focus=profit",
      confidence: Math.max(
        54,
        Math.min(
          94,
          60 + Math.round((profitMove.projectedMonthlyProfit ?? 0) / 70)
        )
      ),
      recommendedAction: "Review margin-defense playbook",
      explanationPoints: [
        `Projected margin increase is ${(profitMove.projectedMarginIncrease ?? 0).toFixed(1)} points.`,
        `Current selling price is $${profitMove.sellingPrice.toFixed(2)}.`,
        "Use profit guidance to decide whether to reprice, bundle, or defend premium SKUs.",
      ],
      automationPosture: "Merchant approval required for execution",
    });
  }

  return {
    summary: {
      activeModules: decisions.length,
      priorityLevel: decisions.some((decision) => decision.severity === "High")
        ? "High"
        : "Medium",
      automationReadiness: decisions.some((decision) =>
        decision.automationPosture.toLowerCase().includes("automation")
      )
        ? "Approval-led automation available"
        : "Advisory mode",
    },
    decisions,
  };
}

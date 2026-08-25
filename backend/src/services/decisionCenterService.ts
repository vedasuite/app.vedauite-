import { HttpError } from "../lib/httpError";
import {
  classifyMonetaryClaim,
  storedProfitValueIsObserved,
  NOT_ENOUGH_DATA,
} from "./evidenceEligibility";

/**
 * The SAME gate the Dashboard and Pricing use.
 *
 * Every money figure in this file derives from ProfitOptimizationData /
 * PriceHistory, whose cost and velocity inputs are assumptions that are then
 * persisted. Reading them back is not evidence, so the verdict is constant
 * here - and identical to what the other two surfaces compute.
 */
const PROFIT_CLAIM = classifyMonetaryClaim({
  salesVelocityObserved: storedProfitValueIsObserved(),
  productCostObserved: storedProfitValueIsObserved(),
});
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
    throw new HttpError(404, "Store not found.");
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
      // The order's real fraud score. A floor of 52 invented confidence for a
      // low-scoring order.
      confidence: Math.max(0, Math.min(100, highRiskOrder.fraudScore)),
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
      // No floor. The previous Math.max(48, ...) asserted 48% confidence for a
      // shopper with a perfect record and no refunds.
      confidence: Math.max(
        0,
        Math.min(
          100,
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
          : "Advisory trust review only",
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
      // Presence of a promotion is a fact; 82 and 68 were invented percentages.
      // Confidence is only asserted when a real price delta backs it.
      confidence: competitorSignal.price != null ? 100 : 0,
      recommendedAction: competitorSignal.promotion
        ? "Run a competitor response play"
        : "Hold current pricing",
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
      // Severity and confidence must not be driven by expectedProfitGain,
      // which is delta x salesVelocity(?? 8) x 6 - two assumptions and a
      // magic constant.
      severity: PROFIT_CLAIM.allowed
        ? (pricingMove.expectedProfitGain ?? 0) >= 100
          ? "High"
          : "Medium"
        : "Medium",
      // An exact target implies an analysis behind it. Without evidence this
      // states the direction only, matching the Pricing card's behaviour.
      rationale: PROFIT_CLAIM.allowed
        ? `Recommended move from $${pricingMove.currentPrice.toFixed(2)} to $${pricingMove.recommendedPrice.toFixed(2)}.`
        : `Current price is $${pricingMove.currentPrice.toFixed(2)}. ${
            pricingMove.recommendedPrice > pricingMove.currentPrice
              ? "There may be room to increase it"
              : "It may be above the market"
          }, but VedaSuite cannot recommend a specific price yet.`,
      route: "/pricing-profit?focus=pricing",
      confidence: !PROFIT_CLAIM.allowed
        ? 0
        : Math.max(
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
        // expectedProfitGain = delta x salesVelocity(?? 8) x 6. Both factors are
        // assumptions, so this may not be stated as money. Same shared gate as
        // the Dashboard and Pricing use, so all three agree.
        PROFIT_CLAIM.allowed
          ? `Projected profit gain is $${(pricingMove.expectedProfitGain ?? 0).toFixed(2)}.`
          : `Projected profit gain: ${NOT_ENOUGH_DATA}. ${PROFIT_CLAIM.explanation}`,
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
      // Severity must not be driven by a fabricated figure either.
      severity: PROFIT_CLAIM.allowed
        ? (profitMove.projectedMonthlyProfit ?? 0) >= 1000
          ? "High"
          : "Medium"
        : "Medium",
      rationale: PROFIT_CLAIM.allowed
        ? `Projected monthly profit gain is $${(profitMove.projectedMonthlyProfit ?? 0).toFixed(2)}.`
        : `This product may be worth repricing, but VedaSuite cannot size the gain yet. ${PROFIT_CLAIM.explanation}`,
      route: "/pricing-profit?focus=profit",
      // A confidence derived from a fabricated projection is itself fabricated.
      confidence: !PROFIT_CLAIM.allowed
        ? 0
        : Math.max(
        54,
        Math.min(
          94,
          60 + Math.round((profitMove.projectedMonthlyProfit ?? 0) / 70)
        )
      ),
      recommendedAction: "Review margin-defense playbook",
      explanationPoints: [
        PROFIT_CLAIM.allowed
          ? `Projected margin increase is ${(profitMove.projectedMarginIncrease ?? 0).toFixed(1)} points.`
          : PROFIT_CLAIM.explanation,
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

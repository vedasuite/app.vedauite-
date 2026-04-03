import { getTrustOperatingLayer, listCustomerScores } from "./creditScoreService";
import {
  getFraudIntelligenceOverview,
  listRecentFraudOrders,
} from "./fraudService";
import { getCurrentSubscription } from "./subscriptionService";

function maskIdentity(value: string | null | undefined, fallback: string) {
  if (!value) {
    return fallback;
  }

  const [name] = value.split("@");
  if (value.includes("@")) {
    const visible = name.slice(0, 2);
    return `${visible}***`;
  }

  return `${value.slice(0, 3)}***`;
}

export async function getTrustAbuseOverview(shopDomain: string) {
  const [subscription, fraudOverview, trustLayer, recentOrders, customers] =
    await Promise.all([
      getCurrentSubscription(shopDomain),
      getFraudIntelligenceOverview(shopDomain),
      getTrustOperatingLayer(shopDomain),
      listRecentFraudOrders(shopDomain),
      listCustomerScores(shopDomain),
    ]);

  const queue = recentOrders.slice(0, 6).map((order) => ({
    id: order.id,
    shopifyOrderId: order.shopifyOrderId,
    riskScore: order.fraudScore,
    riskLevel: order.fraudRiskLevel,
    status: order.status,
    refundRequested: order.refundRequested,
    createdAt: order.createdAt,
  }));

  const behaviorTimeline = customers.slice(0, 6).map((customer) => ({
    id: customer.id,
    shopper: maskIdentity(customer.email, `shopper-${customer.id.slice(-4)}`),
    trustScore: customer.creditScore,
    tier: customer.creditCategory,
    refundRate: Number((customer.refundRate * 100).toFixed(1)),
    eventSummary:
      customer.creditScore >= 80
        ? "Trusted handling history with low refund pressure."
        : customer.creditScore < 50
        ? "Escalating trust concerns from refund and fraud signals."
        : "Normal trust posture with moderate monitoring.",
  }));

  const trustTierSummary = [
    {
      tier: "Trusted",
      count: trustLayer.segments.trusted,
      policy: "Low-friction support and faster exception handling.",
    },
    {
      tier: "Standard",
      count: trustLayer.segments.normal,
      policy: "Normal monitoring with policy recommendations.",
    },
    {
      tier: "Review",
      count: trustLayer.segments.risky,
      policy: "Require manual review before policy exceptions.",
    },
  ];

  const highestRiskOrder = queue[0] ?? null;
  const likelyRefundChannel =
    trustLayer.segments.risky > trustLayer.segments.trusted
      ? "Manual review before refund"
      : trustLayer.segments.trusted >= trustLayer.segments.risky
      ? "Instant refund or exchange"
      : "Store credit with support review";

  const trustRecoveryActions = [
    {
      title: "Rebuild medium-trust shoppers with exchange-first policy",
      detail:
        "Guide borderline shoppers toward exchanges or store credit before full cash refunds when return-abuse pressure is rising.",
      eligibleProfiles: trustLayer.segments.normal,
      priority:
        trustLayer.segments.normal >= 3 ? "High opportunity" : "Monitor",
    },
    {
      title: "Protect the high-trust lane",
      detail:
        "Keep the best shoppers in a low-friction support flow so the trust score remains a merchant advantage.",
      eligibleProfiles: trustLayer.segments.trusted,
      priority:
        trustLayer.segments.trusted > 0 ? "Operationalize now" : "Seed more data",
    },
    {
      title: "Escalate repeat abuse patterns",
      detail:
        "Customers with refund-heavy histories or repeat fraud signals should be routed into manual review until trust recovers.",
      eligibleProfiles: trustLayer.segments.risky,
      priority:
        trustLayer.segments.risky > 0 ? "Requires workflow" : "No current pressure",
    },
  ];

  const smartPolicyRecommendations = [
    {
      name: "Trusted fast lane",
      description:
        "Auto-approve standard refund and exchange requests for trusted shoppers with low abuse indicators.",
      appliesTo: "Trust score 80+",
      action: "Instant refund or exchange",
    },
    {
      name: "Store-credit protection",
      description:
        "Route medium-trust shoppers with rising refund frequency toward store credit or exchange-first handling.",
      appliesTo: "Trust score 50-79 or refund pressure above baseline",
      action: "Offer store credit before cash refund",
    },
    {
      name: "Manual review escalation",
      description:
        "Hold refund and exception requests when return-abuse and fraud signals stack together.",
      appliesTo: "Trust score below 50 or repeated risk events",
      action: "Escalate to fraud/support review queue",
    },
  ];

  return {
    subscription,
    summary: {
      shopperTrustProfiles: customers.length,
      returnAbuseProfiles: fraudOverview.summary.returnAbuseProfiles,
      highRiskOrders: fraudOverview.summary.highRiskOrders,
      manualReviewCount: fraudOverview.summary.manualReviewCount,
      sharedFraudNetworkEnabled: fraudOverview.summary.sharedFraudNetworkEnabled,
      automationReadiness: fraudOverview.summary.automationReadiness,
    },
    scoreBands: fraudOverview.scoreBands,
    trustTierSummary,
    fraudReviewQueue: queue,
    returnAbuseSignals: fraudOverview.returnAbuseSignals,
    wardrobingSignals: fraudOverview.wardrobingSignals,
    networkMatches: fraudOverview.networkMatches,
    chargebackCandidates: fraudOverview.chargebackCandidates,
    policyEngine: trustLayer.policyRecommendations,
    refundOutcomeSimulator: {
      likelyChannel: likelyRefundChannel,
      merchantOutcome:
        highestRiskOrder && highestRiskOrder.refundRequested
          ? "A refund-heavy order is currently better handled with review or store credit."
          : "Fast trust-aware outcomes are available for low-risk shoppers.",
      recoveryRate:
        trustLayer.segments.trusted > 0
          ? "Highest recovery on exchange and store-credit offers for medium-risk shoppers."
          : "Collect more shopper history to personalize refund outcomes.",
      recommendedAction:
        highestRiskOrder?.riskLevel === "High"
          ? "Hold and review the current high-risk order before allowing a refund exception."
          : "Use trust tiers to route refunds automatically when possible.",
    },
    smartPolicyRecommendations,
    trustRecoveryActions,
    supportCopilot: {
      status: subscription.featureAccess.supportCopilot ? "active" : "restricted",
      playbooks: [
        "Recommend refund, store-credit, or manual review based on trust tier.",
        "Summarize the behavior timeline before a CX agent responds.",
        "Flag policy exceptions when return-abuse signals are rising.",
      ],
    },
    evidencePack: {
      status: subscription.featureAccess.evidencePackExport ? "ready" : "preview",
      exports: [
        "Order-level risk explanation",
        "Refund and abuse timeline",
        "Stored fraud-signal summary",
      ],
    },
    behaviorTimeline,
  };
}

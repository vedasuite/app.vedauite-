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

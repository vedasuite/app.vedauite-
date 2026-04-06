import { getTrustOperatingLayer, listCustomerScores } from "./creditScoreService";
import {
  getFraudIntelligenceOverview,
  listRecentFraudOrders,
} from "./fraudService";
import { prisma } from "../db/prismaClient";
import { getCurrentSubscription } from "./subscriptionService";
import {
  deriveModuleReadiness,
  deriveSyncStatus,
  getStoreOperationalSnapshot,
} from "./storeOperationalStateService";

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
  const [
    subscription,
    fraudOverview,
    trustLayer,
    recentOrders,
    customers,
    store,
    operational,
  ] =
    await Promise.all([
      getCurrentSubscription(shopDomain),
      getFraudIntelligenceOverview(shopDomain),
      getTrustOperatingLayer(shopDomain),
      listRecentFraudOrders(shopDomain),
      listCustomerScores(shopDomain),
      prisma.store.findUnique({
        where: { shop: shopDomain },
        select: {
          id: true,
          timelineEvents: {
            orderBy: { createdAt: "desc" },
            take: 24,
          },
        },
      }),
      getStoreOperationalSnapshot(shopDomain),
    ]);

  if (!store) {
    throw new Error("Store not found");
  }

  const queue = recentOrders.slice(0, 6).map((order) => ({
    id: order.id,
    shopifyOrderId: order.shopifyOrderId,
    riskScore: order.fraudScore,
    riskLevel: order.fraudRiskLevel,
    status: order.status,
    refundRequested: order.refundRequested,
    createdAt: order.createdAt,
  }));

  const behaviorTimeline =
    store.timelineEvents.length > 0
      ? store.timelineEvents.slice(0, 10).map((event) => {
          const metadata = (() => {
            if (!event.metadataJson) {
              return {};
            }
            try {
              return JSON.parse(event.metadataJson) as Record<string, unknown>;
            } catch {
              return {};
            }
          })();

          return {
            id: event.id,
            shopper:
              typeof metadata.customerEmail === "string"
                ? maskIdentity(metadata.customerEmail, `shopper-${(event.customerId ?? event.id).slice(-4)}`)
                : event.customerId
                ? `shopper-${event.customerId.slice(-4)}`
                : "Store-level signal",
            trustScore:
              typeof metadata.score === "number"
                ? metadata.score
                : typeof event.scoreImpact === "number"
                ? Math.max(0, Math.min(100, 60 + event.scoreImpact))
                : 60,
            tier:
              typeof metadata.category === "string"
                ? metadata.category
                : event.severity === "critical"
                ? "Review Buyer"
                : event.severity === "success"
                ? "Trusted Buyer"
                : "Standard Buyer",
            refundRate:
              typeof metadata.refundRate === "number"
                ? Number((metadata.refundRate * 100).toFixed(1))
                : 0,
            eventSummary: event.detail,
            occurredAt: event.createdAt,
          };
        })
      : customers.slice(0, 6).map((customer) => ({
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
          occurredAt: null,
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

  const refundOutcomeOptions = [
    {
      channel: "Instant refund",
      marginImpact:
        trustLayer.segments.trusted > trustLayer.segments.risky
          ? "Lower retention, fastest resolution"
          : "Use selectively for the highest-trust lane",
      confidence:
        trustLayer.segments.trusted > 0 ? "High for trusted buyers" : "Needs more history",
      recommendedWhen: "High trust, low abuse, low fraud pressure",
    },
    {
      channel: "Store credit",
      marginImpact: "Best margin protection while preserving recovery potential",
      confidence:
        trustLayer.segments.normal > 0 ? "Strong for medium-trust profiles" : "Requires more mixed trust traffic",
      recommendedWhen: "Medium trust or rising refund frequency",
    },
    {
      channel: "Exchange",
      marginImpact: "Protects revenue and retains the order value",
      confidence:
        queue.some((order) => !order.refundRequested)
          ? "Best when order-quality friction is moderate"
          : "Use when support can redirect to replacement",
      recommendedWhen: "Low fraud pressure with product-fit issues",
    },
  ];

  const supportCopilotCases = [
    highestRiskOrder
      ? {
          title: `Handle ${highestRiskOrder.shopifyOrderId}`,
          reason:
            highestRiskOrder.riskLevel === "High"
              ? "High fraud score plus refund pressure suggests review-first handling."
              : "Manual review can confirm the next safest merchant action.",
          recommendedHandling:
            highestRiskOrder.riskLevel === "High"
              ? "Pause refund, review signals, offer store credit only after confirmation."
              : "Use trust-aware handling and document reasons before support responds.",
        }
      : null,
    behaviorTimeline[0]
      ? {
          title: `Coach support on ${behaviorTimeline[0].shopper}`,
          reason: behaviorTimeline[0].eventSummary,
          recommendedHandling:
            behaviorTimeline[0].trustScore >= 80
              ? "Use low-friction handling and preserve the trusted buyer experience."
              : behaviorTimeline[0].trustScore < 50
              ? "Move into manual review and request more context before exceptions."
              : "Offer exchange or store credit first and monitor repeat behavior.",
        }
      : null,
  ].filter(Boolean) as Array<{
    title: string;
    reason: string;
    recommendedHandling: string;
  }>;

  const evidencePackTemplates = [
    {
      title: "Refund decision pack",
      detail: "Timeline, trust reasons, and order behavior summary for support review.",
    },
    {
      title: "Chargeback support pack",
      detail: "Order risk rationale, payment behavior, and refund posture snapshot.",
    },
    {
      title: "Return abuse evidence pack",
      detail: "Refund-rate summary, repeat pattern indicators, and policy recommendation trail.",
    },
  ];

  const syncState = deriveSyncStatus({
    connectionStatus: operational.store.lastConnectionStatus,
    latestSyncJobStatus: operational.latestSyncJob?.status ?? null,
    lastSyncStatus: operational.store.lastSyncStatus,
    products: operational.counts.products,
    orders: operational.counts.orders,
    customers: operational.counts.customers,
    priceRows: operational.counts.pricingRows,
    profitRows: operational.counts.profitRows,
    timelineEvents: operational.counts.timelineEvents,
  });
  const readiness = deriveModuleReadiness({
    syncStatus: syncState.status,
    rawCount: operational.counts.orders + operational.counts.customers,
    processedCount: operational.counts.timelineEvents,
    lastUpdatedAt: operational.latestProcessingAt,
    failureReason: operational.store.lastConnectionError,
  });

  return {
    subscription,
    readiness,
    summary: {
      shopperTrustProfiles: customers.length,
      returnAbuseProfiles: fraudOverview.summary.returnAbuseProfiles,
      highRiskOrders: fraudOverview.summary.highRiskOrders,
      manualReviewCount: fraudOverview.summary.manualReviewCount,
      sharedFraudNetworkEnabled: fraudOverview.summary.sharedFraudNetworkEnabled,
      automationReadiness: fraudOverview.summary.automationReadiness,
      timelineEvents: store.timelineEvents.length,
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
      options: refundOutcomeOptions,
    },
    smartPolicyRecommendations,
    trustRecoveryActions,
    automationRules: [
      ...trustLayer.automationRules,
      ...fraudOverview.automationRules,
    ],
    supportCopilot: {
      status: subscription.featureAccess.supportCopilot ? "active" : "restricted",
      playbooks: [
        "Recommend refund, store-credit, or manual review based on trust tier.",
        "Summarize the behavior timeline before a CX agent responds.",
        "Flag policy exceptions when return-abuse signals are rising.",
      ],
      cases: supportCopilotCases,
    },
    evidencePack: {
      status: subscription.featureAccess.evidencePackExport ? "ready" : "preview",
      exports: [
        "Order-level risk explanation",
        "Refund and abuse timeline",
        "Stored fraud-signal summary",
      ],
      templates: evidencePackTemplates,
    },
    behaviorTimeline,
  };
}

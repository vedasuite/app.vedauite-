import type { UnifiedModuleState } from "./unifiedModuleStateService";

export type PricingEngineViewStatus =
  | "syncing"
  | "empty_no_data"
  | "ready"
  | "failed_timeout"
  | "failed_error";

export type PricingEngineViewState = {
  status: PricingEngineViewStatus;
  title: string;
  description: string;
  nextAction: string | null;
  emptyReason:
    | "no_catalog_data"
    | "no_sales_history"
    | "no_competitor_input"
    | "no_recommendations"
    | null;
  processingSummary: {
    catalogProducts: number;
    salesOrders: number;
    competitorInputs: number;
    pricingRows: number;
    profitRows: number;
    recommendations: number;
  };
  timedOutSources: string[];
  invalidRecommendationCount: number;
  lastSuccessfulRunAt: string | null;
};

export function derivePricingEngineViewState(input: {
  syncStatus: string;
  moduleState: UnifiedModuleState;
  productsCount: number;
  ordersCount: number;
  competitorCount: number;
  pricingRows: number;
  profitRows: number;
  recommendationCount: number;
  invalidRecommendationCount: number;
  timedOutSources: string[];
}) : PricingEngineViewState {
  const processingSummary = {
    catalogProducts: input.productsCount,
    salesOrders: input.ordersCount,
    competitorInputs: input.competitorCount,
    pricingRows: input.pricingRows,
    profitRows: input.profitRows,
    recommendations: input.recommendationCount,
  };

  if (
    input.timedOutSources.length > 0
  ) {
    return {
      status: "failed_timeout",
      title: "Pricing data took too long to load",
      description:
        "VedaSuite could not finish loading pricing data in time. Try again in a moment.",
      nextAction: "Retry pricing refresh",
      emptyReason: null,
      processingSummary,
      timedOutSources: input.timedOutSources,
      invalidRecommendationCount: input.invalidRecommendationCount,
      lastSuccessfulRunAt: input.moduleState.lastSuccessfulSyncAt,
    };
  }

  if (
    input.moduleState.syncStatus === "failed" ||
    input.moduleState.dataStatus === "failed" ||
    (input.invalidRecommendationCount > 0 && input.recommendationCount === 0)
  ) {
    return {
      status: "failed_error",
      title:
        input.invalidRecommendationCount > 0
          ? "Pricing recommendations need repair"
          : "Pricing data needs attention",
      description:
        input.invalidRecommendationCount > 0
          ? "Stored pricing recommendations could not be read safely. Run a fresh sync to rebuild them."
          : input.moduleState.description,
      nextAction: "Retry pricing refresh",
      emptyReason: null,
      processingSummary,
      timedOutSources: input.timedOutSources,
      invalidRecommendationCount: input.invalidRecommendationCount,
      lastSuccessfulRunAt: input.moduleState.lastSuccessfulSyncAt,
    };
  }

  if (
    input.syncStatus === "SYNC_IN_PROGRESS" ||
    input.syncStatus === "SYNC_COMPLETED_PROCESSING_PENDING" ||
    input.moduleState.syncStatus === "running" ||
    input.moduleState.dataStatus === "processing"
  ) {
    return {
      status: "syncing",
      title: "Pricing insights are being prepared",
      description:
        "VedaSuite is gathering pricing insights from the latest store activity.",
      nextAction: "Check again shortly",
      emptyReason: null,
      processingSummary,
      timedOutSources: input.timedOutSources,
      invalidRecommendationCount: input.invalidRecommendationCount,
      lastSuccessfulRunAt: input.moduleState.lastSuccessfulSyncAt,
    };
  }

  if (
    input.syncStatus === "SYNC_REQUIRED" ||
    (input.productsCount === 0 &&
      input.ordersCount === 0 &&
      input.pricingRows === 0 &&
      input.profitRows === 0)
  ) {
    return {
      status: "empty_no_data",
      title: "No products or orders to analyse yet",
      description:
        "VedaSuite checked your catalog and order history and found neither. Pricing and product profit are calculated per product from its price, its cost and how it actually sells, so all three need data before anything can be recommended.",
      nextAction: "Update store insights",
      emptyReason: "no_catalog_data",
      processingSummary,
      timedOutSources: input.timedOutSources,
      invalidRecommendationCount: input.invalidRecommendationCount,
      lastSuccessfulRunAt: input.moduleState.lastSuccessfulSyncAt,
    };
  }

  if (input.productsCount === 0) {
    return {
      status: "empty_no_data",
      title: "No products synced yet",
      description:
        "VedaSuite has order activity but no Shopify products. A pricing recommendation is always about a specific product, so the catalog has to sync first.",
      nextAction: "Update product insights",
      emptyReason: "no_catalog_data",
      processingSummary,
      timedOutSources: input.timedOutSources,
      invalidRecommendationCount: input.invalidRecommendationCount,
      lastSuccessfulRunAt: input.moduleState.lastSuccessfulSyncAt,
    };
  }

  if (input.ordersCount === 0 && input.recommendationCount === 0) {
    return {
      status: "empty_no_data",
      title: "No order history to price against",
      description:
        "VedaSuite has your products but no orders yet. Without sales it cannot tell a price that is working from one that is not, so it will not guess at a change.",
      nextAction: "Sync again after more sales activity",
      emptyReason: "no_sales_history",
      processingSummary,
      timedOutSources: input.timedOutSources,
      invalidRecommendationCount: input.invalidRecommendationCount,
      lastSuccessfulRunAt: input.moduleState.lastSuccessfulSyncAt,
    };
  }

  if (input.recommendationCount > 0) {
    return {
      status: "ready",
      title: "Pricing recommendations are ready",
      description:
        input.competitorCount === 0
          ? "Baseline recommendations are ready. Review before applying."
          : "Pricing insights are ready from the latest store activity.",
      nextAction: "Review recommendations",
      emptyReason: null,
      processingSummary,
      timedOutSources: input.timedOutSources,
      invalidRecommendationCount: input.invalidRecommendationCount,
      lastSuccessfulRunAt: input.moduleState.lastSuccessfulSyncAt,
    };
  }

  if (input.competitorCount === 0) {
    return {
      status: "empty_no_data",
      title: "No market comparison available",
      description:
        "Pricing here is based on your own product economics only. Add a competitor domain in Market Signals if you want your prices compared against the market as well.",
      nextAction: "Add competitor websites",
      emptyReason: "no_competitor_input",
      processingSummary,
      timedOutSources: input.timedOutSources,
      invalidRecommendationCount: input.invalidRecommendationCount,
      lastSuccessfulRunAt: input.moduleState.lastSuccessfulSyncAt,
    };
  }

  return {
    status: "empty_no_data",
    title: "Analysed, but nothing met the evidence bar",
    description:
      "VedaSuite analysed your products and orders and found no price change it could defend. Exact targets and monetary gains need observed product cost and how many units each product actually sells; Shopify sends neither, so they stay unstated rather than estimated.",
    nextAction: "Add product cost to unlock margin impact",
    emptyReason: "no_recommendations",
    processingSummary,
    timedOutSources: input.timedOutSources,
    invalidRecommendationCount: input.invalidRecommendationCount,
    lastSuccessfulRunAt: input.moduleState.lastSuccessfulSyncAt,
  };
}

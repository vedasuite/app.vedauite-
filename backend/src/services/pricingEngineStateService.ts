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
      title: "Pricing data is still syncing",
      description:
        "VedaSuite is still processing store data before it can publish a usable pricing view.",
      nextAction: "Wait for processing to finish",
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
      title: "Pricing data has not been prepared yet",
      description:
        "Run the first Shopify sync so VedaSuite can load catalog data and start building pricing recommendations.",
      nextAction: "Run live sync",
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
      title: "No catalog data is available yet",
      description:
        "VedaSuite needs synced Shopify products before it can analyze pricing opportunities.",
      nextAction: "Sync products",
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
      title: "More sales history is needed",
      description:
        "VedaSuite has product data, but it needs order history before it can make useful pricing recommendations.",
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
          ? "Baseline pricing recommendations are ready. Competitor-informed comparisons will improve after competitor data is synced."
          : "Pricing recommendations are ready from the latest synced store data.",
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
      title: "No competitor input is available yet",
      description:
        "Pricing baselines are loaded, but competitor-informed pricing is not available until competitor monitoring collects data.",
      nextAction: "Set up competitor monitoring",
      emptyReason: "no_competitor_input",
      processingSummary,
      timedOutSources: input.timedOutSources,
      invalidRecommendationCount: input.invalidRecommendationCount,
      lastSuccessfulRunAt: input.moduleState.lastSuccessfulSyncAt,
    };
  }

  return {
    status: "empty_no_data",
    title: "No pricing recommendations yet",
    description:
      "VedaSuite processed the latest data, but the pricing engine did not find strong recommendations to publish right now.",
    nextAction: "Refresh after the next sync",
    emptyReason: "no_recommendations",
    processingSummary,
    timedOutSources: input.timedOutSources,
    invalidRecommendationCount: input.invalidRecommendationCount,
    lastSuccessfulRunAt: input.moduleState.lastSuccessfulSyncAt,
  };
}

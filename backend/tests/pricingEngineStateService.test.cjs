const test = require("node:test");
const assert = require("node:assert/strict");

const {
  derivePricingEngineViewState,
} = require("../dist/services/pricingEngineStateService.js");

function baseModuleState(overrides = {}) {
  return {
    setupStatus: "complete",
    syncStatus: "completed",
    dataStatus: "ready",
    lastSuccessfulSyncAt: "2026-04-14T10:00:00.000Z",
    lastAttemptAt: "2026-04-14T10:00:00.000Z",
    dataChanged: true,
    coverage: "full",
    dependencies: {
      competitor: "ready",
      pricing: "ready",
      fraud: "ready",
    },
    title: "Pricing data is ready",
    description: "Pricing data is ready.",
    nextAction: "Review recommendations",
    ...overrides,
  };
}

function derive(overrides = {}) {
  return derivePricingEngineViewState({
    syncStatus: "READY_WITH_DATA",
    moduleState: baseModuleState(),
    productsCount: 10,
    ordersCount: 5,
    competitorCount: 3,
    pricingRows: 12,
    profitRows: 4,
    recommendationCount: 4,
    invalidRecommendationCount: 0,
    timedOutSources: [],
    ...overrides,
  });
}

test("no catalog data stays empty with explicit reason", () => {
  const state = derive({
    syncStatus: "SYNC_REQUIRED",
    productsCount: 0,
    ordersCount: 0,
    pricingRows: 0,
    profitRows: 0,
    recommendationCount: 0,
    competitorCount: 0,
    moduleState: baseModuleState({
      setupStatus: "incomplete",
      syncStatus: "idle",
      dataStatus: "empty",
    }),
  });

  assert.equal(state.status, "initializing");
  assert.match(state.description, /first Shopify sync/i);
});

test("no sales history produces a usable empty state", () => {
  const state = derive({
    ordersCount: 0,
    recommendationCount: 0,
  });

  assert.equal(state.status, "empty");
  assert.equal(state.emptyReason, "no_sales_history");
});

test("no competitor input becomes explicit empty state when no recommendations are ready", () => {
  const state = derive({
    competitorCount: 0,
    recommendationCount: 0,
  });

  assert.equal(state.status, "empty");
  assert.equal(state.emptyReason, "no_competitor_input");
});

test("async job still processing becomes syncing_data", () => {
  const state = derive({
    syncStatus: "SYNC_COMPLETED_PROCESSING_PENDING",
    recommendationCount: 0,
    moduleState: baseModuleState({
      syncStatus: "running",
      dataStatus: "processing",
      title: "Pricing data is updating",
    }),
  });

  assert.equal(state.status, "syncing_data");
});

test("recommendations available resolves ready", () => {
  const state = derive({
    recommendationCount: 3,
  });

  assert.equal(state.status, "ready");
});

test("backend timeout resolves failed", () => {
  const state = derive({
    recommendationCount: 0,
    timedOutSources: ["pricing_recommendations"],
  });

  assert.equal(state.status, "failed");
  assert.match(state.title, /too long/i);
});

test("malformed recommendation payload resolves failed", () => {
  const state = derive({
    recommendationCount: 0,
    invalidRecommendationCount: 2,
  });

  assert.equal(state.status, "failed");
  assert.match(state.description, /could not be read safely/i);
});

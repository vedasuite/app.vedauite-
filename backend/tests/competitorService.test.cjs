const test = require("node:test");
const assert = require("node:assert/strict");

const {
  filterCompetitorSourceProducts,
  deriveCompetitorPrimaryState,
} = require("../dist/services/competitorService.js");

test("filterCompetitorSourceProducts excludes archived, draft, gift-card-like, and price-missing products", () => {
  const result = filterCompetitorSourceProducts([
    { productHandle: "active-shirt", title: "Active Shirt", status: "active", currentPrice: 29 },
    { productHandle: "draft-shirt", title: "Draft Shirt", status: "draft", currentPrice: 25 },
    { productHandle: "archived-shirt", title: "Archived Shirt", status: "archived", currentPrice: 19 },
    { productHandle: "gift-card", title: "Gift Card", status: "active", currentPrice: 50 },
    { productHandle: "missing-price", title: "Price Missing", status: "active", currentPrice: null },
  ]);

  assert.equal(result.eligible.length, 1);
  assert.equal(result.eligible[0].productHandle, "active-shirt");
  assert.equal(result.excluded.archived, 1);
  assert.equal(result.excluded.draft, 1);
  assert.equal(result.excluded.giftCardLike, 1);
  assert.equal(result.excluded.missingPrice, 1);
});

test("deriveCompetitorPrimaryState returns setup incomplete when no domains are configured", () => {
  const state = deriveCompetitorPrimaryState({
    hasDomains: false,
    syncStatusLabel: "NOT_STARTED",
    lastSuccessfulRunAt: null,
    freshnessHours: null,
    validMatchedProductsCount: 0,
    lowConfidenceProductsCount: 0,
    changesDetected: false,
  });

  assert.equal(state, "SETUP_INCOMPLETE");
});

test("deriveCompetitorPrimaryState returns awaiting first run before the first success", () => {
  const state = deriveCompetitorPrimaryState({
    hasDomains: true,
    syncStatusLabel: "SUCCEEDED_NO_DATA",
    lastSuccessfulRunAt: null,
    freshnessHours: null,
    validMatchedProductsCount: 0,
    lowConfidenceProductsCount: 0,
    changesDetected: false,
  });

  assert.equal(state, "AWAITING_FIRST_RUN");
});

test("deriveCompetitorPrimaryState returns low confidence when only weak matches exist", () => {
  const state = deriveCompetitorPrimaryState({
    hasDomains: true,
    syncStatusLabel: "SUCCEEDED",
    lastSuccessfulRunAt: new Date("2026-04-15T08:00:00.000Z"),
    freshnessHours: 1,
    validMatchedProductsCount: 0,
    lowConfidenceProductsCount: 3,
    changesDetected: false,
  });

  assert.equal(state, "LOW_CONFIDENCE");
});

test("deriveCompetitorPrimaryState returns no matches when no valid or weak matches exist", () => {
  const state = deriveCompetitorPrimaryState({
    hasDomains: true,
    syncStatusLabel: "SUCCEEDED",
    lastSuccessfulRunAt: new Date("2026-04-15T08:00:00.000Z"),
    freshnessHours: 1,
    validMatchedProductsCount: 0,
    lowConfidenceProductsCount: 0,
    changesDetected: false,
  });

  assert.equal(state, "NO_MATCHES");
});

test("deriveCompetitorPrimaryState returns detected changes when valid comparable matches exist and changes were found", () => {
  const state = deriveCompetitorPrimaryState({
    hasDomains: true,
    syncStatusLabel: "SUCCEEDED",
    lastSuccessfulRunAt: new Date("2026-04-15T08:00:00.000Z"),
    freshnessHours: 1,
    validMatchedProductsCount: 4,
    lowConfidenceProductsCount: 1,
    changesDetected: true,
  });

  assert.equal(state, "CHANGES_DETECTED");
});

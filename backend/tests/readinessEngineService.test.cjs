const test = require("node:test");
const assert = require("node:assert/strict");

const {
  deriveReadinessState,
} = require("../dist/services/readinessEngineService.js");

test("returns locked when entitlement is missing even if data exists", () => {
  const state = deriveReadinessState({
    entitled: false,
    connectionHealthy: true,
    syncStatus: "READY_WITH_DATA",
    setupComplete: true,
    dataReady: true,
  });

  assert.equal(state, "locked");
});

test("returns setup_needed when sync has not completed yet", () => {
  const state = deriveReadinessState({
    entitled: true,
    connectionHealthy: true,
    syncStatus: "SYNC_REQUIRED",
    setupComplete: false,
    dataReady: false,
  });

  assert.equal(state, "setup_needed");
});

test("returns collecting_data when setup exists but outputs are still processing", () => {
  const state = deriveReadinessState({
    entitled: true,
    connectionHealthy: true,
    syncStatus: "SYNC_COMPLETED_PROCESSING_PENDING",
    setupComplete: true,
    dataReady: false,
  });

  assert.equal(state, "collecting_data");
});

test("returns error when sync failed or the shop connection is unhealthy", () => {
  const syncFailure = deriveReadinessState({
    entitled: true,
    connectionHealthy: true,
    syncStatus: "FAILED",
    setupComplete: true,
    dataReady: false,
    hasFailed: true,
  });
  const connectionFailure = deriveReadinessState({
    entitled: true,
    connectionHealthy: false,
    syncStatus: "READY_WITH_DATA",
    setupComplete: true,
    dataReady: true,
  });

  assert.equal(syncFailure, "error");
  assert.equal(connectionFailure, "error");
});

test("returns ready only when entitlement, sync, setup, and data are all satisfied", () => {
  const state = deriveReadinessState({
    entitled: true,
    connectionHealthy: true,
    syncStatus: "READY_WITH_DATA",
    setupComplete: true,
    dataReady: true,
  });

  assert.equal(state, "ready");
});

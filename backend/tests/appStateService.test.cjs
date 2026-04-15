const test = require("node:test");
const assert = require("node:assert/strict");

const {
  deriveInstallState,
  deriveConnectionState,
} = require("../dist/services/appStateService.js");

test("deriveInstallState flags reconnect-required installations", () => {
  const state = deriveInstallState({
    code: "SHOPIFY_RECONNECT_REQUIRED",
    reauthRequired: true,
    reauthorizeUrl: "https://example.com/reconnect",
    message: "Reconnect required",
  });

  assert.equal(state.status, "reauthorize_required");
  assert.equal(state.reauthorizeUrl, "https://example.com/reconnect");
});

test("deriveConnectionState treats webhook gaps as attention, not fatal failure", () => {
  const state = deriveConnectionState({
    code: "WEBHOOKS_MISSING",
    healthy: false,
    message: "Missing webhooks",
  });

  assert.equal(state.status, "attention");
  assert.match(state.description, /setup/i);
});

test("deriveConnectionState returns healthy state when connection is healthy", () => {
  const state = deriveConnectionState({
    code: "OK",
    healthy: true,
    message: "Healthy",
  });

  assert.equal(state.status, "healthy");
});

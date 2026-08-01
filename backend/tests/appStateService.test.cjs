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

// deriveConnectionState keys off `healthy` alone. Webhook registration is an
// internal detail that retries on every authenticated request, so a healthy
// connection stays healthy even while webhook coverage is still catching up —
// `webhookCoverageReady` is the separate internal signal for that. An
// unhealthy connection is reported as `failed` regardless of the code.
test("deriveConnectionState reports an unverified connection as failed", () => {
  const state = deriveConnectionState({
    code: "WEBHOOKS_MISSING",
    healthy: false,
    message: "Missing webhooks",
  });

  assert.equal(state.status, "failed");
  assert.equal(state.title, "Store connection could not be verified");
  assert.equal(state.description, "Missing webhooks");
});

test("deriveConnectionState stays healthy when webhooks are still registering", () => {
  // The case the merchant actually sees: auth works, webhook backfill pending.
  const state = deriveConnectionState({
    code: "WEBHOOKS_MISSING",
    healthy: true,
    message: "Missing webhooks",
  });

  assert.equal(state.status, "healthy");
  assert.match(state.description, /webhook registration/i);
});

test("deriveConnectionState returns healthy state when connection is healthy", () => {
  const state = deriveConnectionState({
    code: "OK",
    healthy: true,
    message: "Healthy",
  });

  assert.equal(state.status, "healthy");
});

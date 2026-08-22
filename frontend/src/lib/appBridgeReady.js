/**
 * Bounded wait for the App Bridge CDN script to finish initialising.
 *
 * THE BUG THIS FIXES: getEmbeddedSessionToken() returned null the instant
 * window.shopify was undefined. A request issued before the CDN script had
 * loaded therefore went out with NO Authorization header, and the backend
 * answered 401. The auth-retry budget re-polled the same instant-null, so all
 * attempts were exhausted inside roughly 750ms - far less than a cold App
 * Bridge load. The merchant saw "Shopify connection needs attention"; a refresh
 * fixed it because the script was cached by then.
 *
 * /api/dashboard/onboarding/view-insight was the most exposed caller: it fires
 * from a useEffect the moment an insight route mounts, which is the earliest
 * point of an embedded session.
 *
 * Plain ESM JavaScript so the regression tests import and execute this exact
 * module. All timing is injected, so the tests are deterministic and instant.
 */

/**
 * How long to wait for App Bridge before giving up. Requests using this have a
 * 30s timeout, so this stays well inside their budget.
 */
export const APP_BRIDGE_READY_TIMEOUT_MS = 5000;

/** How often to re-check. Cheap: a single property read. */
export const APP_BRIDGE_POLL_INTERVAL_MS = 50;

/**
 * Resolves as soon as App Bridge is available, or null once the deadline
 * passes. Returns synchronously-resolved when it is already there, so the
 * normal path costs nothing.
 *
 * @param {{
 *   getBridge: () => unknown,
 *   sleep: (ms: number) => Promise<void>,
 *   now: () => number,
 *   timeoutMs?: number,
 *   pollIntervalMs?: number,
 * }} deps
 * @returns {Promise<unknown|null>}
 */
export async function waitForAppBridge(deps) {
  const {
    getBridge,
    sleep,
    now,
    timeoutMs = APP_BRIDGE_READY_TIMEOUT_MS,
    pollIntervalMs = APP_BRIDGE_POLL_INTERVAL_MS,
  } = deps;

  // Fast path: already initialised. This is the steady state, so the wait must
  // add no latency once the app is running.
  const immediate = getBridge();
  if (immediate) {
    return immediate;
  }

  const deadline = now() + timeoutMs;

  while (now() < deadline) {
    await sleep(pollIntervalMs);
    const bridge = getBridge();
    if (bridge) {
      return bridge;
    }
  }

  // Give up rather than hang. The caller sends the request unauthenticated and
  // surfaces a real auth error, exactly as before this fix.
  return null;
}

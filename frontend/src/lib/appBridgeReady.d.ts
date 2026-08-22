/** Types for appBridgeReady.js. */

export const APP_BRIDGE_READY_TIMEOUT_MS: number;
export const APP_BRIDGE_POLL_INTERVAL_MS: number;

export function waitForAppBridge<T>(deps: {
  getBridge: () => T | null | undefined;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  timeoutMs?: number;
  pollIntervalMs?: number;
}): Promise<T | null>;

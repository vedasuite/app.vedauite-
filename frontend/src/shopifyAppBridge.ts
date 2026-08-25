// Uses the CDN-loaded App Bridge (window.shopify) injected by index.html.
// The @shopify/app-bridge npm package is intentionally not used here —
// Shopify requires the CDN script as of March 2024.
import { getEmbeddedContext } from "./lib/shopifyEmbeddedContext";
import { withRequestTimeout } from "./lib/requestTimeout";
import { waitForAppBridge } from "./lib/appBridgeReady";

declare global {
  interface Window {
    shopify?: {
      idToken(): Promise<string>;
      config?: {
        apiKey?: string;
        shop?: string;
        host?: string;
      };
    };
  }
}

const sessionTokenCache = new Map<
  string,
  { token: string; expiresAt: number; inflight?: Promise<string> }
>();

export function bustSessionTokenCache() {
  sessionTokenCache.clear();
}

// Shopify session tokens carry an `exp` claim and live for about 60 seconds.
// Caching on a fixed timer alone can hand back a token that expired while the
// tab was backgrounded or during a slow request, which the backend then
// rejects with 401. Read the real expiry and stop serving the token 10 seconds
// before it lapses, so it is still valid when the request lands.
// Shopify session tokens are short-lived (~60s). This margin is how early the
// client stops trusting a cached token and asks App Bridge for a fresh one.
//
// At 10s it was too tight: a token still considered valid locally could already
// be expired at the server once network latency and browser/server clock skew
// were taken into account. Several components loading at once would then each
// send the same about-to-expire token, each take a 401, and each self-heal —
// producing the bursts of "jwt expired" seen in production.
//
// Widening the margin only makes the client refresh sooner. It does NOT extend
// the token's lifetime, is not persisted anywhere, and does not weaken backend
// verification — the server still rejects anything genuinely expired.
export const TOKEN_EXPIRY_SAFETY_MS = 25_000;
const MAX_TOKEN_CACHE_MS = 30_000;

/**
 * How close to expiry a token may be and still be SENT.
 *
 * Deliberately much smaller than the cache margin above, because the two
 * margins answer different questions:
 *
 *   TOKEN_EXPIRY_SAFETY_MS — may this token still be served FROM CACHE for some
 *                            unknown future request? Conservative on purpose.
 *   TOKEN_USABLE_MARGIN_MS — will this token still be valid when THIS request
 *                            lands, moments from now? Only needs to cover
 *                            network latency and clock skew.
 *
 * Using the cache margin at the point of use would reject perfectly good tokens
 * with 20 seconds of life left and re-mint for no reason.
 */
export const TOKEN_USABLE_MARGIN_MS = 5_000;

/**
 * Milliseconds until the token's OWN `exp` claim, or null if unreadable.
 *
 * The JWT is the authority here, not our bookkeeping. That distinction is the
 * whole defect this file previously had — see isTokenUsable.
 */
export function millisUntilTokenExpiry(
  token: string,
  now: number = Date.now()
): number | null {
  const expiry = readTokenExpiry(token);
  return expiry === null ? null : expiry - now;
}

/**
 * Whether a token can still be sent.
 *
 * WHY THIS EXISTS
 * ---------------
 * getEmbeddedSessionToken used to return whatever App Bridge handed back, and
 * the cached path trusted `expiresAt` — a value WE computed when we stored it.
 * Neither path ever asked the token itself whether it was still alive.
 *
 * So a dead JWT could go out: App Bridge can return a token from its own cache
 * that is already most of the way through its ~60s life, and a backgrounded tab
 * or clock skew can put our bookkeeping and the JWT's `exp` out of step. The
 * server then answered 401 "jwt expired". Worse, busting OUR cache on retry did
 * not force App Bridge to mint a new one, so the retry could send the same dead
 * token and the merchant finally saw the raw error — recoverable only by a full
 * page refresh, which is exactly what was reported.
 *
 * A token with no readable `exp` is treated as usable: it may be a test double
 * or an opaque format, and refusing to send it would break the request for a
 * reason we cannot actually demonstrate. The server remains the authority.
 */
export function isTokenUsable(
  token: string | null | undefined,
  now: number = Date.now()
): boolean {
  if (!token) return false;
  const remaining = millisUntilTokenExpiry(token, now);
  if (remaining === null) return true;
  return remaining > TOKEN_USABLE_MARGIN_MS;
}

function readTokenExpiry(token: string): number | null {
  try {
    const [, payloadSegment] = token.split(".");
    if (!payloadSegment) {
      return null;
    }
    // JWT uses base64url; atob expects standard base64.
    const base64 = payloadSegment.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(
      base64.length + ((4 - (base64.length % 4)) % 4),
      "="
    );
    const payload = JSON.parse(atob(padded)) as { exp?: number };
    return typeof payload.exp === "number" ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

function cacheExpiryFor(token: string): number {
  const now = Date.now();
  const ceiling = now + MAX_TOKEN_CACHE_MS;
  const tokenExpiry = readTokenExpiry(token);

  if (tokenExpiry === null) {
    return ceiling;
  }

  return Math.min(ceiling, tokenExpiry - TOKEN_EXPIRY_SAFETY_MS);
}

export function getEmbeddedAppBridge() {
  return window.shopify ?? null;
}

// One shared wait for the CDN script, not one per request. If App Bridge never
// arrives we pay the timeout once; every later call then returns immediately.
// The fast path below re-checks window.shopify first, so a late arrival is
// still picked up without re-polling.
let appBridgeReadyPromise: Promise<unknown> | null = null;

function ensureAppBridgeReady(): Promise<unknown> {
  if (window.shopify) {
    return Promise.resolve(window.shopify);
  }
  if (!appBridgeReadyPromise) {
    appBridgeReadyPromise = waitForAppBridge({
      getBridge: () => window.shopify ?? null,
      sleep: (ms) => new Promise((resolve) => window.setTimeout(resolve, ms)),
      now: () => Date.now(),
    });
  }
  return appBridgeReadyPromise;
}

/** Test seam: drop the memoised readiness wait. */
export function resetAppBridgeReadyState() {
  appBridgeReadyPromise = null;
}

/**
 * Asks App Bridge for a token and refuses to hand back a dead one.
 *
 * If the minted token is already past its usable margin, it is retried ONCE —
 * App Bridge may have served its own cached copy the first time. If the second
 * attempt is also dead, that is a real condition (badly skewed clock, or an App
 * Bridge that needs the page reloaded) and it is reported rather than sent, so
 * the failure names its cause instead of arriving as a generic 401.
 */
async function mintUsableToken(bridge: { idToken(): Promise<string> }): Promise<string> {
  const first = await withRequestTimeout(
    bridge.idToken(),
    12000,
    "Shopify session token request timed out."
  );
  if (isTokenUsable(first)) {
    return first;
  }

  // Bounded: exactly one re-mint, never a loop.
  await new Promise((resolve) => window.setTimeout(resolve, 150));
  const second = await withRequestTimeout(
    bridge.idToken(),
    12000,
    "Shopify session token request timed out."
  );
  if (isTokenUsable(second)) {
    return second;
  }

  throw new Error(
    "Shopify returned an already-expired session token twice. Reload VedaSuite " +
      "from Shopify Admin; if this persists, check the device clock."
  );
}

export async function getEmbeddedSessionToken(
  options: { forceFresh?: boolean } = {}
): Promise<string | null> {
  if (typeof window === "undefined") {
    return null;
  }

  // The CDN App Bridge script may still be loading on a cold embedded start.
  // Returning null here used to send the request with no Authorization header,
  // which the backend answered with 401 — surfaced to the merchant as
  // "Shopify connection needs attention". Wait for it instead.
  if (!window.shopify) {
    await ensureAppBridgeReady();
  }

  if (!window.shopify) {
    return null;
  }

  const { shop } = getEmbeddedContext();
  const cacheKey = shop || "default";
  const now = Date.now();

  // A forced refresh discards this shop's entry BEFORE anything is read, so a
  // token the server just rejected can never be served again from cache.
  if (options.forceFresh) {
    sessionTokenCache.delete(cacheKey);
  }

  const cached = sessionTokenCache.get(cacheKey);

  // TWO conditions, both required. `expiresAt` is our own bookkeeping and can
  // drift out of step with the JWT — after a backgrounded tab, or under clock
  // skew — so the token's own `exp` is checked as well. Trusting only the
  // former is what let a dead token reach the server.
  if (cached?.token && cached.expiresAt > now && isTokenUsable(cached.token, now)) {
    return cached.token;
  }

  if (cached?.inflight) {
    return cached.inflight;
  }

  const inflight = mintUsableToken(window.shopify).then((token) => {
    sessionTokenCache.set(cacheKey, {
      token,
      expiresAt: cacheExpiryFor(token),
    });
    return token;
  });

  sessionTokenCache.set(cacheKey, {
    token: cached?.token ?? "",
    expiresAt: cached?.expiresAt ?? 0,
    inflight,
  });

  try {
    return await inflight;
  } catch (error) {
    sessionTokenCache.delete(cacheKey);

    const message =
      error instanceof Error
        ? error.message
        : "Unable to establish the Shopify embedded session.";

    throw new Error(
      /timed out/i.test(message)
        ? "Unable to establish the Shopify embedded session. Refresh the app or reconnect Shopify."
        : message
    );
  } finally {
    const latest = sessionTokenCache.get(cacheKey);
    if (latest?.inflight === inflight) {
      sessionTokenCache.set(cacheKey, {
        token: latest.token,
        expiresAt: latest.expiresAt,
      });
    }
  }
}

export function useAppBridge() {
  const { shop, host } = getEmbeddedContext();

  return {
    app: window.shopify ?? null,
    shop,
    host,
    ready: !!window.shopify && !!shop,
  };
}


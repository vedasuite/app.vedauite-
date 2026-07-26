// Uses the CDN-loaded App Bridge (window.shopify) injected by index.html.
// The @shopify/app-bridge npm package is intentionally not used here —
// Shopify requires the CDN script as of March 2024.
import { getEmbeddedContext } from "./lib/shopifyEmbeddedContext";
import { withRequestTimeout } from "./lib/requestTimeout";

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
const TOKEN_EXPIRY_SAFETY_MS = 10_000;
const MAX_TOKEN_CACHE_MS = 30_000;

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

export async function getEmbeddedSessionToken(): Promise<string | null> {
  if (typeof window === "undefined" || !window.shopify) {
    return null;
  }

  const { shop } = getEmbeddedContext();
  const cacheKey = shop || "default";
  const now = Date.now();
  const cached = sessionTokenCache.get(cacheKey);

  if (cached?.token && cached.expiresAt > now) {
    return cached.token;
  }

  if (cached?.inflight) {
    return cached.inflight;
  }

  const inflight = withRequestTimeout(
    window.shopify.idToken(),
    12000,
    "Shopify session token request timed out."
  ).then((token) => {
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


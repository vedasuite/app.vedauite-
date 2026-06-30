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
      expiresAt: Date.now() + 30_000,
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


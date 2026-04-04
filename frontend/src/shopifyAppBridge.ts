import { getSessionToken } from "@shopify/app-bridge/utilities/session-token";
import { useMemo } from "react";
import createApp, { AppConfig } from "@shopify/app-bridge";
import { getEmbeddedContext } from "./lib/shopifyEmbeddedContext";

const apiKey =
  (import.meta.env.VITE_SHOPIFY_API_KEY as string | undefined) || "";
const appCache = new Map<string, ReturnType<typeof createApp>>();
const sessionTokenCache = new Map<
  string,
  { token: string; expiresAt: number; inflight?: Promise<string> }
>();

function getCachedApp(host: string) {
  if (!apiKey || !host) {
    return null;
  }

  const cacheKey = `${apiKey}|${host || "default"}`;
  const existingApp = appCache.get(cacheKey);
  if (existingApp) {
    return existingApp;
  }

  const config: AppConfig = {
    apiKey,
    host,
    forceRedirect: true,
  };
  const nextApp = createApp(config);
  appCache.set(cacheKey, nextApp);
  return nextApp;
}

export function getEmbeddedAppBridge() {
  const { host } = getEmbeddedContext();
  return getCachedApp(host);
}

export async function getEmbeddedSessionToken() {
  const { host } = getEmbeddedContext();
  if (!apiKey || !host) {
    return null;
  }

  const cacheKey = `${apiKey}|${host || "default"}`;
  const now = Date.now();
  const cached = sessionTokenCache.get(cacheKey);

  if (cached?.token && cached.expiresAt > now) {
    return cached.token;
  }

  if (cached?.inflight) {
    return cached.inflight;
  }

  const app = getCachedApp(host);
  if (!app) {
    return null;
  }

  const inflight = getSessionToken(app).then((token) => {
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

  const config: AppConfig = useMemo(
    () => ({
      apiKey,
      host,
      forceRedirect: true,
    }),
    [host]
  );

  const cachedApp = useMemo(() => {
    return getCachedApp(config.host);
  }, [config, host]);

  return {
    app: cachedApp,
    shop,
    host,
    ready: !!apiKey && !!host,
  };
}


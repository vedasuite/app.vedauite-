import axios, { AxiosInstance } from "axios";
import { getSessionToken } from "@shopify/app-bridge/utilities/session-token";
import { useMemo } from "react";
import { useAppBridge } from "../shopifyAppBridge";
import { withRequestTimeout } from "../lib/requestTimeout";
import { getEmbeddedContext } from "../lib/shopifyEmbeddedContext";

const backendUrl =
  (import.meta.env.VITE_BACKEND_URL as string | undefined) || "";
const clientCache = new Map<string, AxiosInstance>();
const sessionTokenCache = new Map<
  string,
  {
    token: string | null;
    expiresAt: number;
    inflight?: Promise<string>;
  }
>();

async function getStableSessionToken(
  cacheKey: string,
  getToken: () => Promise<string>
) {
  const now = Date.now();
  const cached = sessionTokenCache.get(cacheKey);

  if (cached?.token && cached.expiresAt > now) {
    return cached.token;
  }

  if (cached?.inflight) {
    return cached.inflight;
  }

  const inflight = withRequestTimeout(getToken(), 20000).then((token) => {
    sessionTokenCache.set(cacheKey, {
      token,
      expiresAt: Date.now() + 30_000,
    });
    return token;
  });

  sessionTokenCache.set(cacheKey, {
    token: cached?.token ?? null,
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

export function useApiClient() {
  const { app, shop, host } = useAppBridge();

  const instance = useMemo(() => {
    const cacheKey = `${backendUrl}|${shop}|${host}`;
    const existingClient = clientCache.get(cacheKey);
    if (existingClient) {
      return existingClient;
    }

    const client = axios.create({
      baseURL: backendUrl,
      withCredentials: true,
    });
    client.interceptors.request.use(async (config) => {
      const resolvedContext = getEmbeddedContext();
      const sessionToken =
        app && resolvedContext.host
          ? await getStableSessionToken(cacheKey, () => getSessionToken(app))
          : null;
      if (config.headers && typeof config.headers.set === "function") {
        if (sessionToken) {
          config.headers.set("Authorization", `Bearer ${sessionToken}`);
        }
        config.headers.set("X-Requested-With", "XMLHttpRequest");
      } else {
        config.headers = {
          ...(config.headers ?? {}),
          ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}),
          "X-Requested-With": "XMLHttpRequest",
        } as any;
      }

      if (!config.params) config.params = {};
      if (resolvedContext.shop || shop) {
        config.params.shop = resolvedContext.shop || shop;
        if (resolvedContext.host || host) {
          config.params.host = resolvedContext.host || host;
        }
        const method = config.method?.toLowerCase();
        if (
          method &&
          ["post", "put", "patch", "delete"].includes(method) &&
          config.data &&
          typeof config.data === "object" &&
          !Array.isArray(config.data) &&
          !("shop" in config.data)
        ) {
          config.data = {
            ...config.data,
            shop: resolvedContext.shop || shop,
            ...((resolvedContext.host || host)
              ? { host: resolvedContext.host || host }
              : {}),
          };
        }
      }
      // Session token attachment could be added here if backend validates it.
      return config;
    });

    clientCache.set(cacheKey, client);
    return client;
  }, [app, host, shop]);

  return instance;
}


import axios, { AxiosInstance } from "axios";
import { getSessionToken } from "@shopify/app-bridge/utilities/session-token";
import { useMemo } from "react";
import { useAppBridge } from "../shopifyAppBridge";
import { withRequestTimeout } from "../lib/requestTimeout";

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
      const sessionToken = await getStableSessionToken(cacheKey, () =>
        getSessionToken(app)
      );
      if (config.headers && typeof config.headers.set === "function") {
        config.headers.set("Authorization", `Bearer ${sessionToken}`);
        config.headers.set("X-Requested-With", "XMLHttpRequest");
      } else {
        config.headers = {
          ...(config.headers ?? {}),
          Authorization: `Bearer ${sessionToken}`,
          "X-Requested-With": "XMLHttpRequest",
        } as any;
      }

      if (!config.params) config.params = {};
      if (shop) {
        config.params.shop = shop;
        if (host) {
          config.params.host = host;
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
            shop,
            ...(host ? { host } : {}),
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


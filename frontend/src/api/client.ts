import axios, { AxiosInstance } from "axios";
import { getSessionToken } from "@shopify/app-bridge/utilities/session-token";
import { useMemo } from "react";
import { useAppBridge } from "../shopifyAppBridge";

const backendUrl =
  (import.meta.env.VITE_BACKEND_URL as string | undefined) || "";
const clientCache = new Map<string, AxiosInstance>();

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
      const sessionToken = await getSessionToken(app);
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


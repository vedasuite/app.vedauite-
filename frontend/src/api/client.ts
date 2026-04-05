import axios, { AxiosInstance } from "axios";
import { useMemo } from "react";
import { useAppBridge } from "../shopifyAppBridge";
import { getEmbeddedContext } from "../lib/shopifyEmbeddedContext";

const backendUrl =
  (import.meta.env.VITE_BACKEND_URL as string | undefined) || "";
const clientCache = new Map<string, AxiosInstance>();

export function useApiClient() {
  const { shop, host } = useAppBridge();

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
      const requestUrl = `${config.baseURL ?? ""}${config.url ?? ""}`;
      const isProtectedApiRoute =
        requestUrl.startsWith("/api/") || requestUrl.includes("/api/");

      if (config.headers && typeof config.headers.set === "function") {
        config.headers.set("X-Requested-With", "XMLHttpRequest");
      } else {
        config.headers = {
          ...(config.headers ?? {}),
          "X-Requested-With": "XMLHttpRequest",
        } as any;
      }

      if (!config.params) config.params = {};
      if (!isProtectedApiRoute && (resolvedContext.shop || shop)) {
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

      return config;
    });

    clientCache.set(cacheKey, client);
    return client;
  }, [host, shop]);

  return instance;
}


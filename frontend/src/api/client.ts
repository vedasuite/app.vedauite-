import axios, { AxiosInstance } from "axios";
import { useMemo } from "react";
import { useAppBridge, getEmbeddedSessionToken } from "../shopifyAppBridge";
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

      // Attach Shopify session token as Bearer for cookie-free authentication
      try {
        const sessionToken = await getEmbeddedSessionToken();
        if (sessionToken) {
          if (config.headers && typeof config.headers.set === "function") {
            config.headers.set("Authorization", `Bearer ${sessionToken}`);
          } else {
            config.headers = {
              ...(config.headers ?? {}),
              Authorization: `Bearer ${sessionToken}`,
            } as any;
          }
        }
      } catch {
        // Non-fatal: backend falls back to cookie session
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

    client.interceptors.response.use(
      (response) => response,
      (error) => {
        const status = error?.response?.status;
        const payload = error?.response?.data;
        const requestId =
          payload?.error?.requestId ??
          error?.response?.headers?.["x-request-id"] ??
          null;

        if (status === 401) {
          const message =
            payload?.error?.message ??
            "Your Shopify session expired. Reload VedaSuite from Shopify Admin and try again.";
          return Promise.reject(
            Object.assign(new Error(message), {
              code: payload?.error?.code ?? "REAUTHORIZE_REQUIRED",
              reauthorizeUrl: payload?.error?.reauthorizeUrl ?? null,
            })
          );
        }

        if (status === 403) {
          const message =
            payload?.error?.message ??
            "This feature is not included in your current plan.";
          return Promise.reject(
            Object.assign(new Error(message), {
              code: payload?.error?.code ?? "FEATURE_LOCKED",
              requiredPlan: payload?.error?.requiredPlan ?? null,
              upgradePath: payload?.error?.upgradePath ?? "/app/billing",
            })
          );
        }

        if (status >= 500) {
          const message = requestId
            ? `VedaSuite hit a server problem. Please retry. Reference: ${requestId}.`
            : "VedaSuite hit a server problem. Please retry.";
          return Promise.reject(
            Object.assign(new Error(message), {
              code: payload?.error?.code ?? "SERVER_ERROR",
              requestId,
            })
          );
        }

        return Promise.reject(error);
      }
    );

    clientCache.set(cacheKey, client);
    return client;
  }, [host, shop]);

  return instance;
}


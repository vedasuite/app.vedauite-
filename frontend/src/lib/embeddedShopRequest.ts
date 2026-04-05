import { withRequestTimeout } from "./requestTimeout";
import { getEmbeddedSessionToken } from "../shopifyAppBridge";
import { getEmbeddedContext } from "./shopifyEmbeddedContext";

type EmbeddedRequestOptions = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
  body?: Record<string, unknown>;
  timeoutMs?: number;
};

function buildUrl(path: string) {
  const url = new URL(path, window.location.origin);
  const { shop, host } = getEmbeddedContext();

  if (shop) {
    url.searchParams.set("shop", shop);
  }
  if (host) {
    url.searchParams.set("host", host);
  }

  return url;
}

export async function embeddedShopRequest<T = unknown>(
  path: string,
  options: EmbeddedRequestOptions = {}
) {
  const { method = "GET", body, timeoutMs = 30000 } = options;
  const url = buildUrl(path);
  const { shop, host } = getEmbeddedContext();
  const shouldAttachContext =
    method !== "GET" &&
    method !== "HEAD" &&
    method !== "OPTIONS";
  const requestBody =
    shouldAttachContext
      ? {
          ...(body ?? {}),
          ...(shop ? { shop } : {}),
          ...(host ? { host } : {}),
        }
      : body;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Requested-With": "XMLHttpRequest",
  };

  try {
    const sessionToken = await withRequestTimeout(
      Promise.resolve(getEmbeddedSessionToken()),
      Math.min(timeoutMs, 12000),
      "Unable to establish the Shopify embedded session."
    );

    if (sessionToken) {
      headers.Authorization = `Bearer ${sessionToken}`;
    }
  } catch (error) {
    if (import.meta.env.DEV) {
      console.warn("[embeddedShopRequest] session token fallback to cookie session", error);
    }
  }

  const abortController = new AbortController();

  const response = await withRequestTimeout(
    fetch(url.toString(), {
      method,
      credentials: "same-origin",
      headers,
      signal: abortController.signal,
      body: requestBody ? JSON.stringify(requestBody) : undefined,
    }),
    timeoutMs,
    `Request timed out after ${timeoutMs}ms`
  ).catch((error) => {
    abortController.abort();
    throw error;
  });

  if (response.status === 401 || response.status === 403) {
    const payload = await response.json().catch(() => ({}));
    const reauthorizeMessage =
      payload?.error?.message ||
      payload?.message ||
      "Shopify authorization expired. Reconnect the app and retry.";
    const enrichedError = new Error(reauthorizeMessage) as Error & {
      reauthorizeUrl?: string;
    };
    if (payload?.error?.reauthorizeUrl) {
      enrichedError.reauthorizeUrl = payload.error.reauthorizeUrl;
    }
    throw enrichedError;
  }

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error =
      typeof payload?.error === "string"
        ? payload.error
        : payload?.error?.message ||
          payload?.message ||
          `Request failed with status ${response.status}`;

    const enrichedError = new Error(error) as Error & {
      reauthorizeUrl?: string;
    };
    if (payload?.error?.reauthorizeUrl) {
      enrichedError.reauthorizeUrl = payload.error.reauthorizeUrl;
    }
    throw enrichedError;
  }

  return payload as T;
}

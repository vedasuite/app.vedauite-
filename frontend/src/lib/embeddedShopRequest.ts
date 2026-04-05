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

function buildRequestBody(
  method: EmbeddedRequestOptions["method"],
  body: EmbeddedRequestOptions["body"]
) {
  const { shop, host } = getEmbeddedContext();
  const shouldAttachContext =
    method !== "GET" && method !== "HEAD" && method !== "OPTIONS";

  return shouldAttachContext
    ? {
        ...(body ?? {}),
        ...(shop ? { shop } : {}),
        ...(host ? { host } : {}),
      }
    : body;
}

async function doFetch(
  url: URL,
  method: NonNullable<EmbeddedRequestOptions["method"]>,
  requestBody: ReturnType<typeof buildRequestBody>,
  timeoutMs: number,
  headers: Record<string, string>
) {
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

  const payload = await response.json().catch(() => ({}));

  return { response, payload };
}

function enrichError(
  payload: any,
  fallbackMessage: string
) {
  const errorMessage =
    typeof payload?.error === "string"
      ? payload.error
      : payload?.error?.message ||
        payload?.message ||
        fallbackMessage;

  const enrichedError = new Error(errorMessage) as Error & {
    reauthorizeUrl?: string;
    code?: string;
  };

  if (typeof payload?.error?.reauthorizeUrl === "string") {
    enrichedError.reauthorizeUrl = payload.error.reauthorizeUrl;
  }
  if (typeof payload?.error?.code === "string") {
    enrichedError.code = payload.error.code;
  }

  return enrichedError;
}

export async function embeddedShopRequest<T = unknown>(
  path: string,
  options: EmbeddedRequestOptions = {}
) {
  const { method = "GET", body, timeoutMs = 30000 } = options;
  const url = buildUrl(path);
  const requestBody = buildRequestBody(method, body);
  const baseHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Requested-With": "XMLHttpRequest",
  };

  let firstAttempt = await doFetch(url, method, requestBody, timeoutMs, baseHeaders);

  if (
    (firstAttempt.response.status === 401 || firstAttempt.response.status === 403) &&
    firstAttempt.payload?.error?.code === "INVALID_SHOPIFY_SESSION_TOKEN"
  ) {
    try {
      const sessionToken = await withRequestTimeout(
        Promise.resolve(getEmbeddedSessionToken()),
        Math.min(timeoutMs, 6000),
        "Shopify session token request timed out."
      );

      if (sessionToken) {
        firstAttempt = await doFetch(url, method, requestBody, timeoutMs, {
          ...baseHeaders,
          Authorization: `Bearer ${sessionToken}`,
        });
      }
    } catch (error) {
      if (import.meta.env.DEV) {
        console.warn("[embeddedShopRequest] bearer retry unavailable", error);
      }
    }
  }

  if (firstAttempt.response.status === 401 || firstAttempt.response.status === 403) {
    throw enrichError(
      firstAttempt.payload,
      "Shopify authorization expired. Reconnect the app and retry."
    );
  }

  if (!firstAttempt.response.ok) {
    throw enrichError(
      firstAttempt.payload,
      `Request failed with status ${firstAttempt.response.status}`
    );
  }

  return firstAttempt.payload as T;
}

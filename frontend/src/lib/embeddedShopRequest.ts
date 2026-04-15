import { withRequestTimeout } from "./requestTimeout";
import { getEmbeddedContext } from "./shopifyEmbeddedContext";

type EmbeddedRequestOptions = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
  body?: Record<string, unknown>;
  timeoutMs?: number;
  retries?: number;
};

function buildUrl(path: string) {
  const url = new URL(path, window.location.origin);
  const isProtectedApiRoute = path.startsWith("/api/");
  const { shop, host } = getEmbeddedContext();

  if (!isProtectedApiRoute && shop) {
    url.searchParams.set("shop", shop);
  }
  if (!isProtectedApiRoute && host) {
    url.searchParams.set("host", host);
  }

  return url;
}

function buildRequestBody(
  path: string,
  method: EmbeddedRequestOptions["method"],
  body: EmbeddedRequestOptions["body"]
) {
  const { shop, host } = getEmbeddedContext();
  const isProtectedApiRoute = path.startsWith("/api/");
  const shouldAttachContext =
    !isProtectedApiRoute &&
    method !== "GET" &&
    method !== "HEAD" &&
    method !== "OPTIONS";

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

function isRetriableError(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }

  return /timed out|network|failed to fetch|load the current app state/i.test(
    error.message.toLowerCase()
  );
}

export async function embeddedShopRequest<T = unknown>(
  path: string,
  options: EmbeddedRequestOptions = {}
) {
  const { method = "GET", body, timeoutMs = 30000, retries = 0 } = options;
  const url = buildUrl(path);
  const requestBody = buildRequestBody(path, method, body);
  const baseHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Requested-With": "XMLHttpRequest",
  };
  let attempt = 0;

  while (attempt <= retries) {
    try {
      const responseResult = await doFetch(
        url,
        method,
        requestBody,
        timeoutMs,
        baseHeaders
      );

      if (
        responseResult.response.status === 401 ||
        responseResult.response.status === 403
      ) {
        throw enrichError(
          responseResult.payload,
          "Shopify authorization expired. Reconnect the app and retry."
        );
      }

      if (!responseResult.response.ok) {
        throw enrichError(
          responseResult.payload,
          `Request failed with status ${responseResult.response.status}`
        );
      }

      return responseResult.payload as T;
    } catch (error) {
      if (attempt >= retries || !isRetriableError(error) || method !== "GET") {
        throw error;
      }
      attempt += 1;
    }
  }

  throw new Error("VedaSuite request failed.");
}

import { withRequestTimeout } from "./requestTimeout";
import { getEmbeddedContext } from "./shopifyEmbeddedContext";

type EmbeddedRequestOptions = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
  body?: Record<string, unknown>;
  timeoutMs?: number;
  retries?: number;
  signal?: AbortSignal;
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
  headers: Record<string, string>,
  externalSignal?: AbortSignal
) {
  const abortController = new AbortController();
  const abortFromCaller = () => abortController.abort();
  if (externalSignal) {
    if (externalSignal.aborted) {
      abortController.abort();
    } else {
      externalSignal.addEventListener("abort", abortFromCaller, { once: true });
    }
  }

  try {
    return await withRequestTimeout(
      (async () => {
        const response = await fetch(url.toString(), {
          method,
          credentials: "same-origin",
          headers,
          signal: abortController.signal,
          body: requestBody ? JSON.stringify(requestBody) : undefined,
        });

        const payload = await response.json().catch(() => ({}));
        return { response, payload };
      })(),
      timeoutMs,
      `Request timed out after ${timeoutMs}ms`
    );
  } catch (error) {
    abortController.abort();
    throw error;
  } finally {
    if (externalSignal) {
      externalSignal.removeEventListener("abort", abortFromCaller);
    }
  }
}

function enrichError(
  payload: any,
  fallbackMessage: string,
  statusCode?: number
) {
  const requestId =
    payload?.error?.requestId ?? payload?.requestId ?? null;
  const errorMessage =
    statusCode && statusCode >= 500
      ? requestId
        ? `VedaSuite hit a server problem. Please retry. Reference: ${requestId}.`
        : "VedaSuite hit a server problem. Please retry."
      : typeof payload?.error === "string"
      ? payload.error
      : payload?.error?.message ||
        payload?.message ||
        fallbackMessage;

  const enrichedError = new Error(errorMessage) as Error & {
    reauthorizeUrl?: string;
    code?: string;
    requestId?: string | null;
    requiredPlan?: string | null;
    upgradePath?: string | null;
  };

  if (typeof payload?.error?.reauthorizeUrl === "string") {
    enrichedError.reauthorizeUrl = payload.error.reauthorizeUrl;
  }
  if (typeof payload?.error?.code === "string") {
    enrichedError.code = payload.error.code;
  }
  if (requestId) {
    enrichedError.requestId = requestId;
  }
  if (typeof payload?.error?.requiredPlan === "string") {
    enrichedError.requiredPlan = payload.error.requiredPlan;
  }
  if (typeof payload?.error?.upgradePath === "string") {
    enrichedError.upgradePath = payload.error.upgradePath;
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

async function getShopifySessionToken(): Promise<string | null> {
  const t0 = Date.now();
  try {
    const shopify = (window as unknown as { shopify?: { idToken?: () => Promise<string> } }).shopify;
    if (typeof shopify?.idToken === "function") {
      const token = await shopify.idToken();
      // eslint-disable-next-line no-console
      console.info("[vedasuite.auth] session_token_acquired", { ms: Date.now() - t0, tokenLength: token.length });
      return token;
    }
    // eslint-disable-next-line no-console
    console.warn("[vedasuite.auth] shopify.idToken_unavailable — App Bridge not ready yet", { ms: Date.now() - t0 });
  } catch (err) {
    // App Bridge not ready — return null so the request proceeds without
    // a Bearer header. The backend returns 401, which propagates as an auth
    // error and the user is shown a reconnect prompt.
    // eslint-disable-next-line no-console
    console.warn("[vedasuite.auth] shopify.idToken_threw", { ms: Date.now() - t0, error: err instanceof Error ? err.message : String(err) });
  }
  return null;
}

export async function embeddedShopRequest<T = unknown>(
  path: string,
  options: EmbeddedRequestOptions = {}
) {
  const { method = "GET", body, timeoutMs = 30000, retries = 0, signal } = options;
  const url = buildUrl(path);
  const requestBody = buildRequestBody(path, method, body);
  let attempt = 0;

  while (attempt <= retries) {
    try {
      // Session tokens expire in 60 s — fetch a fresh one on each attempt
      const sessionToken = await getShopifySessionToken();
      const baseHeaders: Record<string, string> = {
        "Content-Type": "application/json",
        "X-Requested-With": "XMLHttpRequest",
        ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}),
      };

      const responseResult = await doFetch(
        url,
        method,
        requestBody,
        timeoutMs,
        baseHeaders,
        signal
      );

      if (responseResult.response.status === 401) {
        // Shopify signals that a fresh session token should fix this transient
        // auth failure. Retry within the caller's retry budget before surfacing
        // a reconnect prompt — this handles the race on fresh install where App
        // Bridge hasn't issued a valid token yet.
        const shopifyWantsRetry =
          responseResult.response.headers.get(
            "x-shopify-retry-invalid-session-request"
          ) === "1";
        // eslint-disable-next-line no-console
        console.warn("[vedasuite.auth] 401_received", {
          path,
          attempt,
          retries,
          shopifyWantsRetry,
          willRetry: shopifyWantsRetry && attempt < retries,
        });
        if (shopifyWantsRetry && attempt < retries) {
          attempt += 1;
          await new Promise((r) => setTimeout(r, 800 * attempt));
          continue;
        }
        throw enrichError(
          responseResult.payload,
          "Shopify authorization expired. Reconnect the app and retry.",
          401
        );
      }

      if (responseResult.response.status === 403) {
        throw enrichError(
          responseResult.payload,
          "This feature is not included in your current plan.",
          403
        );
      }

      if (!responseResult.response.ok) {
        throw enrichError(
          responseResult.payload,
          `Request failed with status ${responseResult.response.status}`,
          responseResult.response.status
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

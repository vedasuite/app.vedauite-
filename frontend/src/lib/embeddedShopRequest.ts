import {
  bustSessionTokenCache,
  getEmbeddedSessionToken,
  isTokenUsable,
} from "../shopifyAppBridge";
import { withRequestTimeout } from "./requestTimeout";
import { getEmbeddedContext } from "./shopifyEmbeddedContext";

type EmbeddedRequestOptions = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
  body?: Record<string, unknown>;
  timeoutMs?: number;
  retries?: number;
  signal?: AbortSignal;
};

/**
 * At most ONE automatic retry for an expired session token.
 *
 * One is the right number and more is not: by the time a 401 comes back, the
 * only recoverable cause is a stale token, and a single forced re-mint either
 * fixes that or proves it was never the problem. Retrying twice against a
 * genuine authorization failure just delays the honest error the merchant needs
 * to see.
 *
 * App Bridge still initialising is handled before the request instead —
 * getEmbeddedSessionToken awaits readiness — so it does not need a retry here.
 */
const AUTH_RETRIES = 1;

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

/**
 * How many times token ACQUISITION may be attempted before a protected request
 * is allowed to fail.
 *
 * This is not the HTTP retry — that stays at exactly one. This is the earlier
 * question of whether we have anything to send at all.
 *
 * WHY IT EXISTS. `acquireSessionToken` returns null when App Bridge has not
 * finished initialising, and the request was sent anyway with NO Authorization
 * header — a guaranteed 401. On a cold embedded load that produced exactly the
 * reported symptom: the first screen a merchant opened showed "Invalid Shopify
 * session token", and navigating away and back worked because App Bridge had
 * become ready in the meantime.
 *
 * Sending a request we KNOW will fail, and then treating the failure as an
 * authorization problem, was the defect. A missing token is a not-ready
 * condition, not a rejection, and it is handled before the request goes out.
 */
const TOKEN_ACQUIRE_ATTEMPTS = 3;
const TOKEN_ACQUIRE_BACKOFF_MS = 300;

/**
 * Obtains a session token for a protected request, waiting briefly if App
 * Bridge is still coming up.
 *
 * Bounded and short: roughly 900ms worst case, which covers a cold start
 * without stalling a page the merchant is looking at.
 */
async function acquireTokenForProtectedRequest(
  bust: boolean,
  sleep: (ms: number) => Promise<void>
): Promise<string | null> {
  for (let attempt = 1; attempt <= TOKEN_ACQUIRE_ATTEMPTS; attempt += 1) {
    // Only the FIRST attempt honours a cache bust. Later attempts are waiting
    // for readiness, not working around a rejected token.
    const token = await acquireSessionToken(bust && attempt === 1);
    if (token) return token;
    if (attempt < TOKEN_ACQUIRE_ATTEMPTS) {
      await sleep(TOKEN_ACQUIRE_BACKOFF_MS * attempt);
    }
  }
  return null;
}

async function acquireSessionToken(bust = false): Promise<string | null> {
  // On 401 retry, the cached token was just rejected — force a fresh idToken()
  // call. `forceFresh` also drops this shop's cache entry inside the token
  // layer BEFORE it reads anything, so the rejected token cannot be served
  // again by a concurrent caller in the same tick.
  if (bust) {
    bustSessionTokenCache();
  }

  const t0 = Date.now();
  try {
    const token = await getEmbeddedSessionToken({ forceFresh: bust });
    if (token) {
      // eslint-disable-next-line no-console
      console.info("[vedasuite.auth] session_token_acquired", { ms: Date.now() - t0, tokenLength: token.length });
      return token;
    }
    // eslint-disable-next-line no-console
    console.warn("[vedasuite.auth] shopify.idToken_unavailable — App Bridge not ready yet", { ms: Date.now() - t0 });
  } catch (err) {
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
  // Protected routes require a session token; public ones (auth, billing
  // redirects) legitimately do not.
  const isProtectedApiPath = path.startsWith("/api/");
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));
  const requestBody = buildRequestBody(path, method, body);
  let attempt = 0;

  // Auth retries are tracked separately from the caller's retry budget.
  // Shopify session tokens expire after ~60 seconds, so an expired token is a
  // normal condition on any screen the merchant leaves open — not an error.
  // Callers that pass retries: 0 (most of them) would otherwise surface
  // "Invalid Shopify session token" to the merchant on the first expiry.
  let authAttempt = 0;

  while (attempt <= retries) {
    try {
      // Fetch a session token. Cached (30 s) normally; the cache is busted on
      // an auth retry so a rejected token is never sent twice.
      const sessionToken = isProtectedApiPath
        ? await acquireTokenForProtectedRequest(authAttempt > 0, sleep)
        : await acquireSessionToken(authAttempt > 0);

      // A protected route with no token is a request we KNOW will 401. Sending
      // it anyway is what put "Invalid Shopify session token" in front of the
      // merchant on a cold load: the failure was then indistinguishable from a
      // real rejection, and one HTTP retry was not enough time for App Bridge
      // to finish starting.
      //
      // The wait above is bounded, so this is reached only when App Bridge is
      // genuinely unavailable — which IS worth telling the merchant about, in
      // words that name the actual problem.
      if (isProtectedApiPath && !sessionToken) {
        // eslint-disable-next-line no-console
        console.warn("[vedasuite.auth] no_session_token_after_wait", { path });
        throw new Error(
          "VedaSuite could not reach Shopify to establish this session. " +
            "Reopen the app from your Shopify admin and try again."
        );
      }

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
        // Shopify sets this header to say a fresh session token should fix the
        // failure. Retry on our own budget rather than the caller's: the common
        // case is simply an expired 60-second token, which must never reach the
        // merchant as an error. Only after AUTH_RETRIES consecutive failures do
        // we treat it as a genuine authorization problem.
        const shopifyWantsRetry =
          responseResult.response.headers.get(
            "x-shopify-retry-invalid-session-request"
          ) === "1";

        // The client's OWN evidence, not just the server's hint.
        //
        // Retrying only when the server sets that header made recovery depend
        // on something outside this codebase: a proxy that strips it, or any
        // 401 raised before that middleware runs, left the merchant staring at
        // "Invalid Shopify session token" during ordinary navigation. We can
        // see for ourselves whether the token we just sent had expired, and
        // that is sufficient grounds to re-mint and try again.
        const sentTokenWasStale = !!sessionToken && !isTokenUsable(sessionToken);
        const willRetry =
          (shopifyWantsRetry || sentTokenWasStale) && authAttempt < AUTH_RETRIES;
        // eslint-disable-next-line no-console
        console.warn("[vedasuite.auth] 401_received", {
          path,
          authAttempt,
          shopifyWantsRetry,
          sentTokenWasStale,
          willRetry,
        });
        if (willRetry) {
          authAttempt += 1;
          // Short backoff — a fresh idToken() is normally instant.
          await new Promise((r) => setTimeout(r, 250 * authAttempt));
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

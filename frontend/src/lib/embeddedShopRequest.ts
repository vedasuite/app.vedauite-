import { withRequestTimeout } from "./requestTimeout";

type EmbeddedRequestOptions = {
  method?: "GET" | "POST";
  body?: Record<string, unknown>;
  timeoutMs?: number;
};

function buildUrl(path: string) {
  const url = new URL(path, window.location.origin);
  const currentParams = new URLSearchParams(window.location.search);
  const shop = currentParams.get("shop");
  const host = currentParams.get("host");

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
  const currentParams = new URLSearchParams(window.location.search);
  const shop = currentParams.get("shop");
  const host = currentParams.get("host");
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

  const response = await withRequestTimeout(
    fetch(url.toString(), {
      method,
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        "X-Requested-With": "XMLHttpRequest",
      },
      body: requestBody ? JSON.stringify(requestBody) : undefined,
    }),
    timeoutMs
  );

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

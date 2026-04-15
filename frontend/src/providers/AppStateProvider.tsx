import { createContext, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { embeddedShopRequest } from "../lib/embeddedShopRequest";
import { readModuleCache, writeModuleCache } from "../lib/moduleCache";
import { getEmbeddedContext } from "../lib/shopifyEmbeddedContext";

export type CanonicalAppState = {
  appStatus: "ready" | "action_required" | "failed";
  install: {
    status: "installed" | "reauthorize_required" | "missing_installation" | "uninstalled";
    title: string;
    description: string;
    reauthorizeUrl: string | null;
  };
  connection: {
    status: "healthy" | "attention" | "failed";
    title: string;
    description: string;
  };
  sync: {
    status: string;
    title: string;
    description: string;
    lastUpdatedAt: string | null;
  };
  billing: {
    planName: string;
    status: string;
    active: boolean;
    accessActive: boolean;
    endsAt: string | null;
    trialEndsAt: string | null;
    title: string;
    description: string;
  };
  onboarding: {
    stage: string;
    isCompleted: boolean;
    canAccessDashboard: boolean;
    nextRoute: string;
    title: string;
    description: string;
  };
  entitlements: {
    trustAbuse: boolean;
    competitor: boolean;
    pricingProfit: boolean;
    reports: boolean;
    settings: boolean;
  };
  modules: {
    fraud: { status: string; title: string; description: string };
    competitor: { status: string; title: string; description: string };
    pricing: { status: string; title: string; description: string };
  };
  readiness: {
    connection: {
      state: string;
      status: string;
      title: string;
      description: string;
      ready: boolean;
      healthy: boolean;
      code: string;
    };
    initialSync: {
      state: string;
      status: string;
      title: string;
      description: string;
      ready: boolean;
      syncStatus: string;
      hasRawData: boolean;
      hasProcessedData: boolean;
    };
    billing: {
      state: string;
      status: string;
      title: string;
      description: string;
      ready: boolean;
      lifecycle: string;
      planName: string;
      accessActive: boolean;
      verified: boolean;
    };
    modules: {
      fraud: { state: string; status: string; title: string; description: string; ready: boolean };
      competitor: { state: string; status: string; title: string; description: string; ready: boolean };
      pricing: { state: string; status: string; title: string; description: string; ready: boolean };
    };
    setup: {
      minimumComplete: boolean;
      allCoreModulesReady: boolean;
      blockers: string[];
      nextAction: {
        label: string;
        route: string;
      };
      percent: number;
      summaryTitle: string;
      summaryDescription: string;
    };
    quickAccess: {
      fraud: { state: string; status: string; freshnessAt: string | null; reason: string };
      competitor: { state: string; status: string; freshnessAt: string | null; reason: string };
      pricing: { state: string; status: string; freshnessAt: string | null; reason: string };
    };
  };
};

type AppStateContextValue = {
  appState: CanonicalAppState | null;
  status: "loading" | "ready" | "error";
  error: string | null;
  bootstrap: BootstrapState;
  refresh: () => Promise<CanonicalAppState>;
};

const CACHE_KEY = "app-state";

export type BootstrapStatus =
  | "initializing_embedded_context"
  | "validating_shopify_params"
  | "loading_session"
  | "loading_installation_record"
  | "needs_reconnect"
  | "ready"
  | "failed";

export type BootstrapState = {
  status: BootstrapStatus;
  shop: string | null;
  host: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  reconnectUrl: string | null;
};

export const AppStateContext = createContext<AppStateContextValue | null>(null);

const INITIAL_BOOTSTRAP_STATE: BootstrapState = {
  status: "initializing_embedded_context",
  shop: null,
  host: null,
  errorCode: null,
  errorMessage: null,
  reconnectUrl: null,
};

function logBootstrap(event: string, details?: Record<string, unknown>) {
  // eslint-disable-next-line no-console
  console.info("[vedasuite.bootstrap]", event, details ?? {});
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

export function isCanonicalAppState(value: unknown): value is CanonicalAppState {
  if (!isObject(value)) {
    return false;
  }

  return (
    isObject(value.install) &&
    typeof value.install.status === "string" &&
    isObject(value.connection) &&
    typeof value.connection.status === "string" &&
    isObject(value.sync) &&
    typeof value.sync.status === "string" &&
    isObject(value.billing) &&
    typeof value.billing.planName === "string" &&
    isObject(value.onboarding) &&
    typeof value.onboarding.stage === "string" &&
    isObject(value.entitlements) &&
    isObject(value.modules) &&
    isObject(value.readiness)
  );
}

export function AppStateProvider({ children }: { children: ReactNode }) {
  const cachedState = useMemo(
    () => {
      const cached = readModuleCache<CanonicalAppState>(CACHE_KEY) ?? null;
      return isCanonicalAppState(cached) ? cached : null;
    },
    []
  );
  const [appState, setAppState] = useState<CanonicalAppState | null>(cachedState);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [bootstrap, setBootstrap] = useState<BootstrapState>(INITIAL_BOOTSTRAP_STATE);
  const requestIdRef = useRef(0);

  const refresh = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    const { host, shop } = getEmbeddedContext();

    logBootstrap("bootstrap.start");
    setStatus("loading");
    setError(null);
    setBootstrap({
      status: "validating_shopify_params",
      shop: shop || null,
      host: host || null,
      errorCode: null,
      errorMessage: null,
      reconnectUrl: null,
    });
    logBootstrap("shopify_params.parsed", {
      hostPresent: !!host,
      shop,
    });

    if (!shop) {
      const errorMessage =
        "VedaSuite needs to open from Shopify Admin so the store session can be restored.";
      logBootstrap("shop_param.missing", { hostPresent: !!host });
      setAppState(null);
      setStatus("error");
      setError(errorMessage);
      setBootstrap({
        status: "needs_reconnect",
        shop: null,
        host: host || null,
        errorCode: "MISSING_SHOP_PARAM",
        errorMessage,
        reconnectUrl: null,
      });
      throw new Error(errorMessage);
    }

    setBootstrap({
      status: "loading_session",
      shop,
      host: host || null,
      errorCode: null,
      errorMessage: null,
      reconnectUrl: null,
    });
    logBootstrap("session.loading", { shop, hostPresent: !!host });

    setBootstrap({
      status: "loading_installation_record",
      shop,
      host: host || null,
      errorCode: null,
      errorMessage: null,
      reconnectUrl: null,
    });
    logBootstrap("installation.fetch.start", { shop });

    try {
      const response = await embeddedShopRequest<{ appState?: CanonicalAppState }>(
        "/api/app-state",
        { timeoutMs: 30000, retries: 1 }
      );
      if (!isCanonicalAppState(response.appState)) {
        const invalidPayloadError = new Error(
          "VedaSuite received an incomplete app bootstrap payload."
        ) as Error & { code?: string };
        invalidPayloadError.code = "INVALID_APP_STATE_PAYLOAD";
        throw invalidPayloadError;
      }
      if (requestId !== requestIdRef.current) {
        return response.appState;
      }

      const nextAppState = response.appState;
      setAppState(nextAppState);
      writeModuleCache(CACHE_KEY, nextAppState);

      if (nextAppState.install.status !== "installed") {
        logBootstrap("installation.fetch.requires_reconnect", {
          shop,
          installStatus: nextAppState.install.status,
        });
        setStatus("error");
        setError(nextAppState.install.description);
        setBootstrap({
          status: "needs_reconnect",
          shop,
          host: host || null,
          errorCode: nextAppState.install.status.toUpperCase(),
          errorMessage: nextAppState.install.description,
          reconnectUrl: nextAppState.install.reauthorizeUrl,
        });
        return nextAppState;
      }

      logBootstrap("installation.fetch.success", {
        shop,
        installStatus: nextAppState.install.status,
      });
      setStatus("ready");
      setBootstrap({
        status: "ready",
        shop,
        host: host || null,
        errorCode: null,
        errorMessage: null,
        reconnectUrl: null,
      });
      logBootstrap("bootstrap.ready", { shop });
      return nextAppState;
    } catch (nextError) {
      if (requestId !== requestIdRef.current) {
        throw nextError;
      }
      const code =
        nextError instanceof Error && "code" in nextError
          ? String((nextError as Error & { code?: string }).code ?? "BOOTSTRAP_FAILED")
          : "BOOTSTRAP_FAILED";
      const reconnectUrl =
        nextError instanceof Error && "reauthorizeUrl" in nextError
          ? ((nextError as Error & { reauthorizeUrl?: string }).reauthorizeUrl ?? null)
          : null;
      const message =
        nextError instanceof Error
          ? nextError.message
          : "VedaSuite could not load the current app state.";

      setStatus("error");
      setError(message);
      setAppState((current) => (current && isCanonicalAppState(current) ? current : null));
      setBootstrap({
        status: reconnectUrl ? "needs_reconnect" : "failed",
        shop,
        host: host || null,
        errorCode: code,
        errorMessage: message,
        reconnectUrl,
      });
      logBootstrap("installation.fetch.failed", {
        shop,
        code,
        error: message,
      });
      throw nextError;
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    refresh().catch(() => {
      if (!mounted) return;
    });
    return () => {
      mounted = false;
    };
  }, [refresh]);

  const value = useMemo(
    () => ({
      appState,
      status,
      error,
      bootstrap,
      refresh,
    }),
    [appState, bootstrap, error, refresh, status]
  );

  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>;
}

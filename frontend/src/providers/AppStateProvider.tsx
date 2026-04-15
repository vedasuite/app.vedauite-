import { createContext, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { embeddedShopRequest } from "../lib/embeddedShopRequest";
import { readModuleCache, writeModuleCache } from "../lib/moduleCache";

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
  refresh: () => Promise<CanonicalAppState>;
};

const CACHE_KEY = "app-state";

export const AppStateContext = createContext<AppStateContextValue | null>(null);

export function AppStateProvider({ children }: { children: ReactNode }) {
  const cachedState = useMemo(
    () => readModuleCache<CanonicalAppState>(CACHE_KEY) ?? null,
    []
  );
  const [appState, setAppState] = useState<CanonicalAppState | null>(cachedState);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    cachedState ? "ready" : "loading"
  );
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  const refresh = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setStatus("loading");
    setError(null);

    try {
      const response = await embeddedShopRequest<{ appState: CanonicalAppState }>(
        "/api/app-state",
        { timeoutMs: 30000, retries: 1 }
      );
      if (requestId !== requestIdRef.current) {
        return response.appState;
      }
      setAppState(response.appState);
      setStatus("ready");
      writeModuleCache(CACHE_KEY, response.appState);
      return response.appState;
    } catch (nextError) {
      if (requestId !== requestIdRef.current) {
        throw nextError;
      }
      setStatus("error");
      setError(
        nextError instanceof Error
          ? nextError.message
          : "VedaSuite could not load the current app state."
      );
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
      refresh,
    }),
    [appState, error, refresh, status]
  );

  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>;
}

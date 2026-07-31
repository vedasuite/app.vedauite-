import { useCallback, useEffect, useRef, useState } from "react";
import { embeddedShopRequest } from "../lib/embeddedShopRequest";
import type { DashboardInsightsResponse } from "../lib/insightsTypes";

export interface InsightsState {
  data: DashboardInsightsResponse | null;
  loading: boolean;      // first load
  refreshing: boolean;   // subsequent load with data already shown
  error: string | null;
  authRequired: boolean; // 401 — reconnect
  unavailable: boolean;  // 503 — endpoint temporarily unavailable
  reload: () => void;
}

export function useInsightsDashboard(): InsightsState {
  const [data, setData] = useState<DashboardInsightsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authRequired, setAuthRequired] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const mounted = useRef(true);

  const load = useCallback(async (isRefresh: boolean) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    setError(null);
    setAuthRequired(false);
    setUnavailable(false);
    try {
      const res = await embeddedShopRequest<DashboardInsightsResponse>(
        "/api/insights/dashboard",
        { timeoutMs: 25000, retries: 2 }
      );
      if (!mounted.current) return;
      setData(res);
    } catch (err) {
      if (!mounted.current) return;
      const code = err instanceof Error && "code" in err ? String((err as Error & { code?: string }).code ?? "") : "";
      const hasReauth = err instanceof Error && "reauthorizeUrl" in err && !!(err as Error & { reauthorizeUrl?: string }).reauthorizeUrl;
      const msg = err instanceof Error ? err.message : "Could not load insights.";
      if (hasReauth || /session|reconnect|authoriz|MISSING_SHOP/i.test(msg) || code === "MISSING_SHOP_CONTEXT") {
        setAuthRequired(true);
      } else if (code === "INSIGHTS_UNAVAILABLE" || /server problem|unavailable|503/i.test(msg)) {
        setUnavailable(true);
      }
      setError(msg);
    } finally {
      if (mounted.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load(false);
    return () => {
      mounted.current = false;
    };
  }, [load]);

  const reload = useCallback(() => {
    void load(data != null);
  }, [load, data]);

  return { data, loading, refreshing, error, authRequired, unavailable, reload };
}

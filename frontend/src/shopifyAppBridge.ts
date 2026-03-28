import { useMemo } from "react";
import createApp, { AppConfig } from "@shopify/app-bridge";

const apiKey =
  (import.meta.env.VITE_SHOPIFY_API_KEY as string | undefined) || "";
const appCache = new Map<string, ReturnType<typeof createApp>>();

export function useAppBridge() {
  const searchParams = new URLSearchParams(window.location.search);
  const shop = searchParams.get("shop") || "";
  const host = searchParams.get("host") || "";

  const config: AppConfig = useMemo(
    () => ({
      apiKey,
      host,
      forceRedirect: true,
    }),
    [host]
  );

  const cachedApp = useMemo(() => {
    const cacheKey = `${apiKey}|${host || "default"}`;
    const existingApp = appCache.get(cacheKey);
    if (existingApp) {
      return existingApp;
    }

    const nextApp = createApp(config);
    appCache.set(cacheKey, nextApp);
    return nextApp;
  }, [config, host]);

  return { app: cachedApp, shop, host };
}


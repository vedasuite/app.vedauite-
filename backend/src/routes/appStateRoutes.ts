import { Router } from "express";
import { getMerchantAppState } from "../services/appStateService";
import { logEvent } from "../services/observabilityService";
import { resolveAuthenticatedShop } from "./routeShop";

export const appStateRouter = Router();

appStateRouter.get("/", async (req, res) => {
  const shop = resolveAuthenticatedShop(req);
  const sessionShop = (req as typeof req & { shopifySession?: { shop?: string } }).shopifySession
    ?.shop;
  logEvent("info", "app_state.route_request_started", {
    shop,
    hasSessionShop: !!sessionShop,
    hasQueryShop: typeof req.query.shop === "string",
  });

  if (!shop) {
    logEvent("warn", "app_state.route_missing_shop", {
      hasSessionShop: !!sessionShop,
      hasQueryShop: typeof req.query.shop === "string",
    });
    return res.status(400).json({
      error: {
        code: "MISSING_SHOP_CONTEXT",
        message:
          "VedaSuite could not determine which Shopify store is loading. Open the app from Shopify Admin and try again.",
      },
    });
  }

  try {
    logEvent("info", "app_state.installation_fetch_started", { shop });
    const appState = await getMerchantAppState(shop);

    if (!appState?.install?.status) {
      logEvent("error", "app_state.installation_fetch_invalid", {
        shop,
        hasInstall: !!appState?.install,
      });
      return res.status(503).json({
        error: {
          code: "APP_STATE_UNAVAILABLE",
          message:
            "VedaSuite could not load the store setup status. Refresh the app and try again.",
        },
      });
    }

    logEvent("info", "app_state.route_request_succeeded", {
      shop,
      installStatus: appState.install.status,
      connectionStatus: appState.connection.status,
      appStatus: appState.appStatus,
    });
    return res.json({ appState });
  } catch (error) {
    logEvent("error", "app_state.route_request_failed", {
      shop,
      error,
    });
    return res.status(503).json({
      error: {
        code: "APP_STATE_FETCH_FAILED",
        message:
          "VedaSuite could not load the latest store setup details. Please refresh and try again.",
      },
    });
  }
});

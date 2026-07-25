import { Router } from "express";
import { prisma } from "../db/prismaClient";
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
    // Self-heal: a valid Shopify session token is cryptographic proof that the
    // app is currently installed (App Bridge only issues tokens for installed apps).
    // If the DB has uninstalledAt set despite a valid token, a delayed
    // APP_UNINSTALLED webhook arrived after a fresh reinstall and corrupted the
    // record — clear it now so the merchant/reviewer doesn't see the reconnect banner.
    const storeSnapshot = await prisma.store.findUnique({
      where: { shop },
      select: { uninstalledAt: true },
    });
    if (storeSnapshot?.uninstalledAt) {
      await prisma.store.update({
        where: { shop },
        data: {
          uninstalledAt: null,
          authErrorCode: null,
          authErrorMessage: null,
          lastConnectionStatus: "OK",
          lastConnectionError: null,
        },
      });
      logEvent("info", "app_state.self_healed_stale_uninstall", { shop });
    }

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

import type { NextFunction, Request, Response } from "express";
import jwt, { type JwtPayload } from "jsonwebtoken";
import { env } from "../config/env";
import {
  buildReauthorizeUrl,
  normalizeShopDomain,
} from "../services/shopifyConnectionService";
import {
  clearShopifySessionCookie,
  readShopifySessionCookie,
} from "../lib/shopifySessionCookie";
import { logEvent } from "../services/observabilityService";

function sendAuthError(
  req: Request,
  res: Response,
  status: number,
  code:
    | "MISSING_SHOP"
    | "INVALID_SHOPIFY_SESSION_TOKEN"
    | "SHOPIFY_AUTH_REQUIRED",
  message: string,
  shop?: string | null
) {
  const host =
    typeof req.query.host === "string"
      ? req.query.host
      : typeof req.body?.host === "string"
      ? req.body.host
      : undefined;
  const returnTo =
    typeof req.query.returnTo === "string"
      ? req.query.returnTo
      : typeof req.body?.returnTo === "string"
      ? req.body.returnTo
      : req.path;

  return res.status(status).json({
    error: {
      code,
      message,
      reauthorizeUrl: buildReauthorizeUrl(shop, returnTo, host),
    },
  });
}

export function verifyShopifySessionToken(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const requestedShop = normalizeShopDomain(
    (typeof req.query.shop === "string" && req.query.shop) ||
      (typeof req.body?.shop === "string" && req.body.shop) ||
      undefined
  );
  const cookieShop = normalizeShopDomain(readShopifySessionCookie(req));
  const authHeader = req.headers.authorization;

  if (!requestedShop && !cookieShop) {
    return sendAuthError(
      req,
      res,
      401,
      "MISSING_SHOP",
      "Missing Shopify shop context. Reopen the embedded app and retry."
    );
  }

  const acceptCookieSession = () => {
    if (!cookieShop) {
      return false;
    }

    if (requestedShop && cookieShop !== requestedShop) {
      return sendAuthError(
        req,
        res,
        403,
        "INVALID_SHOPIFY_SESSION_TOKEN",
        "Shop parameter does not match the authenticated Shopify session.",
        requestedShop
      );
    }

    (req as Request & { shopifySession?: { shop?: string; sub?: string } }).shopifySession = {
      shop: cookieShop,
      sub: undefined,
    };

    return next();
  };

  if (!authHeader?.startsWith("Bearer ")) {
    return acceptCookieSession();
  }

  const token = authHeader.slice("Bearer ".length);

  try {
    const payload = jwt.verify(token, env.shopifyApiSecret, {
      algorithms: ["HS256"],
      audience: env.shopifyApiKey,
    }) as JwtPayload & { dest?: string };

    const tokenShop = normalizeShopDomain(
      typeof payload.dest === "string" ? new URL(payload.dest).host : undefined
    );

    if (requestedShop && tokenShop && requestedShop !== tokenShop) {
      return sendAuthError(
        req,
        res,
        403,
        "INVALID_SHOPIFY_SESSION_TOKEN",
        "Shop parameter does not match the authenticated Shopify session.",
        requestedShop
      );
    }

    (req as Request & { shopifySession?: { shop?: string; sub?: string } }).shopifySession = {
      shop: tokenShop ?? requestedShop ?? cookieShop ?? undefined,
      sub: typeof payload.sub === "string" ? payload.sub : undefined,
    };

    return next();
  } catch (error) {
    logEvent("warn", "shopify.session_token.invalid", {
      shop: requestedShop ?? cookieShop ?? null,
      route: req.originalUrl,
      error,
    });

    if (acceptCookieSession()) {
      return;
    }

    clearShopifySessionCookie(res);
    return sendAuthError(
      req,
      res,
      401,
      "INVALID_SHOPIFY_SESSION_TOKEN",
      "Invalid Shopify session token. Refresh or reconnect the embedded app and retry.",
      requestedShop
    );
  }
}

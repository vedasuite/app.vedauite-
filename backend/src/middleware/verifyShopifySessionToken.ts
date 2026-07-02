import type { NextFunction, Request, Response } from "express";
import jwt, { type JwtPayload } from "jsonwebtoken";
import { env } from "../config/env";
import {
  buildReauthorizeUrl,
  normalizeShopDomain,
} from "../services/shopifyConnectionService";
import { logEvent } from "../services/observabilityService";

// No cookie fallback — Shopify requires embedded apps to authenticate with
// session tokens exclusively so the app works when third-party cookies are
// blocked (Chrome incognito, Safari ITP, etc.).

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

  // Tell App Bridge to refresh the session token and retry automatically
  if (status === 401) {
    res.setHeader("X-Shopify-Retry-Invalid-Session-Request", "1");
  }

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
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith("Bearer ")) {
    return sendAuthError(
      req,
      res,
      401,
      "MISSING_SHOP",
      "Missing Shopify session token. Reopen the embedded app and retry."
    );
  }

  const token = authHeader.slice("Bearer ".length);
  const requestedShop = normalizeShopDomain(
    (typeof req.query.shop === "string" && req.query.shop) ||
      (typeof req.body?.shop === "string" && req.body.shop) ||
      undefined
  );

  try {
    const payload = jwt.verify(token, env.shopifyApiSecret, {
      algorithms: ["HS256"],
      audience: env.shopifyApiKey,
    }) as JwtPayload & { dest?: string; iss?: string };

    // Docs require iss and dest top-level domains to match
    if (typeof payload.iss === "string" && typeof payload.dest === "string") {
      try {
        const issHost = new URL(payload.iss).host;
        const destHost = new URL(payload.dest).host;
        if (issHost !== destHost) {
          throw new Error("iss/dest domain mismatch");
        }
      } catch {
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
      shop: tokenShop ?? requestedShop ?? undefined,
      sub: typeof payload.sub === "string" ? payload.sub : undefined,
    };

    return next();
  } catch (error) {
    logEvent("warn", "shopify.session_token.invalid", {
      shop: requestedShop ?? null,
      route: req.originalUrl,
      error,
    });

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

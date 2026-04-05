import type { NextFunction, Request, Response } from "express";
import jwt, { type JwtPayload } from "jsonwebtoken";
import { env } from "../config/env";
import {
  clearShopifySessionCookie,
  readShopifySessionCookie,
} from "../lib/shopifySessionCookie";

function buildReauthorizeUrl(shop?: string) {
  if (!shop) {
    return undefined;
  }

  return new URL(
    `/auth/install?shop=${encodeURIComponent(shop)}`,
    env.shopifyAppUrl
  ).toString();
}

export function verifyShopifySessionToken(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const authHeader = req.headers.authorization;
  const requestedShop =
    (typeof req.query.shop === "string" && req.query.shop) ||
    (typeof req.body?.shop === "string" && req.body.shop) ||
    undefined;
  const cookieShop = readShopifySessionCookie(req);

  const acceptCookieSession = () => {
    if (!cookieShop) {
      return false;
    }

    if (requestedShop && cookieShop !== requestedShop) {
      return res.status(403).json({
        error: {
          message: "Shop parameter does not match the authenticated Shopify session.",
        },
      });
    }

    (req as Request & { shopifySession?: { shop?: string; sub?: string } }).shopifySession = {
      shop: cookieShop,
      sub: undefined,
    };

    next();
    return true;
  };

  if (!authHeader?.startsWith("Bearer ")) {
    if (acceptCookieSession()) {
      return;
    }

    return res.status(401).json({
      error: {
        message: "Missing Shopify session token. Reload the embedded app and try again.",
        reauthorizeUrl: buildReauthorizeUrl(requestedShop),
      },
    });
  }

  const token = authHeader.slice("Bearer ".length);

  try {
    const payload = jwt.verify(token, env.shopifyApiSecret, {
      algorithms: ["HS256"],
      audience: env.shopifyApiKey,
    }) as JwtPayload & { dest?: string };

    const tokenShop =
      typeof payload.dest === "string" ? new URL(payload.dest).host : undefined;

    if (requestedShop && tokenShop && requestedShop !== tokenShop) {
      return res.status(403).json({
        error: {
          message: "Shop parameter does not match the authenticated Shopify session.",
        },
      });
    }

    (req as Request & { shopifySession?: { shop?: string; sub?: string } }).shopifySession = {
      shop: tokenShop,
      sub: typeof payload.sub === "string" ? payload.sub : undefined,
    };

    return next();
  } catch {
    if (acceptCookieSession()) {
      return;
    }

    if (!cookieShop) {
      clearShopifySessionCookie(res);
    }

    return res.status(401).json({
      error: {
        message: "Invalid Shopify session token. Reopen or reauthorize the embedded app and retry.",
        reauthorizeUrl: buildReauthorizeUrl(requestedShop),
      },
    });
  }
}

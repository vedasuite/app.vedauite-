import type { Request, Response } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env";

const SHOPIFY_SESSION_COOKIE = "vedasuite_embedded_session";
const COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

type ShopifyCookiePayload = {
  shop: string;
};

export function setShopifySessionCookie(res: Response, shop: string) {
  const token = jwt.sign({ shop } satisfies ShopifyCookiePayload, env.shopifyApiSecret, {
    algorithm: "HS256",
    audience: env.shopifyApiKey,
    expiresIn: "7d",
    issuer: "vedasuite",
  });

  res.cookie(SHOPIFY_SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "none",
    path: "/",
    maxAge: COOKIE_MAX_AGE_MS,
  });
}

export function clearShopifySessionCookie(res: Response) {
  res.clearCookie(SHOPIFY_SESSION_COOKIE, {
    httpOnly: true,
    secure: true,
    sameSite: "none",
    path: "/",
  });
}

export function readShopifySessionCookie(req: Request) {
  const rawCookie =
    typeof req.cookies?.[SHOPIFY_SESSION_COOKIE] === "string"
      ? (req.cookies[SHOPIFY_SESSION_COOKIE] as string)
      : null;

  if (!rawCookie) {
    return null;
  }

  try {
    const payload = jwt.verify(rawCookie, env.shopifyApiSecret, {
      algorithms: ["HS256"],
      audience: env.shopifyApiKey,
      issuer: "vedasuite",
    }) as ShopifyCookiePayload;

    return payload.shop || null;
  } catch {
    return null;
  }
}

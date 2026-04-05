import type { Request, Response } from "express";
import crypto from "crypto";
import { env } from "../config/env";

const SHOPIFY_OAUTH_STATE_COOKIE = "vedasuite_oauth_state";
const COOKIE_MAX_AGE_MS = 15 * 60 * 1000;

export type ShopifyOAuthStatePayload = {
  shop: string;
  state: string;
  host?: string | null;
  returnTo?: string | null;
};

function toBase64Url(value: string) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function fromBase64Url(value: string) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function buildCookieValue(payload: ShopifyOAuthStatePayload) {
  const encodedPayload = toBase64Url(
    JSON.stringify({
      shop: payload.shop,
      state: payload.state,
      host: payload.host ?? null,
      returnTo: payload.returnTo ?? null,
    })
  );
  const signature = crypto
    .createHmac("sha256", env.shopifyApiSecret)
    .update(encodedPayload)
    .digest("hex");

  return `${encodedPayload}.${signature}`;
}

function parseCookieValue(raw: string | undefined) {
  if (!raw) {
    return null;
  }

  const [encodedPayload, signature] = raw.split(".");
  if (!encodedPayload || !signature) {
    return null;
  }

  const expected = crypto
    .createHmac("sha256", env.shopifyApiSecret)
    .update(encodedPayload)
    .digest("hex");

  const provided = Buffer.from(signature);
  const generated = Buffer.from(expected);

  if (provided.length !== generated.length) {
    return null;
  }

  if (!crypto.timingSafeEqual(provided, generated)) {
    return null;
  }

  try {
    const payload = JSON.parse(
      fromBase64Url(encodedPayload)
    ) as ShopifyOAuthStatePayload;

    if (!payload.shop || !payload.state) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

export function createShopifyOAuthState() {
  return crypto.randomBytes(24).toString("hex");
}

export function setShopifyOAuthStateCookie(
  res: Response,
  payload: ShopifyOAuthStatePayload
) {
  res.cookie(SHOPIFY_OAUTH_STATE_COOKIE, buildCookieValue(payload), {
    httpOnly: true,
    secure: true,
    sameSite: "none",
    path: "/",
    maxAge: COOKIE_MAX_AGE_MS,
  });
}

export function readShopifyOAuthStateCookie(req: Request) {
  const rawCookie =
    typeof req.cookies?.[SHOPIFY_OAUTH_STATE_COOKIE] === "string"
      ? (req.cookies[SHOPIFY_OAUTH_STATE_COOKIE] as string)
      : undefined;

  return parseCookieValue(rawCookie);
}

export function clearShopifyOAuthStateCookie(res: Response) {
  res.clearCookie(SHOPIFY_OAUTH_STATE_COOKIE, {
    httpOnly: true,
    secure: true,
    sameSite: "none",
    path: "/",
  });
}

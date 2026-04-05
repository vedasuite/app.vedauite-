import type { Request, Response } from "express";
import crypto from "crypto";

const SHOPIFY_OAUTH_STATE_COOKIE = "vedasuite_oauth_state";
const COOKIE_MAX_AGE_MS = 15 * 60 * 1000;

function buildCookieValue(shop: string, state: string) {
  const payload = `${shop}|${state}`;
  const signature = crypto
    .createHmac("sha256", process.env.SHOPIFY_API_SECRET || "")
    .update(payload)
    .digest("hex");

  return `${payload}|${signature}`;
}

function parseCookieValue(raw: string | undefined) {
  if (!raw) {
    return null;
  }

  const [shop, state, signature] = raw.split("|");
  if (!shop || !state || !signature) {
    return null;
  }

  const expected = crypto
    .createHmac("sha256", process.env.SHOPIFY_API_SECRET || "")
    .update(`${shop}|${state}`)
    .digest("hex");

  const provided = Buffer.from(signature);
  const generated = Buffer.from(expected);

  if (provided.length !== generated.length) {
    return null;
  }

  if (!crypto.timingSafeEqual(provided, generated)) {
    return null;
  }

  return { shop, state };
}

export function createShopifyOAuthState() {
  return crypto.randomBytes(24).toString("hex");
}

export function setShopifyOAuthStateCookie(res: Response, shop: string, state: string) {
  res.cookie(SHOPIFY_OAUTH_STATE_COOKIE, buildCookieValue(shop, state), {
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

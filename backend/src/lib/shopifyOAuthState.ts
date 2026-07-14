import crypto from "crypto";
import { env } from "../config/env";

// The OAuth "state" (CSRF) value is self-contained and signed — Shopify just
// echoes it back unchanged in the callback. This avoids storing state in a
// cookie: a cookie can be overwritten by a second, concurrent /auth/install
// hit (common with review-bot double-probing) before the first OAuth flow
// completes, causing spurious "state mismatch" failures on legitimate
// installs. A self-verifying state has nothing to race against.
// 30 minutes: generous enough for a human reviewer who reads docs between
// clicking install and completing the OAuth consent, but short enough to
// limit replay risk. The callback auto-restarts the flow if a token expires,
// so the merchant/reviewer never hits a dead-end page.
const STATE_MAX_AGE_MS = 30 * 60 * 1000;

export type ShopifyOAuthStatePayload = {
  shop: string;
  host?: string | null;
  returnTo?: string | null;
};

type SignedStateBody = ShopifyOAuthStatePayload & {
  nonce: string;
  issuedAt: number;
};

function toBase64Url(value: string) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function fromBase64Url(value: string) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function sign(value: string) {
  return crypto.createHmac("sha256", env.shopifyApiSecret).update(value).digest("hex");
}

function safeEqual(a: string, b: string) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

export function createShopifyOAuthState(payload: ShopifyOAuthStatePayload) {
  const body: SignedStateBody = {
    shop: payload.shop,
    host: payload.host ?? null,
    returnTo: payload.returnTo ?? null,
    nonce: crypto.randomBytes(16).toString("hex"),
    issuedAt: Date.now(),
  };

  const encoded = toBase64Url(JSON.stringify(body));
  const signature = sign(encoded);
  return `${encoded}.${signature}`;
}

export type OAuthStateResult =
  | { ok: true; payload: ShopifyOAuthStatePayload }
  | { ok: false; reason: "expired" | "invalid" };

export function verifyShopifyOAuthState(
  state: string | undefined,
  expectedShop: string
): OAuthStateResult {
  if (!state) {
    return { ok: false, reason: "invalid" };
  }

  const separatorIndex = state.lastIndexOf(".");
  if (separatorIndex === -1) {
    return { ok: false, reason: "invalid" };
  }

  const encoded = state.slice(0, separatorIndex);
  const signature = state.slice(separatorIndex + 1);
  if (!encoded || !signature) {
    return { ok: false, reason: "invalid" };
  }

  const expectedSignature = sign(encoded);
  if (!safeEqual(signature, expectedSignature)) {
    return { ok: false, reason: "invalid" };
  }

  let body: SignedStateBody;
  try {
    body = JSON.parse(fromBase64Url(encoded)) as SignedStateBody;
  } catch {
    return { ok: false, reason: "invalid" };
  }

  if (!body.shop || body.shop !== expectedShop) {
    return { ok: false, reason: "invalid" };
  }

  if (!body.issuedAt || Date.now() - body.issuedAt > STATE_MAX_AGE_MS) {
    return { ok: false, reason: "expired" };
  }

  return { ok: true, payload: { shop: body.shop, host: body.host, returnTo: body.returnTo } };
}

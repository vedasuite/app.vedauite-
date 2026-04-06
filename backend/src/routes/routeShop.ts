import type { Request } from "express";
import { normalizeShopDomain } from "../services/shopifyConnectionService";

type SessionRequest = Request & {
  shopifySession?: {
    shop?: string;
  };
};

export function resolveAuthenticatedShop(req: Request) {
  const sessionShop = normalizeShopDomain(
    (req as SessionRequest).shopifySession?.shop
  );
  const queryShop = normalizeShopDomain(
    typeof req.query.shop === "string" ? req.query.shop : undefined
  );
  const bodyShop = normalizeShopDomain(
    typeof req.body?.shop === "string" ? req.body.shop : undefined
  );

  return sessionShop ?? queryShop ?? bodyShop ?? null;
}

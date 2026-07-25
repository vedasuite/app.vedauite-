import type { NextFunction, Request, Response } from "express";
import { ensureOfflineAccessToken } from "../services/shopifyConnectionService";

/**
 * Runs after `verifyShopifySessionToken`, so the request is already proven to
 * come from a merchant inside the installed embedded app.
 *
 * Guarantees an offline Admin API access token exists for the shop before any
 * route handler runs, minting one via token exchange when it is missing or
 * expired. This is what keeps a merchant from ever hitting a "Reconnect"
 * dead end: the session token they already hold is sufficient to recover.
 *
 * Never blocks the request — if the exchange fails, the route proceeds and the
 * usual connection-health messaging surfaces the problem.
 */
export async function ensureOfflineToken(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const session = (
    req as Request & { shopifySession?: { shop?: string; token?: string } }
  ).shopifySession;

  if (session?.shop && session.token) {
    try {
      await ensureOfflineAccessToken(session.shop, session.token);
    } catch {
      // ensureOfflineAccessToken already logs; never fail the request here.
    }
  }

  return next();
}

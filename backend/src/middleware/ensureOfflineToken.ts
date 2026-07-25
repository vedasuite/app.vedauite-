import type { NextFunction, Request, Response } from "express";
import { env } from "../config/env";
import { prisma } from "../db/prismaClient";
import { logEvent } from "../services/observabilityService";
import { registerSyncWebhooks } from "../services/shopifyAdminService";
import { ensureOfflineAccessToken } from "../services/shopifyConnectionService";

// Shops with an in-flight webhook registration, so concurrent requests during a
// page load don't each fire their own registration against Shopify.
const webhookRegistrationInFlight = new Set<string>();

/**
 * Register the mandatory sync webhooks if they are not registered yet.
 *
 * Registration is fire-and-forget at install time, so it can be missed if that
 * call failed or the installation record was created by token exchange rather
 * than the OAuth callback. Retrying here means a store always converges to full
 * webhook coverage without the merchant being shown anything.
 */
function backfillWebhooksIfMissing(shop: string) {
  if (webhookRegistrationInFlight.has(shop)) {
    return;
  }
  webhookRegistrationInFlight.add(shop);

  void (async () => {
    try {
      const store = await prisma.store.findUnique({
        where: { shop },
        select: { webhooksRegisteredAt: true, accessToken: true },
      });

      if (!store?.accessToken || store.webhooksRegisteredAt) {
        return;
      }

      await registerSyncWebhooks(shop, env.shopifyAppUrl);
      logEvent("info", "shopify.webhooks.backfilled", { shop });
    } catch (error) {
      logEvent("warn", "shopify.webhooks.backfill_failed", { shop, error });
    } finally {
      webhookRegistrationInFlight.delete(shop);
    }
  })();
}

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
      const hasToken = await ensureOfflineAccessToken(session.shop, session.token);
      if (hasToken) {
        // Fire-and-forget — never delays the response.
        backfillWebhooksIfMissing(session.shop);
      }
    } catch {
      // ensureOfflineAccessToken already logs; never fail the request here.
    }
  }

  return next();
}

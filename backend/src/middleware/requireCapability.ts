import type { NextFunction, Request, Response } from "express";
import type { Capability } from "../billing/capabilities";
import { getCurrentSubscription } from "../services/subscriptionService";

function resolveShop(req: Request) {
  const queryShop = typeof req.query.shop === "string" ? req.query.shop : undefined;
  const bodyShop =
    typeof req.body?.shop === "string" ? (req.body.shop as string) : undefined;
  const sessionShop = (req as Request & { shopifySession?: { shop?: string } })
    .shopifySession?.shop;

  return queryShop ?? bodyShop ?? sessionShop;
}

export function requireCapability(capability: Capability) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const shop = resolveShop(req);
    const sessionShop = (req as Request & { shopifySession?: { shop?: string } })
      .shopifySession?.shop;

    if (!sessionShop) {
      return res.status(401).json({
        error: {
          message:
            "Missing Shopify session context. Reload the embedded app and try again.",
        },
      });
    }

    if (!shop) {
      return res.status(400).json({ error: "Missing shop." });
    }

    if (shop !== sessionShop) {
      return res.status(403).json({
        error: {
          message:
            "Shop parameter does not match the authenticated Shopify session.",
        },
      });
    }

    const subscription = await getCurrentSubscription(shop);
    if (!subscription.capabilities[capability]) {
      return res.status(403).json({
        error: {
          message: `Your current plan does not include ${capability}.`,
          requiredCapability: capability,
          currentPlan: subscription.planName,
        },
      });
    }

    return next();
  };
}

import type { NextFunction, Request, Response } from "express";
import { getCurrentSubscription } from "../services/subscriptionService";
import { resolveAuthenticatedShop } from "../routes/routeShop";

export type ProductFeature =
  | "fraud"
  | "competitor"
  | "pricing"
  | "creditScore"
  | "profitOptimization"
  | "reports";

const FEATURE_RULES: Record<
  ProductFeature,
  { requiredPlan: "STARTER" | "GROWTH" | "PRO"; isEnabled: (subscription: Awaited<ReturnType<typeof getCurrentSubscription>>) => boolean }
> = {
  fraud: {
    requiredPlan: "STARTER",
    isEnabled: (subscription) => subscription.enabledModules.fraud,
  },
  competitor: {
    requiredPlan: "STARTER",
    isEnabled: (subscription) => subscription.enabledModules.competitor,
  },
  pricing: {
    requiredPlan: "GROWTH",
    isEnabled: (subscription) => subscription.enabledModules.pricing,
  },
  creditScore: {
    requiredPlan: "GROWTH",
    isEnabled: (subscription) => subscription.enabledModules.creditScore,
  },
  profitOptimization: {
    requiredPlan: "PRO",
    isEnabled: (subscription) => subscription.enabledModules.profitOptimization,
  },
  reports: {
    requiredPlan: "GROWTH",
    isEnabled: (subscription) => subscription.enabledModules.reports,
  },
};

export function requireFeature(feature: ProductFeature) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const shop = resolveAuthenticatedShop(req);
    const sessionShop = (req as Request & { shopifySession?: { shop?: string } })
      .shopifySession?.shop;

    if (!sessionShop) {
      return res.status(401).json({
        error: {
          code: "REAUTHORIZE_REQUIRED",
          message:
            "Your Shopify session expired. Reload VedaSuite from Shopify Admin and try again.",
        },
      });
    }

    if (!shop) {
      return res.status(400).json({
        error: {
          code: "MISSING_SHOP_CONTEXT",
          message:
            "VedaSuite could not determine which Shopify store is loading. Open the app from Shopify Admin and try again.",
        },
      });
    }

    if (shop !== sessionShop) {
      return res.status(403).json({
        error: {
          code: "SHOP_CONTEXT_MISMATCH",
          message:
            "The Shopify session does not match the current store context. Reload the embedded app and try again.",
        },
      });
    }

    const subscription = await getCurrentSubscription(shop);
    const rule = FEATURE_RULES[feature];
    if (!rule.isEnabled(subscription)) {
      return res.status(403).json({
        error: {
          code: "FEATURE_LOCKED",
          message: "This feature is not included in your current plan.",
          requiredPlan: rule.requiredPlan,
          currentPlan: subscription.planName,
          upgradePath: "/app/billing",
        },
      });
    }

    return next();
  };
}

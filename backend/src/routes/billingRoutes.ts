import { Router, type Response } from "express";
import {
  normalizePlanName,
  normalizeStarterModule,
  type BillingPlanName,
  type StarterModule,
} from "../billing/capabilities";
import { env } from "../config/env";
import { verifyShopifySessionToken } from "../middleware/verifyShopifySessionToken";
import {
  cancelBillingPlan,
  confirmBillingApprovalReturn,
  getBillingManagementState,
  requestBillingPlanChange,
} from "../services/billingManagementService";
import { resolveAuthenticatedShop } from "./routeShop";

export const billingRouter = Router();
export const billingApiRouter = Router();

function redirectTopLevel(res: Response, url: string) {
  const safeUrl = JSON.stringify(url);
  res.status(200).send(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Redirecting...</title>
    <script>
      if (window.top && window.top !== window) {
        window.top.location.href = ${safeUrl};
      } else {
        window.location.href = ${safeUrl};
      }
    </script>
  </head>
  <body>
    <p>Redirecting back to VedaSuite...</p>
    <p><a href=${safeUrl}>Continue</a></p>
  </body>
</html>`);
}

function buildSubscriptionReturnUrl(params: {
  shop: string;
  host?: string | null;
  billingResult: "confirmed" | "failed" | "noop";
  intentId?: string | null;
  plan?: string | null;
  starterModule?: string | null;
  message?: string | null;
}) {
  const redirectUrl = new URL("/subscription", env.shopifyAppUrl);
  redirectUrl.searchParams.set("shop", params.shop);
  redirectUrl.searchParams.set("billingResult", params.billingResult);
  if (params.host) {
    redirectUrl.searchParams.set("host", params.host);
  }
  if (params.intentId) {
    redirectUrl.searchParams.set("intentId", params.intentId);
  }
  if (params.plan) {
    redirectUrl.searchParams.set("plan", params.plan);
  }
  if (params.starterModule) {
    redirectUrl.searchParams.set("starterModule", params.starterModule);
  }
  if (params.message) {
    redirectUrl.searchParams.set("billingMessage", params.message);
  }
  return redirectUrl.toString();
}

function parseRequestedPlan(value?: string | null): BillingPlanName | null {
  const plan = normalizePlanName(value);
  if (!plan || plan === "NONE" || plan === "TRIAL") {
    return null;
  }
  return plan;
}

function parseStarterModule(value?: string | null): StarterModule | null {
  return normalizeStarterModule(value);
}

billingApiRouter.get("/state", async (req, res) => {
  const shop = resolveAuthenticatedShop(req);
  if (!shop) {
    return res.status(400).json({ error: "Missing shop." });
  }

  const billing = await getBillingManagementState(shop);
  return res.json({ billing });
});

billingApiRouter.post("/change-plan", async (req, res) => {
  const shop = resolveAuthenticatedShop(req);
  const body = req.body as {
    plan?: string | null;
    starterModule?: string | null;
    host?: string | null;
    returnPath?: string | null;
  };

  if (!shop) {
    return res.status(400).json({ error: "Missing shop." });
  }

  const plan = parseRequestedPlan(body.plan);
  if (!plan) {
    return res.status(400).json({ error: "Unsupported billing plan." });
  }

  try {
    const result = await requestBillingPlanChange({
      shopDomain: shop,
      requestedPlan: plan,
      starterModule: parseStarterModule(body.starterModule),
      host: body.host ?? null,
      returnPath: body.returnPath ?? "/subscription",
    });
    return res.json({ result });
  } catch (error) {
    return res.status(400).json({
      error: error instanceof Error ? error.message : "Unable to change billing plan.",
    });
  }
});

billingApiRouter.post("/cancel-plan", async (req, res) => {
  const shop = resolveAuthenticatedShop(req);
  const body = req.body as { confirm?: boolean };

  if (!shop) {
    return res.status(400).json({ error: "Missing shop." });
  }

  if (!body.confirm) {
    return res.status(400).json({
      error: "Cancellation requires explicit confirmation.",
    });
  }

  try {
    const result = await cancelBillingPlan(shop);
    return res.json({ result });
  } catch (error) {
    return res.status(400).json({
      error:
        error instanceof Error
          ? error.message
          : "Unable to cancel the current subscription.",
    });
  }
});

billingApiRouter.post("/confirm-return", async (req, res) => {
  const shop = resolveAuthenticatedShop(req);
  const body = req.body as { intentId?: string | null };

  if (!shop) {
    return res.status(400).json({ error: "Missing shop." });
  }

  try {
    const result = await confirmBillingApprovalReturn({
      shopDomain: shop,
      intentId: body.intentId ?? null,
    });
    return res.json({ result });
  } catch (error) {
    return res.status(400).json({
      error:
        error instanceof Error
          ? error.message
          : "Unable to confirm the Shopify billing return.",
    });
  }
});

billingRouter.post(
  "/create-recurring",
  verifyShopifySessionToken,
  async (req, res) => {
    const shop = resolveAuthenticatedShop(req);
    const body = req.body as {
      planName?: string | null;
      starterModule?: string | null;
      host?: string | null;
      returnPath?: string | null;
    };

    if (!shop) {
      return res.status(400).json({ error: "Missing shop." });
    }

    const plan = parseRequestedPlan(body.planName);
    if (!plan) {
      return res.status(400).json({ error: "Unsupported billing plan." });
    }

    try {
      const result = await requestBillingPlanChange({
        shopDomain: shop,
        requestedPlan: plan,
        starterModule: parseStarterModule(body.starterModule),
        host: body.host ?? null,
        returnPath: body.returnPath ?? "/subscription",
      });

      if (result.outcome !== "REDIRECT_REQUIRED") {
        return res.json({ result });
      }

      return res.json({
        confirmationUrl: result.confirmationUrl,
        pendingIntent: result.pendingIntent,
      });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Unable to create billing charge.";

      return res.status(400).json({ error: { message } });
    }
  }
);

billingRouter.get("/start", async (req, res) => {
  const { shop, host, planName, starterModule, returnPath } = req.query as {
    shop?: string;
    host?: string;
    planName?: string;
    starterModule?: string;
    returnPath?: string;
  };

  if (!shop || !planName) {
    return res.status(400).send("Missing shop or planName.");
  }

  const normalizedPlan = parseRequestedPlan(planName);
  if (!normalizedPlan) {
    return res.status(400).send("Unsupported billing plan.");
  }

  try {
    const result = await requestBillingPlanChange({
      shopDomain: shop,
      requestedPlan: normalizedPlan,
      starterModule: parseStarterModule(starterModule),
      host: host ?? null,
      returnPath: returnPath ?? "/subscription",
    });

    if (result.outcome === "REDIRECT_REQUIRED") {
      return res.redirect(result.confirmationUrl);
    }

    return redirectTopLevel(
      res,
      buildSubscriptionReturnUrl({
        shop,
        host: host ?? null,
        billingResult: result.outcome === "UPDATED" ? "confirmed" : "noop",
        plan: result.state.subscription.planName,
        starterModule: result.state.subscription.starterModule,
        message: result.message,
      })
    );
  } catch (error) {
    return redirectTopLevel(
      res,
      buildSubscriptionReturnUrl({
        shop,
        host: host ?? null,
        billingResult: "failed",
        plan: normalizedPlan,
        starterModule: parseStarterModule(starterModule),
        message:
          error instanceof Error
            ? error.message
            : "Unable to start Shopify billing approval.",
      })
    );
  }
});

billingRouter.get("/activate", async (req, res) => {
  const { shop, host, intentId } = req.query as {
    shop?: string;
    host?: string;
    intentId?: string;
  };

  if (!shop) {
    return res.status(400).send("Missing billing activation parameters.");
  }

  try {
    const result = await confirmBillingApprovalReturn({
      shopDomain: shop,
      intentId: intentId ?? null,
    });

    return redirectTopLevel(
      res,
      buildSubscriptionReturnUrl({
        shop,
        host: host ?? null,
        billingResult: "confirmed",
        intentId: intentId ?? null,
        plan: result.subscription.planName,
        starterModule: result.subscription.starterModule,
      })
    );
  } catch (error) {
    return redirectTopLevel(
      res,
      buildSubscriptionReturnUrl({
        shop,
        host: host ?? null,
        billingResult: "failed",
        intentId: intentId ?? null,
        message:
          error instanceof Error
            ? error.message
            : "Unable to confirm Shopify billing activation.",
      })
    );
  }
});

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
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>VedaSuite billing redirect</title>
    <style>
      :root {
        color-scheme: light;
        font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: #f6f6f7;
        color: #202223;
      }
      .shell {
        width: min(520px, calc(100vw - 32px));
        background: #ffffff;
        border-radius: 18px;
        box-shadow: 0 12px 32px rgba(0, 0, 0, 0.08);
        padding: 32px 28px;
        text-align: center;
      }
      .spinner {
        width: 40px;
        height: 40px;
        margin: 0 auto 18px;
        border-radius: 999px;
        border: 4px solid #dfe3e8;
        border-top-color: #008060;
        animation: spin 0.9s linear infinite;
      }
      @keyframes spin {
        to { transform: rotate(360deg); }
      }
      h1 {
        margin: 0 0 10px;
        font-size: 22px;
      }
      p {
        margin: 0 0 10px;
        line-height: 1.5;
        color: #5c5f62;
      }
      .actions {
        margin-top: 18px;
        display: inline-flex;
        gap: 12px;
        flex-wrap: wrap;
        justify-content: center;
      }
      a {
        color: #ffffff;
        background: #008060;
        text-decoration: none;
        border-radius: 10px;
        padding: 10px 16px;
        font-weight: 600;
      }
      .secondary {
        background: #f1f2f4;
        color: #202223;
      }
      .timeout {
        display: none;
        margin-top: 14px;
      }
    </style>
    <script>
      let redirected = false;
      function continueToApp() {
        if (redirected) return;
        redirected = true;
        if (window.top && window.top !== window) {
          window.top.location.href = ${safeUrl};
        } else {
          window.location.href = ${safeUrl};
        }
      }
      window.setTimeout(() => {
        const timeout = document.getElementById("timeout-state");
        if (timeout) {
          timeout.style.display = "block";
        }
      }, 10000);
      window.setTimeout(continueToApp, 150);
      if (window.top && window.top !== window) {
        window.top.location.href = ${safeUrl};
      } else {
        window.location.href = ${safeUrl};
      }
    </script>
  </head>
  <body>
    <div class="shell">
      <div class="spinner" aria-hidden="true"></div>
      <h1>Returning to VedaSuite...</h1>
      <p>Shopify has finished the billing step.</p>
      <p>VedaSuite is restoring your embedded session and loading the updated plan.</p>
      <div class="actions">
        <a href=${safeUrl}>Continue</a>
        <a class="secondary" href="javascript:void(0)" onclick="continueToApp()">Retry now</a>
      </div>
      <div class="timeout" id="timeout-state">
        <p>Still working? Use Continue or Retry now to reopen the app.</p>
      </div>
    </div>
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
  const redirectUrl = new URL("/app/billing", env.shopifyAppUrl);
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
      returnPath: body.returnPath ?? "/app/billing",
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
        returnPath: body.returnPath ?? "/app/billing",
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
      returnPath: returnPath ?? "/app/billing",
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

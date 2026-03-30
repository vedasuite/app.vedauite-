import { Router, type Response } from "express";
import { env } from "../config/env";
import { prisma } from "../db/prismaClient";
import { verifyShopifySessionToken } from "../middleware/verifyShopifySessionToken";
import {
  createAppSubscription,
  getActiveAppSubscription,
} from "../services/shopifyAdminService";

export const billingRouter = Router();

function redirectTopLevel(res: Response, url: string) {
  const safeUrl = JSON.stringify(url);
  res.status(200).send(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Redirecting…</title>
    <script>
      if (window.top && window.top !== window) {
        window.top.location.href = ${safeUrl};
      } else {
        window.location.href = ${safeUrl};
      }
    </script>
  </head>
  <body>
    <p>Redirecting back to VedaSuite…</p>
    <p><a href=${safeUrl}>Continue</a></p>
  </body>
</html>`);
}

function buildBillingReturnUrl(params: {
  shop: string;
  host?: string;
  planName: string;
  starterModule?: "fraud" | "competitor";
}) {
  const returnUrl = new URL(`${env.shopifyAppUrl}/billing/activate`);
  returnUrl.searchParams.set("shop", params.shop);
  returnUrl.searchParams.set("plan", params.planName);
  if (params.host) {
    returnUrl.searchParams.set("host", params.host);
  }
  if (params.starterModule) {
    returnUrl.searchParams.set("starterModule", params.starterModule);
  }

  return returnUrl;
}

async function resolvePlanRecord(planName: string) {
  return (
    (await prisma.subscriptionPlan.findFirst({
      where: { name: planName },
    })) ||
    (await prisma.subscriptionPlan.create({
      data: {
        name: planName,
        price:
          planName === "STARTER"
            ? env.billing.starterPrice
            : planName === "GROWTH"
            ? env.billing.growthPrice
            : env.billing.proPrice,
        trialDays: env.billing.trialDays,
        features: JSON.stringify({ planName }),
      },
    }))
  );
}

async function createBillingRedirect(params: {
  shop: string;
  host?: string;
  planName: string;
  starterModule?: "fraud" | "competitor";
}): Promise<string> {
  const store = await prisma.store.findUnique({
    where: { shop: params.shop },
    include: {
      subscription: {
        include: {
          plan: true,
        },
      },
    },
  });

  if (!store) {
    throw new Error("Store not found");
  }

  const plan = await resolvePlanRecord(params.planName);
  const returnUrl = buildBillingReturnUrl(params);

  const billing = await createAppSubscription({
    shopDomain: params.shop,
    name: `VedaSuite AI - ${params.planName}`,
    price: plan.price,
    returnUrl: returnUrl.toString(),
    trialDays: plan.trialDays,
    test: env.billing.testMode,
  });

  if (!billing.confirmationUrl) {
    throw new Error("Shopify did not return a billing confirmation URL.");
  }

  return billing.confirmationUrl;
}

billingRouter.post("/create-recurring", verifyShopifySessionToken, async (req, res) => {
  const { shop, host, planName, starterModule } = req.body as {
    shop: string;
    host?: string;
    planName: string;
    starterModule?: "fraud" | "competitor";
  };

  if (!shop || !planName) {
    return res.status(400).json({ error: "Missing shop or planName" });
  }

  if (planName === "STARTER" && !starterModule) {
    return res
      .status(400)
      .json({ error: "Starter plan requires a starterModule selection." });
  }

  try {
    const confirmationUrl = await createBillingRedirect({
      shop,
      host,
      planName,
      starterModule,
    });

    return res.json({
      confirmationUrl,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to create billing charge.";

    if (/reauthorize the app/i.test(message)) {
      const reauthorizeUrl = new URL("/auth/install", env.shopifyAppUrl);
      reauthorizeUrl.searchParams.set("shop", shop);

      return res.status(401).json({
        error: {
          message,
          reauthorizeUrl: reauthorizeUrl.toString(),
        },
      });
    }

    throw error;
  }
});

billingRouter.get("/start", async (req, res) => {
  const { shop, host, planName, starterModule } = req.query as {
    shop?: string;
    host?: string;
    planName?: string;
    starterModule?: "fraud" | "competitor";
  };

  if (!shop || !planName) {
    return res.status(400).send("Missing shop or planName.");
  }

  if (planName === "STARTER" && !starterModule) {
    return res.status(400).send("Starter plan requires a starterModule selection.");
  }

  try {
    const confirmationUrl = await createBillingRedirect({
      shop,
      host,
      planName,
      starterModule,
    });

    return res.redirect(confirmationUrl);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to open Shopify billing confirmation.";
    const fallback = new URL(`${env.shopifyAppUrl}/subscription`);
    fallback.searchParams.set("shop", shop);
    if (host) {
      fallback.searchParams.set("host", host);
    }
    fallback.searchParams.set("billingError", message);
    return res.redirect(fallback.toString());
  }
});

billingRouter.get("/activate", async (req, res) => {
  const { shop, plan, starterModule, host } = req.query;

  if (!shop || !plan) {
    return res.status(400).send("Missing billing activation parameters.");
  }

  const store = await prisma.store.findUnique({
    where: { shop: String(shop) },
  });
  if (!store) {
    return res.status(404).send("Store not found.");
  }

  const planRecord = await prisma.subscriptionPlan.findFirst({
    where: { name: String(plan) },
  });
  if (!planRecord) {
    return res.status(404).send("Plan not found.");
  }

  const activeSubscription = await getActiveAppSubscription(String(shop));
  if (!activeSubscription) {
    return res.status(400).send("No active Shopify app subscription found.");
  }

  const currentPeriodEnd = activeSubscription.currentPeriodEnd
    ? new Date(activeSubscription.currentPeriodEnd)
    : null;

  await prisma.storeSubscription.upsert({
    where: { storeId: store.id },
    update: {
      planId: planRecord.id,
      starterModule: typeof starterModule === "string" ? starterModule : null,
      shopifyChargeId: activeSubscription.id,
      active: true,
      endsAt: currentPeriodEnd,
    },
    create: {
      storeId: store.id,
      planId: planRecord.id,
      starterModule: typeof starterModule === "string" ? starterModule : null,
      shopifyChargeId: activeSubscription.id,
      active: true,
      endsAt: currentPeriodEnd,
    },
  });

  const redirectUrl = new URL(`${env.shopifyAppUrl}/subscription`);
  redirectUrl.searchParams.set("shop", String(shop));
  redirectUrl.searchParams.set("billing", "activated");
  redirectUrl.searchParams.set("plan", String(plan));
  if (typeof host === "string" && host) {
    redirectUrl.searchParams.set("host", host);
  }
  if (typeof starterModule === "string" && starterModule) {
    redirectUrl.searchParams.set("starterModule", starterModule);
  }

  const redirectAppUrl = redirectUrl.toString();
  return redirectTopLevel(res, redirectAppUrl);
});

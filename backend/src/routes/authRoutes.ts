import { Response, Router } from "express";
import qs from "qs";
import crypto from "crypto";
import axios from "axios";
import { env } from "../config/env";
import { prisma } from "../db/prismaClient";
import { ensureStoreBootstrapped } from "../services/bootstrapService";
import { registerSyncWebhooks } from "../services/shopifyAdminService";

export const authRouter = Router();

function redirectTopLevel(res: Response, url: string) {
  return res
    .status(200)
    .type("html")
    .send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Redirecting…</title>
  </head>
  <body>
    <script>
      (function () {
        var target = ${JSON.stringify(url)};
        if (window.top && window.top !== window) {
          window.top.location.href = target;
          return;
        }
        window.location.href = target;
      })();
    </script>
    <p>Redirecting… <a href="${url}">Continue</a></p>
  </body>
</html>`);
}

function buildInstallUrl(shop: string) {
  const params = qs.stringify({
    client_id: env.shopifyApiKey,
    scope: env.shopifyScopes,
    redirect_uri: `${env.shopifyAppUrl}/auth/callback`,
  });
  return `https://${shop}/admin/oauth/authorize?${params}`;
}

authRouter.get("/install", (req, res) => {
  const { shop } = req.query;
  if (!shop || typeof shop !== "string") {
    return res.status(400).send("Missing shop parameter.");
  }
  const redirectUrl = buildInstallUrl(shop);
  return redirectTopLevel(res, redirectUrl);
});

authRouter.get("/callback", async (req, res) => {
  const { shop, code, hmac } = req.query;

  if (!shop || !code || !hmac) {
    return res.status(400).send("Missing OAuth parameters.");
  }

  const message = qs.stringify(
    Object.fromEntries(
      Object.entries(req.query).filter(
        ([key]) => key !== "hmac" && key !== "signature"
      )
    )
  );

  const generatedHmac = crypto
    .createHmac("sha256", env.shopifyApiSecret)
    .update(message)
    .digest("hex");

  if (generatedHmac !== hmac) {
    return res.status(400).send("HMAC validation failed.");
  }

  const tokenUrl = `https://${shop}/admin/oauth/access_token`;

  const tokenResponse = await axios.post(tokenUrl, {
    client_id: env.shopifyApiKey,
    client_secret: env.shopifyApiSecret,
    code,
  });

  const accessToken = tokenResponse.data.access_token as string;

  const shopDomain = String(shop);
  const trialStartedAt = new Date();
  const trialEndsAt = new Date(trialStartedAt);
  trialEndsAt.setDate(trialEndsAt.getDate() + env.billing.trialDays);

  await prisma.store.upsert({
    where: { shop: shopDomain },
    create: {
      shop: shopDomain,
      accessToken,
      trialStartedAt,
      trialEndsAt,
    },
    update: {
      accessToken,
    },
  });

  await ensureStoreBootstrapped(shopDomain);

  try {
    await registerSyncWebhooks(shopDomain, env.shopifyAppUrl);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn("[auth] Unable to auto-register Shopify sync webhooks.", error);
  }

  // After installation, redirect into the embedded app in Shopify Admin.
  const storeHandle = shopDomain.replace(".myshopify.com", "");
  const adminAppUrl = `https://admin.shopify.com/store/${encodeURIComponent(
    storeHandle
  )}/apps/${encodeURIComponent(env.shopifyApiKey)}`;

  return redirectTopLevel(res, adminAppUrl);
});


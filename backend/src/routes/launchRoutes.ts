import { Router } from "express";
import fs from "fs";
import path from "path";
import { env } from "../config/env";
import { prisma } from "../db/prismaClient";
import { normalizeShopDomain } from "../services/shopifyConnectionService";

export const launchRouter = Router();

function routeUrl(route: string) {
  return new URL(route, env.shopifyAppUrl).toString();
}

launchRouter.get("/launch/audit", async (req, res) => {
  const appTomlPath = path.resolve(process.cwd(), "shopify.app.toml");
  const appTomlContents = fs.existsSync(appTomlPath)
    ? fs.readFileSync(appTomlPath, "utf8")
    : "";
  const requestedShop =
    typeof req.query.shop === "string" ? normalizeShopDomain(req.query.shop) : null;

  const store = requestedShop
    ? await prisma.store.findUnique({
        where: { shop: requestedShop },
        select: {
          shop: true,
          accessToken: true,
          lastSyncStatus: true,
          lastSyncAt: true,
          webhooksRegisteredAt: true,
          lastWebhookRegistrationStatus: true,
          uninstalledAt: true,
        },
      })
    : null;

  const checks = [
    {
      key: "shopify_app_url",
      ok: Boolean(env.shopifyAppUrl),
      detail: env.shopifyAppUrl || "Missing SHOPIFY_APP_URL",
    },
    {
      key: "shopify_app_url_not_temporary",
      ok:
        Boolean(env.shopifyAppUrl) &&
        !/ngrok|trycloudflare|localhost/i.test(env.shopifyAppUrl),
      detail: env.shopifyAppUrl || "Missing SHOPIFY_APP_URL",
    },
    {
      key: "redirect_url_configured",
      ok: appTomlContents.includes("/auth/callback"),
      detail: routeUrl("/auth/callback"),
    },
    {
      key: "application_url_matches_production",
      ok: appTomlContents.includes(`application_url = "${env.shopifyAppUrl}"`),
      detail: env.shopifyAppUrl,
    },
    {
      key: "webhook_routes_match_backend",
      ok:
        appTomlContents.includes('/webhooks/shopify/app_uninstalled') &&
        appTomlContents.includes('/webhooks/shopify/orders_create') &&
        appTomlContents.includes('/webhooks/shopify/orders_updated') &&
        appTomlContents.includes('/webhooks/shopify/customers_create') &&
        appTomlContents.includes('/webhooks/shopify/customers_update') &&
        appTomlContents.includes('/webhooks/shopify/app_subscriptions_update'),
      detail: "/webhooks/shopify/* routes present in shopify.app.toml",
    },
    {
      key: "offline_token_present",
      ok: !!store?.accessToken && !store?.uninstalledAt,
      detail: store?.accessToken
        ? `Offline token stored for ${store.shop}`
        : requestedShop
        ? `No offline token stored for ${requestedShop}`
        : "Add ?shop=<shop>.myshopify.com to audit a store installation.",
    },
    {
      key: "last_sync_status",
      ok: !!store?.lastSyncStatus && store.lastSyncStatus !== "FAILED",
      detail:
        store?.lastSyncStatus != null
          ? `${store.lastSyncStatus}${store.lastSyncAt ? ` at ${store.lastSyncAt.toISOString()}` : ""}`
          : requestedShop
          ? "No sync has completed yet."
          : "No shop selected for sync status.",
    },
    {
      key: "required_webhooks_registered",
      ok:
        !!store?.webhooksRegisteredAt &&
        store.lastWebhookRegistrationStatus !== "FAILED",
      detail:
        store?.webhooksRegisteredAt != null
          ? `Registered at ${store.webhooksRegisteredAt.toISOString()}`
          : requestedShop
          ? "Mandatory webhooks are not registered yet."
          : "No shop selected for webhook status.",
    },
    {
      key: "orders_scope",
      ok: env.shopifyScopes.includes("read_orders"),
      detail: env.shopifyScopes,
    },
    {
      key: "customer_scope",
      ok: env.shopifyScopes.includes("read_customers"),
      detail: env.shopifyScopes,
    },
    {
      key: "privacy_url",
      ok: Boolean(env.publicContact.privacyUrl),
      detail: env.publicContact.privacyUrl,
    },
    {
      key: "terms_url",
      ok: Boolean(env.publicContact.termsUrl),
      detail: env.publicContact.termsUrl,
    },
    {
      key: "support_url",
      ok: Boolean(env.publicContact.supportUrl),
      detail: env.publicContact.supportUrl,
    },
    {
      key: "shopify_app_toml",
      ok: fs.existsSync(appTomlPath),
      detail: appTomlPath,
    },
    {
      key: "compliance_topics_in_toml",
      ok:
        appTomlContents.includes("customers/data_request") &&
        appTomlContents.includes("customers/redact") &&
        appTomlContents.includes("shop/redact"),
      detail: "customers/data_request, customers/redact, shop/redact",
    },
    {
      key: "app_uninstalled_in_toml",
      ok: appTomlContents.includes("app/uninstalled"),
      detail: "app/uninstalled",
    },
  ];

  res.json({
    app: "VedaSuite AI",
    generatedAt: new Date().toISOString(),
    shop: requestedShop,
    publicRoutes: {
      privacy: routeUrl("/legal/privacy"),
      terms: routeUrl("/legal/terms"),
      support: routeUrl("/support"),
      readiness: routeUrl("/launch/readiness"),
      audit: routeUrl("/launch/audit"),
      diagnosticsHint: "Open /api/shopify/diagnostics from an authenticated embedded app session.",
    },
    checks,
  });
});

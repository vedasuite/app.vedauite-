import { type Request, type Response, Router } from "express";
import fs from "fs";
import path from "path";
import { env } from "../config/env";
import { prisma } from "../db/prismaClient";
import { normalizeShopDomain } from "../services/shopifyConnectionService";

export const launchRouter = Router();

function routeUrl(route: string) {
  return new URL(route, env.shopifyAppUrl).toString();
}

function extractConfiguredScopes(appTomlContents: string) {
  const match = appTomlContents.match(/scopes\s*=\s*"([^"]+)"/i);
  if (!match?.[1]) {
    return [];
  }

  return match[1]
    .split(",")
    .map((scope) => scope.trim())
    .filter(Boolean)
    .sort();
}

function findAppTomlPath() {
  const candidates = [
    path.resolve(process.cwd(), "shopify.app.toml"),
    path.resolve(process.cwd(), "../shopify.app.toml"),
    path.resolve(__dirname, "../../../shopify.app.toml"),
  ];

  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
}

function buildSanityChecks(options: {
  appTomlContents: string;
  appTomlPath: string;
  store:
    | {
        shop: string;
        accessToken: string | null;
        lastSyncStatus: string | null;
        lastSyncAt: Date | null;
        webhooksRegisteredAt: Date | null;
        lastWebhookRegistrationStatus: string | null;
        uninstalledAt: Date | null;
      }
    | null;
  requestedShop: string | null;
}) {
  const { appTomlContents, appTomlPath, requestedShop, store } = options;
  const configuredScopes = extractConfiguredScopes(appTomlContents);

  return [
    {
      key: "production_app_url_configured",
      ok: Boolean(env.shopifyAppUrl),
      detail: env.shopifyAppUrl || "Missing SHOPIFY_APP_URL",
    },
    {
      key: "production_app_url_not_temporary",
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
        appTomlContents.includes('/webhooks/shopify/app_subscriptions_update') &&
        appTomlContents.includes('/webhooks/shopify/customers_data_request') &&
        appTomlContents.includes('/webhooks/shopify/customers_redact') &&
        appTomlContents.includes('/webhooks/shopify/shop_redact'),
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
      key: "requested_scopes_minimized",
      ok:
        configuredScopes.includes("read_products") &&
        configuredScopes.includes("read_orders") &&
        configuredScopes.includes("read_customers") &&
        configuredScopes.includes("write_orders") &&
        !configuredScopes.includes("write_products"),
      detail:
        configuredScopes.length > 0
          ? configuredScopes.join(", ")
          : "Could not parse access scopes from shopify.app.toml",
    },
    {
      key: "privacy_url_available",
      ok: Boolean(env.publicContact.privacyUrl),
      detail: env.publicContact.privacyUrl,
    },
    {
      key: "terms_url_available",
      ok: Boolean(env.publicContact.termsUrl),
      detail: env.publicContact.termsUrl,
    },
    {
      key: "support_url_available",
      ok: Boolean(env.publicContact.supportUrl),
      detail: env.publicContact.supportUrl,
    },
    {
      key: "shopify_app_toml_present",
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
      key: "protected_customer_data_declaration_reminder",
      ok: false,
      detail:
        "Confirm protected customer data declarations are complete in Shopify Partner Dashboard before submission.",
    },
  ];
}

async function sendSanityResponse(req: Request, res: Response) {
  const appTomlPath = findAppTomlPath();
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

  const checks = buildSanityChecks({
    appTomlContents,
    appTomlPath,
    requestedShop,
    store,
  });

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
      sanity: routeUrl("/launch/sanity"),
      diagnosticsHint: "Open /api/shopify/diagnostics from an authenticated embedded app session.",
    },
    checks,
    reviewerReminders: [
      "Verify the protected customer data declaration in Partner Dashboard.",
      "Open /api/shopify/diagnostics from inside the embedded app to confirm install, token, webhook, sync, and billing state.",
      "Reconnect once after deploy if this store was installed before the latest auth hardening.",
    ],
  });
}

launchRouter.get("/launch/sanity", async (req, res) => {
  await sendSanityResponse(req, res);
});

launchRouter.get("/launch/audit", async (req, res) => {
  await sendSanityResponse(req, res);
});

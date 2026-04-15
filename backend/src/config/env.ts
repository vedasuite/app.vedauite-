import dotenv from "dotenv";

dotenv.config();

export const env = {
  port: Number(process.env.PORT) || 4000,
  shopifyApiKey: process.env.SHOPIFY_API_KEY || "",
  shopifyApiSecret: process.env.SHOPIFY_API_SECRET || "",
  shopifyScopes:
    process.env.SHOPIFY_SCOPES ||
    "read_products,read_orders,write_orders,read_customers",
  shopifyAppUrl: process.env.SHOPIFY_APP_URL || "",
  shopifyAdminApiVersion:
    process.env.SHOPIFY_ADMIN_API_VERSION || "2026-01",
  databaseUrl: process.env.DATABASE_URL || "",
  complianceExportDir:
    process.env.COMPLIANCE_EXPORT_DIR || "backend/runtime/compliance-exports",
  publicContact: {
    supportEmail: process.env.SUPPORT_EMAIL || "abhimanyu@vedasuite.in",
    privacyEmail: process.env.PRIVACY_EMAIL || "abhimanyu@vedasuite.in",
    legalEmail: process.env.LEGAL_EMAIL || "abhimanyu@vedasuite.in",
    securityEmail: process.env.SECURITY_EMAIL || "abhimanyu@vedasuite.in",
    supportUrl:
      process.env.SUPPORT_URL || `${process.env.SHOPIFY_APP_URL || ""}/support`,
    privacyUrl:
      process.env.PRIVACY_POLICY_URL ||
      `${process.env.SHOPIFY_APP_URL || ""}/legal/privacy`,
    termsUrl:
      process.env.TERMS_OF_SERVICE_URL ||
      `${process.env.SHOPIFY_APP_URL || ""}/legal/terms`,
  },
  billing: {
    trialDays: Number(process.env.BILLING_PLAN_TRIAL_DAYS) || 3,
    starterPrice: Number(process.env.BILLING_PLAN_STARTER_PRICE) || 19,
    growthPrice: Number(process.env.BILLING_PLAN_GROWTH_PRICE) || 49,
    proPrice: Number(process.env.BILLING_PLAN_PRO_PRICE) || 99,
    testMode:
      (process.env.SHOPIFY_BILLING_TEST_MODE || "true").toLowerCase() !==
      "false",
  },
  enableDemoBootstrap:
    (process.env.VEDASUITE_ENABLE_DEMO_BOOTSTRAP || "false").toLowerCase() ===
    "true",
};

if (!env.shopifyApiKey || !env.shopifyApiSecret || !env.shopifyAppUrl) {
  console.warn(
    "[env] Missing SHOPIFY_API_KEY, SHOPIFY_API_SECRET, or SHOPIFY_APP_URL."
  );
}

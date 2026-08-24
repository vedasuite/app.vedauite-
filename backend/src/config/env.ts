import dotenv from "dotenv";

dotenv.config();

/**
 * Reads a numeric env var, preserving an explicit 0.
 *
 * `Number(x) || fallback` silently turns a deliberate 0 into the fallback,
 * which matters for values where 0 means "off" — e.g. setting the AI hourly
 * call ceiling to 0 to stop all provider spend would otherwise grant 12.
 */
function numberFromEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

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
    trialDays: Number(process.env.BILLING_PLAN_TRIAL_DAYS) || 7,
    starterPrice: Number(process.env.BILLING_PLAN_STARTER_PRICE) || 19,
    growthPrice: Number(process.env.BILLING_PLAN_GROWTH_PRICE) || 49,
    proPrice: Number(process.env.BILLING_PLAN_PRO_PRICE) || 99,
    testMode:
      (process.env.SHOPIFY_BILLING_TEST_MODE || "true").toLowerCase() !==
      "false",
  },
  dataRetention: {
    // Days after uninstall before a store's remaining personal data is purged.
    // Shopify normally delivers shop/redact ~48h after uninstall and that path
    // already deletes everything; this is the backstop for a redact webhook that
    // never arrives or fails permanently, so a bounded retention period holds
    // even then. Set to 0 to disable the sweep.
    uninstalledStoreDays: Number(process.env.DATA_RETENTION_DAYS ?? 90),
    sweepIntervalHours: Number(process.env.DATA_RETENTION_SWEEP_HOURS ?? 24),
  },
  enableGuidedBootstrap:
    (process.env.VEDASUITE_ENABLE_GUIDED_BOOTSTRAP || "false").toLowerCase() ===
    "true",
  enableGuidedSetupData:
    (process.env.ENABLE_GUIDED_SETUP_DATA || "false").toLowerCase() === "true",
  // Persistence of intelligence findings (IntelligenceFinding). OFF by default:
  // the table and service ship inert, so this branch changes nothing until a
  // later detector is wired up and the flag is switched on in that environment.
  // Read paths are never gated by this — only writes.
  enableIntelligenceFindingPersistence:
    (
      process.env.ENABLE_INTELLIGENCE_FINDING_PERSISTENCE || "false"
    ).toLowerCase() === "true",
  // The controlled AI explanation layer for the Action Center brief.
  //
  // OFF by default and fails closed: with the flag off, no key, or any provider
  // problem, the Action Center serves the deterministic brief it already
  // serves today. AI never detects anything, never computes impact and never
  // changes severity/confidence — it only rewords findings VedaSuite already
  // verified. See services/ai/aiBriefProvider.ts.
  ai: {
    enabled: (process.env.ENABLE_AI_INTELLIGENCE_BRIEF || "false").toLowerCase() === "true",
    // Server-side only. Never exposed to the frontend, never logged.
    apiKey: process.env.OPENAI_API_KEY || "",
    model: process.env.AI_BRIEF_MODEL || "gpt-4.1-mini",
    // Kept short: the merchant is waiting on the Action Center response, and a
    // slow provider must degrade to deterministic rather than stall the page.
    timeoutMs: numberFromEnv(process.env.AI_BRIEF_TIMEOUT_MS, 8000),
    // Cost/abuse protection, per store, in-process. Set to 0 to stop all
    // provider spend while leaving the flag on.
    maxCallsPerStorePerHour: numberFromEnv(
      process.env.AI_BRIEF_MAX_CALLS_PER_HOUR,
      12
    ),
    // Repeated Action Center loads reuse one brief while findings are
    // unchanged. Set to 0 to disable caching.
    cacheTtlMs: numberFromEnv(process.env.AI_BRIEF_CACHE_TTL_MS, 15 * 60 * 1000),
  },
};

if (!env.shopifyApiKey || !env.shopifyApiSecret || !env.shopifyAppUrl) {
  console.warn(
    "[env] Missing SHOPIFY_API_KEY, SHOPIFY_API_SECRET, or SHOPIFY_APP_URL."
  );
}

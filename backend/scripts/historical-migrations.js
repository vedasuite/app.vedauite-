/**
 * ============================================================================
 * TEMPORARY — shared source of truth for the staging Prisma baseline.
 * ============================================================================
 *
 * TODO(remove): delete this file together with verify-staging-baseline.js and
 * baseline-staging-migrations.js once the staging baseline is established.
 *
 * Both the verifier and the baseliner require this module, so the list of
 * migrations being VERIFIED can never drift from the list being MARKED APPLIED.
 * That matters: a mismatch between the two would mean recording a migration as
 * applied on the strength of evidence gathered for a different one.
 *
 * The 14 entries below are the migrations that already existed before
 * 20260804_intelligence_finding_foundation, with the structures each one
 * creates, extracted from the SQL in backend/prisma/migrations.
 *
 * Spec grammar:
 *   T:Table          -> that table must exist
 *   C:Table.column   -> that column must exist
 *   D:Table.column   -> that column's DEFAULT must be 7
 *
 * `D:` exists for 20260803_subscription_plan_trial_days_default, which creates
 * nothing — it only changes SubscriptionPlan.trialDays's default from 3 to 7. An
 * existence check would pass whether or not it ever ran, so the default value is
 * the only real evidence.
 */

/** The migration that must NEVER be baselined — it is the one to deploy. */
const NEW_MIGRATION = "20260804_intelligence_finding_foundation";

/** The table that migration creates. Must not exist before the deploy. */
const NEW_MIGRATION_TABLE = "IntelligenceFinding";

const HISTORICAL_MIGRATIONS = [
  {
    name: "20260403_billing_access_architecture",
    specs: [
      "T:BillingAuditLog",
      "C:Store.trialStartedAt",
      "C:Store.trialEndsAt",
      "C:StoreSubscription.billingStatus",
      "C:StoreSubscription.cancelledAt",
      "C:StoreSubscription.lastBillingSyncAt",
      "C:StoreSubscription.moduleSwitchedAt",
      "C:StoreSubscription.planActivatedAt",
    ],
  },
  { name: "20260404_core_engines", specs: ["T:SyncJob", "T:TimelineEvent"] },
  {
    name: "20260405_shopify_connection_health",
    specs: [
      "C:Store.installedAt",
      "C:Store.isOffline",
      "C:Store.lastConnectionCheckAt",
      "C:Store.lastConnectionStatus",
      "C:Store.lastSyncAt",
      "C:Store.scope",
      "C:Store.syncStatus",
      "C:Store.uninstalledAt",
      "C:Store.webhooksRegisteredAt",
    ],
  },
  {
    name: "20260405_shopify_oauth_hardening",
    specs: ["C:Store.lastConnectionError"],
  },
  {
    name: "20260406_activation_truthfulness",
    specs: ["T:ProductSnapshot", "T:VariantSnapshot"],
  },
  {
    name: "20260406_expiring_offline_tokens",
    specs: ["C:Store.tokenAcquisitionMode"],
  },
  {
    name: "20260406_shopify_installation_hardening",
    specs: [
      "C:Store.accessTokenExpiresAt",
      "C:Store.authErrorCode",
      "C:Store.authErrorMessage",
      "C:Store.lastWebhookRegistrationStatus",
      "C:Store.reauthorizedAt",
      "C:Store.refreshToken",
      "C:Store.refreshTokenExpiresAt",
    ],
  },
  {
    name: "20260408_billing_install_metadata_truth",
    specs: [
      "C:StoreSubscription.lastBillingResolutionSource",
      "C:StoreSubscription.lastBillingSubscriptionName",
      "C:StoreSubscription.lastBillingWebhookProcessedAt",
    ],
  },
  {
    name: "20260408_billing_management_intents",
    specs: ["T:BillingPlanIntent"],
  },
  {
    name: "20260409_onboarding_flow_refactor",
    specs: [
      "C:Store.onboardingFirstInsightViewedAt",
      "C:Store.onboardingPlanConfirmedAt",
      "C:Store.onboardingSelectedModule",
    ],
  },
  {
    name: "20260409_onboarding_state",
    specs: ["C:Store.onboardingCompletedAt", "C:Store.onboardingDismissedAt"],
  },
  {
    name: "20260502_order_identity_fields",
    specs: [
      "C:Order.orderName",
      "C:Order.shopifyLegacyOrderId",
      "C:Order.shopifyOrderGid",
    ],
  },
  { name: "20260803_shop_trial_history", specs: ["T:ShopTrialHistory"] },
  {
    name: "20260803_subscription_plan_trial_days_default",
    specs: ["D:SubscriptionPlan.trialDays"],
  },
];

/**
 * Tables whose COUNT(*) is captured for before/after comparison.
 * Totals only — never row contents.
 */
const ROW_COUNT_TABLES = [
  "Store",
  "Customer",
  "Order",
  "SubscriptionPlan",
  "StoreSubscription",
  "ShopTrialHistory",
  "SyncJob",
  "TimelineEvent",
  "BillingAuditLog",
  "BillingPlanIntent",
  "ProductSnapshot",
  "VariantSnapshot",
  "SupportTicket",
];

// --- read-only probes. Parameterized SELECTs against information_schema. -----

function buildProbes(prisma) {
  async function tableExists(table) {
    const rows = await prisma.$queryRaw`
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ${table}
      LIMIT 1`;
    return rows.length > 0;
  }

  async function columnExists(table, column) {
    const rows = await prisma.$queryRaw`
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ${table} AND column_name = ${column}
      LIMIT 1`;
    return rows.length > 0;
  }

  async function columnDefaultIsSeven(table, column) {
    const rows = await prisma.$queryRaw`
      SELECT column_default AS d FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ${table} AND column_name = ${column}
      LIMIT 1`;
    if (rows.length === 0) return false;
    const value = rows[0].d;
    return typeof value === "string" && value.trim().startsWith("7");
  }

  async function checkSpec(spec) {
    const [kind, reference] = spec.split(":");
    const [table, column] = reference.split(".");
    if (kind === "T") return tableExists(table);
    if (kind === "C") return columnExists(table, column);
    if (kind === "D") return columnDefaultIsSeven(table, column);
    throw new Error(`Unknown spec kind "${kind}" in "${spec}"`);
  }

  /**
   * Re-checks every historical migration. Returns { allSafe, results, missing }.
   * The baseliner calls this immediately before writing anything, so it never
   * relies on a verification run from an earlier deploy.
   */
  async function verifyAll() {
    const results = [];
    const missing = [];
    for (const migration of HISTORICAL_MIGRATIONS) {
      let found = 0;
      for (const spec of migration.specs) {
        if (await checkSpec(spec)) {
          found += 1;
        } else {
          missing.push(`${migration.name} -> ${spec}`);
        }
      }
      results.push({
        name: migration.name,
        found,
        total: migration.specs.length,
        safe: found === migration.specs.length,
      });
    }
    return { allSafe: results.every((r) => r.safe), results, missing };
  }

  return {
    tableExists,
    columnExists,
    columnDefaultIsSeven,
    checkSpec,
    verifyAll,
  };
}

module.exports = {
  NEW_MIGRATION,
  NEW_MIGRATION_TABLE,
  HISTORICAL_MIGRATIONS,
  ROW_COUNT_TABLES,
  buildProbes,
};

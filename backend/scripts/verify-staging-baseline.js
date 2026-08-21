#!/usr/bin/env node
/**
 * ============================================================================
 * TEMPORARY STAGING BASELINE VERIFIER — READ-ONLY — REMOVE AFTER USE
 * ============================================================================
 *
 * TODO(remove): delete this file once the staging Prisma baseline has been
 * established and `20260804_intelligence_finding_foundation` has deployed.
 * It is a one-off operational diagnostic, not application code. Nothing in the
 * app imports it, and it is never executed by the server, a route, a job or a
 * build step — it only runs when a human invokes it explicitly.
 *
 * WHY THIS EXISTS
 * ---------------
 * `prisma migrate deploy` fails on staging with P3005 ("the database schema is
 * not empty"). Both databases were originally bootstrapped with `prisma db
 * push`, so `_prisma_migrations` was never populated: 11 of the 19 tables in
 * schema.prisma are created by NO migration at all, the first migration only
 * ALTERs an already-existing Store table, and migrations/migration_lock.toml is
 * absent. The migrations folder was added later as hand-written incremental SQL.
 *
 * The correct fix is Prisma's documented baselining flow: mark the historical
 * migrations as already-applied, then deploy only the genuinely new one. But a
 * migration must only be marked applied if the structures it creates ACTUALLY
 * EXIST — otherwise the database is permanently out of step with the code.
 *
 * This script provides that evidence. It answers, per migration:
 *   "is every structure this migration creates already present?"
 *
 * SAFETY
 * ------
 *  - Read-only. Issues ONLY SELECT statements against information_schema and
 *    COUNT(*) aggregates. Contains no INSERT / UPDATE / DELETE / CREATE /
 *    ALTER / DROP / TRUNCATE, no $executeRaw, and no Prisma migrate command.
 *  - Prints no secrets. It never reads or logs DATABASE_URL, passwords or
 *    tokens; the connection comes from the environment Prisma already uses.
 *  - Prints no merchant or customer data. Table checks read information_schema
 *    metadata only, and the data section reports COUNT(*) totals — never a row.
 *
 * USAGE
 * -----
 * Run inside the Render `vedasuite-staging` service shell, where DATABASE_URL
 * already points at the staging database:
 *
 *     cd /opt/render/project/src/backend && node scripts/verify-staging-baseline.js
 *
 * Do NOT run it from a developer laptop: backend/.env may point at production.
 * The script only reads, so it could do no damage, but the output would then
 * describe the wrong database and could lead to baselining the wrong one.
 * ============================================================================
 */

const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

/**
 * The 14 historical migrations and the structures each one creates, extracted
 * from the migration SQL in backend/prisma/migrations.
 *
 * Spec grammar:
 *   T:Table          -> that table must exist
 *   C:Table.column   -> that column must exist
 *   D:Table.column   -> that column's DEFAULT must be 7
 *
 * The `D:` form exists for 20260803_subscription_plan_trial_days_default, which
 * does not create anything — it only changes SubscriptionPlan.trialDays's
 * default from 3 to 7. An existence check would pass whether or not that
 * migration ever ran, so the default value itself is the only real evidence.
 */
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

/** The migration this whole exercise is trying to deploy. Must NOT exist yet. */
const NEW_MIGRATION_TABLE = "IntelligenceFinding";

/**
 * Tables whose COUNT(*) is captured so the same script can be re-run after the
 * deploy and the totals compared. Counts only — never row contents.
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

// --- read-only probes --------------------------------------------------------
// All three use parameterized $queryRaw against information_schema.

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

// --- report sections ---------------------------------------------------------

async function reportMigrationHistory() {
  console.log("=== A. PRISMA MIGRATION HISTORY ===");
  const exists = await tableExists("_prisma_migrations");
  console.log(`_prisma_migrations table exists : ${exists}`);

  if (!exists) {
    console.log("recorded migration rows        : 0 (table absent)");
    console.log(
      "note                           : an absent history table with a populated schema is exactly what produces P3005."
    );
    return;
  }

  const rows = await prisma.$queryRaw`
    SELECT migration_name, finished_at, rolled_back_at
    FROM "_prisma_migrations" ORDER BY started_at`;
  console.log(`recorded migration rows        : ${rows.length}`);
  for (const row of rows) {
    const state = row.rolled_back_at
      ? "ROLLED BACK"
      : row.finished_at
      ? "applied"
      : "INCOMPLETE";
    console.log(`   - ${row.migration_name} [${state}]`);
  }
  if (rows.length === 0) {
    console.log(
      "note                           : table present but empty — still P3005."
    );
  }
}

async function reportVerdicts() {
  console.log("");
  console.log("=== B. PER-MIGRATION BASELINE VERDICT ===");

  const missing = [];
  let allSafe = true;

  for (const migration of HISTORICAL_MIGRATIONS) {
    let found = 0;
    for (const spec of migration.specs) {
      if (await checkSpec(spec)) {
        found += 1;
      } else {
        missing.push(`${migration.name} -> ${spec}`);
      }
    }
    const safe = found === migration.specs.length;
    if (!safe) allSafe = false;
    const label = safe ? "SAFE TO BASELINE" : "DO NOT BASELINE ";
    console.log(
      `${label}  ${migration.name}  (${found}/${migration.specs.length} present)`
    );
  }

  console.log("");
  if (missing.length === 0) {
    console.log("MISSING STRUCTURES : none");
  } else {
    console.log(`MISSING STRUCTURES : ${missing.length}`);
    for (const item of missing) console.log(`   ! ${item}`);
  }

  console.log("");
  console.log(
    `OVERALL VERDICT    : ${
      allSafe
        ? `ALL ${HISTORICAL_MIGRATIONS.length} SAFE TO BASELINE`
        : "NOT ALL SAFE — DO NOT BASELINE"
    }`
  );
  if (!allSafe) {
    console.log(
      "                     A missing structure means that migration never actually ran."
    );
    console.log(
      "                     Recording it as applied would leave the database out of step with the code."
    );
  }
  return allSafe;
}

async function reportNewTable() {
  console.log("");
  console.log("=== C. NEW MIGRATION TARGET ===");
  const exists = await tableExists(NEW_MIGRATION_TABLE);
  console.log(`${NEW_MIGRATION_TABLE} exists : ${exists}`);
  console.log(
    `expected before deploy   : false (it must be created BY the migration, never by hand)`
  );

  if (exists) {
    const indexes = await prisma.$queryRaw`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = ${NEW_MIGRATION_TABLE}
      ORDER BY indexname`;
    console.log(`indexes present          : ${indexes.length}`);
    for (const index of indexes) console.log(`   - ${index.indexname}`);

    const fks = await prisma.$queryRaw`
      SELECT c.conname, c.confdeltype
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      WHERE t.relname = ${NEW_MIGRATION_TABLE} AND c.contype = 'f'`;
    for (const fk of fks) {
      console.log(
        `   FK ${fk.conname} (on delete: ${
          fk.confdeltype === "c" ? "CASCADE" : fk.confdeltype
        })`
      );
    }
  }
}

async function reportRowCounts() {
  console.log("");
  console.log("=== D. ROW COUNTS (totals only — no row data) ===");
  for (const table of ROW_COUNT_TABLES) {
    try {
      // Identifier is from the hard-coded ROW_COUNT_TABLES list above, never
      // from input, so there is no injection surface here.
      const rows = await prisma.$queryRawUnsafe(
        `SELECT COUNT(*)::text AS n FROM "${table}"`
      );
      console.log(`   ${table.padEnd(20)} ${rows[0].n}`);
    } catch (error) {
      const first = String(error.message).split("\n")[0];
      console.log(`   ${table.padEnd(20)} (not readable: ${first})`);
    }
  }
  console.log("");
  console.log(
    "Re-run this script after the deploy and compare these totals to prove no data was lost."
  );
}

async function main() {
  console.log("VedaSuite — staging Prisma baseline verification (READ-ONLY)");
  console.log("No data is created, modified or deleted by this script.");
  console.log("");

  await reportMigrationHistory();
  const allSafe = await reportVerdicts();
  await reportNewTable();
  await reportRowCounts();

  console.log("");
  console.log("=== NEXT STEP ===");
  console.log(
    allSafe
      ? "All historical migrations verified. Send this output back before baselining — do not run any migrate command yet."
      : "At least one migration is NOT safe to baseline. Send this output back for diagnosis. Do not baseline."
  );
}

main()
  .catch((error) => {
    // Message only — never the connection string or any credential.
    console.error("");
    console.error("VERIFICATION FAILED:", String(error.message).split("\n")[0]);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await prisma.$disconnect();
    } catch {
      /* ignore */
    }
  });

#!/usr/bin/env node
/**
 * READ-ONLY production Prisma baseline verification.
 *
 * WHY THIS EXISTS
 * ---------------
 * Production's schema was originally created with `prisma db push`. The 14
 * historical migration files were added afterwards and were never recorded in
 * `_prisma_migrations`, so `prisma migrate deploy` fails with P3005 ("the
 * database schema is not empty").
 *
 * The fix is to mark those 14 as applied — but ONLY after proving that every
 * structure each one creates already exists. This script proves it. It does not
 * fix anything, and it cannot: see the safety properties below.
 *
 * SAFETY PROPERTIES
 * -----------------
 * 1. It runs entirely inside `BEGIN TRANSACTION READ ONLY`, which the database
 *    itself enforces. Any write — by this script or by a mistake in it — is
 *    rejected by PostgreSQL, not merely avoided by convention.
 * 2. The transaction is always ROLLed BACK, never committed.
 * 3. It refuses to run without an explicit confirmation env var, so it cannot
 *    execute as a side effect of a normal build.
 * 4. It never prints credentials. The connection string is read from the
 *    environment and never echoed; the host is identified by a one-way
 *    fingerprint so the operator can confirm which database was inspected
 *    without the value being disclosed.
 *
 * USAGE (see docs/runbooks/production-prisma-baseline.md)
 *   VEDASUITE_BASELINE_CONFIRM=verify-production-baseline \
 *     node scripts/verify-production-baseline.js
 *
 * EXIT CODES
 *   0  all 14 historical migrations verified — safe to proceed to resolve
 *   1  at least one could not be proven — STOP, do not baseline
 *   2  refused to run (missing gate or connection string)
 */

const crypto = require("node:crypto");
const { Client } = require("pg");

const REQUIRED_CONFIRMATION = "verify-production-baseline";

/**
 * Everything the 14 historical migrations create, derived by reading each
 * migration.sql. A migration is "verified present" only when every structure
 * listed for it exists.
 */
const HISTORICAL_MIGRATIONS = [
  {
    name: "20260403_billing_access_architecture",
    columns: [
      ["Store", "trialStartedAt"],
      ["Store", "trialEndsAt"],
      ["StoreSubscription", "billingStatus"],
      ["StoreSubscription", "planActivatedAt"],
      ["StoreSubscription", "cancelledAt"],
      ["StoreSubscription", "lastBillingSyncAt"],
      ["StoreSubscription", "moduleSwitchedAt"],
    ],
    tables: ["BillingAuditLog"],
    indexes: [
      "BillingAuditLog_storeId_createdAt_idx",
      "BillingAuditLog_subscriptionId_createdAt_idx",
    ],
    constraints: [
      "BillingAuditLog_pkey",
      "BillingAuditLog_storeId_fkey",
      "BillingAuditLog_subscriptionId_fkey",
    ],
  },
  {
    name: "20260404_core_engines",
    tables: ["TimelineEvent", "SyncJob"],
    indexes: [
      "TimelineEvent_storeId_createdAt_idx",
      "TimelineEvent_customerId_createdAt_idx",
      "SyncJob_storeId_createdAt_idx",
      "SyncJob_status_createdAt_idx",
    ],
    constraints: [
      "TimelineEvent_pkey",
      "SyncJob_pkey",
      "TimelineEvent_storeId_fkey",
      "TimelineEvent_customerId_fkey",
      "TimelineEvent_orderId_fkey",
      "SyncJob_storeId_fkey",
    ],
  },
  {
    name: "20260405_shopify_connection_health",
    columns: [
      ["Store", "scope"],
      ["Store", "isOffline"],
      ["Store", "installedAt"],
      ["Store", "webhooksRegisteredAt"],
      ["Store", "lastConnectionCheckAt"],
      ["Store", "lastConnectionStatus"],
      ["Store", "uninstalledAt"],
      ["Store", "lastSyncAt"],
      ["Store", "syncStatus"],
    ],
  },
  {
    name: "20260405_shopify_oauth_hardening",
    columns: [["Store", "lastConnectionError"]],
    // This migration also DROPs NOT NULL on Store.accessToken.
    nullableColumns: [["Store", "accessToken"]],
  },
  {
    name: "20260406_activation_truthfulness",
    tables: ["ProductSnapshot", "VariantSnapshot"],
    indexes: [
      "ProductSnapshot_storeId_shopifyProductId_key",
      "ProductSnapshot_storeId_handle_idx",
      "VariantSnapshot_productSnapshotId_shopifyVariantId_key",
    ],
    constraints: [
      "ProductSnapshot_pkey",
      "VariantSnapshot_pkey",
      "ProductSnapshot_storeId_fkey",
      "VariantSnapshot_productSnapshotId_fkey",
    ],
  },
  {
    name: "20260406_expiring_offline_tokens",
    columns: [["Store", "tokenAcquisitionMode"]],
  },
  {
    name: "20260406_shopify_installation_hardening",
    columns: [
      ["Store", "reauthorizedAt"],
      ["Store", "lastWebhookRegistrationStatus"],
      ["Store", "authErrorCode"],
      ["Store", "authErrorMessage"],
      ["Store", "accessTokenExpiresAt"],
      ["Store", "refreshToken"],
      ["Store", "refreshTokenExpiresAt"],
    ],
  },
  {
    name: "20260408_billing_install_metadata_truth",
    columns: [
      ["StoreSubscription", "lastBillingWebhookProcessedAt"],
      ["StoreSubscription", "lastBillingResolutionSource"],
      ["StoreSubscription", "lastBillingSubscriptionName"],
    ],
    // Also performs a data backfill. A backfill leaves no structure behind, so
    // it cannot be proven by introspection — noted, not silently ignored.
    dataOnlyNote:
      "also backfills lastBilling* values; not structurally verifiable, and re-running it is not part of baselining",
  },
  {
    name: "20260408_billing_management_intents",
    tables: ["BillingPlanIntent"],
    indexes: ["BillingPlanIntent_storeId_status_createdAt_idx"],
    constraints: ["BillingPlanIntent_pkey", "BillingPlanIntent_storeId_fkey"],
  },
  {
    name: "20260409_onboarding_flow_refactor",
    columns: [
      ["Store", "onboardingSelectedModule"],
      ["Store", "onboardingFirstInsightViewedAt"],
      ["Store", "onboardingPlanConfirmedAt"],
    ],
  },
  {
    name: "20260409_onboarding_state",
    columns: [
      ["Store", "onboardingCompletedAt"],
      ["Store", "onboardingDismissedAt"],
    ],
  },
  {
    name: "20260502_order_identity_fields",
    columns: [
      ["Order", "shopifyOrderGid"],
      ["Order", "shopifyLegacyOrderId"],
      ["Order", "orderName"],
    ],
    indexes: [
      "Order_shopifyOrderGid_key",
      "Order_storeId_shopifyLegacyOrderId_idx",
      "Order_storeId_orderName_idx",
      "Order_shopifyOrderGid_idx",
    ],
  },
  {
    name: "20260803_shop_trial_history",
    tables: ["ShopTrialHistory"],
    indexes: ["ShopTrialHistory_shop_key"],
    constraints: ["ShopTrialHistory_pkey"],
  },
  {
    name: "20260803_subscription_plan_trial_days_default",
    columnDefaults: [["SubscriptionPlan", "trialDays", "7"]],
  },
];

/**
 * Migrations that must be APPLIED by migrate deploy, never marked as done.
 * Everything not in HISTORICAL_MIGRATIONS belongs here.
 */
const NON_HISTORICAL_MIGRATIONS = [
  "20260804_intelligence_finding_foundation",
  "20260825_profit_input_provenance",
  "20260825_competitor_attempt_status",
  // Reconciliation Engine V1. Additive: two nullable columns on
  // VariantSnapshot and four new tables. Applied by migrate deploy like the
  // rest of this list — never resolved.
  "20260826_reconciliation_engine",
  // Reconciliation V1 completion. Additive: persisted reference evidence,
  // order line items, versioned rate cards, XLSX sheet selection.
  "20260826_reconciliation_v1_completion",
];
/** Kept for the post-deploy checks that name the original one. */
const PENDING_MIGRATION = NON_HISTORICAL_MIGRATIONS[0];

/**
 * The pure verification core: given an introspection snapshot, decide which
 * migrations are proven present.
 *
 * Separated from all I/O so it can be tested without a database — the STOP
 * path in particular, because a wrongly-reported PASS would baseline a
 * structure that is actually missing.
 *
 * @param {{tables:Set<string>, columns:Map<string,object>, indexes:Set<string>, constraints:Map<string,object>}} db
 */
function verifyAll(db) {
  const verified = [];
  const failed = [];

  for (const migration of HISTORICAL_MIGRATIONS) {
    const missing = [];

    for (const table of migration.tables ?? []) {
      if (!db.tables.has(table)) missing.push(`table ${table}`);
    }
    for (const [table, column] of migration.columns ?? []) {
      if (!db.columns.has(`${table}.${column}`)) {
        missing.push(`column ${table}.${column}`);
      }
    }
    for (const [table, column] of migration.nullableColumns ?? []) {
      const found = db.columns.get(`${table}.${column}`);
      if (!found) missing.push(`column ${table}.${column}`);
      else if (found.is_nullable !== "YES") {
        missing.push(`${table}.${column} is still NOT NULL`);
      }
    }
    for (const [table, column, expected] of migration.columnDefaults ?? []) {
      const found = db.columns.get(`${table}.${column}`);
      if (!found) missing.push(`column ${table}.${column}`);
      else if (!String(found.column_default ?? "").includes(expected)) {
        missing.push(
          `${table}.${column} default is ${found.column_default ?? "NULL"}, expected ${expected}`
        );
      }
    }
    for (const index of migration.indexes ?? []) {
      if (!db.indexes.has(index)) missing.push(`index ${index}`);
    }
    for (const constraint of migration.constraints ?? []) {
      if (!db.constraints.has(constraint) && !db.indexes.has(constraint)) {
        missing.push(`constraint ${constraint}`);
      }
    }

    if (missing.length === 0) verified.push(migration.name);
    else failed.push({ name: migration.name, missing });
  }

  return { verified, failed };
}

function fail(message, code = 2) {
  console.error(`\n[REFUSED] ${message}\n`);
  process.exit(code);
}

async function main() {
  const postDeploy = process.argv.includes("--post-deploy");

  // --- Gate ---------------------------------------------------------------
  if (process.env.VEDASUITE_BASELINE_CONFIRM !== REQUIRED_CONFIRMATION) {
    fail(
      "This script inspects a production database and will not run without an\n" +
        "explicit confirmation, so it cannot execute as a side effect of a build.\n\n" +
        `Set VEDASUITE_BASELINE_CONFIRM=${REQUIRED_CONFIRMATION} to proceed.`
    );
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    fail("DATABASE_URL is not set in this environment.");
  }

  // Identify the target WITHOUT disclosing the credential.
  let hostFingerprint = "unknown";
  try {
    hostFingerprint = crypto
      .createHash("sha256")
      .update(new URL(connectionString).host)
      .digest("hex")
      .slice(0, 12);
  } catch {
    /* a non-URL connection string still verifies fine; identity is advisory */
  }

  const client = new Client({
    connectionString,
    ssl: /sslmode=disable/.test(connectionString)
      ? false
      : { rejectUnauthorized: false },
  });

  await client.connect();

  const report = { verified: [], failed: [] };

  try {
    // The database enforces read-only for everything below. This is the
    // guarantee, not the comments.
    await client.query("BEGIN TRANSACTION READ ONLY");

    const dbName = (await client.query("SELECT current_database() AS db")).rows[0].db;
    const version = (await client.query("SHOW server_version")).rows[0].server_version;

    console.log("=".repeat(74));
    console.log("VedaSuite — production Prisma baseline verification (READ ONLY)");
    console.log("=".repeat(74));
    console.log(`database          : ${dbName}`);
    console.log(`host fingerprint  : sha256:${hostFingerprint}`);
    console.log(`server version    : ${version}`);
    console.log(`transaction mode  : READ ONLY (enforced by PostgreSQL)`);
    console.log(`timestamp         : ${new Date().toISOString()}`);

    // --- Introspection ----------------------------------------------------
    const tables = new Set(
      (
        await client.query(
          `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`
        )
      ).rows.map((r) => r.tablename)
    );

    const columns = new Map();
    for (const row of (
      await client.query(
        `SELECT table_name, column_name, is_nullable, column_default
           FROM information_schema.columns
          WHERE table_schema = 'public'`
      )
    ).rows) {
      columns.set(`${row.table_name}.${row.column_name}`, row);
    }

    const indexes = new Set(
      (
        await client.query(
          `SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`
        )
      ).rows.map((r) => r.indexname)
    );

    const constraints = new Map();
    for (const row of (
      await client.query(
        `SELECT con.conname, con.contype, con.confdeltype
           FROM pg_constraint con
           JOIN pg_namespace ns ON ns.oid = con.connamespace
          WHERE ns.nspname = 'public'`
      )
    ).rows) {
      constraints.set(row.conname, row);
    }

    // --- Per-migration verification --------------------------------------
    console.log(`\n${"-".repeat(74)}`);
    console.log("STEP 1 — verifying all 14 historical migrations");
    console.log("-".repeat(74));

    const result = verifyAll({ tables, columns, indexes, constraints });
    report.verified = result.verified;
    report.failed = result.failed;

    for (const migration of HISTORICAL_MIGRATIONS) {
      const failure = result.failed.find((f) => f.name === migration.name);
      if (!failure) {
        console.log(`  PASS  ${migration.name}`);
        if (migration.dataOnlyNote) {
          console.log(`        note: ${migration.dataOnlyNote}`);
        }
      } else {
        console.log(`  FAIL  ${migration.name}`);
        failure.missing.forEach((m) => console.log(`          missing: ${m}`));
      }
    }

    // --- The migration that must NOT be marked applied --------------------
    console.log(`\n${"-".repeat(74)}`);
    console.log("STEP 2 — the pending migration");
    console.log("-".repeat(74));
    const findingTableExists = tables.has("IntelligenceFinding");
    console.log(`  ${PENDING_MIGRATION}`);
    console.log(
      `  IntelligenceFinding table present: ${findingTableExists ? "YES" : "no"}`
    );
    if (postDeploy) {
      console.log(
        findingTableExists
          ? "  Expected after deploy: the table is present."
          : "  PROBLEM: after migrate deploy this table should exist."
      );
    } else if (findingTableExists) {
      console.log(
        "  WARNING: the table already exists BEFORE the deploy. Do NOT create it\n" +
          "  manually and do NOT mark this migration applied — report this first."
      );
    } else {
      console.log("  Correct: migrate deploy will create it.");
    }

    // --- Migration history state -----------------------------------------
    console.log(`\n${"-".repeat(74)}`);
    console.log("STEP 3 — _prisma_migrations state");
    console.log("-".repeat(74));
    if (!tables.has("_prisma_migrations")) {
      console.log(
        "  _prisma_migrations does not exist — the schema was created outside\n" +
          "  the migration history, which is the P3005 condition."
      );
      console.log("  `prisma migrate resolve` will create it.");
    } else {
      const applied = await client.query(
        `SELECT migration_name, finished_at, rolled_back_at
           FROM "_prisma_migrations" ORDER BY started_at`
      );
      if (applied.rows.length === 0) {
        console.log("  _prisma_migrations exists but is empty.");
      } else {
        console.log(`  ${applied.rows.length} row(s) already recorded:`);
        applied.rows.forEach((r) =>
          console.log(
            `    ${r.migration_name}  finished=${r.finished_at ? "yes" : "NO"}${
              r.rolled_back_at ? "  ROLLED BACK" : ""
            }`
          )
        );
      }
    }

    // --- Row counts, captured BEFORE any write ---------------------------
    console.log(`\n${"-".repeat(74)}`);
    console.log("STEP 4 — row-count baseline (capture this output)");
    console.log("-".repeat(74));
    const counted = [...tables].filter((t) => !t.startsWith("_")).sort();
    const counts = {};
    for (const table of counted) {
      const { rows } = await client.query(
        `SELECT COUNT(*)::bigint AS n FROM "${table}"`
      );
      counts[table] = Number(rows[0].n);
      console.log(`  ${table.padEnd(34)} ${String(counts[table]).padStart(10)}`);
    }

    // --- Deep diagnostic mode ---------------------------------------------
    // Run with --deep to turn a STOP verdict into exact facts: which objects
    // are missing, whether adding the unique index would change any data, and
    // where production disagrees with the migration SQL in ways a name-only
    // check cannot see. Read-only, like everything else here.
    if (process.argv.includes("--deep")) {
      const line = "-".repeat(74);

      console.log("\n" + line);
      console.log("DEEP 1 — exactly which named objects are missing");
      console.log(line);
      let anyMissing = false;
      for (const migration of HISTORICAL_MIGRATIONS) {
        const bad = [];
        for (const t of migration.tables ?? []) {
          if (!tables.has(t)) bad.push("table " + t);
        }
        for (const [t, c] of migration.columns ?? []) {
          if (!columns.has(t + "." + c)) bad.push("column " + t + "." + c);
        }
        for (const i of migration.indexes ?? []) {
          if (!indexes.has(i)) bad.push("index " + i);
        }
        for (const c of migration.constraints ?? []) {
          if (!constraints.has(c) && !indexes.has(c)) bad.push("constraint " + c);
        }
        if (bad.length) {
          anyMissing = true;
          console.log("  " + migration.name);
          bad.forEach((b) => console.log("    MISSING: " + b));
        }
      }
      if (!anyMissing) console.log("  Nothing missing by name.");

      console.log("\n" + line);
      console.log("DEEP 2 — would adding Order_shopifyOrderGid_key change any data?");
      console.log(line);
      if (!tables.has("Order")) {
        console.log("  Order table absent — nothing to report.");
      } else {
        const one = async (sql) => (await client.query(sql)).rows[0].n;
        const total = await one('SELECT COUNT(*)::bigint n FROM "Order"');
        const nonNull = await one(
          'SELECT COUNT(*)::bigint n FROM "Order" WHERE "shopifyOrderGid" IS NOT NULL'
        );
        const blank = await one(
          'SELECT COUNT(*)::bigint n FROM "Order" WHERE "shopifyOrderGid" IS NOT NULL AND BTRIM("shopifyOrderGid") = \'\''
        );
        const dupes = await client.query(
          'SELECT "shopifyOrderGid", COUNT(*)::bigint n FROM "Order" WHERE "shopifyOrderGid" IS NOT NULL GROUP BY "shopifyOrderGid" HAVING COUNT(*) > 1'
        );
        const affected = dupes.rows.reduce((sum, r) => sum + (Number(r.n) - 1), 0);

        console.log("  Order rows                : " + total);
        console.log("  with a shopifyOrderGid    : " + nonNull);
        console.log("  blank-string gids         : " + blank);
        console.log("  duplicated gid values     : " + dupes.rows.length);
        console.log("  rows that would be NULLed : " + affected);
        console.log(
          affected === 0 && Number(blank) === 0
            ? "\n  => SAFE: the unique index can be added with NO data change."
            : "\n  => NOT purely additive: the migration would NULL the values above.\n" +
                "     This needs an explicit decision before anything is run."
        );
      }

      console.log("\n" + line);
      console.log("DEEP 3 — actual FK delete rules (a name-only check cannot see these)");
      console.log(line);
      const RULE = {
        a: "NO ACTION",
        r: "RESTRICT",
        c: "CASCADE",
        n: "SET NULL",
        d: "SET DEFAULT",
      };
      const fks = await client.query(
        "SELECT con.conname, con.confdeltype FROM pg_constraint con JOIN pg_namespace ns ON ns.oid = con.connamespace WHERE ns.nspname = 'public' AND con.contype = 'f' ORDER BY con.conname"
      );
      fks.rows.forEach((r) =>
        console.log(
          "  " + r.conname.padEnd(52) + " ON DELETE " + (RULE[r.confdeltype] ?? r.confdeltype)
        )
      );

      console.log("\n" + line);
      console.log("DEEP 4 — index definitions on the tables the migrations touch");
      console.log(line);
      const defs = await client.query(
        "SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename IN ('Order','BillingAuditLog','TimelineEvent','SyncJob','ProductSnapshot','VariantSnapshot','BillingPlanIntent','ShopTrialHistory','Store','StoreSubscription','SubscriptionPlan') ORDER BY indexname"
      );
      defs.rows.forEach((r) => console.log("  " + r.indexdef));
    }

    // --- Post-deploy mode -------------------------------------------------
    // Run with --post-deploy AFTER `prisma migrate deploy`, to prove the one
    // new migration landed correctly and nothing else moved.
    if (postDeploy) {
      console.log(`\n${"-".repeat(74)}`);
      console.log("STEP 5 — post-deploy verification of IntelligenceFinding");
      console.log("-".repeat(74));

      const problems = [];
      const need = (ok, label) => {
        console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
        if (!ok) problems.push(label);
      };

      need(tables.has("IntelligenceFinding"), "table IntelligenceFinding exists");
      need(
        constraints.has("IntelligenceFinding_pkey") ||
          indexes.has("IntelligenceFinding_pkey"),
        "primary key IntelligenceFinding_pkey"
      );
      need(
        indexes.has("IntelligenceFinding_storeId_fingerprint_key"),
        "unique index on (storeId, fingerprint)"
      );

      // The unique index must actually cover both columns, in order.
      const uniqueDef = (
        await client.query(
          `SELECT indexdef FROM pg_indexes
            WHERE schemaname = 'public'
              AND indexname = 'IntelligenceFinding_storeId_fingerprint_key'`
        )
      ).rows[0]?.indexdef;
      need(
        !!uniqueDef && /UNIQUE/i.test(uniqueDef) &&
          /storeId/.test(uniqueDef) && /fingerprint/.test(uniqueDef),
        "that index is UNIQUE and covers storeId + fingerprint"
      );

      // The FK must cascade, or a shop/redact purge would leave orphans.
      const fk = constraints.get("IntelligenceFinding_storeId_fkey");
      need(!!fk, "foreign key IntelligenceFinding_storeId_fkey");
      need(
        fk?.confdeltype === "c",
        "that foreign key is ON DELETE CASCADE (required for shop/redact)"
      );

      const recorded = tables.has("_prisma_migrations")
        ? (
            await client.query(
              `SELECT migration_name, finished_at FROM "_prisma_migrations"
                ORDER BY started_at`
            )
          ).rows
        : [];
      need(
        recorded.length === HISTORICAL_MIGRATIONS.length + NON_HISTORICAL_MIGRATIONS.length,
        `_prisma_migrations holds exactly ${HISTORICAL_MIGRATIONS.length + NON_HISTORICAL_MIGRATIONS.length} rows (found ${recorded.length})`
      );
      need(
        recorded.some(
          (r) => r.migration_name === PENDING_MIGRATION && r.finished_at
        ),
        `${PENDING_MIGRATION} is recorded and finished`
      );
      need(
        recorded.every((r) => r.finished_at),
        "no migration is left unfinished"
      );

      console.log(
        `\n  IntelligenceFinding row count: ${counts.IntelligenceFinding ?? "(table absent)"}` +
          " — expected 0 on a fresh baseline"
      );
      console.log(
        "\n  Compare the row counts above against the STEP 4 baseline you captured\n" +
          "  before the resolve step. Every pre-existing table must be unchanged."
      );

      if (problems.length > 0) {
        report.failed.push({ name: "post-deploy verification", missing: problems });
      }
    }

    // --- Verdict ----------------------------------------------------------
    console.log(`\n${"=".repeat(74)}`);
    if (report.failed.length === 0) {
      console.log(
        `VERDICT: all ${report.verified.length}/14 historical migrations VERIFIED PRESENT.`
      );
      console.log(
        postDeploy
          ? "Post-deploy checks also passed. The baseline is complete."
          : "Safe to proceed to the resolve step in the runbook."
      );
      console.log("=".repeat(74));
      console.log(
        `\nROW_COUNT_BASELINE_JSON=${JSON.stringify({
          database: dbName,
          hostFingerprint,
          capturedAt: new Date().toISOString(),
          counts,
        })}`
      );
    } else {
      console.log(
        `VERDICT: STOP. ${report.failed.length} migration(s) could NOT be proven present.`
      );
      report.failed.forEach((f) => console.log(`  - ${f.name}`));
      console.log(
        "\nDo NOT run `prisma migrate resolve` for any migration. Marking an\n" +
          "unverified migration as applied would permanently skip a change the\n" +
          "database actually needs. Report this output instead."
      );
      console.log("=".repeat(74));
    }
  } finally {
    // Never commit. The transaction was read-only anyway; this is belt and braces.
    await client.query("ROLLBACK").catch(() => undefined);
    await client.end().catch(() => undefined);
  }

  process.exit(report.failed.length === 0 ? 0 : 1);
}

module.exports = {
  HISTORICAL_MIGRATIONS,
  PENDING_MIGRATION,
  NON_HISTORICAL_MIGRATIONS,
  verifyAll,
};

// Never auto-run on require: the test suite imports the pure core only.
if (require.main !== module) {
  return;
}

main().catch((error) => {
  console.error("\n[ERROR] verification could not complete:");
  // Print the message only — a pg error can carry connection detail.
  console.error(`  ${error instanceof Error ? error.message : String(error)}`);
  console.error("\nNo changes were made. The session was read-only.");
  process.exit(1);
});

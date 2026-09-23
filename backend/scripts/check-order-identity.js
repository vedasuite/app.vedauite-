#!/usr/bin/env node
/**
 * READ-ONLY pre-migration checks for store-scoped order identity.
 *
 * Runs the three questions that must be answered before
 * 20260914_order_identity_store_scoped is applied:
 *
 *   CHECK 1 — duplicate shopifyOrderId values
 *   CHECK 2 — orphaned Order records
 *   CHECK 3 — the indexes that actually exist on "Order"
 *
 * SAFETY
 * ------
 * Every statement below is a SELECT. There is no CREATE, INSERT, UPDATE,
 * DELETE, DROP, ALTER, TRUNCATE or GRANT anywhere in this file, and no
 * migration is applied or resolved. `$queryRaw` (the read API) is the only
 * Prisma call used — `$executeRaw`, which is the one that can write, is never
 * called. A guard at the bottom re-checks each statement before it runs, so a
 * future edit that slipped a write in here would refuse rather than execute.
 *
 * Credentials are never printed. The connection target is shown as
 * host/database only, with user and password removed.
 *
 * Usage:
 *   node scripts/check-order-identity.js
 *
 * It reads DATABASE_URL from the environment, or from backend/.env.
 */

const path = require("path");

// Load backend/.env the same way the app does, without overriding anything
// already set in the real environment (Render sets DATABASE_URL directly).
try {
  require("dotenv").config({ path: path.resolve(__dirname, "../.env") });
} catch {
  /* dotenv absent is fine when DATABASE_URL is already exported */
}

const { PrismaClient } = require("@prisma/client");

/** Shows WHICH database was reached, with user and password removed. */
function safeTarget(rawUrl) {
  if (!rawUrl) return "(DATABASE_URL is not set)";
  try {
    const u = new URL(rawUrl);
    const db = u.pathname.replace(/^\//, "") || "(none)";
    return `${u.hostname}:${u.port || "5432"}/${db}`;
  } catch {
    return "(DATABASE_URL could not be parsed — not printing it)";
  }
}

/**
 * Refuses anything that is not a single read.
 *
 * Belt and braces: the queries below are already SELECT-only, but this makes
 * that a property the script enforces rather than one a reader has to verify.
 */
const FORBIDDEN =
  /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|comment|copy|vacuum|reindex|call|do)\b/i;

function assertReadOnly(label, sql) {
  const text = String(sql);
  if (FORBIDDEN.test(text)) {
    throw new Error(`${label}: refused — this script may only run SELECT statements.`);
  }
  if (!/^\s*select\b/i.test(text)) {
    throw new Error(`${label}: refused — statement does not begin with SELECT.`);
  }
}

const line = (ch = "=") => console.log(ch.repeat(72));

async function main() {
  const target = safeTarget(process.env.DATABASE_URL);

  line();
  console.log("VedaSuite — Order identity pre-migration checks (READ ONLY)");
  console.log(`Database : ${target}`);
  console.log(`Run at   : ${new Date().toISOString()}`);
  line();
  console.log("");

  if (!process.env.DATABASE_URL) {
    console.log("DATABASE_URL is not set. Nothing was queried.");
    console.log("Set it, or run this from the Render shell where it already exists.");
    process.exitCode = 2;
    return;
  }

  const prisma = new PrismaClient();

  try {
    // ---- CHECK 1 --------------------------------------------------------
    const sql1 = `SELECT "shopifyOrderId", COUNT(*)::int AS occurrences
                  FROM "Order"
                  GROUP BY "shopifyOrderId"
                  HAVING COUNT(*) > 1
                  ORDER BY COUNT(*) DESC
                  LIMIT 50`;
    assertReadOnly("CHECK 1", sql1);
    const duplicates = await prisma.$queryRawUnsafe(sql1);

    console.log("CHECK 1 — Duplicate shopifyOrderId values");
    line("-");
    if (duplicates.length === 0) {
      console.log("  RESULT: none. Every shopifyOrderId currently appears once.");
      console.log("  MEANING: expected, and the migration is safe either way —");
      console.log("           it only WIDENS the constraint, so no row can newly conflict.");
    } else {
      console.log(`  RESULT: ${duplicates.length} value(s) appear more than once:`);
      for (const row of duplicates) {
        console.log(`    ${row.shopifyOrderId}  ->  ${row.occurrences} rows`);
      }
      console.log("  MEANING: still safe to migrate (the new constraint is wider),");
      console.log("           but send this list to review before proceeding.");
    }
    console.log("");

    // ---- CHECK 2 --------------------------------------------------------
    const sql2 = `SELECT COUNT(*)::int AS orphaned
                  FROM "Order" o
                  LEFT JOIN "Store" s ON s.id = o."storeId"
                  WHERE s.id IS NULL`;
    assertReadOnly("CHECK 2", sql2);
    const [orphans] = await prisma.$queryRawUnsafe(sql2);

    console.log("CHECK 2 — Orphaned Order records (no matching Store)");
    line("-");
    console.log(`  RESULT: ${orphans.orphaned} orphaned order(s).`);
    console.log(
      orphans.orphaned === 0
        ? "  MEANING: expected. Every order belongs to a real store."
        : "  MEANING: unexpected — report this before migrating."
    );
    console.log("");

    // ---- CHECK 3 --------------------------------------------------------
    const sql3 = `SELECT indexname, indexdef
                  FROM pg_indexes
                  WHERE tablename = 'Order'
                  ORDER BY indexname`;
    assertReadOnly("CHECK 3", sql3);
    const indexes = await prisma.$queryRawUnsafe(sql3);

    console.log("CHECK 3 — Indexes that actually exist on the Order table");
    line("-");
    if (indexes.length === 0) {
      console.log("  RESULT: no indexes found. Unexpected — report this.");
    } else {
      for (const row of indexes) {
        console.log(`  ${row.indexname}`);
        console.log(`      ${row.indexdef}`);
      }
    }
    console.log("");

    // ---- The verdict this whole script exists to produce ----------------
    const names = indexes.map((r) => r.indexname);
    const hasGlobal = indexes.some(
      (r) =>
        r.indexname === "Order_shopifyOrderId_key" &&
        /UNIQUE/i.test(r.indexdef) &&
        !/storeId/i.test(r.indexdef)
    );
    const hasCompound = names.includes("Order_storeId_shopifyOrderId_key");

    line();
    console.log("VERDICT");
    line("-");
    if (hasCompound && !hasGlobal) {
      console.log("  The store-scoped index is ALREADY in place. Migration not needed.");
    } else if (hasGlobal && !hasCompound) {
      console.log("  Confirmed: the GLOBAL unique index on shopifyOrderId is present,");
      console.log("  and the store-scoped one is not. This is the expected starting");
      console.log("  state, and matches the diagnosis. Migration can proceed.");
    } else if (hasGlobal && hasCompound) {
      console.log("  BOTH indexes exist. Unexpected — report before migrating.");
    } else {
      console.log("  Neither index matched the expected names. Unexpected —");
      console.log("  send the CHECK 3 output above before migrating.");
    }
    line();
    console.log("");
    console.log("Nothing was created, updated, deleted or migrated by this script.");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  // Never print the connection string, even on failure.
  const message = error instanceof Error ? error.message : String(error);
  const raw = process.env.DATABASE_URL;
  console.error("");
  console.error("The checks could not complete:");
  console.error("  " + (raw ? message.split(raw).join("<redacted>") : message));
  process.exitCode = 1;
});

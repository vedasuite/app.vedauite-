-- Reconciliation Engine V1.
--
-- WHY
-- ---
-- VedaSuite could compare a store against itself, but not against the files a
-- merchant actually receives from a warehouse, a 3PL or a supplier. Those files
-- are where operational money leaks are visible, and nothing in the schema
-- could hold one.
--
-- WHAT THIS ADDS
-- --------------
-- Two nullable columns on VariantSnapshot, and four new tables.
--
-- VariantSnapshot.sku and .inventoryQuantity exist because inventory
-- reconciliation is impossible without them: the product sync recorded handle,
-- title and price but never a SKU or a stock level, so there was no Shopify
-- side to compare a warehouse file against. Both are NULLABLE and both mean
-- "Shopify did not report this", never zero — a null quantity must not be
-- reconciled as though Shopify had said there were none.
--
-- The four tables are deliberately generic. Nothing in them names inventory,
-- 3PL or suppliers, so a fourth check type needs no fifth table.
--
-- SAFETY
-- ------
-- Entirely additive and idempotent. No column is dropped, no column changes
-- type, no existing row is rewritten, and no existing query changes meaning:
-- every VariantSnapshot row keeps exactly the values it had, with two new NULLs
-- that mean precisely what their absence meant before.
--
-- Rollback: the two columns can be dropped and the four tables dropped, with no
-- effect on any pre-existing data. Deploying the previous application build
-- against this schema also works unchanged, because nothing existing reads or
-- writes the new columns.
--
-- Every table cascades from Store, matching the deletion behaviour already
-- verified for the rest of the schema.

ALTER TABLE "VariantSnapshot"
  ADD COLUMN IF NOT EXISTS "sku" TEXT,
  ADD COLUMN IF NOT EXISTS "inventoryQuantity" INTEGER;

CREATE TABLE IF NOT EXISTS "ReconciliationSource" (
  "id"            TEXT NOT NULL,
  "storeId"       TEXT NOT NULL,
  "checkType"     TEXT NOT NULL,
  "fileName"      TEXT NOT NULL,
  "fileFormat"    TEXT NOT NULL,
  "fileSizeBytes" INTEGER NOT NULL,
  "status"        TEXT NOT NULL DEFAULT 'uploaded',
  "statusReason"  TEXT,
  "headersJson"   TEXT,
  "mappingJson"   TEXT,
  "totalRows"     INTEGER NOT NULL DEFAULT 0,
  "validRows"     INTEGER NOT NULL DEFAULT 0,
  "invalidRows"   INTEGER NOT NULL DEFAULT 0,
  "duplicateRows" INTEGER NOT NULL DEFAULT 0,
  "uploadedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ReconciliationSource_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ReconciliationRecord" (
  "id"            TEXT NOT NULL,
  "sourceId"      TEXT NOT NULL,
  "storeId"       TEXT NOT NULL,
  "rowNumber"     INTEGER NOT NULL,
  "sku"           TEXT,
  "orderRef"      TEXT,
  "tracking"      TEXT,
  "location"      TEXT,
  "quantity"      DOUBLE PRECISION,
  "amount"        DOUBLE PRECISION,
  "currency"      TEXT,
  "observedAt"    TIMESTAMP(3),
  "invalidReason" TEXT,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReconciliationRecord_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ReconciliationRun" (
  "id"               TEXT NOT NULL,
  "storeId"          TEXT NOT NULL,
  "sourceId"         TEXT,
  "checkType"        TEXT NOT NULL,
  "status"           TEXT NOT NULL DEFAULT 'queued',
  "statusReason"     TEXT,
  "matchedCount"     INTEGER NOT NULL DEFAULT 0,
  "probableCount"    INTEGER NOT NULL DEFAULT 0,
  "unmatchedCount"   INTEGER NOT NULL DEFAULT 0,
  "discrepancyCount" INTEGER NOT NULL DEFAULT 0,
  "quantifiedCount"  INTEGER NOT NULL DEFAULT 0,
  "startedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt"       TIMESTAMP(3),
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ReconciliationRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ReconciliationDiscrepancy" (
  "id"                 TEXT NOT NULL,
  "runId"              TEXT NOT NULL,
  "storeId"            TEXT NOT NULL,
  "kind"               TEXT NOT NULL,
  "certainty"          TEXT NOT NULL,
  "matchConfidence"    TEXT NOT NULL,
  "subjectKey"         TEXT NOT NULL,
  "shopifyValue"       TEXT,
  "externalValue"      TEXT,
  "difference"         DOUBLE PRECISION,
  "impactAmount"       DOUBLE PRECISION,
  "impactCurrency"     TEXT,
  "impactBasis"        TEXT,
  "evidenceJson"       TEXT,
  "findingFingerprint" TEXT,
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReconciliationDiscrepancy_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ReconciliationSource_storeId_checkType_uploadedAt_idx"
  ON "ReconciliationSource"("storeId", "checkType", "uploadedAt");
CREATE INDEX IF NOT EXISTS "ReconciliationSource_storeId_status_idx"
  ON "ReconciliationSource"("storeId", "status");
CREATE INDEX IF NOT EXISTS "ReconciliationRecord_storeId_sourceId_idx"
  ON "ReconciliationRecord"("storeId", "sourceId");
CREATE INDEX IF NOT EXISTS "ReconciliationRecord_sourceId_sku_idx"
  ON "ReconciliationRecord"("sourceId", "sku");
CREATE INDEX IF NOT EXISTS "ReconciliationRecord_sourceId_orderRef_idx"
  ON "ReconciliationRecord"("sourceId", "orderRef");
CREATE INDEX IF NOT EXISTS "ReconciliationRun_storeId_checkType_startedAt_idx"
  ON "ReconciliationRun"("storeId", "checkType", "startedAt");
CREATE INDEX IF NOT EXISTS "ReconciliationRun_storeId_status_idx"
  ON "ReconciliationRun"("storeId", "status");
CREATE INDEX IF NOT EXISTS "ReconciliationDiscrepancy_storeId_runId_idx"
  ON "ReconciliationDiscrepancy"("storeId", "runId");
CREATE INDEX IF NOT EXISTS "ReconciliationDiscrepancy_runId_kind_idx"
  ON "ReconciliationDiscrepancy"("runId", "kind");
CREATE INDEX IF NOT EXISTS "ReconciliationDiscrepancy_storeId_subjectKey_idx"
  ON "ReconciliationDiscrepancy"("storeId", "subjectKey");

DO $$
BEGIN
  ALTER TABLE "ReconciliationSource"
    ADD CONSTRAINT "ReconciliationSource_storeId_fkey"
    FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "ReconciliationRecord"
    ADD CONSTRAINT "ReconciliationRecord_sourceId_fkey"
    FOREIGN KEY ("sourceId") REFERENCES "ReconciliationSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "ReconciliationRun"
    ADD CONSTRAINT "ReconciliationRun_storeId_fkey"
    FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "ReconciliationRun"
    ADD CONSTRAINT "ReconciliationRun_sourceId_fkey"
    FOREIGN KEY ("sourceId") REFERENCES "ReconciliationSource"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "ReconciliationDiscrepancy"
    ADD CONSTRAINT "ReconciliationDiscrepancy_runId_fkey"
    FOREIGN KEY ("runId") REFERENCES "ReconciliationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

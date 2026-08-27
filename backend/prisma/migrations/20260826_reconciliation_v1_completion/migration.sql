-- Reconciliation V1 completion.
--
-- WHY
-- ---
-- Four gaps, each of which could have produced a wrong or unexplainable
-- merchant-facing claim.
--
-- 1. EVIDENCE LIVED IN PROCESS MEMORY. expectedAmount, expectedQuantity,
--    receivedQuantity and unitCost were held in a Map for the life of the
--    process. After a Render restart or redeploy, re-running an old upload
--    silently skipped every check that needed them, and the run still displayed
--    as complete. Those are columns now, so a run is reproducible from the
--    database alone.
--
-- 2. NO ORDER LINE ITEMS. A 3PL invoice claiming "4 items picked" could only be
--    compared against an order total, which says nothing about how many things
--    were in the order. OrderLineItem makes per-item comparison possible.
--
-- 3. NO PERSISTENT RATE CARD. Agreed pricing had nowhere to live, so the
--    engine could only ever say a charge was unverified. RateCard and
--    RateCardEntry hold it, VERSIONED — a merchant who renegotiates must not
--    change what an earlier reconciliation found.
--
-- 4. XLSX SHEET SELECTION. Only the first worksheet was read and the rest were
--    silently ignored. The sheet list and the chosen sheet are recorded.
--
-- SAFETY
-- ------
-- Entirely additive and idempotent. No column is dropped, no column changes
-- type, no existing row is rewritten, and every added column is nullable or
-- carries a default that means exactly what its absence meant before.
--
-- ReconciliationRecord.valueSource defaults to 'merchant_file'. Existing rows
-- carry no reference values at all (the columns are new and NULL), so the
-- default describes rows that have nothing to describe and cannot mislabel
-- anything.
--
-- Rollback: drop the added columns and the three new tables. The previous
-- application build also runs unchanged against this schema, because nothing
-- existing reads or writes any of it.

-- ---------------------------------------------------------------------------
-- 1. Persisted reconciliation evidence
-- ---------------------------------------------------------------------------

ALTER TABLE "ReconciliationRecord"
  ADD COLUMN IF NOT EXISTS "expectedAmount"   DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "expectedQuantity" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "receivedQuantity" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "unitCost"         DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "chargeType"       TEXT,
  ADD COLUMN IF NOT EXISTS "valueSource"      TEXT NOT NULL DEFAULT 'merchant_file',
  ADD COLUMN IF NOT EXISTS "duplicateOfRow"   INTEGER;

ALTER TABLE "ReconciliationSource"
  ADD COLUMN IF NOT EXISTS "availableSheetsJson" TEXT,
  ADD COLUMN IF NOT EXISTS "sheetName"           TEXT;

ALTER TABLE "ReconciliationRun"
  ADD COLUMN IF NOT EXISTS "rateCardId"      TEXT,
  ADD COLUMN IF NOT EXISTS "rateCardVersion" INTEGER,
  ADD COLUMN IF NOT EXISTS "rateCardName"    TEXT;

ALTER TABLE "ReconciliationDiscrepancy"
  ADD COLUMN IF NOT EXISTS "expectedValue"   TEXT,
  ADD COLUMN IF NOT EXISTS "chargeType"      TEXT,
  ADD COLUMN IF NOT EXISTS "rateCardVersion" INTEGER;

-- Why a variant has no inventory figure. "we are not allowed to look" and "the
-- merchant does not track this variant" are different facts and were
-- indistinguishable as a bare NULL.
ALTER TABLE "VariantSnapshot"
  ADD COLUMN IF NOT EXISTS "inventorySource" TEXT;

-- ---------------------------------------------------------------------------
-- 2. Order line items
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "OrderLineItem" (
  "id"                  TEXT NOT NULL,
  "orderId"             TEXT NOT NULL,
  "storeId"             TEXT NOT NULL,
  "shopifyLineItemId"   TEXT NOT NULL,
  "shopifyVariantId"    TEXT,
  "shopifyProductId"    TEXT,
  "sku"                 TEXT,
  "title"               TEXT,
  "quantity"            INTEGER NOT NULL,
  "currentQuantity"     INTEGER,
  "fulfillableQuantity" INTEGER,
  "refundedQuantity"    INTEGER,
  "fulfilledQuantity"   INTEGER,
  "price"               DOUBLE PRECISION,
  "currency"            TEXT,
  "syncedAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OrderLineItem_pkey" PRIMARY KEY ("id")
);

-- Repeat syncs UPDATE rather than duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS "OrderLineItem_storeId_shopifyLineItemId_key"
  ON "OrderLineItem"("storeId", "shopifyLineItemId");
CREATE INDEX IF NOT EXISTS "OrderLineItem_storeId_sku_idx"
  ON "OrderLineItem"("storeId", "sku");
CREATE INDEX IF NOT EXISTS "OrderLineItem_orderId_idx"
  ON "OrderLineItem"("orderId");

-- ---------------------------------------------------------------------------
-- 3. Versioned rate cards
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "RateCard" (
  "id"             TEXT NOT NULL,
  "storeId"        TEXT NOT NULL,
  "name"           TEXT NOT NULL,
  "version"        INTEGER NOT NULL,
  "status"         TEXT NOT NULL DEFAULT 'active',
  "sourceFileName" TEXT,
  "currency"       TEXT,
  "note"           TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RateCard_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "RateCardEntry" (
  "id"          TEXT NOT NULL,
  "rateCardId"  TEXT NOT NULL,
  "storeId"     TEXT NOT NULL,
  "chargeKey"   TEXT NOT NULL,
  "chargeType"  TEXT NOT NULL,
  "aliasesJson" TEXT,
  "unit"        TEXT,
  "rate"        DOUBLE PRECISION NOT NULL,
  "currency"    TEXT,
  "minQuantity" DOUBLE PRECISION,
  "maxQuantity" DOUBLE PRECISION,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RateCardEntry_pkey" PRIMARY KEY ("id")
);

-- One version number per (store, card name). Uploading new pricing creates the
-- next version; it never overwrites the previous one.
CREATE UNIQUE INDEX IF NOT EXISTS "RateCard_storeId_name_version_key"
  ON "RateCard"("storeId", "name", "version");
CREATE INDEX IF NOT EXISTS "RateCard_storeId_status_idx"
  ON "RateCard"("storeId", "status");
CREATE INDEX IF NOT EXISTS "RateCardEntry_storeId_rateCardId_idx"
  ON "RateCardEntry"("storeId", "rateCardId");
CREATE INDEX IF NOT EXISTS "RateCardEntry_rateCardId_chargeKey_idx"
  ON "RateCardEntry"("rateCardId", "chargeKey");

-- ---------------------------------------------------------------------------
-- 4. Foreign keys
--
-- ReconciliationRun -> RateCard is ON DELETE SET NULL, never CASCADE: deleting
-- a rate card must not delete the history of runs that used it. The run keeps
-- rateCardVersion and rateCardName, which are denormalized precisely so the
-- evidence survives the card.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  ALTER TABLE "OrderLineItem"
    ADD CONSTRAINT "OrderLineItem_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "RateCard"
    ADD CONSTRAINT "RateCard_storeId_fkey"
    FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "RateCardEntry"
    ADD CONSTRAINT "RateCardEntry_rateCardId_fkey"
    FOREIGN KEY ("rateCardId") REFERENCES "RateCard"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "ReconciliationRun"
    ADD CONSTRAINT "ReconciliationRun_rateCardId_fkey"
    FOREIGN KEY ("rateCardId") REFERENCES "RateCard"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

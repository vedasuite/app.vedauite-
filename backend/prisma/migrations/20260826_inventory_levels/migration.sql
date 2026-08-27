-- Per-location Shopify inventory.
--
-- WHY
-- ---
-- Store-wide stock comes from ProductVariant.inventoryQuantity, which needs
-- only read_products. Per-LOCATION stock comes from InventoryLevel, which needs
-- read_inventory, and location names need read_locations. Those two scopes are
-- newly requested and NO EXISTING MERCHANT HAS GRANTED THEM.
--
-- So this table is frequently empty, and that is a normal state rather than a
-- fault. Emptiness means "not permitted, or not yet synced" — never "zero
-- stock". The sync records which of those it was, and nothing reads a missing
-- row as a quantity.
--
-- SAFETY
-- ------
-- Purely additive: one new table, three indexes, one foreign key. No existing
-- table is altered, no column changes type, no row is rewritten, and no
-- existing query changes meaning. Dropping the table restores the previous
-- schema exactly, and the previous application build runs unchanged against
-- this one because nothing existing reads or writes it.

CREATE TABLE IF NOT EXISTS "InventoryLevelSnapshot" (
  "id"                     TEXT NOT NULL,
  "storeId"                TEXT NOT NULL,
  "shopifyLocationId"      TEXT NOT NULL,
  "locationName"           TEXT,
  "shopifyVariantId"       TEXT,
  "shopifyInventoryItemId" TEXT,
  "sku"                    TEXT,
  "available"              INTEGER,
  "syncedAt"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"              TIMESTAMP(3) NOT NULL,
  CONSTRAINT "InventoryLevelSnapshot_pkey" PRIMARY KEY ("id")
);

-- Repeat syncs UPDATE rather than duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS
  "InventoryLevelSnapshot_storeId_location_item_key"
  ON "InventoryLevelSnapshot"("storeId", "shopifyLocationId", "shopifyInventoryItemId");
CREATE INDEX IF NOT EXISTS "InventoryLevelSnapshot_storeId_sku_idx"
  ON "InventoryLevelSnapshot"("storeId", "sku");
CREATE INDEX IF NOT EXISTS "InventoryLevelSnapshot_storeId_shopifyLocationId_idx"
  ON "InventoryLevelSnapshot"("storeId", "shopifyLocationId");

DO $$
BEGIN
  ALTER TABLE "InventoryLevelSnapshot"
    ADD CONSTRAINT "InventoryLevelSnapshot_storeId_fkey"
    FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

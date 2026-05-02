ALTER TABLE "Order"
ADD COLUMN IF NOT EXISTS "shopifyOrderGid" TEXT,
ADD COLUMN IF NOT EXISTS "shopifyLegacyOrderId" TEXT,
ADD COLUMN IF NOT EXISTS "orderName" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "Order_shopifyOrderGid_key"
ON "Order"("shopifyOrderGid");

CREATE INDEX IF NOT EXISTS "Order_storeId_shopifyLegacyOrderId_idx"
ON "Order"("storeId", "shopifyLegacyOrderId");

CREATE INDEX IF NOT EXISTS "Order_storeId_orderName_idx"
ON "Order"("storeId", "orderName");

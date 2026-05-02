ALTER TABLE "Order"
ADD COLUMN IF NOT EXISTS "shopifyOrderGid" TEXT,
ADD COLUMN IF NOT EXISTS "shopifyLegacyOrderId" TEXT,
ADD COLUMN IF NOT EXISTS "orderName" TEXT;

UPDATE "Order"
SET "shopifyOrderGid" = NULL
WHERE "shopifyOrderGid" IS NOT NULL
  AND BTRIM("shopifyOrderGid") = '';

WITH ranked_gids AS (
  SELECT
    id,
    "shopifyOrderGid",
    ROW_NUMBER() OVER (
      PARTITION BY "shopifyOrderGid"
      ORDER BY
        CASE WHEN "shopifyLegacyOrderId" IS NOT NULL THEN 0 ELSE 1 END,
        CASE WHEN "orderName" IS NOT NULL THEN 0 ELSE 1 END,
        "updatedAt" DESC,
        "createdAt" DESC,
        id DESC
    ) AS gid_rank
  FROM "Order"
  WHERE "shopifyOrderGid" IS NOT NULL
)
UPDATE "Order" AS duplicate_order
SET "shopifyOrderGid" = NULL
FROM ranked_gids
WHERE duplicate_order.id = ranked_gids.id
  AND ranked_gids.gid_rank > 1;

DROP INDEX IF EXISTS "Order_shopifyOrderGid_key";

CREATE UNIQUE INDEX IF NOT EXISTS "Order_shopifyOrderGid_key"
ON "Order"("shopifyOrderGid")
WHERE "shopifyOrderGid" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "Order_storeId_shopifyLegacyOrderId_idx"
ON "Order"("storeId", "shopifyLegacyOrderId");

CREATE INDEX IF NOT EXISTS "Order_storeId_orderName_idx"
ON "Order"("storeId", "orderName");

CREATE INDEX IF NOT EXISTS "Order_shopifyOrderGid_idx"
ON "Order"("shopifyOrderGid");

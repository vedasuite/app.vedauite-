-- ORDER IDENTITY IS STORE-SCOPED, NOT GLOBAL.
--
-- `Order.shopifyOrderId` holds the Shopify order NAME ("#1001"), which is
-- unique only WITHIN a store. It carried a GLOBAL unique constraint.
--
-- The sync looks an order up scoped to its store:
--
--     findFirst({ where: { storeId, OR: [...shopifyOrderId: "#1001"] } })
--
-- so a second merchant's #1001 was never found, fell through to create(), and
-- collided with the first merchant's row. The failure is deterministic — the
-- store-scoped lookup can never find another store's row — so every retry
-- failed identically and the sync ended SYNC_REQUIRED.
--
-- Shopify starts every store at #1001, so this broke onboarding for
-- essentially any merchant after the first.
--
-- SAFETY: this WIDENS the constraint. Every row that satisfied a global unique
-- on ("shopifyOrderId") necessarily satisfies a unique on
-- ("storeId", "shopifyOrderId"). No row can conflict, so no data is rewritten,
-- deleted or de-duplicated here. That property is why this migration needs no
-- backfill and no cleanup step.
--
-- NOT TOUCHED: "Order_shopifyOrderGid_key" (the partial unique index created by
-- 20260502_order_identity_fields). Order GIDs genuinely ARE globally unique, so
-- that constraint is correct and stays exactly as it is.

CREATE UNIQUE INDEX IF NOT EXISTS "Order_storeId_shopifyOrderId_key"
ON "Order"("storeId", "shopifyOrderId");

-- Dropped only AFTER the replacement exists, so the column is never left
-- without a uniqueness guarantee, not even briefly.
DROP INDEX IF EXISTS "Order_shopifyOrderId_key";

-- Profit input provenance.
--
-- WHY
-- ---
-- coreEngineService persisted ASSUMED values into ProfitOptimizationData:
--
--   productCost   = latestProfit?.productCost   ?? currentPrice * 0.58
--   salesVelocity = latestProfit?.salesVelocity ?? max(4, orders / products)
--
-- Later readers null-checked those fields and treated a non-null value as an
-- observation, which is how "Potential revenue $5,641" and "AI confidence 60%"
-- reached merchants with no supporting evidence.
--
-- productCost was NOT NULL, so "unknown" could not be represented at all.
--
-- WHAT THIS DOES
-- --------------
-- 1. Makes productCost nullable so UNKNOWN can stay UNKNOWN.
-- 2. Adds explicit provenance for the two inputs that gate monetary claims.
--
-- Existing rows default to 'assumed'. That is not a guess: the audit
-- established VedaSuite has no Shopify product-cost feed and no order line
-- items, so no historical value could have been observed. No existing value is
-- read, rewritten or deleted.
--
-- Additive and idempotent. Widening a column to nullable cannot fail on
-- existing data.

ALTER TABLE "ProfitOptimizationData"
  ALTER COLUMN "productCost" DROP NOT NULL;

ALTER TABLE "ProfitOptimizationData"
  ADD COLUMN IF NOT EXISTS "costSource" TEXT NOT NULL DEFAULT 'assumed',
  ADD COLUMN IF NOT EXISTS "velocitySource" TEXT NOT NULL DEFAULT 'assumed';

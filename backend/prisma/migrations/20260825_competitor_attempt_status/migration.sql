-- Per-domain competitor collection status.
--
-- WHY
-- ---
-- Competitor fetch failures were only logged, never persisted, so the UI could
-- not tell a merchant that a domain had failed. Freshness was inferred by
-- comparing CompetitorData.collectedAt against the last sync time, which cannot
-- distinguish "unresolvable domain" from "site blocked us" from "page had no
-- price" - and cannot report anything at all for a domain that never collected.
--
-- Recording the outcome of the last attempt removes the inference.
--
-- Additive and idempotent. All columns are nullable, so existing rows are
-- untouched and mean exactly what they meant before: never attempted.

ALTER TABLE "CompetitorDomain"
  ADD COLUMN IF NOT EXISTS "lastAttemptAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "lastAttemptStatus" TEXT,
  ADD COLUMN IF NOT EXISTS "lastAttemptDetail" TEXT,
  ADD COLUMN IF NOT EXISTS "lastSuccessAt" TIMESTAMP(3);

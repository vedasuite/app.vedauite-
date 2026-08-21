-- Persisted envelope around computed intelligence findings.
--
-- ADDITIVE AND NON-DESTRUCTIVE: creates one new table and its indexes. It
-- alters no existing table, drops nothing, renames nothing, and backfills
-- nothing, so it cannot affect any current row, query or code path. Existing
-- deployments that have never run it are functionally identical to ones that
-- have until the feature flag is switched on.
--
-- Every statement is guarded with IF NOT EXISTS so a re-run (or a redelivered
-- deploy) converges instead of failing. The foreign key is declared inline in
-- the CREATE TABLE rather than as a separate ALTER, because Postgres has no
-- "ADD CONSTRAINT IF NOT EXISTS" and an inline declaration inherits the
-- table's IF NOT EXISTS guard.
--
-- ON DELETE CASCADE is intentional: a finding is derived data describing a
-- store, so a shop/redact purge (privacyService.deleteStoreCompletely) must
-- remove it along with everything else it was computed from.
--
-- This table holds NO analytical semantics — no severity, confidence,
-- financial impact, evidence, methodology, recommended action or data
-- coverage. Those stay owned by services/explainabilityCalc.ts. See the
-- IntelligenceFinding doc comment in schema.prisma.
CREATE TABLE IF NOT EXISTS "IntelligenceFinding" (
  "id" TEXT NOT NULL,
  "storeId" TEXT NOT NULL,
  "fingerprint" TEXT NOT NULL,
  "module" TEXT NOT NULL,
  "findingType" TEXT NOT NULL,
  "sourceInsightId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'new',
  "firstDetectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "detectionCount" INTEGER NOT NULL DEFAULT 1,
  "statusChangedAt" TIMESTAMP(3),
  "resolvedAt" TIMESTAMP(3),
  "dismissedAt" TIMESTAMP(3),
  "resolutionNote" TEXT,
  "statusChangedBy" TEXT,
  "snapshotJson" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "IntelligenceFinding_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "IntelligenceFinding_storeId_fkey"
    FOREIGN KEY ("storeId") REFERENCES "Store"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

-- Deduplication / idempotency: one row per (store, fingerprint). Repeated
-- detection of the same finding updates this row instead of inserting a new
-- one, and a concurrent double-detect surfaces as a unique violation the
-- service handles by falling back to an update.
CREATE UNIQUE INDEX IF NOT EXISTS "IntelligenceFinding_storeId_fingerprint_key"
  ON "IntelligenceFinding"("storeId", "fingerprint");

-- Action Center read paths: "open findings for this store, most recent first"
-- and "findings for this store and module by status".
CREATE INDEX IF NOT EXISTS "IntelligenceFinding_storeId_status_lastSeenAt_idx"
  ON "IntelligenceFinding"("storeId", "status", "lastSeenAt");

CREATE INDEX IF NOT EXISTS "IntelligenceFinding_storeId_module_status_idx"
  ON "IntelligenceFinding"("storeId", "module", "status");

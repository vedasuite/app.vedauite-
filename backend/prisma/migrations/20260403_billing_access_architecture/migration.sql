ALTER TABLE "Store"
  ADD COLUMN IF NOT EXISTS "trialStartedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "trialEndsAt" TIMESTAMP(3);

ALTER TABLE "StoreSubscription"
  ADD COLUMN IF NOT EXISTS "billingStatus" TEXT NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN IF NOT EXISTS "planActivatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN IF NOT EXISTS "cancelledAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "lastBillingSyncAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "moduleSwitchedAt" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "BillingAuditLog" (
  "id" TEXT NOT NULL,
  "storeId" TEXT NOT NULL,
  "subscriptionId" TEXT,
  "eventType" TEXT NOT NULL,
  "previousPlanName" TEXT,
  "nextPlanName" TEXT,
  "previousStarterModule" TEXT,
  "nextStarterModule" TEXT,
  "billingStatus" TEXT,
  "metadataJson" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BillingAuditLog_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "BillingAuditLog_storeId_fkey"
    FOREIGN KEY ("storeId") REFERENCES "Store"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "BillingAuditLog_subscriptionId_fkey"
    FOREIGN KEY ("subscriptionId") REFERENCES "StoreSubscription"("id")
    ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "BillingAuditLog_storeId_createdAt_idx"
  ON "BillingAuditLog"("storeId", "createdAt");

CREATE INDEX IF NOT EXISTS "BillingAuditLog_subscriptionId_createdAt_idx"
  ON "BillingAuditLog"("subscriptionId", "createdAt");

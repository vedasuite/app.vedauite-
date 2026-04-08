CREATE TABLE "BillingPlanIntent" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "requestedPlanName" TEXT NOT NULL,
    "requestedStarterModule" TEXT,
    "actionType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'CREATING',
    "confirmationUrl" TEXT,
    "shopifyChargeId" TEXT,
    "host" TEXT,
    "returnPath" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "confirmedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "BillingPlanIntent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "BillingPlanIntent_storeId_status_createdAt_idx"
ON "BillingPlanIntent"("storeId", "status", "createdAt");

ALTER TABLE "BillingPlanIntent"
ADD CONSTRAINT "BillingPlanIntent_storeId_fkey"
FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

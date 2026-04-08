ALTER TABLE "StoreSubscription"
ADD COLUMN "lastBillingWebhookProcessedAt" TIMESTAMP(3),
ADD COLUMN "lastBillingResolutionSource" TEXT,
ADD COLUMN "lastBillingSubscriptionName" TEXT;

UPDATE "StoreSubscription"
SET
  "lastBillingWebhookProcessedAt" = "lastBillingSyncAt",
  "lastBillingResolutionSource" = COALESCE("lastBillingResolutionSource", 'legacy_backfill'),
  "lastBillingSubscriptionName" = COALESCE("lastBillingSubscriptionName", (
    SELECT "SubscriptionPlan"."name"
    FROM "SubscriptionPlan"
    WHERE "SubscriptionPlan"."id" = "StoreSubscription"."planId"
  ))
WHERE "lastBillingSyncAt" IS NOT NULL;

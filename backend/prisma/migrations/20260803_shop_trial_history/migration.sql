-- Durable, per-shop trial history — independent of the Store row's
-- lifecycle. Deliberately has NO foreign key to "Store", so it is never
-- affected by Store's ON DELETE CASCADE (triggered by shop/redact or the
-- retention sweep). See schema.prisma ShopTrialHistory doc comment.
--
-- Backfill: for every shop that currently has trial dates on its Store row,
-- record that same window here so already-known shops are protected
-- immediately, without granting anyone a new trial. Shops with no trial
-- dates yet are left alone — they get a history row the next time they
-- genuinely go through the install path.
CREATE TABLE IF NOT EXISTS "ShopTrialHistory" (
  "id" TEXT NOT NULL,
  "shop" TEXT NOT NULL,
  "firstInstalledAt" TIMESTAMP(3) NOT NULL,
  "trialStartedAt" TIMESTAMP(3) NOT NULL,
  "trialEndsAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ShopTrialHistory_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ShopTrialHistory_shop_key"
  ON "ShopTrialHistory"("shop");

INSERT INTO "ShopTrialHistory" ("id", "shop", "firstInstalledAt", "trialStartedAt", "trialEndsAt", "createdAt")
SELECT
  'seed_' || substr(md5(random()::text || clock_timestamp()::text), 1, 20),
  "shop",
  COALESCE("installedAt", "trialStartedAt", "createdAt"),
  "trialStartedAt",
  "trialEndsAt",
  CURRENT_TIMESTAMP
FROM "Store"
WHERE "trialStartedAt" IS NOT NULL
  AND "trialEndsAt" IS NOT NULL
ON CONFLICT ("shop") DO NOTHING;

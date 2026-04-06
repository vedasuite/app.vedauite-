ALTER TABLE "Store"
ADD COLUMN IF NOT EXISTS "tokenAcquisitionMode" TEXT DEFAULT 'offline_expiring';

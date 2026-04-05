ALTER TABLE "Store"
ADD COLUMN "reauthorizedAt" TIMESTAMP(3),
ADD COLUMN "lastWebhookRegistrationStatus" TEXT,
ADD COLUMN "authErrorCode" TEXT,
ADD COLUMN "authErrorMessage" TEXT,
ADD COLUMN "accessTokenExpiresAt" TIMESTAMP(3),
ADD COLUMN "refreshToken" TEXT,
ADD COLUMN "refreshTokenExpiresAt" TIMESTAMP(3);

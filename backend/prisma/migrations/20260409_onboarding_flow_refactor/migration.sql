ALTER TABLE "Store"
ADD COLUMN "onboardingSelectedModule" TEXT,
ADD COLUMN "onboardingFirstInsightViewedAt" TIMESTAMP(3),
ADD COLUMN "onboardingPlanConfirmedAt" TIMESTAMP(3);

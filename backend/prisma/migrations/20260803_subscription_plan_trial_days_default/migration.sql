-- Corrects the dormant SubscriptionPlan.trialDays column default from 3 to
-- 7, matching env.billing.trialDays (BILLING_PLAN_TRIAL_DAYS, default 7) —
-- the single runtime source of truth for trial length.
--
-- This does not touch any existing row's stored value. Every current code
-- path that creates a SubscriptionPlan row already passes trialDays
-- explicitly, so this default has not been hit in production; it is
-- corrected here so it can never silently diverge if that ever changes.
ALTER TABLE "SubscriptionPlan"
  ALTER COLUMN "trialDays" SET DEFAULT 7;

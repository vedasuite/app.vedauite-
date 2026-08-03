import { Badge, BlockStack, Banner, Box, Button, Card, Icon, InlineStack, Text } from "@shopify/polaris";
import { CalendarIcon, CheckCircleIcon, ConfettiIcon } from "@shopify/polaris-icons";

/**
 * Shared presentation of the plan-selected trial.
 *
 * PRESENTATIONAL ONLY. It never decides whether a trial is active — callers
 * pass `trialActive`, which must come from the canonical entitlement state
 * (`appState.billing.trialActive`, resolved server-side by the same resolver
 * the Billing page uses). Nothing here infers access from a date.
 *
 * Plan-selected trial model (2026-08-03): the trial only starts once a plan
 * (STARTER/GROWTH/PRO) is approved in Shopify, and only that plan's features
 * unlock during it — never "every module". Before any plan is approved,
 * `trialActive` is false and these components render nothing; use
 * `ChoosePlanCard`/`ChoosePlanBanner` for that state instead.
 *
 * Centralising the date and days-remaining formatting here is what stops
 * Onboarding, Dashboard and Billing drifting apart.
 */

export type TrialStatusData = {
  /** Canonical active-trial flag. The component renders nothing when false. */
  trialActive: boolean;
  /** ISO timestamp of trial expiry. */
  trialEndsAt: string | null;
  /**
   * The plan that begins when the trial ends. "TRIAL"/"NONE" are treated as
   * "not a real selected plan" so the UI never says "your TRIAL plan begins".
   */
  planName: string | null;
};

/** "8 Aug 2026" — a fixed, unambiguous format for every locale. */
export function formatTrialDate(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/**
 * Whole days left, rounded up so a trial ending later today reads as
 * "1 day remaining" rather than "0". Returns null when unknown/expired.
 */
export function trialDaysRemaining(trialEndsAt: string | null): number | null {
  if (!trialEndsAt) return null;
  const endsAt = new Date(trialEndsAt).getTime();
  if (!Number.isFinite(endsAt)) return null;
  const msLeft = endsAt - Date.now();
  if (msLeft <= 0) return null;
  return Math.ceil(msLeft / 86_400_000);
}

/** "1 day remaining" / "5 days remaining" / "Ends today". */
export function trialRemainingLabel(trialEndsAt: string | null): string {
  const days = trialDaysRemaining(trialEndsAt);
  if (days === null) return "Ends today";
  return `${days} day${days === 1 ? "" : "s"} remaining`;
}

/** A real, chargeable plan the merchant picked — not a placeholder. */
export function selectedPaidPlan(planName: string | null): string | null {
  if (!planName) return null;
  const normalized = planName.trim().toUpperCase();
  if (normalized === "TRIAL" || normalized === "NONE" || normalized === "UNKNOWN") {
    return null;
  }
  return normalized.charAt(0) + normalized.slice(1).toLowerCase();
}

/**
 * Sentence describing what's unlocked right now, scoped to the selected
 * plan — plan-selected trial model, so only that plan's features are
 * active, not "every module".
 */
export function trialPlanSentence(planName: string | null): string {
  const plan = selectedPaidPlan(planName);
  return plan
    ? `Your ${plan} features are active. You will not be charged until the trial ends.`
    : `Your selected features are active. You will not be charged until the trial ends.`;
}

/**
 * Detailed card — Onboarding.
 * Renders nothing unless the canonical trial flag is set (i.e. a plan has
 * been approved in Shopify and its trial window is still open). Use
 * `ChoosePlanCard` for the "no plan approved yet" state instead.
 */
export function TrialStatusCard({
  data,
  onViewBilling,
}: {
  data: TrialStatusData;
  onViewBilling: () => void;
}) {
  if (!data.trialActive) return null;

  const formattedDate = formatTrialDate(data.trialEndsAt);
  const remaining = trialRemainingLabel(data.trialEndsAt);
  const plan = selectedPaidPlan(data.planName);

  return (
    <Card padding="400">
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="center" gap="300" wrap>
          <InlineStack gap="200" blockAlign="center" wrap={false}>
            <Box as="span">
              <Icon source={ConfettiIcon} tone="success" />
            </Box>
            <Text as="h2" variant="headingMd">
              {plan ? `${plan} trial active` : "Trial active"}
            </Text>
          </InlineStack>
          <Badge tone="success">{remaining}</Badge>
        </InlineStack>

        <Text as="p" variant="bodyMd">
          {formattedDate
            ? `${trialPlanSentence(data.planName)} Trial ends ${formattedDate}.`
            : trialPlanSentence(data.planName)}
        </Text>

        <InlineStack gap="200" blockAlign="start" wrap={false}>
          <Box as="span" paddingBlockStart="050">
            <Icon source={CheckCircleIcon} tone="success" />
          </Box>
          <div style={{ minInlineSize: 0 }}>
            <Text as="p" variant="bodySm" tone="subdued">
              {plan
                ? `Shopify will start billing for ${plan} only after the trial ends.`
                : "Shopify will not bill you until the trial ends."}
            </Text>
          </div>
        </InlineStack>

        {formattedDate ? (
          <InlineStack gap="200" blockAlign="center" wrap={false}>
            <Box as="span">
              <Icon source={CalendarIcon} tone="subdued" />
            </Box>
            <Text as="span" variant="bodySm" tone="subdued">
              {`Trial ends ${formattedDate}`}
            </Text>
          </InlineStack>
        ) : null}

        <InlineStack gap="200" wrap>
          <Button onClick={onViewBilling}>View billing</Button>
        </InlineStack>
      </BlockStack>
    </Card>
  );
}

/**
 * Compact banner — Dashboard. Deliberately one line of status plus an action,
 * so it slots into the existing layout without changing its rhythm.
 */
export function TrialStatusBanner({
  data,
  onViewBilling,
}: {
  data: TrialStatusData;
  onViewBilling: () => void;
}) {
  if (!data.trialActive) return null;

  const formattedDate = formatTrialDate(data.trialEndsAt);
  const remaining = trialRemainingLabel(data.trialEndsAt);
  const plan = selectedPaidPlan(data.planName);

  return (
    <Banner tone="success" title={plan ? `${plan} trial active` : "Trial active"}>
      <BlockStack gap="200">
        <Text as="p" variant="bodySm">
          {formattedDate
            ? `${remaining} · ${plan ? `${plan} features` : "Your selected features"} active until ${formattedDate}.`
            : `${remaining} · ${plan ? `${plan} features` : "Your selected features"} active.`}
        </Text>
        <InlineStack gap="200" wrap>
          <Button onClick={onViewBilling}>View billing</Button>
        </InlineStack>
      </BlockStack>
    </Banner>
  );
}

/**
 * The single source of choose-a-plan wording, shared by the Onboarding card and
 * the Dashboard banner so the two can never drift.
 *
 * `trialEligible` comes from the server (billing.trialEligible, backed by
 * ShopTrialHistory). It must NEVER be inferred here from trialActive, planName,
 * lifecycle, or trial dates — none of those separate "never had a trial" from
 * "already used it", and promising a 7-day trial to a shop whose one trial is
 * spent is the bug this exists to fix. A missing/undefined value is treated as
 * ineligible, so a stale or partial payload can only ever under-promise.
 */
function choosePlanCopy(trialEligible: boolean | undefined) {
  if (trialEligible === true) {
    return {
      title: "Choose a plan to start your 7-day free trial",
      body: "Select STARTER, GROWTH or PRO and approve it in Shopify. You will not be charged until the trial ends.",
      cta: "View plans / Start free trial",
    };
  }

  return {
    title: "Choose a plan to activate VedaSuite",
    body: "Your free trial has already been used. Select a plan to continue using VedaSuite.",
    cta: "View plans",
  };
}

/**
 * Detailed card — Onboarding. Shown when NO plan has been approved yet
 * (trialActive is false and no plan is selected) — the trial has not
 * started, so this must never claim any module is unlocked.
 */
export function ChoosePlanCard({
  onChoosePlan,
  trialEligible,
}: {
  onChoosePlan: () => void;
  trialEligible: boolean | undefined;
}) {
  const copy = choosePlanCopy(trialEligible);

  return (
    <Card padding="400">
      <BlockStack gap="300">
        <Text as="h2" variant="headingMd">
          {copy.title}
        </Text>
        <Text as="p" variant="bodyMd">
          {copy.body}
        </Text>
        <InlineStack gap="200" wrap>
          <Button variant="primary" onClick={onChoosePlan}>
            {copy.cta}
          </Button>
        </InlineStack>
      </BlockStack>
    </Card>
  );
}

/**
 * Compact banner — Dashboard equivalent of `ChoosePlanCard`.
 */
export function ChoosePlanBanner({
  onChoosePlan,
  trialEligible,
}: {
  onChoosePlan: () => void;
  trialEligible: boolean | undefined;
}) {
  const copy = choosePlanCopy(trialEligible);

  return (
    <Banner tone="info" title={copy.title}>
      <BlockStack gap="200">
        <Text as="p" variant="bodySm">
          {copy.body}
        </Text>
        <InlineStack gap="200" wrap>
          <Button variant="primary" onClick={onChoosePlan}>
            {copy.cta}
          </Button>
        </InlineStack>
      </BlockStack>
    </Banner>
  );
}

/** Exported for tests — the canonical choose-a-plan copy resolver. */
export { choosePlanCopy };

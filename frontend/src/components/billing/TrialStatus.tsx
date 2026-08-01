import { Badge, BlockStack, Banner, Box, Button, Card, Icon, InlineStack, Text } from "@shopify/polaris";
import { CalendarIcon, CheckCircleIcon, ConfettiIcon } from "@shopify/polaris-icons";

/**
 * Shared presentation of the full-access trial.
 *
 * PRESENTATIONAL ONLY. It never decides whether a trial is active — callers
 * pass `trialActive`, which must come from the canonical entitlement state
 * (`appState.billing.trialActive`, resolved server-side by the same resolver
 * the Billing page uses). Nothing here infers access from a date.
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

/** Sentence describing what happens after the trial, with a safe fallback. */
export function postTrialPlanSentence(planName: string | null): string {
  const plan = selectedPaidPlan(planName);
  return plan
    ? `Your selected ${plan} subscription will begin after the free trial ends. You will not be charged before then.`
    : `Your selected subscription will begin after the free trial ends. You will not be charged before then.`;
}

/**
 * Detailed card — Onboarding.
 * Renders nothing unless the canonical trial flag is set.
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

  return (
    <Card padding="400">
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="center" gap="300" wrap>
          <InlineStack gap="200" blockAlign="center" wrap={false}>
            <Box as="span">
              <Icon source={ConfettiIcon} tone="success" />
            </Box>
            <Text as="h2" variant="headingMd">
              Full-access trial active
            </Text>
          </InlineStack>
          <Badge tone="success">{remaining}</Badge>
        </InlineStack>

        <Text as="p" variant="bodyMd">
          {formattedDate
            ? `All VedaSuite modules are unlocked until ${formattedDate}.`
            : "All VedaSuite modules are currently unlocked."}
        </Text>

        <InlineStack gap="200" blockAlign="start" wrap={false}>
          <Box as="span" paddingBlockStart="050">
            <Icon source={CheckCircleIcon} tone="success" />
          </Box>
          <div style={{ minInlineSize: 0 }}>
            <Text as="p" variant="bodySm" tone="subdued">
              {postTrialPlanSentence(data.planName)}
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

  return (
    <Banner tone="success" title="Full-access trial active">
      <BlockStack gap="200">
        <Text as="p" variant="bodySm">
          {formattedDate
            ? `${remaining} · All modules unlocked until ${formattedDate}.`
            : `${remaining} · All modules unlocked.`}
        </Text>
        <InlineStack gap="200" wrap>
          <Button onClick={onViewBilling}>View billing</Button>
        </InlineStack>
      </BlockStack>
    </Banner>
  );
}

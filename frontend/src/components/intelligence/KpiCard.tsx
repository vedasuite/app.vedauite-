import { Badge, BlockStack, Box, Card, Icon, InlineStack, Text } from "@shopify/polaris";
import { ArrowDownIcon, ArrowUpIcon } from "@shopify/polaris-icons";
import type { ReactNode } from "react";
import { AnimatedCounter } from "./AnimatedCounter";
import "./intelligence.css";

export type KpiTrend = {
  direction: "up" | "down";
  label: string;
  /** Whether this direction is good news — up isn't always positive. */
  isPositive: boolean;
};

/**
 * Premium KPI tile.
 *
 * Renders either an animated numeric value (`value` + `format`) or arbitrary
 * `display` content for non-numeric readings ("Not quantified", a module name).
 * Falls back to an explicit em dash rather than a zero when data is absent, so
 * "no data" is never mistaken for "zero dollars".
 */
export function KpiCard({
  label,
  value,
  format,
  display,
  caption,
  icon,
  iconTone = "subdued",
  trend,
  badge,
  badgeTone,
  footer,
  emphasis = false,
}: {
  label: string;
  /** Numeric reading — animates on mount. Omit when using `display`. */
  value?: number | null;
  format?: (n: number) => string;
  /** Non-numeric reading, rendered verbatim. */
  display?: ReactNode;
  caption?: string;
  icon?: typeof ArrowUpIcon;
  iconTone?: "critical" | "caution" | "success" | "info" | "subdued";
  trend?: KpiTrend | null;
  badge?: string;
  badgeTone?: "critical" | "warning" | "success" | "info" | "attention" | undefined;
  footer?: ReactNode;
  /** Larger value type, for the one or two headline tiles. */
  emphasis?: boolean;
}) {
  const hasNumber = typeof value === "number" && Number.isFinite(value) && !!format;

  return (
    <Card padding="400">
      <BlockStack gap="200">
        <InlineStack align="space-between" blockAlign="center" gap="200" wrap={false}>
          <InlineStack gap="150" blockAlign="center" wrap={false}>
            {icon ? (
              <Box as="span">
                <Icon source={icon} tone={iconTone} />
              </Box>
            ) : null}
            <Text as="h3" variant="bodySm" tone="subdued">
              {label}
            </Text>
          </InlineStack>
          {badge ? <Badge tone={badgeTone}>{badge}</Badge> : null}
        </InlineStack>

        <div className="veda-kpi-value veda-clamp">
          <Text as="p" variant={emphasis ? "heading2xl" : "headingLg"} fontWeight="semibold">
            {hasNumber ? (
              <AnimatedCounter value={value as number} format={format as (n: number) => string} />
            ) : (
              display ?? "—"
            )}
          </Text>
        </div>

        {trend ? (
          <InlineStack gap="100" blockAlign="center" wrap={false}>
            <Box as="span">
              <Icon
                source={trend.direction === "up" ? ArrowUpIcon : ArrowDownIcon}
                tone={trend.isPositive ? "success" : "critical"}
              />
            </Box>
            <Text
              as="span"
              variant="bodySm"
              tone={trend.isPositive ? "success" : "critical"}
            >
              {trend.label}
            </Text>
          </InlineStack>
        ) : null}

        {caption ? (
          <Text as="span" variant="bodySm" tone="subdued">
            {caption}
          </Text>
        ) : null}

        {footer}
      </BlockStack>
    </Card>
  );
}

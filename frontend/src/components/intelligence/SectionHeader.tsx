import { Badge, Box, Icon, InlineStack, Text } from "@shopify/polaris";
import type { ReactNode } from "react";
import type { InfoIcon } from "@shopify/polaris-icons";
import "./intelligence.css";

/**
 * The single section header used by every intelligence surface.
 *
 * Hierarchy here comes from structure, not font size: a small uppercase
 * eyebrow, a normal-weight title, an optional count, and a rule underneath.
 * That reads as a section boundary at 14px, where simply enlarging the text
 * would have made the page noisier without making it clearer.
 *
 * Using one header everywhere is what makes Dashboard / Fraud / Pricing /
 * Competitor feel like one product rather than four pages.
 */
export function SectionHeader({
  eyebrow,
  title,
  count,
  countTone,
  icon,
  iconTone = "subdued",
  action,
}: {
  /** Short uppercase kicker, e.g. "PRIORITISED". */
  eyebrow?: string;
  title: string;
  /** Right-aligned count chip, e.g. "3 ranked actions". */
  count?: string;
  countTone?: "critical" | "warning" | "success" | "info" | "attention" | undefined;
  icon?: typeof InfoIcon;
  iconTone?: "critical" | "caution" | "success" | "info" | "subdued";
  action?: ReactNode;
}) {
  return (
    <div className="veda-section-head">
      <InlineStack gap="200" blockAlign="center" wrap={false}>
        {icon ? (
          <Box as="span">
            <Icon source={icon} tone={iconTone} />
          </Box>
        ) : null}
        <div className="veda-clamp">
          {eyebrow ? <div className="veda-eyebrow">{eyebrow}</div> : null}
          <Text as="h2" variant="headingMd">
            {title}
          </Text>
        </div>
      </InlineStack>

      <InlineStack gap="200" blockAlign="center" wrap>
        {count ? <Badge tone={countTone}>{count}</Badge> : null}
        {action}
      </InlineStack>
    </div>
  );
}

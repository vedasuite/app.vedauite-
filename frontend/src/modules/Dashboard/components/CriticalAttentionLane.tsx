import { Badge, BlockStack, Box, Icon, InlineStack, Text } from "@shopify/polaris";
import { SEVERITY } from "../../../components/intelligence/severity";
import type { ExplainableInsight } from "../../../lib/insightsTypes";
import { ExplainableInsightCard } from "./ExplainableInsightCard";

/**
 * High-confidence critical findings, surfaced even when the financial impact
 * cannot be quantified.
 *
 * Deliberately never invents a dollar figure to make an item rank: an
 * unquantifiable critical finding shows "Impact not quantified" and is
 * excluded from monetary ranking rather than being assigned a placeholder.
 */
export function CriticalAttentionLane({ items }: { items: ExplainableInsight[] }) {
  if (items.length === 0) return null;

  const unquantified = items.filter(
    (item) => item.financialImpact.status === "impact_not_quantifiable"
  ).length;

  return (
    <BlockStack gap="300">
      <InlineStack align="space-between" blockAlign="center" gap="200" wrap>
        <InlineStack gap="200" blockAlign="center" wrap={false}>
          <Box as="span">
            <Icon source={SEVERITY.critical.icon} tone="critical" />
          </Box>
          <Text as="h2" variant="headingMd">
            Critical attention
          </Text>
        </InlineStack>
        <Badge tone="critical">
          {`${items.length} item${items.length === 1 ? "" : "s"}`}
        </Badge>
      </InlineStack>

      {unquantified > 0 ? (
        <Text as="p" variant="bodySm" tone="subdued">
          {`${unquantified} of these ${
            unquantified === 1 ? "findings has" : "findings have"
          } no defensible dollar estimate, so ${
            unquantified === 1 ? "it is" : "they are"
          } shown as “Impact not quantified” rather than being assigned an invented value.`}
        </Text>
      ) : null}

      <BlockStack gap="300">
        {items.map((item) => (
          <ExplainableInsightCard key={`crit-${item.id}`} insight={item} defaultOpen={false} />
        ))}
      </BlockStack>
    </BlockStack>
  );
}

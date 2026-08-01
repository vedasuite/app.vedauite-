import { Badge, BlockStack, Box, Icon, InlineStack, Text } from "@shopify/polaris";
import { TargetIcon } from "@shopify/polaris-icons";
import { EducationalEmptyState } from "../../../components/intelligence/EducationalEmptyState";
import type { ExplainableInsight } from "../../../lib/insightsTypes";
import { ExplainableInsightCard } from "./ExplainableInsightCard";

/**
 * The ranked action queue. Ordered by the engine's opportunity score, highest
 * first, with the top item pre-expanded so the reasoning behind the single
 * most important action is visible without a click.
 */
export function WhereToFocusToday({
  opportunities,
}: {
  opportunities: ExplainableInsight[];
}) {
  return (
    <BlockStack gap="300">
      <InlineStack align="space-between" blockAlign="center" gap="200" wrap>
        <InlineStack gap="200" blockAlign="center" wrap={false}>
          <Box as="span">
            <Icon source={TargetIcon} tone="info" />
          </Box>
          <Text as="h2" variant="headingMd">
            Where to focus today
          </Text>
        </InlineStack>
        {opportunities.length > 0 ? (
          <Badge tone="info">
            {`${opportunities.length} ranked action${opportunities.length === 1 ? "" : "s"}`}
          </Badge>
        ) : null}
      </InlineStack>

      {opportunities.length === 0 ? (
        <EducationalEmptyState
          title="No ranked opportunities right now"
          why="An opportunity only appears here once VedaSuite can defend it — it needs enough history to estimate the impact, judge urgency and assign a confidence level. Nothing is shown speculatively."
          steps={[
            "Keep Shopify order and product sync running so history accumulates",
            "Add product cost so pricing and margin opportunities can be scored",
            "Add competitor domains to surface price-pressure opportunities",
          ]}
        />
      ) : (
        <BlockStack gap="300">
          {opportunities.map((opportunity, index) => (
            <ExplainableInsightCard
              key={opportunity.id}
              insight={opportunity}
              defaultOpen={index === 0}
            />
          ))}
        </BlockStack>
      )}
    </BlockStack>
  );
}

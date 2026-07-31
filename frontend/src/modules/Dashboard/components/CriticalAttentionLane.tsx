import { Badge, BlockStack, Banner, InlineStack, Text } from "@shopify/polaris";
import { ExplainableInsightCard } from "./ExplainableInsightCard";
import type { ExplainableInsight } from "../../../lib/insightsTypes";

// High-confidence critical findings — surfaced even when the financial impact is
// not quantifiable. No fabricated monetary score is ever shown here.
export function CriticalAttentionLane({ items }: { items: ExplainableInsight[] }) {
  if (items.length === 0) return null;
  const anyNonMonetary = items.some((i) => i.financialImpact.status === "impact_not_quantifiable");
  return (
    <BlockStack gap="300">
      <InlineStack gap="150" blockAlign="center" wrap>
        <Text as="h2" variant="headingMd">Critical attention</Text>
        <Badge tone="critical">{`${items.length}`}</Badge>
      </InlineStack>
      {anyNonMonetary ? (
        <Banner tone="warning" title="Some items need attention before a financial impact can be estimated">
          <p>These are high-confidence critical findings. Where the monetary impact cannot be calculated, it is shown as “Impact not quantified” — no dollar value is invented.</p>
        </Banner>
      ) : null}
      <BlockStack gap="200">
        {items.map((c) => (
          <ExplainableInsightCard key={`crit-${c.id}`} insight={c} defaultOpen={false} />
        ))}
      </BlockStack>
    </BlockStack>
  );
}

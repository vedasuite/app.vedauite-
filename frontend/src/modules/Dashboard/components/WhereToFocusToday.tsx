import { BlockStack, Card, Text } from "@shopify/polaris";
import { ExplainableInsightCard } from "./ExplainableInsightCard";
import type { ExplainableInsight } from "../../../lib/insightsTypes";

export function WhereToFocusToday({ opportunities }: { opportunities: ExplainableInsight[] }) {
  return (
    <BlockStack gap="300">
      <Text as="h2" variant="headingMd">Where to focus today</Text>
      {opportunities.length === 0 ? (
        <Card>
          <Text as="p" tone="subdued">
            No prioritized opportunities right now. As store activity and data coverage grow, ranked opportunities will appear here.
          </Text>
        </Card>
      ) : (
        <BlockStack gap="200">
          {opportunities.map((o, i) => (
            <ExplainableInsightCard key={o.id} insight={o} defaultOpen={i === 0} />
          ))}
        </BlockStack>
      )}
    </BlockStack>
  );
}

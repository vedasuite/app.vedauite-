import { Badge, BlockStack, Card, InlineStack, List, Text } from "@shopify/polaris";
import type { ExecutiveSummary } from "../../../lib/insightsTypes";

export function ExecutiveSummaryCard({ summary }: { summary: ExecutiveSummary }) {
  return (
    <Card>
      <BlockStack gap="200">
        <InlineStack align="space-between" blockAlign="center" wrap gap="200">
          <Text as="h2" variant="headingMd">AI Executive Summary</Text>
          <Badge tone="new">AI</Badge>
        </InlineStack>
        <Text as="p" variant="bodyMd">{summary.headline}</Text>
        {summary.bullets.length > 0 ? (
          <List type="bullet">
            {summary.bullets.map((b, i) => (<List.Item key={i}>{b}</List.Item>))}
          </List>
        ) : null}
        <Text as="span" variant="bodySm" tone="subdued">
          Estimates only. Generated {new Date(summary.generatedAt).toLocaleString()}.
        </Text>
      </BlockStack>
    </Card>
  );
}

import { BlockStack, Card, InlineStack, Spinner, Text } from "@shopify/polaris";
import { useInsightsDashboard } from "../../../hooks/useInsightsDashboard";
import type { InsightModule } from "../../../lib/insightsTypes";
import { ExplainableInsightCard } from "./ExplainableInsightCard";

// Additive explainability panel for an existing module page. Reuses the shared
// insights endpoint + ExplainableInsightCard. Renders nothing intrusive: a
// compact section with the module's explainable findings. Does not touch the
// page's existing routes, controls, ModuleGate, or layout.
export function ModuleInsights({
  modules,
  title = "Explainable insights",
}: {
  modules: InsightModule[];
  title?: string;
}) {
  const { data, loading, error, authRequired } = useInsightsDashboard();
  const set = new Set(modules);

  if (authRequired) return null; // the page's own auth handling covers this

  if (loading && !data) {
    return (
      <Card>
        <InlineStack align="center" gap="200" blockAlign="center">
          <Spinner accessibilityLabel="Loading insights" size="small" />
          <Text as="span" tone="subdued" variant="bodySm">Loading explainable insights…</Text>
        </InlineStack>
      </Card>
    );
  }
  if (!data || error) return null;

  const all = [...data.opportunities, ...data.criticalAttention].filter((i) => set.has(i.module));
  // de-dup by id (an item may be in both lists)
  const seen = new Set<string>();
  const items = all.filter((i) => (seen.has(i.id) ? false : (seen.add(i.id), true)));

  if (items.length === 0) {
    return (
      <Card>
        <BlockStack gap="150">
          <Text as="h3" variant="headingSm">{title}</Text>
          <Text as="p" tone="subdued" variant="bodySm">
            No explainable findings for this module yet. They appear as data coverage grows.
          </Text>
        </BlockStack>
      </Card>
    );
  }

  return (
    <BlockStack gap="200">
      <Text as="h3" variant="headingSm">{title}</Text>
      {items.map((i) => (<ExplainableInsightCard key={`mod-${i.id}`} insight={i} />))}
    </BlockStack>
  );
}

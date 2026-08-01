import { BlockStack, Text } from "@shopify/polaris";
import { SectionHeader } from "../../../components/intelligence/SectionHeader";
import { SEVERITY } from "../../../components/intelligence/severity";
import type { ExplainableInsight } from "../../../lib/insightsTypes";
import { ExplainableInsightCard } from "./ExplainableInsightCard";
import "../../../components/intelligence/intelligence.css";

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
    <div className="veda-band veda-band--tight">
      <SectionHeader
        eyebrow="Act now"
        title="Critical attention"
        icon={SEVERITY.critical.icon}
        iconTone="critical"
        count={`${items.length} item${items.length === 1 ? "" : "s"}`}
        countTone="critical"
      />

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
    </div>
  );
}

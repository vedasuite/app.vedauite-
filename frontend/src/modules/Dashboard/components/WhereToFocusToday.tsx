import { BlockStack } from "@shopify/polaris";
import { TargetIcon } from "@shopify/polaris-icons";
import { EducationalEmptyState } from "../../../components/intelligence/EducationalEmptyState";
import { SectionHeader } from "../../../components/intelligence/SectionHeader";
import type { ExplainableInsight } from "../../../lib/insightsTypes";
import { ExplainableInsightCard } from "./ExplainableInsightCard";
import "../../../components/intelligence/intelligence.css";

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
    <div className="veda-band veda-band--tight">
      <SectionHeader
        eyebrow="Prioritised"
        title="Where to focus today"
        icon={TargetIcon}
        iconTone="info"
        count={
          opportunities.length > 0
            ? `${opportunities.length} ranked action${opportunities.length === 1 ? "" : "s"}`
            : undefined
        }
        countTone="info"
      />

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
    </div>
  );
}

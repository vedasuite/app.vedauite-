import { BlockStack, Text } from "@shopify/polaris";
import { MagicIcon } from "@shopify/polaris-icons";
import { EducationalEmptyState } from "../../../components/intelligence/EducationalEmptyState";
import { SectionHeader } from "../../../components/intelligence/SectionHeader";
import {
  InsightListSkeleton,
  KpiSkeletonGrid,
} from "../../../components/intelligence/IntelligenceSkeletons";
import { useInsightsDashboard } from "../../../hooks/useInsightsDashboard";
import type { InsightModule } from "../../../lib/insightsTypes";
import { ExplainableInsightCard } from "./ExplainableInsightCard";
import { ModuleIntelligencePanel } from "./ModuleIntelligencePanel";
import "../../../components/intelligence/intelligence.css";

/**
 * Additive explainability panel for an existing module page.
 *
 * Reuses the shared insights endpoint plus the same card and gauge components
 * as the dashboard, so a finding reads identically wherever it appears. Never
 * interferes with the host page: it stays silent on auth errors (the page has
 * its own reconnect handling) and renders nothing on failure rather than
 * showing a competing error banner.
 */
export function ModuleInsights({
  modules,
  title = "Explainable insights",
  pressureLabel,
  pressureCaption,
  emptyWhy,
  emptySteps,
}: {
  modules: InsightModule[];
  title?: string;
  pressureLabel?: string;
  pressureCaption?: string;
  emptyWhy?: string;
  emptySteps?: string[];
}) {
  const { data, loading, error, authRequired } = useInsightsDashboard();
  const wanted = new Set(modules);

  // The host page owns the reconnect experience — don't duplicate it here.
  if (authRequired) return null;

  if (loading && !data) {
    return (
      <BlockStack gap="300">
        <Text as="h3" variant="headingSm">
          {title}
        </Text>
        <KpiSkeletonGrid count={2} />
        <InsightListSkeleton count={2} />
      </BlockStack>
    );
  }

  if (!data || error) return null;

  // An insight can appear in both lanes; show it once.
  const seen = new Set<string>();
  const items = [...data.opportunities, ...data.criticalAttention]
    .filter((insight) => wanted.has(insight.module))
    .filter((insight) => (seen.has(insight.id) ? false : (seen.add(insight.id), true)));

  const relevantCoverage = data.dataCoverage.filter(
    (entry) => entry.module === "all" || wanted.has(entry.module as InsightModule)
  );

  // How much data the engine actually analysed for this module. Used only to
  // tell "nothing has been analysed" apart from "analysed, but nothing met the
  // evidence bar" — the engine's own coverage figure, not a new calculation.
  const monitoredRows = relevantCoverage
    .filter((entry) => entry.module !== "all")
    .reduce((total, entry) => total + Math.max(0, entry.rowsAvailable), 0);

  return (
    <div className="veda-band">
      <SectionHeader
        eyebrow="Explainable AI"
        title={title}
        icon={MagicIcon}
        iconTone="info"
        count={
          items.length > 0
            ? `${items.length} finding${items.length === 1 ? "" : "s"}`
            : undefined
        }
        countTone="info"
      />

      {items.length === 0 ? (
        monitoredRows > 0 ? (
          // Activity HAS been analysed, but nothing cleared the evidence bar.
          // Saying "no explainable findings" alone read as "nothing happened",
          // directly contradicting the activity counts shown elsewhere on the
          // page. This states both facts truthfully without inventing a
          // recommendation or lowering any threshold.
          <EducationalEmptyState
            title="Activity detected — no recommendations yet"
            why={`VedaSuite analysed ${monitoredRows.toLocaleString()} record${
              monitoredRows === 1 ? "" : "s"
            } for this module and detected activity, but none of it currently meets the confidence required for an AI recommendation. Recommendations are generated only when there is enough supporting evidence to explain and quantify them.`}
            steps={
              emptySteps ?? [
                "Add product cost and selling price so margin impact can be calculated",
                "Let more order history accumulate to strengthen match confidence",
                "Keep monitoring running — findings appear automatically once evidence is sufficient",
              ]
            }
          />
        ) : (
          <EducationalEmptyState
            title="No explainable findings for this module yet"
            why={
              emptyWhy ??
              "Findings appear here once this module has enough synced history for VedaSuite to estimate impact and assign a confidence level. Nothing is shown until it can be explained."
            }
            steps={
              emptySteps ?? [
                "Keep Shopify sync running so this module accumulates history",
                "Complete any setup this module still needs",
                "Re-run the analysis from this page once more data has arrived",
              ]
            }
          />
        )
      ) : (
        <>
          <ModuleIntelligencePanel
            title="Module intelligence"
            insights={items}
            coverage={relevantCoverage}
            pressureLabel={pressureLabel}
            pressureCaption={pressureCaption}
          />
          <BlockStack gap="300">
            {items.map((insight) => (
              <ExplainableInsightCard key={`mod-${insight.id}`} insight={insight} />
            ))}
          </BlockStack>
        </>
      )}
    </div>
  );
}

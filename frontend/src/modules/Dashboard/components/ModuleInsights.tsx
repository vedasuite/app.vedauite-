import { Banner, BlockStack, Text } from "@shopify/polaris";
import { MagicIcon } from "@shopify/polaris-icons";
import { EducationalEmptyState } from "../../../components/intelligence/EducationalEmptyState";
import { SectionHeader } from "../../../components/intelligence/SectionHeader";
import {
  InsightListSkeleton,
  KpiSkeletonGrid,
} from "../../../components/intelligence/IntelligenceSkeletons";
import { useInsightsDashboard } from "../../../hooks/useInsightsDashboard";
import { useModuleFindings } from "../../../hooks/useModuleFindings";
import type { ModuleFinding } from "../../../hooks/useModuleFindings";
import type { ExplainableInsight, InsightModule } from "../../../lib/insightsTypes";
import { ExplainableInsightCard } from "./ExplainableInsightCard";
import { ModuleIntelligencePanel } from "./ModuleIntelligencePanel";
import "../../../components/intelligence/intelligence.css";

/**
 * The open findings for one engine family, on that family's workspace page.
 *
 * WHAT CHANGED, AND WHY
 * ---------------------
 * This panel used to read /api/insights/dashboard, which recomputes insights
 * on every request and knows nothing about IntelligenceFinding. That made the
 * workspaces the last surface able to contradict the Action Center: a merchant
 * could resolve a finding, watch it disappear from the Action Center and the
 * Store Overview, then open the matching workspace and still find it there —
 * with a "Critical" badge and a monetary impact beside it.
 *
 * It now reads the SAME open findings the Action Center renders, filtered to
 * this family. Every merchant-facing surface — Action Center, Store Overview,
 * the three workspaces and the AI brief — reads one source with one lifecycle.
 *
 * Coverage still comes from the insights endpoint on purpose: "how many rows
 * were analysed" makes no claim about problems, money, confidence or status,
 * so it cannot contradict a finding.
 *
 * Never interferes with the host page: it stays silent on auth errors (the page
 * has its own reconnect handling) rather than showing a competing banner.
 */

/**
 * Adapts a finding to the shape the existing card and panel render.
 *
 * A pure remapping — no value is recomputed, reworded or added. `reasons` is
 * rebuilt from the two sentences the card already displayed under those
 * headings, and the empty score breakdown is honest: ranking is the Action
 * Center's, and inventing per-component numbers to fill a shape would be the
 * fabrication this whole programme removes.
 */
function toInsight(finding: ModuleFinding): ExplainableInsight {
  return {
    id: finding.id,
    storeId: "",
    module: finding.module as InsightModule,
    title: finding.title,
    reasons: [finding.whatHappened, finding.whyItMatters].filter(Boolean),
    evidence: finding.evidence ?? [],
    financialImpact:
      finding.impact.status === "quantified"
        ? {
            status: "quantified",
            min: finding.impact.min,
            max: finding.impact.max,
            currency: finding.impact.currency,
            period: finding.impact.period as ExplainableInsight["financialImpact"] extends {
              period: infer P;
            }
              ? P
              : never,
            basis: finding.impact.basis ?? "",
          }
        : { status: "impact_not_quantifiable", reason: finding.impact.reason },
    confidence: finding.confidence,
    recency: finding.lastSeenAt,
    urgency: finding.severity,
    easeOfAction: "manual",
    recommendedAction: finding.recommendedAction,
    score: {
      total: finding.rank.score,
      components: {
        financialImpact: 0,
        urgency: 0,
        confidence: 0,
        easeOfAction: 0,
        recency: 0,
      },
      weights: {
        financialImpact: 0,
        urgency: 0,
        confidence: 0,
        easeOfAction: 0,
        recency: 0,
      },
    },
    methodology: finding.methodology ?? { summary: "", assumptions: [], caps: [] },
    route: finding.route,
    dataQuality: finding.dataComplete ? "ok" : "insufficient_data",
  } as ExplainableInsight;
}

export function ModuleInsights({
  modules,
  title = "Open findings",
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
  const { findings, loading, unavailable, authRequired } = useModuleFindings(modules);
  // Coverage only. No money, no confidence, no status — nothing that could
  // disagree with a finding.
  const { data: coverageData } = useInsightsDashboard();

  // The host page owns the reconnect experience — don't duplicate it here.
  if (authRequired) return null;

  if (loading) {
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

  if (unavailable) {
    // "VedaSuite could not check" is not "nothing is wrong". Rendering the
    // second in place of the first is precisely the kind of quiet false
    // reassurance this programme exists to remove.
    return (
      <Banner title="Findings could not be loaded" tone="warning">
        <p>
          This is a temporary read problem, not a statement about your store.
          Refresh to try again.
        </p>
      </Banner>
    );
  }

  const wanted = new Set<string>(modules);
  const relevantCoverage = (coverageData?.dataCoverage ?? []).filter(
    (entry) => entry.module === "all" || wanted.has(entry.module as InsightModule)
  );

  // How much data the engine actually analysed for this module. Used only to
  // tell "nothing has been analysed" apart from "analysed, but nothing met the
  // evidence bar" — the engine's own coverage figure, not a new calculation.
  const monitoredRows = relevantCoverage
    .filter((entry) => entry.module !== "all")
    .reduce((total, entry) => total + Math.max(0, entry.rowsAvailable), 0);

  const items = findings.map(toInsight);

  return (
    <div className="veda-band">
      <SectionHeader
        eyebrow="Evidence-backed findings"
        title={title}
        icon={MagicIcon}
        iconTone="info"
        count={
          items.length > 0
            ? `${items.length} open finding${items.length === 1 ? "" : "s"}`
            : undefined
        }
        countTone="info"
      />

      {items.length === 0 ? (
        monitoredRows > 0 ? (
          // Activity HAS been analysed, but nothing cleared the evidence bar.
          // Saying "no findings" alone read as "nothing happened", directly
          // contradicting the activity counts shown elsewhere on the page. This
          // states both facts truthfully without inventing a recommendation or
          // lowering any threshold.
          <EducationalEmptyState
            title="Activity detected — no findings yet"
            why={`VedaSuite analysed ${monitoredRows.toLocaleString()} record${
              monitoredRows === 1 ? "" : "s"
            } for this module and detected activity, but none of it currently meets the evidence bar for a finding. Findings appear only when there is enough supporting data to explain and quantify them.`}
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
            title="No open findings for this module"
            why={
              emptyWhy ??
              "Findings appear here once this module has enough synced history for VedaSuite to explain and, where the data allows, quantify what it found. Nothing is shown until it can be explained. Anything you have already resolved will not reappear here."
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

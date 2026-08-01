import { Badge, BlockStack, Box, Card, Icon, InlineStack, Text } from "@shopify/polaris";
import { ChartVerticalIcon } from "@shopify/polaris-icons";
import { Meter, SegmentedMeter } from "../../../components/intelligence/Meter";
import {
  SEVERITY,
  severityForPressure,
  severityForUrgency,
} from "../../../components/intelligence/severity";
import { Timeline } from "../../../components/intelligence/Timeline";
import type { TimelineEntry } from "../../../components/intelligence/Timeline";
import { urgencyMix } from "../../../lib/executiveMetrics";
import { MODULE_LABEL, impactRangeText } from "../../../lib/insightsTypes";
import type { DataCoverage, ExplainableInsight } from "../../../lib/insightsTypes";
import "../../../components/intelligence/intelligence.css";

const CONFIDENCE_WEIGHT: Record<string, number> = {
  high: 1,
  medium: 0.6,
  low: 0.3,
  insufficient_data: 0,
};

/**
 * Module-level intelligence header: how much pressure this module is under,
 * how sure the engine is, whether it has enough data, and what has changed
 * recently.
 *
 * Every reading is an aggregate of labels the engine already assigned to this
 * module's own insights. Gauges are only rendered when there is real data
 * behind them — an empty module shows an explanation, not a zeroed dial.
 */
export function ModuleIntelligencePanel({
  title,
  insights,
  coverage,
  pressureLabel = "Risk pressure",
  pressureCaption = "Weighted from the urgency of this module's open findings.",
}: {
  title: string;
  insights: ExplainableInsight[];
  coverage?: DataCoverage[];
  pressureLabel?: string;
  pressureCaption?: string;
}) {
  if (insights.length === 0) return null;

  const mix = urgencyMix(insights);
  const pressureSeverity = severityForPressure(mix.pressure);

  const confidencePercent = Math.round(
    (insights.reduce((sum, i) => sum + (CONFIDENCE_WEIGHT[i.confidence] ?? 0), 0) /
      insights.length) *
      100
  );

  const readyModules = coverage?.filter((entry) => entry.sufficient).length ?? 0;
  const totalModules = coverage?.length ?? 0;

  // Most recent first — the engine stamps each insight with a `recency` ISO date.
  const timeline: TimelineEntry[] = [...insights]
    .sort((a, b) => new Date(b.recency).getTime() - new Date(a.recency).getTime())
    .slice(0, 6)
    .map((insight) => {
      const severity = severityForUrgency(insight.urgency);
      return {
        id: insight.id,
        title: insight.title,
        timestamp: insight.recency,
        detail: impactRangeText(insight.financialImpact),
        tone:
          severity.meter === "neutral"
            ? "info"
            : (severity.meter as "critical" | "warning" | "success" | "info"),
        meta: (
          <InlineStack gap="150" blockAlign="center" wrap>
            <Badge tone="new">{MODULE_LABEL[insight.module]}</Badge>
            <Badge tone={severity.badgeTone}>{severity.label}</Badge>
          </InlineStack>
        ),
      };
    });

  return (
    <Card padding="400">
      <BlockStack gap="400">
        <InlineStack align="space-between" blockAlign="center" gap="200" wrap>
          <InlineStack gap="200" blockAlign="center" wrap={false}>
            <Box as="span">
              <Icon source={ChartVerticalIcon} tone="info" />
            </Box>
            <Text as="h3" variant="headingSm">
              {title}
            </Text>
          </InlineStack>
          <Badge tone={pressureSeverity.badgeTone}>{pressureSeverity.label}</Badge>
        </InlineStack>

        {/* Gauges — each backed by a real aggregate, never a placeholder. */}
        <div className="veda-kpi-grid">
          <Meter
            value={mix.pressure}
            tone={pressureSeverity.meter === "neutral" ? "info" : pressureSeverity.meter}
            label={pressureLabel}
            valueText={`${mix.pressure}% — ${pressureSeverity.label.toLowerCase()}`}
            caption={pressureCaption}
          />
          <Meter
            value={confidencePercent}
            tone={confidencePercent >= 75 ? "success" : confidencePercent >= 45 ? "info" : "warning"}
            label="Signal confidence"
            valueText={`${confidencePercent}%`}
            caption={`Average confidence across ${insights.length} finding${
              insights.length === 1 ? "" : "s"
            }.`}
          />
          {totalModules > 0 ? (
            <SegmentedMeter
              total={totalModules}
              filled={readyModules}
              tone={readyModules === totalModules ? "success" : "warning"}
              label="Data coverage"
              caption="Modules on your plan with enough history to report."
            />
          ) : null}
        </div>

        {/* Urgency mix — the composition behind the pressure reading. */}
        <InlineStack gap="200" wrap>
          {(
            [
              ["critical", mix.critical, SEVERITY.critical],
              ["high", mix.high, SEVERITY.warning],
              ["medium", mix.medium, SEVERITY.opportunity],
              ["low", mix.low, SEVERITY.info],
            ] as const
          )
            .filter(([, count]) => count > 0)
            .map(([key, count, severity]) => (
              <InlineStack key={key} gap="100" blockAlign="center" wrap={false}>
                <Box as="span">
                  <Icon source={severity.icon} tone={severity.iconTone} />
                </Box>
                <Text as="span" variant="bodySm" tone="subdued">
                  {`${count} ${key}`}
                </Text>
              </InlineStack>
            ))}
        </InlineStack>

        {timeline.length > 0 ? (
          <BlockStack gap="200">
            <Text as="h4" variant="headingXs">
              Recent activity
            </Text>
            <Timeline entries={timeline} />
          </BlockStack>
        ) : null}
      </BlockStack>
    </Card>
  );
}

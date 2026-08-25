import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  Icon,
  InlineStack,
  Layout,
  Spinner,
  Text,
} from "@shopify/polaris";
import { ChartVerticalIcon, RefreshIcon } from "@shopify/polaris-icons";
import { EducationalEmptyState } from "../../../components/intelligence/EducationalEmptyState";
import { DashboardSkeleton } from "../../../components/intelligence/IntelligenceSkeletons";
import { SegmentedMeter } from "../../../components/intelligence/Meter";
import { SEVERITY } from "../../../components/intelligence/severity";
import { useInsightsDashboard } from "../../../hooks/useInsightsDashboard";
import { MODULE_LABEL } from "../../../lib/insightsTypes";
import type { DataCoverage } from "../../../lib/insightsTypes";
import "../../../components/intelligence/intelligence.css";

/** Per-module readiness, with a segmented "how many modules are ready" gauge. */
function DataCoverageCard({ coverage }: { coverage: DataCoverage[] }) {
  const ready = coverage.filter((entry) => entry.sufficient).length;

  return (
    <Card padding="400">
      <BlockStack gap="400">
        <InlineStack gap="200" blockAlign="center" wrap={false}>
          <Box as="span">
            <Icon source={ChartVerticalIcon} tone="subdued" />
          </Box>
          <Text as="h2" variant="headingMd">
            Data coverage &amp; sync status
          </Text>
        </InlineStack>

        {coverage.length === 0 ? (
          <Text as="p" tone="subdued">
            Coverage details appear once the modules on your plan begin
            receiving data.
          </Text>
        ) : (
          <BlockStack gap="400">
            <SegmentedMeter
              total={coverage.length}
              filled={ready}
              tone={ready === coverage.length ? "success" : "warning"}
              label="Modules with enough data"
              caption={
                ready === coverage.length
                  ? "Every module on your plan has enough history to produce insights."
                  : "Modules below the threshold need more synced history before they report."
              }
            />

            <BlockStack gap="300">
              {coverage.map((entry) => {
                const severity = entry.sufficient ? SEVERITY.ready : SEVERITY.warning;
                return (
                  <div
                    key={String(entry.module)}
                    className={`veda-rail ${entry.sufficient ? "veda-rail--info" : "veda-rail--warning"}`}
                  >
                    <InlineStack align="space-between" blockAlign="center" gap="200" wrap>
                      <InlineStack gap="150" blockAlign="center" wrap>
                        <Box as="span">
                          <Icon source={severity.icon} tone={severity.iconTone} />
                        </Box>
                        <Text as="span" variant="bodyMd" fontWeight="medium">
                          {entry.module === "all" ? "All modules" : MODULE_LABEL[entry.module]}
                        </Text>
                        <Badge tone={entry.sufficient ? "success" : "attention"}>
                          {entry.sufficient ? "Ready" : "Needs more data"}
                        </Badge>
                      </InlineStack>
                      <div className="veda-clamp">
                        <Text as="span" variant="bodySm" tone="subdued">
                          {`${entry.rowsAvailable.toLocaleString()} rows${
                            entry.note ? ` · ${entry.note}` : ""
                          }`}
                        </Text>
                      </div>
                    </InlineStack>
                  </div>
                );
              })}
            </BlockStack>

            {coverage[0]?.lastSyncAt ? (
              <Text as="span" variant="bodySm" tone="subdued">
                {`Last synced ${new Date(coverage[0].lastSyncAt).toLocaleString()}.`}
              </Text>
            ) : null}
          </BlockStack>
        )}
      </BlockStack>
    </Card>
  );
}


/**
 * Store-level data coverage.
 *
 * PHASE F/G — WHAT THIS COMPONENT USED TO RENDER, AND WHY IT NO LONGER DOES.
 *
 * It previously drove five store-level sections on the Dashboard:
 *
 *   ExecutiveHero        — a second narrative headline, plus "Potential
 *                          revenue" and "AI confidence" figures
 *   WhereToFocusToday    — a second prioritized list of what to do next
 *   CriticalAttentionLane— a second critical-severity count
 *   RevenueLeakDetector  — a second money total (upside and revenue at risk)
 *   DataCoverageCard     — how much data was actually analysed
 *
 * All five came from /api/insights/dashboard, which recomputes insights on
 * every read and knows nothing about IntelligenceFinding. That made the first
 * four direct contradictions of the Action Center: a merchant could resolve a
 * finding, watch it leave the Action Center and the Dashboard tiles, and still
 * see its money inside "Potential revenue" and its text inside the executive
 * summary — the same class of defect as being told a resolved problem was
 * still happening.
 *
 * So the Dashboard now states NO money and NO confidence of its own. It reports
 * counts of open findings and links to the Action Center, which owns impact,
 * confidence, evidence and lifecycle in one place.
 *
 * NOTHING WAS TAKEN AWAY. The same explainable insights, with their per-insight
 * financial impact, still render on each workspace page through ModuleInsights
 * — scoped to that family, where they are an analysis of one area rather than a
 * competing store-level headline. The only figure that disappeared is the
 * cross-module rolled-up total, which is exactly the kind of aggregate this
 * programme has been removing; the Action Center's quantifiedImpact groups are
 * its defensible replacement.
 *
 * Data coverage survives because it makes no claim about problems, money or
 * confidence. It reports how much data was analysed, which cannot contradict a
 * finding.
 */
export function InsightsDashboardSections() {
  const { data, loading, error, authRequired, unavailable, reload } =
    useInsightsDashboard();

  if (loading && !data) {
    return (
      <Layout.Section>
        <DashboardSkeleton />
      </Layout.Section>
    );
  }

  // The host page owns the reconnect experience, and the findings projection
  // above already tells the merchant its own state. A second auth banner here
  // was a competing explanation of the same condition.
  if (authRequired) return null;

  if ((unavailable || error) && !data) {
    return (
      <Layout.Section>
        <Banner tone="warning" title="Data coverage is temporarily unavailable">
          <BlockStack gap="300">
            <p>
              {error ??
                "The coverage service did not respond. Your data is safe, and this says nothing about your store."}
            </p>
            <InlineStack gap="200">
              <Button onClick={reload} icon={RefreshIcon}>
                Try again
              </Button>
            </InlineStack>
          </BlockStack>
        </Banner>
      </Layout.Section>
    );
  }

  if (!data) return null;

  return (
    <Layout.Section>
      <DataCoverageCard coverage={data.dataCoverage} />
    </Layout.Section>
  );
}

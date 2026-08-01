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
import { CriticalAttentionLane } from "./CriticalAttentionLane";
import { ExecutiveHero } from "./ExecutiveHero";
import { RevenueLeakDetector } from "./RevenueLeakDetector";
import { WhereToFocusToday } from "./WhereToFocusToday";
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
 * Phase 1 intelligence sections, in the order a merchant reads them:
 * executive summary → where to focus → critical attention → revenue leak →
 * data coverage.
 *
 * Handles every state the endpoint can produce — first load, refreshing,
 * auth-required, unavailable, syncing, insufficient data and empty — and never
 * renders sample data as a stand-in for any of them.
 */
export function InsightsDashboardSections() {
  const { data, loading, refreshing, error, authRequired, unavailable, reload } =
    useInsightsDashboard();

  // First load — skeletons matching the real layout, not a blank screen.
  if (loading && !data) {
    return (
      <Layout.Section>
        <DashboardSkeleton />
      </Layout.Section>
    );
  }

  if (authRequired) {
    return (
      <Layout.Section>
        <Banner tone="critical" title="Reconnect to load your intelligence">
          <BlockStack gap="200">
            <p>
              Your Shopify session needs to be refreshed before insights can be
              generated. Reopen VedaSuite from your Shopify Admin to reconnect.
            </p>
          </BlockStack>
        </Banner>
      </Layout.Section>
    );
  }

  if ((unavailable || error) && !data) {
    return (
      <Layout.Section>
        <Banner tone="warning" title="Intelligence is temporarily unavailable">
          <BlockStack gap="300">
            <p>{error ?? "The insights service did not respond. Your data is safe."}</p>
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

  const notReady = !data.executiveSummary.dataReady;

  return (
    <>
      {refreshing ? (
        <Layout.Section>
          <InlineStack gap="200" blockAlign="center" wrap={false}>
            <Spinner accessibilityLabel="Refreshing intelligence" size="small" />
            <Text as="span" tone="subdued" variant="bodySm">
              Refreshing intelligence with your latest store data…
            </Text>
          </InlineStack>
        </Layout.Section>
      ) : null}

      {/* 1. AI executive summary + the seven headline readings. */}
      <Layout.Section>
        <div className="veda-enter">
          <ExecutiveHero data={data} />
        </div>
      </Layout.Section>

      {notReady ? (
        <Layout.Section>
          <EducationalEmptyState
            title="VedaSuite is still preparing this store"
            why="Ranked opportunities and revenue estimates stay hidden until your Shopify connection, data sync and plan are all ready. Showing partial results now would mean ranking your store on incomplete data."
            steps={[
              "Finish connecting Shopify so order and product sync can run",
              "Let the first full sync complete — this usually takes a few minutes",
              "Confirm your plan so the matching modules are enabled",
            ]}
          />
        </Layout.Section>
      ) : (
        <>
          {/* 2. Where to focus today. */}
          <Layout.Section>
            <WhereToFocusToday opportunities={data.opportunities} />
          </Layout.Section>

          {/* 3. Critical attention — only when the engine flagged something. */}
          {data.criticalAttention.length > 0 ? (
            <Layout.Section>
              <CriticalAttentionLane items={data.criticalAttention} />
            </Layout.Section>
          ) : null}

          {/* 4. Revenue leak detector. */}
          <Layout.Section>
            <RevenueLeakDetector model={data.revenueLeak} />
          </Layout.Section>
        </>
      )}

      {/* 7. Data coverage & sync status. */}
      <Layout.Section>
        <DataCoverageCard coverage={data.dataCoverage} />
      </Layout.Section>
    </>
  );
}

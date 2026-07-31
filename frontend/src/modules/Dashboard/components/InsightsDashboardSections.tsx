import {
  Badge, Banner, BlockStack, Button, Card, InlineStack, Layout, Spinner, Text,
} from "@shopify/polaris";
import { useInsightsDashboard } from "../../../hooks/useInsightsDashboard";
import { MODULE_LABEL } from "../../../lib/insightsTypes";
import type { DataCoverage } from "../../../lib/insightsTypes";
import { ExecutiveSummaryCard } from "./ExecutiveSummaryCard";
import { WhereToFocusToday } from "./WhereToFocusToday";
import { CriticalAttentionLane } from "./CriticalAttentionLane";
import { RevenueLeakDetector } from "./RevenueLeakDetector";

function DataCoverageCard({ coverage }: { coverage: DataCoverage[] }) {
  return (
    <Card>
      <BlockStack gap="200">
        <Text as="h2" variant="headingMd">Data coverage</Text>
        {coverage.length === 0 ? (
          <Text as="p" tone="subdued">Coverage details appear once your plan modules have data.</Text>
        ) : (
          <BlockStack gap="150">
            {coverage.map((c) => (
              <InlineStack key={String(c.module)} align="space-between" blockAlign="center" wrap gap="200">
                <InlineStack gap="150" blockAlign="center">
                  <Text as="span" variant="bodyMd">{c.module === "all" ? "All" : MODULE_LABEL[c.module]}</Text>
                  <Badge tone={c.sufficient ? "success" : "attention"}>
                    {c.sufficient ? "Ready" : "Insufficient data"}
                  </Badge>
                </InlineStack>
                <Text as="span" variant="bodySm" tone="subdued">
                  {`${c.rowsAvailable} rows${c.note ? ` · ${c.note}` : ""}`}
                </Text>
              </InlineStack>
            ))}
          </BlockStack>
        )}
      </BlockStack>
    </Card>
  );
}

export function InsightsDashboardSections() {
  const { data, loading, refreshing, error, authRequired, unavailable, reload } = useInsightsDashboard();

  // First load
  if (loading && !data) {
    return (
      <Layout.Section>
        <Card>
          <InlineStack align="center" gap="200" blockAlign="center">
            <Spinner accessibilityLabel="Loading insights" size="small" />
            <Text as="span" tone="subdued">Preparing your store insights…</Text>
          </InlineStack>
        </Card>
      </Layout.Section>
    );
  }

  // Authentication required
  if (authRequired) {
    return (
      <Layout.Section>
        <Banner tone="critical" title="Reconnect to load insights">
          <p>Your Shopify session needs to be refreshed. Reopen the app from Shopify Admin.</p>
        </Banner>
      </Layout.Section>
    );
  }

  // Endpoint unavailable / other error, with nothing to show
  if ((unavailable || error) && !data) {
    return (
      <Layout.Section>
        <Banner tone="warning" title="Insights are temporarily unavailable">
          <BlockStack gap="150">
            <p>{error ?? "Please try again."}</p>
            <Button onClick={reload}>Try again</Button>
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
          <InlineStack gap="150" blockAlign="center">
            <Spinner accessibilityLabel="Refreshing insights" size="small" />
            <Text as="span" tone="subdued" variant="bodySm">Refreshing insights…</Text>
          </InlineStack>
        </Layout.Section>
      ) : null}

      {/* 1. AI Executive Summary */}
      <Layout.Section>
        <ExecutiveSummaryCard summary={data.executiveSummary} />
      </Layout.Section>

      {notReady ? (
        <Layout.Section>
          <Banner tone="info" title="VedaSuite is still preparing this store">
            <p>Insights appear automatically once connection, data sync and plan are ready.</p>
          </Banner>
        </Layout.Section>
      ) : (
        <>
          {/* 2. Where to focus today */}
          <Layout.Section>
            <WhereToFocusToday opportunities={data.opportunities} />
          </Layout.Section>

          {/* 3. Critical attention */}
          {data.criticalAttention.length > 0 ? (
            <Layout.Section>
              <CriticalAttentionLane items={data.criticalAttention} />
            </Layout.Section>
          ) : null}

          {/* 4. Revenue Leak Detector */}
          <Layout.Section>
            <RevenueLeakDetector model={data.revenueLeak} />
          </Layout.Section>
        </>
      )}

      {/* 7. Data coverage (sync status remains in the existing dashboard below) */}
      <Layout.Section>
        <DataCoverageCard coverage={data.dataCoverage} />
      </Layout.Section>
    </>
  );
}

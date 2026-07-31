import {
  Badge, BlockStack, Box, Button, Card, Collapsible, Divider,
  InlineStack, List, Text,
} from "@shopify/polaris";
import { useCallback, useId, useState } from "react";
import { useEmbeddedNavigation } from "../../../hooks/useEmbeddedNavigation";
import {
  MODULE_LABEL, PERIOD_LABEL, confidenceTone, impactRangeText, urgencyTone,
} from "../../../lib/insightsTypes";
import type { ExplainableInsight, OpportunityScoreBreakdown } from "../../../lib/insightsTypes";

const WEIGHT_ROWS: { key: keyof OpportunityScoreBreakdown["components"]; label: string; pct: string }[] = [
  { key: "financialImpact", label: "Impact", pct: "35%" },
  { key: "urgency", label: "Urgency", pct: "25%" },
  { key: "confidence", label: "Confidence", pct: "20%" },
  { key: "easeOfAction", label: "Ease", pct: "10%" },
  { key: "recency", label: "Recency", pct: "10%" },
];

export function ExplainableInsightCard({
  insight,
  defaultOpen = false,
}: {
  insight: ExplainableInsight;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const panelId = useId();
  const { navigateEmbedded } = useEmbeddedNavigation();
  const toggle = useCallback(() => setOpen((v) => !v), []);

  const impactText = impactRangeText(insight.financialImpact);
  const notQuantified = insight.financialImpact.status === "impact_not_quantifiable";

  return (
    <Card>
      <BlockStack gap="200">
        {/* Collapsed summary */}
        <InlineStack align="space-between" blockAlign="start" wrap gap="200">
          <BlockStack gap="100">
            <InlineStack gap="150" blockAlign="center" wrap>
              <Text as="h3" variant="headingSm">{insight.title}</Text>
              <Badge tone="new">{MODULE_LABEL[insight.module]}</Badge>
              <Badge tone={urgencyTone(insight.urgency)}>{`Priority: ${insight.urgency}`}</Badge>
            </InlineStack>
            <InlineStack gap="200" blockAlign="center" wrap>
              <Text as="span" variant="bodySm" tone={notQuantified ? "subdued" : undefined}>
                {impactText}
              </Text>
              <Badge tone={confidenceTone(insight.confidence)}>{`Confidence: ${insight.confidence.replace("_", " ")}`}</Badge>
            </InlineStack>
            <Text as="span" variant="bodySm" tone="subdued">
              {insight.recommendedAction}
            </Text>
          </BlockStack>
          <Button
            variant="tertiary"
            onClick={toggle}
            ariaExpanded={open}
            ariaControls={panelId}
            accessibilityLabel={open ? `Hide details for ${insight.title}` : `Show details for ${insight.title}`}
          >
            {open ? "Hide details" : "Why this priority?"}
          </Button>
        </InlineStack>

        {/* Expanded details */}
        <Collapsible open={open} id={panelId} transition={{ duration: "150ms", timingFunction: "ease-in-out" }}>
          <Box paddingBlockStart="200">
            <BlockStack gap="300">
              <Divider />

              {/* Why this priority — weighted breakdown */}
              <BlockStack gap="150">
                <Text as="h4" variant="headingXs">Why this priority?</Text>
                {insight.score.excludedFromMonetaryRanking ? (
                  <Text as="span" variant="bodySm" tone="subdued">
                    Not ranked by monetary score{insight.score.excludedReason ? ` — ${insight.score.excludedReason}.` : "."} Shown for attention only.
                  </Text>
                ) : (
                  <Text as="span" variant="bodySm" tone="subdued">
                    {`Opportunity Score ${insight.score.total} / 100`}
                  </Text>
                )}
                <BlockStack gap="050">
                  {WEIGHT_ROWS.map((r) => (
                    <InlineStack key={r.key} align="space-between" blockAlign="center">
                      <Text as="span" variant="bodySm">{`${r.label} (${r.pct})`}</Text>
                      <Text as="span" variant="bodySm" tone="subdued">
                        {`${insight.score.components[r.key]} / 100`}
                      </Text>
                    </InlineStack>
                  ))}
                </BlockStack>
              </BlockStack>

              {/* Explanation */}
              {insight.reasons.length > 0 ? (
                <BlockStack gap="100">
                  <Text as="h4" variant="headingXs">What we detected & why</Text>
                  <List type="bullet">
                    {insight.reasons.map((r, i) => (<List.Item key={i}>{r}</List.Item>))}
                  </List>
                </BlockStack>
              ) : null}

              {/* Evidence (aggregate only) */}
              {insight.evidence.length > 0 ? (
                <BlockStack gap="100">
                  <Text as="h4" variant="headingXs">Evidence</Text>
                  <BlockStack gap="050">
                    {insight.evidence.map((e, i) => (
                      <InlineStack key={i} align="space-between">
                        <Text as="span" variant="bodySm" tone="subdued">{e.label}</Text>
                        <Text as="span" variant="bodySm">{e.value}</Text>
                      </InlineStack>
                    ))}
                  </BlockStack>
                </BlockStack>
              ) : null}

              {/* Methodology / basis / assumptions */}
              <BlockStack gap="100">
                <Text as="h4" variant="headingXs">Methodology</Text>
                <Text as="span" variant="bodySm">{insight.methodology.summary}</Text>
                {insight.financialImpact.status === "quantified" ? (
                  <Text as="span" variant="bodySm" tone="subdued">
                    {`Calculation basis: ${insight.financialImpact.basis} (${PERIOD_LABEL[insight.financialImpact.period]}).`}
                  </Text>
                ) : (
                  <Text as="span" variant="bodySm" tone="subdued">
                    {`Impact not quantified: ${insight.financialImpact.reason}.`}
                  </Text>
                )}
                {insight.methodology.assumptions.length > 0 ? (
                  <List type="bullet">
                    {insight.methodology.assumptions.map((a, i) => (<List.Item key={i}>{a}</List.Item>))}
                  </List>
                ) : null}
              </BlockStack>

              <InlineStack align="end">
                <Button variant="primary" onClick={() => navigateEmbedded(insight.route)}>
                  Open in {MODULE_LABEL[insight.module]}
                </Button>
              </InlineStack>
            </BlockStack>
          </Box>
        </Collapsible>
      </BlockStack>
    </Card>
  );
}

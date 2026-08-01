import {
  Badge,
  BlockStack,
  Box,
  Button,
  Card,
  Collapsible,
  Divider,
  Icon,
  InlineStack,
  List,
  Text,
} from "@shopify/polaris";
import { ChevronDownIcon, ClockIcon } from "@shopify/polaris-icons";
import { useCallback, useId, useState } from "react";
import { Meter } from "../../../components/intelligence/Meter";
import { severityForUrgency } from "../../../components/intelligence/severity";
import { usePrefersReducedMotion } from "../../../components/intelligence/AnimatedCounter";
import { useEmbeddedNavigation } from "../../../hooks/useEmbeddedNavigation";
import { effortFor } from "../../../lib/executiveMetrics";
import {
  MODULE_LABEL,
  PERIOD_LABEL,
  confidenceTone,
  impactRangeText,
} from "../../../lib/insightsTypes";
import type {
  ExplainableInsight,
  OpportunityScoreBreakdown,
} from "../../../lib/insightsTypes";
import "../../../components/intelligence/intelligence.css";

const WEIGHT_ROWS: {
  key: keyof OpportunityScoreBreakdown["components"];
  label: string;
  pct: string;
}[] = [
  { key: "financialImpact", label: "Impact", pct: "35%" },
  { key: "urgency", label: "Urgency", pct: "25%" },
  { key: "confidence", label: "Confidence", pct: "20%" },
  { key: "easeOfAction", label: "Ease", pct: "10%" },
  { key: "recency", label: "Recency", pct: "10%" },
];

/**
 * The universal explainable-insight card.
 *
 * Collapsed it answers: what, how urgent, how much, how sure, what to do.
 * Expanded it shows the full chain of reasoning — score breakdown, detection
 * reasons, aggregate evidence, methodology and calculation basis — so a
 * merchant can audit any number before acting on it.
 *
 * Monetary values are never invented: when the engine reports
 * `impact_not_quantifiable`, the card says so and explains why.
 */
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
  const reducedMotion = usePrefersReducedMotion();
  const toggle = useCallback(() => setOpen((value) => !value), []);

  const severity = severityForUrgency(insight.urgency);
  const effort = effortFor(insight.easeOfAction);
  const quantified = insight.financialImpact.status === "quantified";
  const impactText = impactRangeText(insight.financialImpact);
  const scored = !insight.score.excludedFromMonetaryRanking;

  return (
    <Card padding="400">
      <div className={`veda-card-interactive veda-rail ${severity.rail}`}>
        <BlockStack gap="300">
          {/* ---------- Collapsed summary ---------- */}
          <InlineStack align="space-between" blockAlign="start" gap="300" wrap>
            <div className="veda-clamp" style={{ flex: "1 1 260px" }}>
              <BlockStack gap="200">
                <InlineStack gap="150" blockAlign="center" wrap>
                  <Box as="span">
                    <Icon source={severity.icon} tone={severity.iconTone} />
                  </Box>
                  <Text as="h3" variant="headingSm">
                    {insight.title}
                  </Text>
                </InlineStack>

                <InlineStack gap="150" blockAlign="center" wrap>
                  <Badge tone="new">{MODULE_LABEL[insight.module]}</Badge>
                  <Badge tone={severity.badgeTone}>{`Priority: ${severity.label}`}</Badge>
                  <Badge tone={confidenceTone(insight.confidence)}>
                    {`Confidence: ${insight.confidence.replace("_", " ")}`}
                  </Badge>
                  <Badge>{effort.difficulty}</Badge>
                </InlineStack>

                <InlineStack gap="300" blockAlign="center" wrap>
                  <Text
                    as="span"
                    variant="bodyLg"
                    fontWeight="semibold"
                    tone={quantified ? undefined : "subdued"}
                  >
                    {impactText}
                  </Text>
                  {scored ? (
                    <Text as="span" variant="bodySm" tone="subdued">
                      {`Score ${insight.score.total}/100`}
                    </Text>
                  ) : null}
                  <InlineStack gap="100" blockAlign="center" wrap={false}>
                    <Box as="span">
                      <Icon source={ClockIcon} tone="subdued" />
                    </Box>
                    <Text as="span" variant="bodySm" tone="subdued">
                      {effort.minutes}
                    </Text>
                  </InlineStack>
                </InlineStack>

                <Text as="p" variant="bodyMd" tone="subdued">
                  {insight.recommendedAction}
                </Text>
              </BlockStack>
            </div>

            <InlineStack gap="200" blockAlign="center" wrap>
              <Button variant="primary" onClick={() => navigateEmbedded(insight.route)}>
                {`Open ${MODULE_LABEL[insight.module]}`}
              </Button>
              <Button
                variant="tertiary"
                onClick={toggle}
                ariaExpanded={open}
                ariaControls={panelId}
                accessibilityLabel={
                  open
                    ? `Hide the reasoning behind ${insight.title}`
                    : `Show the reasoning behind ${insight.title}`
                }
                icon={
                  <span className={`veda-chevron${open ? " veda-chevron--open" : ""}`}>
                    <Icon source={ChevronDownIcon} tone="subdued" />
                  </span>
                }
              >
                {open ? "Hide details" : "Why this?"}
              </Button>
            </InlineStack>
          </InlineStack>

          {/* ---------- Expanded reasoning ---------- */}
          <Collapsible
            open={open}
            id={panelId}
            transition={
              reducedMotion ? undefined : { duration: "180ms", timingFunction: "ease-in-out" }
            }
          >
            <Box paddingBlockStart="300">
              <BlockStack gap="400">
                <Divider />

                {/* Why this priority — weighted breakdown */}
                <BlockStack gap="200">
                  <Text as="h4" variant="headingXs">
                    Why this priority
                  </Text>
                  {scored ? (
                    <>
                      <Meter
                        value={insight.score.total}
                        tone={severity.meter === "neutral" ? "info" : severity.meter}
                        label="Opportunity score"
                        valueText={`${insight.score.total} / 100`}
                      />
                      <BlockStack gap="100">
                        {WEIGHT_ROWS.map((row) => (
                          <InlineStack
                            key={row.key}
                            align="space-between"
                            blockAlign="center"
                            gap="200"
                            wrap
                          >
                            <Text as="span" variant="bodySm">
                              {`${row.label} (${row.pct})`}
                            </Text>
                            <Text as="span" variant="bodySm" tone="subdued">
                              {`${insight.score.components[row.key]} / 100`}
                            </Text>
                          </InlineStack>
                        ))}
                      </BlockStack>
                    </>
                  ) : (
                    <Text as="p" variant="bodySm" tone="subdued">
                      {`Not ranked by monetary score${
                        insight.score.excludedReason ? ` — ${insight.score.excludedReason}` : ""
                      }. Shown for attention only, with no invented dollar value.`}
                    </Text>
                  )}
                </BlockStack>

                {/* What we detected */}
                {insight.reasons.length > 0 ? (
                  <BlockStack gap="150">
                    <Text as="h4" variant="headingXs">
                      What we detected
                    </Text>
                    <List type="bullet">
                      {insight.reasons.map((reason, index) => (
                        <List.Item key={index}>{reason}</List.Item>
                      ))}
                    </List>
                  </BlockStack>
                ) : null}

                {/* Evidence */}
                {insight.evidence.length > 0 ? (
                  <BlockStack gap="150">
                    <Text as="h4" variant="headingXs">
                      Evidence
                    </Text>
                    <BlockStack gap="100">
                      {insight.evidence.map((item, index) => (
                        <InlineStack
                          key={index}
                          align="space-between"
                          blockAlign="center"
                          gap="200"
                          wrap
                        >
                          <Text as="span" variant="bodySm" tone="subdued">
                            {item.label}
                          </Text>
                          <Text as="span" variant="bodySm" fontWeight="medium">
                            {item.value}
                          </Text>
                        </InlineStack>
                      ))}
                    </BlockStack>
                  </BlockStack>
                ) : null}

                {/* Methodology + calculation basis */}
                <BlockStack gap="150">
                  <Text as="h4" variant="headingXs">
                    How this was calculated
                  </Text>
                  <Text as="p" variant="bodySm">
                    {insight.methodology.summary}
                  </Text>
                  {insight.financialImpact.status === "quantified" ? (
                    <Text as="p" variant="bodySm" tone="subdued">
                      {`Basis: ${insight.financialImpact.basis} (${
                        PERIOD_LABEL[insight.financialImpact.period]
                      }).`}
                    </Text>
                  ) : (
                    <Text as="p" variant="bodySm" tone="subdued">
                      {`Impact not quantified: ${insight.financialImpact.reason}.`}
                    </Text>
                  )}
                  {insight.methodology.assumptions.length > 0 ? (
                    <BlockStack gap="050">
                      <Text as="span" variant="bodySm" fontWeight="medium">
                        Assumptions
                      </Text>
                      <List type="bullet">
                        {insight.methodology.assumptions.map((assumption, index) => (
                          <List.Item key={index}>{assumption}</List.Item>
                        ))}
                      </List>
                    </BlockStack>
                  ) : null}
                  {insight.methodology.caps.length > 0 ? (
                    <BlockStack gap="050">
                      <Text as="span" variant="bodySm" fontWeight="medium">
                        Limits applied
                      </Text>
                      <List type="bullet">
                        {insight.methodology.caps.map((cap, index) => (
                          <List.Item key={index}>{cap}</List.Item>
                        ))}
                      </List>
                    </BlockStack>
                  ) : null}
                </BlockStack>
              </BlockStack>
            </Box>
          </Collapsible>
        </BlockStack>
      </div>
    </Card>
  );
}

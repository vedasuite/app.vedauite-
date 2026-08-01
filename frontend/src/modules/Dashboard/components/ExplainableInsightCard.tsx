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
import { ScoreBreakdown } from "../../../components/intelligence/ScoreBreakdown";
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
import type { ExplainableInsight } from "../../../lib/insightsTypes";
import "../../../components/intelligence/intelligence.css";

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
    // Critical findings get a faint surface tint so they separate from the
    // routine stack pre-attentively. The tint is redundant with the icon,
    // badge and rail — it is never the only signal.
    <Card
      padding="400"
      background={severity.level === "critical" ? "bg-surface-critical" : undefined}
    >
      <div className={`veda-card-interactive veda-rail ${severity.rail}`}>
        <BlockStack gap="300">
          {/* ---------- Collapsed summary ----------
              Reading order: severity → what → how much → the qualifiers.
              Money is the visual anchor; the qualifying facts sit beneath it
              as a quiet metadata row rather than four competing badges. */}
          <InlineStack align="space-between" blockAlign="start" gap="400" wrap>
            <div className="veda-clamp" style={{ flex: "1 1 280px" }}>
              <BlockStack gap="200">
                <InlineStack gap="150" blockAlign="start" wrap={false}>
                  <Box as="span" paddingBlockStart="050">
                    <Icon source={severity.icon} tone={severity.iconTone} />
                  </Box>
                  <div className="veda-clamp">
                    <BlockStack gap="100">
                      <Text as="h3" variant="headingSm">
                        {insight.title}
                      </Text>
                      <Text
                        as="p"
                        variant="headingLg"
                        fontWeight="semibold"
                        tone={quantified ? undefined : "subdued"}
                      >
                        {impactText}
                      </Text>
                    </BlockStack>
                  </div>
                </InlineStack>

                {/* One quiet metadata line replaces the badge stack. Only
                    priority keeps a badge — it is the one field that should
                    interrupt scanning. */}
                <div className="veda-meta">
                  <Badge tone={severity.badgeTone}>{severity.label}</Badge>
                  <span className="veda-meta__item">
                    <Text as="span" variant="bodySm" tone="subdued">
                      {MODULE_LABEL[insight.module]}
                    </Text>
                  </span>
                  <span className="veda-meta__sep" aria-hidden="true" />
                  <span className="veda-meta__item">
                    <Text as="span" variant="bodySm" tone="subdued">
                      {`${insight.confidence.replace("_", " ")} confidence`}
                    </Text>
                  </span>
                  <span className="veda-meta__sep" aria-hidden="true" />
                  <span className="veda-meta__item">
                    <Icon source={ClockIcon} tone="subdued" />
                    <Text as="span" variant="bodySm" tone="subdued">
                      {`${effort.minutes} · ${effort.difficulty}`}
                    </Text>
                  </span>
                  {scored ? (
                    <>
                      <span className="veda-meta__sep" aria-hidden="true" />
                      <span className="veda-meta__item">
                        <Text as="span" variant="bodySm" tone="subdued">
                          {`Score ${insight.score.total}/100`}
                        </Text>
                      </span>
                    </>
                  ) : null}
                </div>

                <Text as="p" variant="bodyMd">
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

                {/* Two columns on wide screens so the reasoning reads as a
                    panel rather than a long report. Collapses to one column
                    below ~320px per track. */}
                <div className="veda-split-grid">
                  {/* Left: the score, and what triggered it. */}
                  <BlockStack gap="400">
                    <BlockStack gap="200">
                      <Text as="h4" variant="headingXs">
                        Why this priority
                      </Text>
                      {scored ? (
                        <ScoreBreakdown score={insight.score} />
                      ) : (
                        <Text as="p" variant="bodySm" tone="subdued">
                          {`Not ranked by monetary score${
                            insight.score.excludedReason
                              ? ` — ${insight.score.excludedReason}`
                              : ""
                          }. Shown for attention only, with no invented dollar value.`}
                        </Text>
                      )}
                    </BlockStack>

                    {insight.reasons.length > 0 ? (
                      <BlockStack gap="150">
                        <Text as="h4" variant="headingXs">
                          What we detected
                        </Text>
                        <BlockStack gap="150">
                          {insight.reasons.map((reason, index) => (
                            <InlineStack key={index} gap="150" blockAlign="start" wrap={false}>
                              <Box as="span" paddingBlockStart="050">
                                <Icon source={severity.icon} tone={severity.iconTone} />
                              </Box>
                              <div className="veda-clamp">
                                <Text as="span" variant="bodySm">
                                  {reason}
                                </Text>
                              </div>
                            </InlineStack>
                          ))}
                        </BlockStack>
                      </BlockStack>
                    ) : null}
                  </BlockStack>

                  {/* Right: the audit trail — evidence, method, limits. */}
                  <BlockStack gap="400">
                    {insight.evidence.length > 0 ? (
                      <BlockStack gap="150">
                        <Text as="h4" variant="headingXs">
                          Evidence
                        </Text>
                        <Box
                          background="bg-surface-secondary"
                          padding="300"
                          borderRadius="200"
                        >
                          <BlockStack gap="150">
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
                                <Text as="span" variant="bodySm" fontWeight="semibold">
                                  {item.value}
                                </Text>
                              </InlineStack>
                            ))}
                          </BlockStack>
                        </Box>
                      </BlockStack>
                    ) : null}

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
                        <BlockStack gap="100">
                          <Text as="span" variant="bodySm" fontWeight="semibold">
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
                        <BlockStack gap="100">
                          <Text as="span" variant="bodySm" fontWeight="semibold">
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
                </div>
              </BlockStack>
            </Box>
          </Collapsible>
        </BlockStack>
      </div>
    </Card>
  );
}

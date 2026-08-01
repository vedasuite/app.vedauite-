import {
  Badge,
  BlockStack,
  Box,
  Button,
  Card,
  Icon,
  InlineStack,
  Text,
} from "@shopify/polaris";
import {
  AlertDiamondIcon,
  CashDollarIcon,
  ClockIcon,
  LightbulbIcon,
  MagicIcon,
  TargetIcon,
} from "@shopify/polaris-icons";
import { KpiCard } from "../../../components/intelligence/KpiCard";
import { Meter } from "../../../components/intelligence/Meter";
import { SEVERITY, severityForUrgency } from "../../../components/intelligence/severity";
import { useEmbeddedNavigation } from "../../../hooks/useEmbeddedNavigation";
import {
  aiConfidence,
  biggestOpportunity,
  biggestRisk,
  effortFor,
  expectedReturn,
  formatRange,
  periodLabel,
  potentialMonthlyRevenue,
  recommendedModule,
} from "../../../lib/executiveMetrics";
import { MODULE_LABEL, formatMoney } from "../../../lib/insightsTypes";
import type { DashboardInsightsResponse, ExplainableInsight } from "../../../lib/insightsTypes";
import "../../../components/intelligence/intelligence.css";

/** Compact "what/why/where" tile for the top opportunity and top risk. */
function SpotlightCard({
  kind,
  insight,
  onOpen,
}: {
  kind: "opportunity" | "risk";
  insight: ExplainableInsight | null;
  onOpen: (route: string) => void;
}) {
  const severity =
    kind === "risk"
      ? insight
        ? severityForUrgency(insight.urgency)
        : SEVERITY.healthy
      : SEVERITY.opportunity;

  const heading = kind === "risk" ? "Biggest risk" : "Biggest opportunity";

  if (!insight) {
    return (
      <Card padding="400">
        <div className={`veda-rail ${SEVERITY.healthy.rail}`}>
          <BlockStack gap="150">
            <InlineStack gap="150" blockAlign="center" wrap={false}>
              <Box as="span">
                <Icon source={SEVERITY.healthy.icon} tone="success" />
              </Box>
              <Text as="h3" variant="bodySm" tone="subdued">
                {heading}
              </Text>
            </InlineStack>
            <Text as="p" variant="headingMd" fontWeight="semibold">
              {kind === "risk" ? "Nothing critical" : "None ranked yet"}
            </Text>
            <Text as="span" variant="bodySm" tone="subdued">
              {kind === "risk"
                ? "No high-confidence critical findings are open right now."
                : "Ranked opportunities appear as data coverage grows."}
            </Text>
          </BlockStack>
        </div>
      </Card>
    );
  }

  // Bind the union to a local so TypeScript narrows it for the whole block.
  const impact = insight.financialImpact;
  const money =
    impact.status === "quantified"
      ? `${formatMoney(impact.min, impact.currency)}–${formatMoney(impact.max, impact.currency)}`
      : "Impact not quantified";
  const effort = effortFor(insight.easeOfAction);

  return (
    <Card padding="400">
      <div className={`veda-rail ${severity.rail}`}>
        <BlockStack gap="200">
          <InlineStack align="space-between" blockAlign="center" gap="200" wrap>
            <InlineStack gap="150" blockAlign="center" wrap={false}>
              <Box as="span">
                <Icon source={severity.icon} tone={severity.iconTone} />
              </Box>
              <Text as="h3" variant="bodySm" tone="subdued">
                {heading}
              </Text>
            </InlineStack>
            <InlineStack gap="150" blockAlign="center" wrap>
              <Badge tone="new">{MODULE_LABEL[insight.module]}</Badge>
              <Badge tone={severity.badgeTone}>{severity.label}</Badge>
            </InlineStack>
          </InlineStack>

          <div className="veda-clamp">
            <Text as="p" variant="headingMd" fontWeight="semibold">
              {insight.title}
            </Text>
          </div>

          <InlineStack gap="300" blockAlign="center" wrap>
            <Text
              as="span"
              variant="bodyMd"
              fontWeight="semibold"
              tone={impact.status === "quantified" ? undefined : "subdued"}
            >
              {money}
            </Text>
            {impact.status === "quantified" ? (
              <Text as="span" variant="bodySm" tone="subdued">
                {`est. · ${periodLabel(impact.period)}`}
              </Text>
            ) : null}
          </InlineStack>

          <Text as="span" variant="bodySm" tone="subdued">
            {insight.recommendedAction}
          </Text>

          <InlineStack gap="200" blockAlign="center" wrap>
            <Button variant="primary" onClick={() => onOpen(insight.route)}>
              {`Open ${MODULE_LABEL[insight.module]}`}
            </Button>
            <InlineStack gap="100" blockAlign="center" wrap={false}>
              <Box as="span">
                <Icon source={ClockIcon} tone="subdued" />
              </Box>
              <Text as="span" variant="bodySm" tone="subdued">
                {`${effort.minutes} · ${effort.difficulty}`}
              </Text>
            </InlineStack>
          </InlineStack>
        </BlockStack>
      </div>
    </Card>
  );
}

/**
 * The executive command center: the seven readings a merchant needs before
 * scrolling — potential revenue, AI confidence, expected return, time to act,
 * biggest opportunity, biggest risk, and the recommended module.
 *
 * Every figure comes from `executiveMetrics`, which reads the engine's own
 * output. Where the engine cannot quantify something, this shows that fact
 * rather than a placeholder number.
 */
export function ExecutiveHero({ data }: { data: DashboardInsightsResponse }) {
  const { navigateEmbedded } = useEmbeddedNavigation();

  const upside = potentialMonthlyRevenue(data);
  const confidence = aiConfidence(data);
  const topOpportunity = biggestOpportunity(data);
  const topRisk = biggestRisk(data);
  const recommended = recommendedModule(data);
  const expected = expectedReturn(data);
  const timeRequired = topOpportunity ? effortFor(topOpportunity.easeOfAction) : null;

  return (
    <div className="veda-band">
      {/* Headline narrative + the single next action.
          Raised surface: this is the one card per screen that should read as
          the control centre. Bullets sit in a two-column grid so the summary
          occupies a band rather than a paragraph stack. */}
      <Card padding="400">
        <div className="veda-surface-raised">
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="start" gap="300" wrap>
              <InlineStack gap="200" blockAlign="center" wrap={false}>
                <Box as="span">
                  <Icon source={MagicIcon} tone="info" />
                </Box>
                <div>
                  <div className="veda-eyebrow">Executive summary</div>
                  <Text as="h2" variant="headingMd">
                    {`Your store right now`}
                  </Text>
                </div>
              </InlineStack>
              <InlineStack gap="150" blockAlign="center" wrap>
                <Badge tone="new">AI</Badge>
                {recommended ? (
                  <Button variant="primary" onClick={() => navigateEmbedded(recommended.route)}>
                    {`Start with ${recommended.label}`}
                  </Button>
                ) : null}
              </InlineStack>
            </InlineStack>

            <div className="veda-clamp">
              <Text as="p" variant="bodyLg">
                {data.executiveSummary.headline}
              </Text>
            </div>

            {data.executiveSummary.bullets.length > 0 ? (
              <div className="veda-split-grid">
                {data.executiveSummary.bullets.map((bullet, index) => (
                  <InlineStack key={index} gap="150" blockAlign="start" wrap={false}>
                    <Box as="span" paddingBlockStart="050">
                      <Icon source={LightbulbIcon} tone="subdued" />
                    </Box>
                    <div className="veda-clamp">
                      <Text as="span" variant="bodySm" tone="subdued">
                        {bullet}
                      </Text>
                    </div>
                  </InlineStack>
                ))}
              </div>
            ) : null}
          </BlockStack>
        </div>
      </Card>

      {/* The four headline numbers. */}
      <div className="veda-kpi-grid">
        <KpiCard
          label="Potential revenue"
          emphasis
          icon={CashDollarIcon}
          iconTone="success"
          value={upside ? upside.max : null}
          format={(n) => formatMoney(n, upside?.currency ?? "USD")}
          display={upside ? undefined : "Not quantified"}
          caption={
            upside
              ? `Est. range ${formatRange(upside)} · ${periodLabel(upside.period)}`
              : "No quantified upside yet — estimates appear as coverage grows."
          }
          badge={upside ? "Estimate" : undefined}
          badgeTone={undefined}
        />

        <KpiCard
          label="AI confidence"
          icon={TargetIcon}
          iconTone={confidence.label === "High" ? "success" : "info"}
          value={confidence.sampleSize > 0 ? confidence.percent : null}
          format={(n) => `${Math.round(n)}%`}
          display={confidence.sampleSize > 0 ? undefined : "No signal"}
          badge={confidence.label}
          badgeTone={confidence.tone}
          footer={
            confidence.sampleSize > 0 ? (
              <Meter
                value={confidence.percent}
                tone={
                  confidence.label === "High"
                    ? "success"
                    : confidence.label === "Medium"
                    ? "info"
                    : "warning"
                }
                label="Confidence"
                valueText={`${confidence.percent}% — ${confidence.label.toLowerCase()}`}
                caption={`Across ${confidence.sampleSize} finding${
                  confidence.sampleSize === 1 ? "" : "s"
                }`}
              />
            ) : undefined
          }
        />

        <KpiCard
          label="Expected return"
          icon={CashDollarIcon}
          iconTone="success"
          value={expected ? expected.max : null}
          format={(n) => formatMoney(n, expected?.currency ?? "USD")}
          display={expected ? undefined : "Not quantified"}
          caption={
            expected
              ? `Top action · est. ${formatRange(expected)} ${periodLabel(expected.period)}`
              : "The top-ranked action has no quantifiable dollar impact."
          }
        />

        <KpiCard
          label="Time to act"
          icon={ClockIcon}
          iconTone="subdued"
          display={timeRequired ? timeRequired.minutes : "—"}
          caption={
            timeRequired
              ? `${timeRequired.difficulty} · for the top-ranked action`
              : "No ranked action yet."
          }
          badge={recommended ? recommended.label : undefined}
          badgeTone={undefined}
        />
      </div>

      {/* Opportunity vs. risk, side by side. */}
      <div className="veda-split-grid">
        <SpotlightCard kind="opportunity" insight={topOpportunity} onOpen={navigateEmbedded} />
        <SpotlightCard kind="risk" insight={topRisk} onOpen={navigateEmbedded} />
      </div>

      {/* Provenance line. Kept — merchants must know these are estimates — but
          demoted to the smallest type so it reads as a footnote, not prose. */}
      <InlineStack gap="150" blockAlign="center" wrap>
        <Text as="span" variant="bodySm" tone="subdued">
          Bounded estimates from your synced Shopify data — not guarantees.
        </Text>
        <span className="veda-meta__sep" aria-hidden="true" />
        <Text as="span" variant="bodySm" tone="subdued">
          <time dateTime={data.executiveSummary.generatedAt}>
            {`Updated ${new Date(data.executiveSummary.generatedAt).toLocaleTimeString([], {
              hour: "numeric",
              minute: "2-digit",
            })}`}
          </time>
        </Text>
      </InlineStack>
    </div>
  );
}

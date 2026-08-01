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
  Text,
} from "@shopify/polaris";
import { ArrowDownIcon, ArrowUpIcon, ChevronDownIcon } from "@shopify/polaris-icons";
import { useId, useState } from "react";
import { usePrefersReducedMotion } from "../../../components/intelligence/AnimatedCounter";
import { EducationalEmptyState } from "../../../components/intelligence/EducationalEmptyState";
import { KpiCard } from "../../../components/intelligence/KpiCard";
import { formatRange, largestOf, periodLabel } from "../../../lib/executiveMetrics";
import { PERIOD_LABEL, confidenceTone, formatMoney } from "../../../lib/insightsTypes";
import type { LeakGroup, RevenueLeakModel } from "../../../lib/insightsTypes";
import "../../../components/intelligence/intelligence.css";

/**
 * One period-homogeneous group. The backend guarantees every item inside a
 * group shares a period, which is why a group total is meaningful — and why
 * totals are never carried across groups.
 */
function GroupCard({ group }: { group: LeakGroup }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const reducedMotion = usePrefersReducedMotion();
  const isUpside = group.kind === "potential_upside";

  return (
    <Card padding="400">
      <div
        className={`veda-card-interactive veda-rail ${
          isUpside ? "veda-rail--opportunity" : "veda-rail--warning"
        }`}
      >
        <BlockStack gap="200">
          <InlineStack align="space-between" blockAlign="start" gap="200" wrap>
            <InlineStack gap="150" blockAlign="center" wrap>
              <Box as="span">
                <Icon
                  source={isUpside ? ArrowUpIcon : ArrowDownIcon}
                  tone={isUpside ? "success" : "caution"}
                />
              </Box>
              <Text as="h4" variant="headingSm">
                {PERIOD_LABEL[group.period]}
              </Text>
            </InlineStack>
            <Badge tone={confidenceTone(group.confidence)}>
              {`${group.confidence.replace("_", " ")} confidence`}
            </Badge>
          </InlineStack>

          <div className="veda-kpi-value veda-clamp">
            <Text as="p" variant="headingLg" fontWeight="semibold">
              {`${formatMoney(group.min, group.currency)}–${formatMoney(
                group.max,
                group.currency
              )}`}
            </Text>
          </div>

          <Text as="span" variant="bodySm" tone="subdued">
            {`Estimated range · ${PERIOD_LABEL[group.period]} · ${group.currency} · ${
              group.items.length
            } contributor${group.items.length === 1 ? "" : "s"}`}
          </Text>

          {group.items.length > 0 ? (
            <>
              <Button
                variant="tertiary"
                onClick={() => setOpen((value) => !value)}
                ariaExpanded={open}
                ariaControls={panelId}
                accessibilityLabel={
                  open
                    ? `Hide the breakdown for ${PERIOD_LABEL[group.period]}`
                    : `Show the breakdown for ${PERIOD_LABEL[group.period]}`
                }
                icon={
                  <span className={`veda-chevron${open ? " veda-chevron--open" : ""}`}>
                    <Icon source={ChevronDownIcon} tone="subdued" />
                  </span>
                }
              >
                {open ? "Hide breakdown" : "Show breakdown"}
              </Button>

              <Collapsible
                open={open}
                id={panelId}
                transition={
                  reducedMotion ? undefined : { duration: "180ms", timingFunction: "ease-in-out" }
                }
              >
                <Box paddingBlockStart="200">
                  <BlockStack gap="200">
                    <Divider />
                    {group.items.map((item) => (
                      <InlineStack
                        key={item.key}
                        align="space-between"
                        blockAlign="center"
                        gap="200"
                        wrap
                      >
                        <div className="veda-clamp">
                          <Text as="span" variant="bodySm">
                            {item.label}
                          </Text>
                        </div>
                        <Text as="span" variant="bodySm" tone="subdued">
                          {`${formatMoney(item.min, group.currency)}–${formatMoney(
                            item.max,
                            group.currency
                          )}`}
                        </Text>
                      </InlineStack>
                    ))}
                    <Text as="span" variant="bodySm" tone="subdued">
                      Contributors are only added together inside this one period.
                      Figures from other periods are never combined with these.
                    </Text>
                  </BlockStack>
                </Box>
              </Collapsible>
            </>
          ) : null}
        </BlockStack>
      </div>
    </Card>
  );
}

function Column({
  title,
  description,
  groups,
  emptyWhy,
  emptySteps,
}: {
  title: string;
  description: string;
  groups: LeakGroup[];
  emptyWhy: string;
  emptySteps: string[];
}) {
  return (
    <BlockStack gap="300">
      <BlockStack gap="100">
        <Text as="h3" variant="headingSm">
          {title}
        </Text>
        <Text as="span" variant="bodySm" tone="subdued">
          {description}
        </Text>
      </BlockStack>
      {groups.length === 0 ? (
        <EducationalEmptyState title={`No ${title.toLowerCase()} yet`} why={emptyWhy} steps={emptySteps} />
      ) : (
        <BlockStack gap="300">
          {groups.map((group) => (
            <GroupCard key={`${group.kind}-${group.period}`} group={group} />
          ))}
        </BlockStack>
      )}
    </BlockStack>
  );
}

/**
 * Revenue Leak Detector.
 *
 * Potential upside and revenue at risk are kept structurally separate — they
 * are different questions ("what could I gain" vs "what might I lose") and are
 * never netted against each other or summed across time periods.
 */
export function RevenueLeakDetector({ model }: { model: RevenueLeakModel }) {
  const largestOpportunity = largestOf(model.potentialUpside);
  const largestLeak = largestOf(model.revenueAtRisk);

  return (
    <BlockStack gap="400">
      <BlockStack gap="100">
        <Text as="h2" variant="headingMd">
          Revenue leak detector
        </Text>
        <Text as="span" variant="bodySm" tone="subdued">
          Upside and risk are shown side by side but never combined. Each figure
          is a bounded estimate for a single time period.
        </Text>
      </BlockStack>

      {/* Headline: the single largest item on each side. */}
      <div className="veda-kpi-grid">
        <KpiCard
          label="Largest opportunity"
          icon={ArrowUpIcon}
          iconTone="success"
          value={largestOpportunity ? largestOpportunity.max : null}
          format={(n) => formatMoney(n, largestOpportunity?.currency ?? "USD")}
          display={largestOpportunity ? undefined : "None yet"}
          caption={
            largestOpportunity
              ? `Est. ${formatRange(largestOpportunity)} · ${periodLabel(largestOpportunity.period)}`
              : "No quantified upside group yet."
          }
          badge={largestOpportunity ? largestOpportunity.confidence.replace("_", " ") : undefined}
          badgeTone={largestOpportunity ? confidenceTone(largestOpportunity.confidence) : undefined}
        />
        <KpiCard
          label="Largest leak"
          icon={ArrowDownIcon}
          iconTone="caution"
          value={largestLeak ? largestLeak.max : null}
          format={(n) => formatMoney(n, largestLeak?.currency ?? "USD")}
          display={largestLeak ? undefined : "None detected"}
          caption={
            largestLeak
              ? `Est. ${formatRange(largestLeak)} · ${periodLabel(largestLeak.period)}`
              : "No quantified revenue-at-risk group yet."
          }
          badge={largestLeak ? largestLeak.confidence.replace("_", " ") : undefined}
          badgeTone={largestLeak ? confidenceTone(largestLeak.confidence) : undefined}
        />
      </div>

      <div className="veda-split-grid">
        <Column
          title="Potential upside"
          description="Estimated gains if the recommended actions are applied."
          groups={model.potentialUpside}
          emptyWhy="VedaSuite only reports upside it can defend from your synced pricing, profit and product data — so nothing appears until those signals are strong enough to bound a range."
          emptySteps={[
            "Sync more product and order history from Shopify",
            "Add product cost so margin impact can be calculated",
            "Let pricing and profit analysis complete at least one run",
          ]}
        />
        <Column
          title="Revenue at risk"
          description="Money exposed if these findings go unresolved."
          groups={model.revenueAtRisk}
          emptyWhy="Nothing is currently exposed, or there isn't yet enough order and fraud history to bound a defensible range."
          emptySteps={[
            "Keep order sync running so open exposure stays current",
            "Add competitor domains to detect price pressure",
            "Allow fraud and return-abuse analysis to build baseline history",
          ]}
        />
      </div>
    </BlockStack>
  );
}

import {
  Badge, BlockStack, Box, Button, Card, Collapsible, Divider, InlineStack, Text,
} from "@shopify/polaris";
import { useId, useState } from "react";
import {
  PERIOD_LABEL, confidenceTone, formatMoney,
} from "../../../lib/insightsTypes";
import type { LeakGroup, RevenueLeakModel } from "../../../lib/insightsTypes";

function GroupCard({ group }: { group: LeakGroup }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return (
    <Card>
      <BlockStack gap="150">
        <InlineStack align="space-between" blockAlign="center" wrap gap="200">
          <BlockStack gap="050">
            <InlineStack gap="150" blockAlign="center" wrap>
              <Text as="h4" variant="headingSm">
                {group.kind === "potential_upside" ? "Upside" : "At risk"} — {PERIOD_LABEL[group.period]}
              </Text>
              <Badge tone={confidenceTone(group.confidence)}>{`Confidence: ${group.confidence.replace("_", " ")}`}</Badge>
            </InlineStack>
            <Text as="span" variant="bodyMd">
              {`${formatMoney(group.min, group.currency)}–${formatMoney(group.max, group.currency)}`}
            </Text>
            <Text as="span" variant="bodySm" tone="subdued">
              {`Estimated range · ${PERIOD_LABEL[group.period]} · ${group.currency}`}
            </Text>
          </BlockStack>
          <Button
            variant="tertiary"
            onClick={() => setOpen((v) => !v)}
            ariaExpanded={open}
            ariaControls={panelId}
            accessibilityLabel={open ? "Hide breakdown" : "Show breakdown"}
          >
            {open ? "Hide breakdown" : "Breakdown"}
          </Button>
        </InlineStack>
        <Collapsible open={open} id={panelId} transition={{ duration: "150ms", timingFunction: "ease-in-out" }}>
          <Box paddingBlockStart="150">
            <BlockStack gap="100">
              <Divider />
              {group.items.map((it) => (
                <InlineStack key={it.key} align="space-between" blockAlign="center" wrap>
                  <Text as="span" variant="bodySm">{it.label}</Text>
                  <Text as="span" variant="bodySm" tone="subdued">
                    {`${formatMoney(it.min, group.currency)}–${formatMoney(it.max, group.currency)}`}
                  </Text>
                </InlineStack>
              ))}
            </BlockStack>
          </Box>
        </Collapsible>
      </BlockStack>
    </Card>
  );
}

function GroupColumn({ title, groups, emptyText }: { title: string; groups: LeakGroup[]; emptyText: string }) {
  return (
    <BlockStack gap="200">
      <Text as="h3" variant="headingSm">{title}</Text>
      {groups.length === 0 ? (
        <Card><Text as="p" tone="subdued">{emptyText}</Text></Card>
      ) : (
        groups.map((g) => <GroupCard key={`${g.kind}-${g.period}`} group={g} />)
      )}
    </BlockStack>
  );
}

export function RevenueLeakDetector({ model }: { model: RevenueLeakModel }) {
  return (
    <BlockStack gap="300">
      <Text as="h2" variant="headingMd">Revenue Leak Detector</Text>
      <Text as="span" variant="bodySm" tone="subdued">
        Potential upside and revenue at risk are shown separately and never combined. Each group is a bounded estimate for a single time period.
      </Text>
      {/* Two strictly separate columns; periods never summed across groups. */}
      <InlineStack gap="400" align="start" blockAlign="start" wrap>
        <Box minWidth="280px" width="48%">
          <GroupColumn
            title="Potential upside"
            groups={model.potentialUpside}
            emptyText="No supported upside opportunities yet."
          />
        </Box>
        <Box minWidth="280px" width="48%">
          <GroupColumn
            title="Revenue at risk"
            groups={model.revenueAtRisk}
            emptyText="No supported revenue-at-risk signals yet."
          />
        </Box>
      </InlineStack>
    </BlockStack>
  );
}

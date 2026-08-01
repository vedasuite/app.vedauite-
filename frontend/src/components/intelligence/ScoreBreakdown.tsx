import { BlockStack, InlineStack, Text } from "@shopify/polaris";
import { usePrefersReducedMotion } from "./AnimatedCounter";
import type { OpportunityScoreBreakdown } from "../../lib/insightsTypes";
import "./intelligence.css";

const ROWS: {
  key: keyof OpportunityScoreBreakdown["components"];
  label: string;
  weight: string;
}[] = [
  { key: "financialImpact", label: "Impact", weight: "35%" },
  { key: "urgency", label: "Urgency", weight: "25%" },
  { key: "confidence", label: "Confidence", weight: "20%" },
  { key: "easeOfAction", label: "Ease", weight: "10%" },
  { key: "recency", label: "Recency", weight: "10%" },
];

/**
 * The weighted opportunity score, shown as five proportional bars.
 *
 * Same five components, same weights, same 0–100 values the engine already
 * computed — nothing is recalculated here. Bars simply let a merchant see at a
 * glance *which* factor is carrying the score, which a column of numbers
 * cannot do. Each row still states its exact value in text for screen readers
 * and for anyone auditing the figure.
 */
export function ScoreBreakdown({ score }: { score: OpportunityScoreBreakdown }) {
  const reducedMotion = usePrefersReducedMotion();

  return (
    <BlockStack gap="200">
      <InlineStack align="space-between" blockAlign="center" gap="200" wrap>
        <Text as="span" variant="bodySm" tone="subdued">
          Opportunity score
        </Text>
        <Text as="span" variant="headingSm">
          {`${score.total}`}
          <Text as="span" variant="bodySm" tone="subdued">
            {" / 100"}
          </Text>
        </Text>
      </InlineStack>

      <BlockStack gap="150">
        {ROWS.map((row) => {
          const value = score.components[row.key];
          return (
            <div key={row.key} className="veda-score-row">
              <Text as="span" variant="bodySm" tone="subdued">
                {`${row.label} · ${row.weight}`}
              </Text>
              <div
                className="veda-score-track"
                role="progressbar"
                aria-label={`${row.label}, weighted ${row.weight}`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={value}
                aria-valuetext={`${value} out of 100`}
              >
                <div
                  className="veda-score-fill"
                  style={{
                    inlineSize: `${Math.max(0, Math.min(100, value))}%`,
                    transition: reducedMotion ? "none" : undefined,
                  }}
                />
              </div>
              <Text as="span" variant="bodySm" numeric>
                {value}
              </Text>
            </div>
          );
        })}
      </BlockStack>
    </BlockStack>
  );
}

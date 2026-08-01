import { BlockStack, InlineStack, Text } from "@shopify/polaris";
import { usePrefersReducedMotion } from "./AnimatedCounter";
import "./intelligence.css";

/**
 * Horizontal 0–100 meter (risk pressure, trust, confidence).
 *
 * Exposed to assistive tech as a real progressbar with min/max/now and a text
 * equivalent, so the reading is never conveyed by the bar's width alone.
 */
export function Meter({
  value,
  tone = "info",
  label,
  valueText,
  caption,
}: {
  /** 0–100. Clamped defensively. */
  value: number;
  tone?: "critical" | "warning" | "success" | "info" | "neutral";
  label: string;
  /** Text equivalent of the reading, e.g. "72% — elevated". */
  valueText?: string;
  caption?: string;
}) {
  const reducedMotion = usePrefersReducedMotion();
  const clamped = Math.max(0, Math.min(100, Math.round(value)));
  const text = valueText ?? `${clamped}%`;

  return (
    <BlockStack gap="150">
      <InlineStack align="space-between" blockAlign="center" gap="200" wrap>
        <Text as="span" variant="bodySm" tone="subdued">
          {label}
        </Text>
        <Text as="span" variant="bodySm" fontWeight="semibold">
          {text}
        </Text>
      </InlineStack>
      <div
        className="veda-meter"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={clamped}
        aria-valuetext={text}
      >
        <div
          className={`veda-meter__fill veda-meter__fill--${tone}`}
          style={{
            inlineSize: `${clamped}%`,
            transition: reducedMotion ? "none" : undefined,
          }}
        />
      </div>
      {caption ? (
        <Text as="span" variant="bodySm" tone="subdued">
          {caption}
        </Text>
      ) : null}
    </BlockStack>
  );
}

/**
 * Segmented health readout — "4 of 6 checks passing". Better than a percentage
 * when the underlying quantity is genuinely discrete.
 */
export function SegmentedMeter({
  total,
  filled,
  tone = "success",
  label,
  caption,
}: {
  total: number;
  filled: number;
  tone?: "success" | "critical" | "warning" | "info";
  label: string;
  caption?: string;
}) {
  const safeTotal = Math.max(0, total);
  const safeFilled = Math.max(0, Math.min(safeTotal, filled));
  const valueText = `${safeFilled} of ${safeTotal}`;

  return (
    <BlockStack gap="150">
      <InlineStack align="space-between" blockAlign="center" gap="200" wrap>
        <Text as="span" variant="bodySm" tone="subdued">
          {label}
        </Text>
        <Text as="span" variant="bodySm" fontWeight="semibold">
          {valueText}
        </Text>
      </InlineStack>
      <div
        className="veda-segments"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={safeTotal}
        aria-valuenow={safeFilled}
        aria-valuetext={valueText}
      >
        {Array.from({ length: safeTotal }, (_, index) => (
          <div
            key={index}
            className={`veda-segment ${index < safeFilled ? `veda-segment--on-${tone}` : ""}`}
          />
        ))}
      </div>
      {caption ? (
        <Text as="span" variant="bodySm" tone="subdued">
          {caption}
        </Text>
      ) : null}
    </BlockStack>
  );
}

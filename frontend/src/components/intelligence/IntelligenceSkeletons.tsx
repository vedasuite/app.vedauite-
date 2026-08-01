import {
  BlockStack,
  Card,
  InlineStack,
  SkeletonBodyText,
  SkeletonDisplayText,
  Text,
} from "@shopify/polaris";
import "./intelligence.css";

/**
 * Loading placeholders that mirror the real layout, so the page doesn't jump
 * when data lands. Each block carries a polite live-region status message —
 * a purely visual skeleton is invisible to screen readers.
 */

export function KpiSkeletonGrid({ count = 4 }: { count?: number }) {
  return (
    <div className="veda-kpi-grid">
      {Array.from({ length: count }, (_, index) => (
        <Card key={index} padding="400">
          <BlockStack gap="300">
            <SkeletonBodyText lines={1} />
            <SkeletonDisplayText size="medium" />
            <SkeletonBodyText lines={1} />
          </BlockStack>
        </Card>
      ))}
    </div>
  );
}

export function InsightCardSkeleton() {
  return (
    <Card padding="400">
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="start" gap="300" wrap>
          <div style={{ flex: "1 1 220px", minInlineSize: 0 }}>
            <BlockStack gap="200">
              <SkeletonDisplayText size="small" />
              <SkeletonBodyText lines={2} />
            </BlockStack>
          </div>
        </InlineStack>
      </BlockStack>
    </Card>
  );
}

export function InsightListSkeleton({ count = 3 }: { count?: number }) {
  return (
    <BlockStack gap="300">
      {Array.from({ length: count }, (_, index) => (
        <InsightCardSkeleton key={index} />
      ))}
    </BlockStack>
  );
}

/**
 * Full dashboard loading state. `message` is announced politely so assistive
 * tech users know work is in progress rather than hearing silence.
 */
export function DashboardSkeleton({
  message = "Loading your store intelligence…",
}: {
  message?: string;
}) {
  return (
    <BlockStack gap="400">
      <Text as="p" visuallyHidden aria-live="polite">
        {message}
      </Text>
      <Card padding="400">
        <BlockStack gap="400">
          <SkeletonDisplayText size="medium" />
          <SkeletonBodyText lines={2} />
        </BlockStack>
      </Card>
      <KpiSkeletonGrid count={4} />
      <InsightListSkeleton count={2} />
    </BlockStack>
  );
}


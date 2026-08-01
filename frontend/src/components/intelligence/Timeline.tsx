import { BlockStack, InlineStack, Text } from "@shopify/polaris";
import type { ReactNode } from "react";
import "./intelligence.css";

export type TimelineEntry = {
  id: string;
  title: string;
  /** Absolute ISO timestamp — rendered as a relative label plus a full title. */
  timestamp: string;
  detail?: string;
  tone?: "critical" | "warning" | "success" | "info";
  meta?: ReactNode;
};

/** "3 days ago" / "just now" — purely a display helper. */
export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const diffMs = Date.now() - then;
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  const months = Math.round(days / 30);
  return `${months} mo ago`;
}

/**
 * Vertical activity spine. Rendered as an ordered list so screen readers
 * announce position and count ("2 of 5") without extra ARIA.
 */
export function Timeline({ entries }: { entries: TimelineEntry[] }) {
  if (entries.length === 0) return null;

  return (
    <ol className="veda-timeline">
      {entries.map((entry) => (
        <li key={entry.id} className="veda-timeline__item">
          <span
            className={`veda-timeline__dot${
              entry.tone ? ` veda-timeline__dot--${entry.tone}` : ""
            }`}
            aria-hidden="true"
          />
          <BlockStack gap="050">
            <InlineStack align="space-between" blockAlign="start" gap="200" wrap>
              <div className="veda-clamp">
                <Text as="span" variant="bodyMd" fontWeight="medium">
                  {entry.title}
                </Text>
              </div>
              <Text as="span" variant="bodySm" tone="subdued">
                <time dateTime={entry.timestamp} title={new Date(entry.timestamp).toLocaleString()}>
                  {relativeTime(entry.timestamp)}
                </time>
              </Text>
            </InlineStack>
            {entry.detail ? (
              <Text as="span" variant="bodySm" tone="subdued">
                {entry.detail}
              </Text>
            ) : null}
            {entry.meta}
          </BlockStack>
        </li>
      ))}
    </ol>
  );
}

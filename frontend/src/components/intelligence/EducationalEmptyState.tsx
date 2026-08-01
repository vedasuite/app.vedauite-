import { BlockStack, Box, Button, Card, Icon, InlineStack, List, Text } from "@shopify/polaris";
import { InfoIcon } from "@shopify/polaris-icons";
import "./intelligence.css";

export type EmptyStateAction = {
  label: string;
  onAction?: () => void;
  url?: string;
  variant?: "primary" | "secondary";
};

/**
 * Empty states that teach instead of apologising.
 *
 * Every instance answers three questions: what is missing, *why* it is missing,
 * and what specifically produces the data. Never renders sample/demo figures —
 * a merchant must never mistake illustrative numbers for their own data.
 */
export function EducationalEmptyState({
  title,
  why,
  steps,
  actions,
  icon = InfoIcon,
  iconTone = "subdued",
}: {
  title: string;
  /** Plain-language reason there is nothing to show yet. */
  why: string;
  /** Concrete things that will cause insights to appear. */
  steps?: string[];
  actions?: EmptyStateAction[];
  icon?: typeof InfoIcon;
  iconTone?: "critical" | "caution" | "success" | "info" | "subdued";
}) {
  return (
    <Card padding="400">
      <BlockStack gap="300">
        <InlineStack gap="200" blockAlign="center" wrap={false}>
          <Box as="span">
            <Icon source={icon} tone={iconTone} />
          </Box>
          <Text as="h3" variant="headingSm">
            {title}
          </Text>
        </InlineStack>

        <Text as="p" variant="bodyMd" tone="subdued">
          {why}
        </Text>

        {steps && steps.length > 0 ? (
          <BlockStack gap="150">
            <Text as="h4" variant="headingXs">
              What produces this
            </Text>
            <List type="bullet">
              {steps.map((step, index) => (
                <List.Item key={index}>{step}</List.Item>
              ))}
            </List>
          </BlockStack>
        ) : null}

        {actions && actions.length > 0 ? (
          <InlineStack gap="200" wrap>
            {actions.map((action) => (
              <Button
                key={action.label}
                variant={action.variant === "primary" ? "primary" : undefined}
                onClick={action.onAction}
                url={action.url}
              >
                {action.label}
              </Button>
            ))}
          </InlineStack>
        ) : null}
      </BlockStack>
    </Card>
  );
}

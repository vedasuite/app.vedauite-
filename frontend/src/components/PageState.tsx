import { BlockStack, Button, Card, Layout, Page, Text } from "@shopify/polaris";

type Props = {
  title: string;
  subtitle?: string;
  message: string;
  heading?: string;
  actionLabel?: string;
  onAction?: () => void;
};

function PageStateCard({
  title,
  subtitle,
  message,
  heading,
  actionLabel,
  onAction,
}: Props) {
  return (
    <Page title={title} subtitle={subtitle}>
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h3" variant="headingMd">
                {heading}
              </Text>
              <Text as="p" tone="subdued">
                {message}
              </Text>
              {actionLabel && onAction ? (
                <Button onClick={onAction}>{actionLabel}</Button>
              ) : null}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

export function LoadingPageState(props: Props) {
  return <PageStateCard {...props} heading={props.heading ?? "Loading"} />;
}

export function EmptyPageState(props: Props) {
  return <PageStateCard {...props} heading={props.heading ?? "Nothing here yet"} />;
}

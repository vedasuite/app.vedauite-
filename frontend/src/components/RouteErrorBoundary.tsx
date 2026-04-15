import React from "react";
import { Banner, Button, Card, Layout, Page, Text } from "@shopify/polaris";

type Props = {
  title: string;
  children: React.ReactNode;
};

type State = {
  hasError: boolean;
  message: string | null;
};

export class RouteErrorBoundary extends React.Component<Props, State> {
  state: State = {
    hasError: false,
    message: null,
  };

  static getDerivedStateFromError(error: Error): State {
    return {
      hasError: true,
      message: error.message,
    };
  }

  componentDidCatch(error: Error) {
    console.error("VedaSuite route crash", this.props.title, error);
  }

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    return (
      <Page title={this.props.title}>
        <Layout>
          <Layout.Section>
            <Card>
              <Banner title="This screen needs attention" tone="critical">
                <p>
                  VedaSuite hit a problem while loading this page. Refresh once and
                  try again.
                </p>
              </Banner>
              <div style={{ paddingTop: "1rem" }}>
                {this.state.message ? (
                  <Text as="p" tone="subdued">
                    Error: {this.state.message}
                  </Text>
                ) : null}
                <div style={{ marginTop: "1rem" }}>
                  <Button onClick={() => window.location.reload()}>Refresh page</Button>
                </div>
              </div>
            </Card>
          </Layout.Section>
        </Layout>
      </Page>
    );
  }
}

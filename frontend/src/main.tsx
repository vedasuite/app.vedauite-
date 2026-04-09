import React from "react";
import ReactDOM from "react-dom/client";
import { AppProvider } from "@shopify/polaris";
import enTranslations from "@shopify/polaris/locales/en.json";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { OnboardingProvider } from "./providers/OnboardingProvider";
import { SubscriptionProvider } from "./providers/SubscriptionProvider";
import "@shopify/polaris/build/esm/styles.css";
import { Button, Card, Layout, Page, Text } from "@shopify/polaris";
import { getEmbeddedContext } from "./lib/shopifyEmbeddedContext";

type ErrorBoundaryState = {
  hasError: boolean;
  message: string | null;
};

class FrontendErrorBoundary extends React.Component<
  React.PropsWithChildren,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = {
    hasError: false,
    message: null,
  };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return {
      hasError: true,
      message: error.message,
    };
  }

  componentDidCatch(error: Error) {
    console.error("VedaSuite frontend crash", error);
  }

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    const { shop, host } = getEmbeddedContext();
    const reconnectPath = shop
      ? `/auth/install?shop=${encodeURIComponent(shop)}${
          host ? `&host=${encodeURIComponent(host)}` : ""
        }&returnTo=${encodeURIComponent(window.location.pathname)}`
      : null;

    return (
      <Page title="VedaSuite AI">
        <Layout>
          <Layout.Section>
            <Card>
              <div style={{ padding: "1rem" }}>
                <Text as="h2" variant="headingLg">
                  The embedded app hit a loading problem
                </Text>
                <div style={{ marginTop: "0.75rem" }}>
                  <Text as="p" tone="subdued">
                    VedaSuite caught the error before the whole screen crashed. Refresh once or reconnect the app if Shopify loaded it without full embedded context.
                  </Text>
                </div>
                {this.state.message ? (
                  <div style={{ marginTop: "0.75rem" }}>
                    <Text as="p" tone="subdued">
                      Error: {this.state.message}
                    </Text>
                  </div>
                ) : null}
                <div style={{ marginTop: "1rem", display: "flex", gap: "0.75rem" }}>
                  <Button onClick={() => window.location.reload()}>Refresh app</Button>
                  {reconnectPath ? (
                    <Button
                      variant="primary"
                      onClick={() => (window.top ?? window).location.assign(reconnectPath)}
                    >
                      Reconnect Shopify
                    </Button>
                  ) : null}
                </div>
              </div>
            </Card>
          </Layout.Section>
        </Layout>
      </Page>
    );
  }
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <AppProvider i18n={enTranslations}>
    <BrowserRouter>
      <FrontendErrorBoundary>
        <SubscriptionProvider>
          <OnboardingProvider>
            <App />
          </OnboardingProvider>
        </SubscriptionProvider>
      </FrontendErrorBoundary>
    </BrowserRouter>
  </AppProvider>
);

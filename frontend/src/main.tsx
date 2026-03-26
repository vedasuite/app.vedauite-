import React from "react";
import ReactDOM from "react-dom/client";
import { AppProvider } from "@shopify/polaris";
import enTranslations from "@shopify/polaris/locales/en.json";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { SubscriptionProvider } from "./providers/SubscriptionProvider";
import "@shopify/polaris/build/esm/styles.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <AppProvider i18n={enTranslations}>
    <BrowserRouter>
      <SubscriptionProvider>
        <App />
      </SubscriptionProvider>
    </BrowserRouter>
  </AppProvider>
);

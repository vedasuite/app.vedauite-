import { fileURLToPath, URL } from "node:url";
import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react-swc";
import { injectShopifyApiKey, resolveShopifyApiKey } from "./shopifyApiKey.js";

const srcPath = fileURLToPath(new URL("./src", import.meta.url));

/**
 * Stamps the Shopify App Bridge API key into index.html at build time.
 *
 * Without an override this writes the same production key that used to be
 * hardcoded, so production builds are unchanged. Staging sets
 * VITE_SHOPIFY_API_KEY to its own app's client id so App Bridge and the
 * staging backend agree on the app identity.
 */
function shopifyApiKeyPlugin(mode: string): Plugin {
  return {
    name: "vedasuite:shopify-api-key",
    transformIndexHtml(html) {
      // Render supplies the value as a real environment variable; loadEnv also
      // picks up .env files for local development.
      const fileEnv = loadEnv(mode, process.cwd(), "VITE_");
      const apiKey = resolveShopifyApiKey({
        VITE_SHOPIFY_API_KEY:
          process.env.VITE_SHOPIFY_API_KEY ?? fileEnv.VITE_SHOPIFY_API_KEY,
      });
      return injectShopifyApiKey(html, apiKey);
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), shopifyApiKeyPlugin(mode)],
  resolve: {
    alias: {
      "@": srcPath,
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) {
            return undefined;
          }

          if (id.includes("@shopify/polaris")) {
            return "polaris";
          }

          if (id.includes("react-router")) {
            return "router";
          }

          if (id.includes("axios")) {
            return "network";
          }

          return "vendor";
        },
      },
    },
  },
  server: {
    port: 5173,
  },
}));

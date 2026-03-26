import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";

const srcPath = fileURLToPath(new URL("./src", import.meta.url));

export default defineConfig({
  plugins: [react()],
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
});

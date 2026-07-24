import "express-async-errors";
import path from "path";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import cookieParser from "cookie-parser";

import { logEvent } from "./services/observabilityService";
import { errorHandler } from "./middleware/errorHandler";
import { attachRequestContext } from "./middleware/requestContext";
import { router } from "./routes";
import { shopifyWebhookRouter } from "./routes/shopifyWebhookRoutes";
import { ensureStoreBootstrapped } from "./services/bootstrapService";
import { env } from "./config/env";
import {
  readShopifySessionCookie,
  setShopifySessionCookie,
} from "./lib/shopifySessionCookie";
import {
  normalizeShopDomain,
} from "./services/shopifyConnectionService";
import { shopifyGraphQL } from "./services/shopifyAdminService";

const embeddedAppRoutes = [
  "/",
  "/app",
  "/app/onboarding",
  "/app/dashboard",
  "/app/fraud-intelligence",
  "/app/competitor-intelligence",
  "/app/ai-pricing-engine",
  "/app/billing",
  "/app/settings",
  "/dashboard",
  "/onboarding",
  "/modules/fraud",
  "/modules/competitor",
  "/modules/pricing",
  "/trust-abuse",
  "/competitor",
  "/pricing-profit",
  "/settings",
  "/subscription",
  "/fraud",
  "/pricing",
  "/profit",
  "/credit-score",
];

export function createApp() {
  const app = express();
  app.set("trust proxy", 1);
  const frontendDistPath = path.resolve(__dirname, "../../frontend/dist");
  const frontendIndexPath = path.join(frontendDistPath, "index.html");

  morgan.token("request-id", (req) =>
    (req as typeof req & { requestId?: string }).requestId ?? "-"
  );

  app.use(
    helmet({
      frameguard: false,
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          frameAncestors: [
            "https://admin.shopify.com",
            "https://*.myshopify.com",
          ],
          scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.shopify.com"],
          styleSrc: ["'self'", "'unsafe-inline'", "https://cdn.shopify.com"],
        },
      },
    })
  );

  const allowedCorsOrigins = [
    "https://admin.shopify.com",
    env.shopifyAppUrl,
  ].filter(Boolean);

  app.use(
    cors({
      origin: (origin, callback) => {
        // Same-origin requests (no Origin header, e.g. curl/server-to-server)
        // and the app's own frontend are always allowed. Only Shopify admin
        // and this app's own domain may make credentialed cross-origin calls.
        if (!origin) {
          return callback(null, true);
        }
        if (
          allowedCorsOrigins.includes(origin) ||
          /^https:\/\/[a-z0-9-]+\.myshopify\.com$/i.test(origin)
        ) {
          return callback(null, true);
        }
        return callback(new Error("Not allowed by CORS"));
      },
      credentials: true,
    })
  );

  // Absolute-first middleware: log every inbound HTTP request before any
  // business logic runs. This is the safety net for "zero trace" incidents —
  // if a request reaches Node but is never processed (middleware crash, async
  // error before logger), this entry still appears in Render's log stream.
  app.use((req, _res, next) => {
    logEvent("info", "http.request_received", {
      method: req.method,
      path: req.path,
      ip: req.ip,
    });
    next();
  });

  app.use(attachRequestContext);
  app.use(morgan(":method :url :status :response-time ms req_id=:request-id"));
  app.use("/webhooks/shopify", express.raw({ type: "application/json" }));
  app.use("/webhooks/shopify", shopifyWebhookRouter);
  app.use(express.json());
  app.use(cookieParser());

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.use(
    express.static(frontendDistPath, {
      index: false,
    })
  );

  app.get("/auth", (req, res) => {
    const shop = normalizeShopDomain(
      (req.query.shop as string | undefined) ?? readShopifySessionCookie(req)
    );

    if (!shop) {
      return res.status(400).send("Missing shop");
    }

    const redirectUrl = new URL("/auth/reconnect", env.shopifyAppUrl);
    redirectUrl.searchParams.set("shop", shop);
    const host =
      typeof req.query.host === "string" && req.query.host
        ? req.query.host
        : undefined;
    if (host) {
      redirectUrl.searchParams.set("host", host);
    }
    if (typeof req.query.returnTo === "string" && req.query.returnTo.startsWith("/")) {
      redirectUrl.searchParams.set("returnTo", req.query.returnTo);
    }

    return res.redirect(redirectUrl.toString());
  });

  app.get("/products", async (req, res) => {
    try {
      const shop = normalizeShopDomain(req.query.shop as string | undefined);

      if (!shop) {
        return res.status(400).send("Missing shop");
      }

      const data = await shopifyGraphQL<{
        products: {
          edges: Array<{
            node: {
              id: string;
              handle: string;
              title: string;
            };
          }>;
        };
      }>(
        shop,
        `
          query EmbeddedProducts {
            products(first: 20, sortKey: UPDATED_AT, reverse: true) {
              edges {
                node {
                  id
                  handle
                  title
                }
              }
            }
          }
        `
      );

      return res.status(200).json(data);
    } catch (err) {
      return res.status(500).send("Error fetching products");
    }
  });

  app.use(router);

  app.get(embeddedAppRoutes, async (req, res, next) => {
    try {
      const shop = normalizeShopDomain(
        (req.query.shop as string | undefined) ?? readShopifySessionCookie(req)
      );

      if (shop) {
        if (env.enableGuidedBootstrap) {
          await ensureStoreBootstrapped(shop);
        }
        setShopifySessionCookie(res, shop);
      }

      return res.sendFile(frontendIndexPath);
    } catch (err) {
      return next(err);
    }
  });

  app.use(errorHandler);

  return app;
}

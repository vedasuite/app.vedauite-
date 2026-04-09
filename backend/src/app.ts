import "express-async-errors";
import path from "path";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import cookieParser from "cookie-parser";

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
  getConnectionHealth,
  normalizeShopDomain,
} from "./services/shopifyConnectionService";
import { shopifyGraphQL } from "./services/shopifyAdminService";

const embeddedAppRoutes = [
  "/",
  "/onboarding",
  "/trust-abuse",
  "/competitor",
  "/pricing-profit",
  "/reports",
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
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          frameAncestors: [
            "https://admin.shopify.com",
            "https://*.myshopify.com",
          ],
          scriptSrc: ["'self'", "'unsafe-inline'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
        },
      },
    })
  );

  app.use(
    cors({
      origin: true,
      credentials: true,
    })
  );

  app.use(attachRequestContext);
  app.use(morgan(":method :url :status :response-time ms req_id=:request-id"));
  app.use("/webhooks/shopify", express.raw({ type: "application/json" }));
  app.use("/webhooks/shopify", shopifyWebhookRouter);
  app.use(express.json());
  app.use(cookieParser());

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  function redirectTopLevel(res: express.Response, url: string) {
    return res
      .status(200)
      .type("html")
      .send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Redirecting…</title>
  </head>
  <body>
    <script>
      (function () {
        var target = ${JSON.stringify(url)};
        if (window.top && window.top !== window) {
          window.top.location.href = target;
          return;
        }
        window.location.href = target;
      })();
    </script>
    <p>Redirecting… <a href="${url}">Continue</a></p>
  </body>
</html>`);
  }

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

      if (!shop) {
        return res.status(400).send("Missing shop");
      }

      const connectionHealth = await getConnectionHealth(shop, { probeApi: false });

      if (!connectionHealth.installationFound || !connectionHealth.hasOfflineToken) {
        const reconnectUrl = new URL("/auth", env.shopifyAppUrl);
        reconnectUrl.searchParams.set("shop", shop);
        reconnectUrl.searchParams.set("returnTo", req.path);
        if (typeof req.query.host === "string" && req.query.host) {
          reconnectUrl.searchParams.set("host", req.query.host);
        }

        return redirectTopLevel(res, reconnectUrl.toString());
      }

      if (env.enableDemoBootstrap) {
        await ensureStoreBootstrapped(shop);
      }

      setShopifySessionCookie(res, shop);

      return res.sendFile(frontendIndexPath);
    } catch (err) {
      return next(err);
    }
  });

  app.use(errorHandler);

  return app;
}

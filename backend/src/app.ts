import "express-async-errors";
import path from "path";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import cookieParser from "cookie-parser";

import { errorHandler } from "./middleware/errorHandler";
import { attachRequestContext } from "./middleware/requestContext";
import { getToken } from "./db/store";
import { router } from "./routes";
import { shopifyWebhookRouter } from "./routes/shopifyWebhookRoutes";
import { ensureStoreBootstrapped } from "./services/bootstrapService";

const embeddedAppRoutes = [
  "/",
  "/fraud",
  "/competitor",
  "/pricing",
  "/profit",
  "/credit-score",
  "/reports",
  "/settings",
  "/subscription",
];

export function createApp() {
  const app = express();
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
    const shop = req.query.shop as string | undefined;

    if (!shop) {
      return res.status(400).send("Missing shop");
    }

    return res.redirect(`/auth/install?shop=${encodeURIComponent(shop)}`);
  });

  app.get("/products", async (req, res) => {
    try {
      const shop = req.query.shop as string;

      if (!shop) {
        return res.status(400).send("Missing shop");
      }

      const token = await getToken(shop);

      if (!token) {
        return res.status(400).send("No token found");
      }

      const response = await fetch(
        `https://${shop}/admin/api/2024-01/products.json`,
        {
          headers: {
            "X-Shopify-Access-Token": token,
            "Content-Type": "application/json",
          },
        }
      );

      const data = await response.json();
      return res.status(response.status).json(data);
    } catch (err) {
      return res.status(500).send("Error fetching products");
    }
  });

  app.use(router);

  app.get(embeddedAppRoutes, async (req, res, next) => {
    try {
      const shop = req.query.shop as string | undefined;

      if (!shop) {
        return res.status(400).send("Missing shop");
      }

      const token = await getToken(shop);

      if (!token) {
        return redirectTopLevel(
          res,
          `/auth?shop=${encodeURIComponent(shop)}`
        );
      }

      await ensureStoreBootstrapped(shop);

      return res.sendFile(frontendIndexPath);
    } catch (err) {
      return next(err);
    }
  });

  app.use(errorHandler);

  return app;
}

import { createApp } from "./app";
import { env } from "./config/env";
import { prisma } from "./db/prismaClient";
import { startDataRetentionSweep } from "./services/dataRetentionService";
import { logEvent } from "./services/observabilityService";

// Catch anything that escaped Express's async error handler.  Without these,
// an unhandled rejection (e.g. Prisma connection error on a cold-start query)
// kills the process with zero log output — which is exactly the "zero trace"
// symptom observed when Shopify's callback found the server unreachable.
process.on("uncaughtException", (err) => {
  logEvent("error", "process.uncaught_exception", { error: err });
  // eslint-disable-next-line no-console
  console.error("[fatal] uncaughtException — process will exit", err);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  logEvent("error", "process.unhandled_rejection", { reason });
  // eslint-disable-next-line no-console
  console.error("[fatal] unhandledRejection", reason);
});

async function startServer() {
  // Validate the database connection at startup.  If the Postgres instance is
  // sleeping (Neon free tier auto-suspends after 5 min) or credentials are
  // wrong, fail fast with a clear log rather than letting the first real
  // request hit the error and potentially crash the process silently.
  try {
    await prisma.$connect();
    logEvent("info", "db.connected", { url: env.databaseUrl.replace(/:[^:@]+@/, ":***@") });
  } catch (err) {
    logEvent("error", "db.connect_failed", { error: err });
    // eslint-disable-next-line no-console
    console.error("[fatal] Database connection failed at startup", err);
    process.exit(1);
  }

  const app = createApp();

  // Backstop for shop/redact webhooks that never arrive, so a bounded retention
  // period holds even when Shopify's deletion signal is missed.
  startDataRetentionSweep();

  app.listen(env.port, () => {
    logEvent("info", "server.started", { port: env.port });
    // eslint-disable-next-line no-console
    console.log(`VedaSuite backend listening on port ${env.port}`);
  });
}

void startServer();


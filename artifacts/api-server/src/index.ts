import app from "./app";
import { logger } from "./lib/logger";
import { setupMessengerWebSocket } from "./lib/messenger-ws";
import { scheduleVendorLinkBackfillIfNeeded } from "./lib/vendor-link-backfill";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const server = app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  scheduleVendorLinkBackfillIfNeeded();
});

setupMessengerWebSocket(server);

function shutdown(signal: string) {
  logger.info({ signal }, "Received shutdown signal, closing server");
  server.close(() => {
    logger.info("HTTP server closed");
    process.exit(0);
  });
  setTimeout(() => {
    logger.warn("Graceful shutdown timed out, forcing exit");
    process.exit(0);
  }, 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

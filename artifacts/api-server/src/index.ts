import app from "./app";
import { logger } from "./lib/logger";
import { setupMessengerWebSocket } from "./lib/messenger-ws";
import { scheduleVendorLinkBackfillIfNeeded } from "./lib/vendor-link-backfill";
import { ensureDbConstraints } from "./lib/db-constraints";
import {
  ensureLegacyCaseMediaTable,
  backfillLegacyCaseMedia,
  startDailyOrphanedMediaCleanup,
} from "./lib/case-media";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

// ── Production security pre-flight ──────────────────────────────────────────
// PLATFORM_ADMIN_PIN must be explicitly configured before the server is allowed
// to start in production. Falling back to "0000" would let anyone bypass the
// admin PIN gate on a fresh deployment.
if (process.env.NODE_ENV === "production") {
  const adminPin = process.env.PLATFORM_ADMIN_PIN;
  if (!adminPin) {
    process.stderr.write(
      "[startup] FATAL: PLATFORM_ADMIN_PIN is not set.\n" +
      "[startup] The server refuses to start in production without an admin PIN.\n" +
      "[startup] Add PLATFORM_ADMIN_PIN to your Replit environment secrets and restart.\n",
    );
    process.exit(1);
  }
  if (adminPin === "0000") {
    process.stderr.write(
      "[startup] FATAL: PLATFORM_ADMIN_PIN is set to the insecure default '0000'.\n" +
      "[startup] Choose a unique PIN and update PLATFORM_ADMIN_PIN in your Replit secrets.\n",
    );
    process.exit(1);
  }
}

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// Start the HTTP listener IMMEDIATELY so the platform's port-open health
// check passes inside the 60s deploy window. DB constraint setup is a
// background safety-net task — it must never gate the listener. Previously
// a slow Neon cold-start on the constraint DDL caused the entire deploy to
// SIGKILL at 60s before the port ever opened.
const server = app.listen(port, (err) => {
  if (err) {
    process.stderr.write(`[startup] listen FAILED: ${err.message}\n`);
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  process.stderr.write(`[startup] server listening on port ${port}\n`);
  logger.info({ port }, "Server listening");
  scheduleVendorLinkBackfillIfNeeded();
  startDailyOrphanedMediaCleanup();

  // Fire-and-forget DB constraint installation. Logs loudly on failure
  // but does NOT crash the process — the app worked for months without
  // this trigger, and a slow/unreachable DB at boot must not take the
  // whole service down.
  ensureDbConstraints().catch((err) => {
    process.stderr.write(
      `[startup] DB constraint setup failed (server still running): ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
    logger.error(
      { err },
      "DB constraint setup failed — server is running but invoice_line_items integrity trigger is NOT installed",
    );
  });

  // Fire-and-forget: ensure the legacy_case_media ledger table exists, then
  // backfill it from existing lab_cases and recover any legacy media files a
  // prior orphan-cleanup moved to .trash/. Restores blank legacy-case photos
  // on deploy with no manual migration. Never gates the listener or crashes.
  ensureLegacyCaseMediaTable()
    .then(() => backfillLegacyCaseMedia())
    .then((r) =>
      logger.info(r, "legacy_case_media: ensure + backfill complete"),
    )
    .catch((err) => {
      process.stderr.write(
        `[startup] legacy_case_media ensure/backfill failed (server still running): ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
      logger.error(
        { err },
        "legacy_case_media ensure/backfill failed — legacy-case photos may remain blank until next successful run",
      );
    });
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


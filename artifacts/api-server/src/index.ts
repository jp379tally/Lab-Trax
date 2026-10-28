import app from "./app";
import { logger } from "./lib/logger";
import { scheduleVendorLinkBackfillIfNeeded } from "./lib/vendor-link-backfill";
import { scheduleLabInboxStorageRepair } from "./lib/lab-inbox-storage-repair";
import { scheduleExpectedDeliveryDateBackfillIfNeeded } from "./lib/expected-delivery-date-backfill";
import { scheduleRemovableRestorationCollapseBackfillIfNeeded } from "./lib/removable-restoration-collapse-backfill";
import { ensureStartupDbConstraints } from "./lib/db-constraints";
import { restartScheduledBackupJob } from "./lib/backup";
import { migrateDraftInvoicesToOpen } from "./lib/migrate-draft-invoices";
import { migrateInvoiceIssuedAt } from "./lib/migrate-invoice-issued-at";
import {
  ensureLegacyCaseMediaTable,
  backfillLegacyCaseMedia,
} from "./lib/case-media";
import {
  ensureLabCaseProjection,
  scheduleLabCaseProjectionBackfillIfNeeded,
} from "./lib/lab-case-projection";
import { attachCaseEventsWebSocketServer } from "./lib/case-events-ws";
import { scheduleRecentCaseInvoiceRepair } from "./lib/ai-intake-invoice-repair";
import { registerHistoricalStartupJobs } from "./lib/startup-maintenance";
import { ensureBackupLiveStatusSchema } from "./lib/backup-live-status-store";
import { ensureProductionMediaJournalSchema } from "./lib/production-media-journal";
import { startBackupCloudStageCleanup } from "./lib/backup-cloud-staging";

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
  attachCaseEventsWebSocketServer(server);
  ensureBackupLiveStatusSchema().catch((err) => {
    process.stderr.write(
      `[startup] backup live-status schema setup failed (server still running): ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
    logger.error(
      { err },
      "Backup live-status schema setup failed — existing backup status metadata was not removed",
    );
  });
  const historicalMaintenance = registerHistoricalStartupJobs([
    { name: "vendor transaction linking", schedule: scheduleVendorLinkBackfillIfNeeded },
    { name: "lab inbox storage normalization", schedule: scheduleLabInboxStorageRepair },
    { name: "expected delivery date clearing", schedule: scheduleExpectedDeliveryDateBackfillIfNeeded },
    { name: "removable restoration collapse", schedule: scheduleRemovableRestorationCollapseBackfillIfNeeded },
    { name: "recent case invoice reconstruction", schedule: scheduleRecentCaseInvoiceRepair },
    {
      name: "legacy draft invoice conversion",
      schedule: () => {
        void migrateDraftInvoicesToOpen().catch((err) => {
          process.stderr.write(
            `[startup] draft-invoice migration failed (server still running): ${
              err instanceof Error ? err.message : String(err)
            }\n`,
          );
          logger.error({ err }, "migrate-draft-invoices failed");
        });
      },
    },
    {
      name: "historical invoice issue-date fill",
      schedule: () => {
        void migrateInvoiceIssuedAt().catch((err) => {
          process.stderr.write(
            `[startup] invoice issued_at migration failed (server still running): ${
              err instanceof Error ? err.message : String(err)
            }\n`,
          );
          logger.error({ err }, "migrate-invoice-issued-at failed");
        });
      },
    },
    {
      name: "legacy case media ledger repair and trash restoration",
      schedule: () => {
        void backfillLegacyCaseMedia().catch((err) => {
          process.stderr.write(
            `[startup] legacy_case_media backfill failed (server still running): ${
              err instanceof Error ? err.message : String(err)
            }\n`,
          );
          logger.error({ err }, "legacy_case_media backfill failed");
        });
      },
    },
  ]);
  if (historicalMaintenance.deferred.length > 0) {
    logger.warn(
      { jobs: historicalMaintenance.deferred, nodeEnv: process.env.NODE_ENV ?? null },
      "Historical startup maintenance deferred; production and ambiguous environments do not rewrite existing records or media",
    );
  }

  // Open the listener promptly, but never let a catch-up backup's pg_dump
  // acquire table locks before startup finishes installing integrity guards.
  ensureStartupDbConstraints().then(async () => {
    await ensureBackupLiveStatusSchema();
    await ensureProductionMediaJournalSchema();
    startBackupCloudStageCleanup();
    await restartScheduledBackupJob();
  }).catch((err) => {
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

  // Fire-and-forget: install the legacy-case list projection (columns,
  // trigger, list indexes) and then backfill rows written before it existed.
  // Both lists fall back to parsing `case_data` for any row without a current
  // projection, so a failure here costs speed, never correctness.
  ensureLabCaseProjection()
    .then((installed) => {
      logger.info(
        { installed },
        installed
          ? "lab_cases projection: installed current columns, triggers and indexes"
          : "lab_cases projection: database already has current or newer rules",
      );
      scheduleLabCaseProjectionBackfillIfNeeded();
    })
    .catch((err) => {
      process.stderr.write(
        `[startup] lab_cases projection setup failed (server still running): ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
      logger.error(
        { err },
        "lab_cases projection setup failed — case lists still work but fall back to parsing case_data",
      );
    });

  // This additive table/index setup is safe to run during startup. The
  // historical backfill and trash restoration are separately deferred above.
  ensureLegacyCaseMediaTable()
    .then(() => logger.info("legacy_case_media: additive table/index setup complete"))
    .catch((err) => {
      process.stderr.write(
        `[startup] legacy_case_media additive table/index setup failed (server still running): ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
      logger.error(
        { err },
        "legacy_case_media additive setup failed — the existing media references and files were not changed",
      );
    });
});

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


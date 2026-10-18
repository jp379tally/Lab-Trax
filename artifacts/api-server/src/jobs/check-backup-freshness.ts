/**
 * Out-of-process backup freshness check.
 *
 * Why this exists as its own process: the watchdog that should have caught
 * the eighteen-day backup outage (`checkAndAlertBackupStaleness`, and the
 * off-site monitor beside it) runs inside the API server, on a timer owned by
 * that server. A watchdog hosted by the process it is watching cannot report
 * that process being dead, crash-looping, or never having reached a tick —
 * which is exactly what happened. Nothing was sent because nothing ran.
 *
 * This entry point asks the same question from outside: it reads the newest
 * archive directly out of the OneDrive folder and alerts when that archive is
 * older than a multiple of the configured cadence. It needs the database (to
 * find admins, raise in-app alerts, and hold its own rate-limit row) and SMTP,
 * but it does not need the API server to be running.
 *
 * Wire it up as a Replit Scheduled Deployment, hourly:
 *   build: pnpm install && pnpm --filter @workspace/api-server run build
 *   run:   pnpm --filter @workspace/api-server run check-backup-freshness
 *
 * Publishing that deployment is a human step (an agent cannot click Publish),
 * and until it exists an API outage still silences every automatic freshness
 * alarm. The runbook — how to switch it on, how to verify it with the API
 * server stopped, and what each exit code means — is in
 * docs/backup-freshness-watchdog.md.
 *
 * Required environment: the same DATABASE_URL, SMTP_*, and OneDrive connector
 * variables the API server uses. Deployments set REPLIT_DEPLOYMENT=1, which is
 * what selects the lab's real backup folder; anywhere else this inspects the
 * non-production subfolder instead (dev and production share one OneDrive
 * account, and a dev run must never judge — or prune — the real archives).
 *
 * Exit codes:
 *   0  a recent archive is confirmed present off-site (or protection is off)
 *   1  the check itself could not run
 *   2  no recent archive — admins were alerted (or were alerted very recently)
 *   3  no recent archive — the alert could not be delivered
 */

import { pool } from "@workspace/db";
import { runBackupFreshnessCheck } from "../lib/backup.js";
import { getOneDriveBackupFolder } from "../lib/onedrive.js";

const EXIT_OK = 0;
const EXIT_CHECK_FAILED = 1;
const EXIT_STALE_ALERTED = 2;
const EXIT_STALE_NOT_ALERTED = 3;

const LABEL = "[backup-freshness]";

function info(message: string): void {
  console.log(`${LABEL} ${message}`);
}

function problem(message: string): void {
  console.error(`${LABEL} ${message}`);
}

async function main(): Promise<number> {
  info(`Inspecting OneDrive folder: ${getOneDriveBackupFolder()}`);

  const result = await runBackupFreshnessCheck();
  const { freshness } = result;

  if (!result.enabled) {
    info("Off-site backup protection is switched off; nothing to check.");
    return EXIT_OK;
  }

  if (freshness.newestArchive) {
    info(
      `Newest archive: ${freshness.newestArchive.name} ` +
        `(${freshness.newestArchive.sizeBytes} bytes, ${freshness.newestArchive.ageMinutes} minutes old). ` +
        `Expected at least one every ${freshness.intervalMinutes} minutes; ` +
        `alerting past ${freshness.windowMinutes}.`,
    );
  } else if (freshness.listingError) {
    problem(`The OneDrive folder could not be listed: ${freshness.listingError}`);
  } else {
    problem("The OneDrive folder holds no usable backup archive.");
  }

  if (result.ok) {
    info("Off-site protection is healthy.");
    return EXIT_OK;
  }

  problem(freshness.reason ?? "Off-site backup protection has stopped working.");

  if (result.alertError !== null) {
    problem(`The alert could not be delivered: ${result.alertError}`);
    return EXIT_STALE_NOT_ALERTED;
  }
  if (result.alerted) {
    info("Admins were alerted in-app and by email.");
  } else if (result.alertSuppressed) {
    info("An alert for this outage already went out recently; not repeating it.");
  }
  return EXIT_STALE_ALERTED;
}

let exitCode = EXIT_CHECK_FAILED;
try {
  exitCode = await main();
} catch (err: unknown) {
  problem(
    `The freshness check could not run: ${err instanceof Error ? err.message : String(err)}`,
  );
  exitCode = EXIT_CHECK_FAILED;
} finally {
  await pool.end().catch(() => undefined);
}
process.exit(exitCode);

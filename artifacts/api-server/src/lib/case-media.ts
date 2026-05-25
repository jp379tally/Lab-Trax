import * as fs from "node:fs";
import { promises as fsp } from "node:fs";
import * as path from "node:path";
import { and, eq, lt, sql } from "drizzle-orm";
import { db, caseAttachments, mediaCleanupRuns, systemSettings, users } from "@workspace/db";
import { logger } from "./logger";
import { sendCleanupAlertEmail, sendCleanupRecoveryAlertEmail } from "./mail";
import { filterEmailsByPref } from "./email-prefs";

/**
 * Thrown by runAndPersistCleanup when a concurrent run is already in
 * progress (i.e. the DB unique constraint on status='running' fires).
 */
export class CleanupAlreadyRunningError extends Error {
  constructor() {
    super("Cleanup already in progress.");
    this.name = "CleanupAlreadyRunningError";
  }
}

/**
 * Thrown internally when a cancel has been requested via cancelCleanup().
 */
export class CleanupCancelledError extends Error {
  constructor() {
    super("Cleanup run cancelled by admin.");
    this.name = "CleanupCancelledError";
  }
}

let _cancelRequested = false;

/**
 * Signal the currently-running cleanup to abort at its next checkpoint.
 * No-op if no cleanup is running.
 */
export function cancelCleanup(): void {
  _cancelRequested = true;
}

function resetCancelFlag(): void {
  _cancelRequested = false;
}

function checkCancellation(): void {
  if (_cancelRequested) {
    throw new CleanupCancelledError();
  }
}


/**
 * Stages emitted while a cleanup run is in progress.
 * "idle" means no cleanup is currently running.
 */
export type CleanupStage =
  | "idle"
  | "scanning"
  | "checking-references"
  | "removing"
  | "finishing";

export interface CleanupProgress {
  stage: CleanupStage;
  scannedFiles?: number;
  orphanCount?: number;
}

let _currentProgress: CleanupProgress = { stage: "idle" };

export function getCleanupProgress(): CleanupProgress {
  return { ..._currentProgress };
}

function setCleanupProgress(progress: CleanupProgress): void {
  _currentProgress = progress;
}

/**
 * Keys used in the system_settings table for cleanup alert thresholds.
 */
export const SETTING_CLEANUP_MIN_REMOVED = "cleanup_alert_min_removed";
export const SETTING_CLEANUP_MIN_FREED_MB = "cleanup_alert_min_freed_mb";

/**
 * Key used in the system_settings table for the crash-recovery timeout
 * (minutes).  When absent the env var CLEANUP_STUCK_TIMEOUT_MINUTES is used
 * (default 30).
 */
export const SETTING_CLEANUP_STUCK_TIMEOUT_MINUTES =
  "cleanup_stuck_timeout_minutes";

/**
 * Key used in the system_settings table for the cleanup history retention
 * period (days).  When absent the env var CLEANUP_HISTORY_RETENTION_DAYS is
 * used (default 365).
 */
export const SETTING_CLEANUP_HISTORY_RETENTION_DAYS =
  "cleanup_history_retention_days";

/**
 * Read the cleanup-history retention window from the DB, falling back to the
 * CLEANUP_HISTORY_RETENTION_DAYS env var (default 365).
 */
export async function getCleanupHistoryRetentionDays(): Promise<{
  retentionDays: number;
  dbRetentionDays: number | null;
  envRetentionDays: number;
}> {
  const envRetentionDays =
    Math.max(1, parseInt(process.env.CLEANUP_HISTORY_RETENTION_DAYS || "365", 10) || 365);
  const rows = await db
    .select()
    .from(systemSettings)
    .where(eq(systemSettings.key, SETTING_CLEANUP_HISTORY_RETENTION_DAYS));
  const raw = rows[0]?.value ?? null;
  const dbRetentionDays = raw !== null ? Math.max(1, parseInt(raw, 10) || 1) : null;
  const retentionDays = dbRetentionDays !== null ? dbRetentionDays : envRetentionDays;
  return { retentionDays, dbRetentionDays, envRetentionDays };
}

/**
 * Read cleanup alert thresholds from the DB, falling back to env vars if no
 * DB value is set.
 */
export async function getCleanupAlertThresholds(): Promise<{
  minRemoved: number;
  minFreedMb: number;
}> {
  const rows = await db
    .select()
    .from(systemSettings)
    .where(
      sql`${systemSettings.key} in (${SETTING_CLEANUP_MIN_REMOVED}, ${SETTING_CLEANUP_MIN_FREED_MB})`,
    );

  const minRemovedRaw = rows.find((r) => r.key === SETTING_CLEANUP_MIN_REMOVED)?.value ?? null;
  const minFreedMbRaw = rows.find((r) => r.key === SETTING_CLEANUP_MIN_FREED_MB)?.value ?? null;

  const minRemoved = Math.max(
    1,
    minRemovedRaw !== null
      ? parseInt(minRemovedRaw, 10) || 1
      : parseInt(process.env.CLEANUP_ALERT_MIN_REMOVED || "1", 10) || 1,
  );
  const minFreedMb =
    minFreedMbRaw !== null
      ? parseFloat(minFreedMbRaw) || 0
      : parseFloat(process.env.CLEANUP_ALERT_MIN_FREED_MB || "0") || 0;

  return { minRemoved, minFreedMb };
}

/**
 * Default timeout (minutes) after which a "running" cleanup row is considered
 * stuck and eligible for recovery.  Override with the
 * CLEANUP_STUCK_TIMEOUT_MINUTES env var or the system_settings DB row.
 */
const DEFAULT_STUCK_TIMEOUT_MINUTES = 30;

/**
 * Read the crash-recovery stuck-run timeout from the DB, falling back to the
 * CLEANUP_STUCK_TIMEOUT_MINUTES env var (default 30).  DB value takes
 * precedence so changes take effect without a server restart.
 */
export async function getCleanupStuckTimeoutMinutes(): Promise<{
  stuckTimeoutMinutes: number;
  dbStuckTimeoutMinutes: number | null;
  envStuckTimeoutMinutes: number;
}> {
  const envStuckTimeoutMinutes = Math.max(
    1,
    parseInt(
      process.env.CLEANUP_STUCK_TIMEOUT_MINUTES || String(DEFAULT_STUCK_TIMEOUT_MINUTES),
      10,
    ) || DEFAULT_STUCK_TIMEOUT_MINUTES,
  );
  const rows = await db
    .select()
    .from(systemSettings)
    .where(eq(systemSettings.key, SETTING_CLEANUP_STUCK_TIMEOUT_MINUTES));
  const raw = rows[0]?.value ?? null;
  const dbStuckTimeoutMinutes =
    raw !== null ? Math.max(1, parseInt(raw, 10) || 1) : null;
  const stuckTimeoutMinutes =
    dbStuckTimeoutMinutes !== null ? dbStuckTimeoutMinutes : envStuckTimeoutMinutes;
  return { stuckTimeoutMinutes, dbStuckTimeoutMinutes, envStuckTimeoutMinutes };
}

/**
 * Mark any `media_cleanup_runs` rows that are still in status="running" but
 * were started more than `timeoutMinutes` ago as status="error".  This
 * recovers rows that were never finalised because the server crashed mid-run.
 *
 * Safe to call concurrently — the partial unique index on status='running'
 * means at most one row can be in that state at a time, so the UPDATE will
 * affect at most one row.
 *
 * Returns the number of rows recovered.
 */
export async function recoverStuckCleanupRuns(
  timeoutMinutes?: number,
): Promise<number> {
  const minutes =
    timeoutMinutes !== undefined
      ? timeoutMinutes
      : (await getCleanupStuckTimeoutMinutes()).stuckTimeoutMinutes;
  const cutoff = new Date(Date.now() - minutes * 60 * 1000);
  const updated = await db
    .update(mediaCleanupRuns)
    .set({
      status: "error",
      errorMessage: "Run interrupted — server restarted",
      finishedAt: new Date(),
    })
    .where(
      and(
        eq(mediaCleanupRuns.status, "running"),
        lt(mediaCleanupRuns.startedAt, cutoff),
      ),
    )
    .returning({ id: mediaCleanupRuns.id });
  return updated.length;
}

export const caseMediaDir = path.resolve(
  process.cwd(),
  "uploads",
  "case-media",
);

/**
 * A `case_attachments.storageKey` is typically the public URL the file was
 * uploaded to (e.g. `https://host/uploads/case-media/<filename>`), but legacy
 * rows may also be a bare filename or a relative path. Extract just the
 * basename of the underlying file inside `uploads/case-media/`.
 *
 * Returns `null` if the storageKey does not look like it points into our
 * media directory (e.g. an external URL).
 */
export function extractMediaFileName(storageKey: string): string | null {
  const markers = ["/uploads/case-media/", "/api/cases/attachment-file/"];
  let fileName: string | null = null;
  for (const marker of markers) {
    const idx = storageKey.indexOf(marker);
    if (idx >= 0) {
      fileName = storageKey.slice(idx + marker.length).split(/[?#]/)[0] ?? null;
      break;
    }
  }
  if (fileName === null && !/^[a-z][a-z0-9+.-]*:\/\//i.test(storageKey)) {
    fileName = path.basename(storageKey);
  }
  if (!fileName) return null;
  try {
    fileName = decodeURIComponent(fileName);
  } catch {
    // leave as-is if not URL-encoded
  }
  fileName = path.basename(fileName);
  return fileName || null;
}

export interface OrphanedMediaReport {
  dryRun: boolean;
  mediaDirExists: boolean;
  scannedFiles: number;
  referencedFiles: number;
  orphanCount: number;
  removedCount: number;
  freedBytes: number;
  /** Up to `sampleLimit` orphan filenames (full list omitted to keep responses small). */
  sample: string[];
  errors: Array<{ fileName: string; error: string }>;
}

export interface CleanupOptions {
  dryRun: boolean;
  /** Trim the sample list returned in the report. Default 50. */
  sampleLimit?: number;
}

/**
 * Find every file under `uploads/case-media/` whose name is not referenced by
 * any `case_attachments.storageKey`. When `dryRun` is false, the orphan files
 * are deleted. Either way, a structured report is returned.
 *
 * Safe to call concurrently with uploads — files added after the directory
 * scan are not in the orphan list, and deletion is best-effort.
 */
export async function cleanupOrphanedCaseMedia(
  opts: CleanupOptions,
): Promise<OrphanedMediaReport> {
  const sampleLimit = opts.sampleLimit ?? 50;

  const report: OrphanedMediaReport = {
    dryRun: opts.dryRun,
    mediaDirExists: false,
    scannedFiles: 0,
    referencedFiles: 0,
    orphanCount: 0,
    removedCount: 0,
    freedBytes: 0,
    sample: [],
    errors: [],
  };

  checkCancellation();
  setCleanupProgress({ stage: "scanning" });

  // Use async fs operations throughout so the event loop is never blocked and
  // cancel requests from the HTTP endpoint can be processed between awaits.
  let dirExists = false;
  try {
    await fsp.access(caseMediaDir);
    dirExists = true;
  } catch {
    // directory doesn't exist
  }

  if (!dirExists) {
    return report;
  }
  report.mediaDirExists = true;

  const dirEntries = await fsp.readdir(caseMediaDir, { withFileTypes: true });
  const filesOnDisk = dirEntries
    .filter((e) => e.isFile())
    .map((e) => e.name);
  report.scannedFiles = filesOnDisk.length;

  checkCancellation();

  setCleanupProgress({ stage: "checking-references", scannedFiles: report.scannedFiles });

  const rows = await db
    .select({ storageKey: caseAttachments.storageKey })
    .from(caseAttachments);

  const referenced = new Set<string>();
  for (const row of rows) {
    const name = extractMediaFileName(row.storageKey);
    if (name) referenced.add(name);
  }
  report.referencedFiles = referenced.size;

  checkCancellation();

  const orphanCount = filesOnDisk.filter((f) => !referenced.has(f)).length;
  setCleanupProgress({ stage: "removing", scannedFiles: report.scannedFiles, orphanCount });

  for (const fileName of filesOnDisk) {
    // Check for cancellation on every iteration so the loop can be aborted
    // promptly — the async stat/rm below yield the event loop between files,
    // allowing the cancel HTTP request to be processed in between.
    checkCancellation();

    if (referenced.has(fileName)) continue;
    report.orphanCount += 1;
    if (report.sample.length < sampleLimit) {
      report.sample.push(fileName);
    }

    const resolved = path.resolve(caseMediaDir, fileName);
    if (
      resolved === caseMediaDir ||
      !(resolved + path.sep).startsWith(caseMediaDir + path.sep)
    ) {
      // Defensive — shouldn't happen because we read from this dir.
      continue;
    }

    let size = 0;
    try {
      const stat = await fsp.stat(resolved);
      size = stat.size;
    } catch {
      // file may have been removed between readdir and stat
      continue;
    }

    if (opts.dryRun) {
      report.freedBytes += size;
      continue;
    }

    // Move orphan file to a trash folder instead of unlinking, so an
    // operator can recover from a false-positive cleanup. The nightly
    // cleanup job is responsible for eventually pruning .trash/ contents
    // older than the retention window.
    try {
      const trashDir = path.resolve(caseMediaDir, ".trash");
      await fsp.mkdir(trashDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const trashedName = `${stamp}__${fileName}`;
      await fsp.rename(resolved, path.resolve(trashDir, trashedName));
      report.removedCount += 1;
      report.freedBytes += size;
    } catch (err: unknown) {
      report.errors.push({
        fileName,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return report;
}

/**
 * Key used in the system_settings table for the nightly cleanup hour (0–23 UTC).
 * When absent the env var CLEANUP_HOUR_UTC is used (default 8).
 */
export const SETTING_CLEANUP_HOUR_UTC = "cleanup_hour_utc";

/**
 * Read the nightly cleanup hour from the DB, falling back to the
 * CLEANUP_HOUR_UTC env var (default 8).
 */
export async function getCleanupHourUtc(): Promise<number> {
  const envHour = Math.max(
    0,
    Math.min(23, parseInt(process.env.CLEANUP_HOUR_UTC || "8", 10) || 8),
  );
  try {
    const rows = await db
      .select()
      .from(systemSettings)
      .where(eq(systemSettings.key, SETTING_CLEANUP_HOUR_UTC));
    const raw = rows[0]?.value ?? null;
    if (raw !== null) {
      const parsed = parseInt(raw, 10);
      if (Number.isFinite(parsed)) {
        return Math.max(0, Math.min(23, parsed));
      }
    }
  } catch {
    // fall through to env default
  }
  return envHour;
}

// ── Daily orphaned-media cleanup scheduler ──────────────────────────────────
// Mirrors the daily OneDrive backup scheduler in lib/backup.ts. Runs once per
// day at the configured UTC hour (default 08:00 UTC, an hour after the
// backup so we don't compete for IO). Override with CLEANUP_HOUR_UTC env var
// or the cleanup_hour_utc system_settings row.

let scheduled = false;

function msUntilNext(hourUtc: number): number {
  const now = new Date();
  const next = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      hourUtc,
      0,
      0,
      0,
    ),
  );
  if (next.getTime() <= now.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next.getTime() - now.getTime();
}

/**
 * Run `cleanupOrphanedCaseMedia` and persist the result to `media_cleanup_runs`.
 *
 * On a fatal cleanup failure the run is still persisted with status="error",
 * and then the original error is re-thrown so callers can surface a proper
 * error response rather than silently reporting success with zeroed metrics.
 */
export async function runAndPersistCleanup(
  triggeredBy: string,
  opts: CleanupOptions = { dryRun: false },
): Promise<{ runId: string; report: OrphanedMediaReport; status: string; errorMessage: string | null }> {
  const startedAt = new Date();

  // Recover any stuck run from a previous crashed server before attempting to
  // insert our own sentinel.  If the prior sentinel is still within the
  // timeout window we will hit the unique-constraint below and surface a
  // CleanupAlreadyRunningError to the caller — that is correct behaviour.
  try {
    const recovered = await recoverStuckCleanupRuns();
    if (recovered > 0) {
      logger.warn(
        { recovered },
        "runAndPersistCleanup: recovered stuck cleanup run(s) from a previous server crash",
      );
    }
  } catch (recoverErr: unknown) {
    logger.warn(
      { err: recoverErr instanceof Error ? recoverErr.message : String(recoverErr) },
      "runAndPersistCleanup: stuck-run recovery query failed — continuing anyway",
    );
  }

  let runningRow: { id: string } | undefined;
  try {
    const [row] = await db
      .insert(mediaCleanupRuns)
      .values({
        startedAt,
        dryRun: opts.dryRun,
        status: "running",
        triggeredBy,
      })
      .returning({ id: mediaCleanupRuns.id });
    runningRow = row;
  } catch (insertErr: unknown) {
    // PG error code 23505 = unique_violation — another run is in progress.
    const pgCode =
      insertErr != null &&
      typeof insertErr === "object" &&
      "code" in insertErr
        ? (insertErr as { code: unknown }).code
        : undefined;
    if (pgCode === "23505") {
      throw new CleanupAlreadyRunningError();
    }
    throw insertErr;
  }

  const runId = runningRow!.id;

  // Reset any stale cancel flag so a fresh run isn't immediately aborted.
  resetCancelFlag();

  let report: OrphanedMediaReport | null = null;
  let status = "ok";
  let errorMessage: string | null = null;
  let fatalError: unknown = null;

  try {
    report = await cleanupOrphanedCaseMedia(opts);
  } catch (err: unknown) {
    if (err instanceof CleanupCancelledError) {
      status = "cancelled";
      errorMessage = null;
    } else {
      fatalError = err;
      status = "error";
      errorMessage = err instanceof Error ? err.message : String(err);
    }
    // Build a partial-metrics placeholder so the DB update always has valid data.
    report = report ?? {
      dryRun: opts.dryRun,
      mediaDirExists: false,
      scannedFiles: 0,
      referencedFiles: 0,
      orphanCount: 0,
      removedCount: 0,
      freedBytes: 0,
      sample: [],
      errors: [],
    };
  } finally {
    resetCancelFlag();
    setCleanupProgress({ stage: "finishing" });
    resetCancelFlag();
  }

  const finishedAt = new Date();

  try {
    // Update the sentinel row with the final outcome.
    await db
      .update(mediaCleanupRuns)
      .set({
        finishedAt,
        status,
        errorMessage,
        scannedFiles: report.scannedFiles,
        referencedFiles: report.referencedFiles,
        orphanCount: report.orphanCount,
        removedCount: report.removedCount,
        freedBytes: report.freedBytes,
        errorCount: report.errors.length,
      })
      .where(eq(mediaCleanupRuns.id, runId));

    // Trim old history rows to keep the table small.
    const { retentionDays } = await getCleanupHistoryRetentionDays();
    try {
      const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
      await db
        .delete(mediaCleanupRuns)
        .where(lt(mediaCleanupRuns.startedAt, cutoff));
    } catch (trimErr: unknown) {
      logger.warn(
        { err: trimErr instanceof Error ? trimErr.message : String(trimErr) },
        "media_cleanup_runs trim failed — history rows not pruned",
      );
    }

    // Row-count cap: keep only the most recent N rows, oldest first out.
    // Works alongside the day-based retention above; whichever removes more rows wins.
    const maxRows = Math.max(
      1,
      parseInt(process.env.CLEANUP_HISTORY_MAX_ROWS || "1000", 10) || 1000,
    );
    try {
      await db
        .delete(mediaCleanupRuns)
        .where(
          sql`${mediaCleanupRuns.id} NOT IN (
            SELECT id FROM ${mediaCleanupRuns}
            ORDER BY ${mediaCleanupRuns.startedAt} DESC
            LIMIT ${maxRows}
          )`,
        );
    } catch (trimErr: unknown) {
      logger.warn(
        { err: trimErr instanceof Error ? trimErr.message : String(trimErr) },
        "media_cleanup_runs row-count cap trim failed — history rows not pruned",
      );
    }
  } finally {
    // Always reset to idle — even if DB persistence throws — so the progress
    // indicator does not stay stuck on "finishing" across future runs.
    setCleanupProgress({ stage: "idle" });
  }

  // Re-throw after persisting so callers can return a proper error response.
  if (fatalError !== null) {
    throw fatalError;
  }

  return { runId, report, status, errorMessage };
}

export function startDailyOrphanedMediaCleanup() {
  if (scheduled) return;
  scheduled = true;

  const tick = async () => {
    const ranAt = new Date().toISOString();
    try {
      logger.info(
        { startedAt: ranAt },
        "Daily orphaned case-media cleanup starting",
      );
      const { runId, report } = await runAndPersistCleanup("scheduler", {
        dryRun: false,
      });
      logger.info(
        {
          runId,
          scannedFiles: report.scannedFiles,
          referencedFiles: report.referencedFiles,
          orphanCount: report.orphanCount,
          removedCount: report.removedCount,
          freedBytes: report.freedBytes,
          errorCount: report.errors.length,
        },
        "Daily orphaned case-media cleanup OK",
      );

      // Alert admins if removed/freed thresholds are met, or errors occurred.
      // Prefer DB-persisted values; fall back to env vars.
      const { minRemoved, minFreedMb } = await getCleanupAlertThresholds();
      const meetsRemoveThreshold = report.removedCount >= minRemoved;
      const meetsFreedThreshold =
        minFreedMb > 0 &&
        report.freedBytes / 1024 / 1024 >= minFreedMb;
      const hasErrors = report.errors.length > 0;
      if (meetsRemoveThreshold || meetsFreedThreshold || hasErrors) {
        try {
          const admins = await db
            .select({ email: users.email })
            .from(users)
            .where(eq(users.role, "admin"));
          const adminEmails = await filterEmailsByPref(
            admins.map((u) => u.email).filter((e): e is string => Boolean(e)),
            "cleanupAlerts",
          );
          await sendCleanupAlertEmail({
            adminEmails,
            triggeredBy: "scheduler",
            report: {
              ranAt,
              scannedFiles: report.scannedFiles,
              orphanCount: report.orphanCount,
              removedCount: report.removedCount,
              freedBytes: report.freedBytes,
              errorCount: report.errors.length,
              errors: report.errors,
            },
          });
        } catch (mailErr: unknown) {
          logger.error(
            { err: mailErr instanceof Error ? mailErr.message : String(mailErr) },
            "Daily orphaned case-media cleanup: admin alert email failed",
          );
        }
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error(
        { err: errMsg },
        "Daily orphaned case-media cleanup FAILED",
      );
      // Send a fatal-failure alert to admins even though no report was produced.
      try {
        const admins = await db
          .select({ email: users.email })
          .from(users)
          .where(eq(users.role, "admin"));
        const adminEmails = await filterEmailsByPref(
          admins.map((u) => u.email).filter((e): e is string => Boolean(e)),
          "cleanupAlerts",
        );
        await sendCleanupAlertEmail({
          adminEmails,
          triggeredBy: "scheduler",
          report: { ranAt, fatalError: errMsg },
        });
      } catch (mailErr: unknown) {
        logger.error(
          { err: mailErr instanceof Error ? mailErr.message : String(mailErr) },
          "Daily orphaned case-media cleanup: fatal alert email failed",
        );
      }
    } finally {
      // Re-read the hour from DB on each tick so that admin UI changes take
      // effect on the next scheduled run without a server restart.
      const nextHour = await getCleanupHourUtc();
      setTimeout(tick, msUntilNext(nextHour));
    }
  };

  // On startup, recover any stuck "running" row left over from a server crash.
  // This runs once immediately so that manual runs triggered shortly after
  // restart are not blocked by a stale sentinel.
  recoverStuckCleanupRuns().then(async (recovered) => {
    if (recovered > 0) {
      logger.warn(
        { recovered },
        "startDailyOrphanedMediaCleanup: recovered stuck cleanup run(s) from a previous server crash",
      );
      try {
        const admins = await db
          .select({ email: users.email })
          .from(users)
          .where(eq(users.role, "admin"));
        const adminEmails = await filterEmailsByPref(
          admins.map((u) => u.email).filter((e): e is string => Boolean(e)),
          "cleanupAlerts",
        );
        await sendCleanupRecoveryAlertEmail({ adminEmails, recoveredCount: recovered });
      } catch (mailErr: unknown) {
        logger.error(
          { err: mailErr instanceof Error ? mailErr.message : String(mailErr) },
          "startDailyOrphanedMediaCleanup: recovery alert email failed",
        );
      }
    }
  }).catch((err: unknown) => {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "startDailyOrphanedMediaCleanup: startup stuck-run recovery failed",
    );
  });

  // Read initial hour from DB (with env fallback) so the first delay is
  // consistent with any previously saved admin setting.
  getCleanupHourUtc().then((hourUtc) => {
    const initialDelay = msUntilNext(hourUtc);
    logger.info(
      {
        hourUtc,
        firstRunInMinutes: Math.round(initialDelay / 60000),
      },
      "Daily orphaned case-media cleanup scheduled",
    );
    setTimeout(tick, initialDelay);
  }).catch((err: unknown) => {
    // If DB read fails at startup, fall back to env default.
    const hourUtc = Math.max(
      0,
      Math.min(23, parseInt(process.env.CLEANUP_HOUR_UTC || "8", 10) || 8),
    );
    const initialDelay = msUntilNext(hourUtc);
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), hourUtc },
      "Daily orphaned case-media cleanup: could not read hour from DB at startup, using env default",
    );
    setTimeout(tick, initialDelay);
  });
}

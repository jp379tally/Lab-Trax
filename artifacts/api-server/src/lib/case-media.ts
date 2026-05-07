import * as fs from "node:fs";
import * as path from "node:path";
import { eq, lt, sql } from "drizzle-orm";
import { db, caseAttachments, mediaCleanupRuns, systemSettings, users } from "@workspace/db";
import { logger } from "./logger";
import { sendCleanupAlertEmail } from "./mail";

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
 * Keys used in the system_settings table for cleanup alert thresholds.
 */
export const SETTING_CLEANUP_MIN_REMOVED = "cleanup_alert_min_removed";
export const SETTING_CLEANUP_MIN_FREED_MB = "cleanup_alert_min_freed_mb";

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
  const marker = "/uploads/case-media/";
  const idx = storageKey.indexOf(marker);
  let fileName: string | null = null;
  if (idx >= 0) {
    fileName = storageKey.slice(idx + marker.length).split(/[?#]/)[0] ?? null;
  } else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(storageKey)) {
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

  if (!fs.existsSync(caseMediaDir)) {
    return report;
  }
  report.mediaDirExists = true;

  const dirEntries = fs.readdirSync(caseMediaDir, { withFileTypes: true });
  const filesOnDisk = dirEntries
    .filter((e) => e.isFile())
    .map((e) => e.name);
  report.scannedFiles = filesOnDisk.length;

  const rows = await db
    .select({ storageKey: caseAttachments.storageKey })
    .from(caseAttachments);

  const referenced = new Set<string>();
  for (const row of rows) {
    const name = extractMediaFileName(row.storageKey);
    if (name) referenced.add(name);
  }
  report.referencedFiles = referenced.size;

  for (const fileName of filesOnDisk) {
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
      size = fs.statSync(resolved).size;
    } catch {
      // file may have been removed between readdir and stat
      continue;
    }

    if (opts.dryRun) {
      report.freedBytes += size;
      continue;
    }

    try {
      fs.rmSync(resolved, { force: true });
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

  // Insert a "running" sentinel row.  The schema has a partial unique index
  // on status WHERE status='running', so a second concurrent insert will
  // fail with a unique-constraint violation (PG code 23505) — the DB
  // enforces mutual exclusion atomically with no check-then-act race.
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

  let report: OrphanedMediaReport | null = null;
  let status = "ok";
  let errorMessage: string | null = null;
  let fatalError: unknown = null;

  try {
    report = await cleanupOrphanedCaseMedia(opts);
  } catch (err: unknown) {
    fatalError = err;
    status = "error";
    errorMessage = err instanceof Error ? err.message : String(err);
    // Build a zero-metrics placeholder so the DB update always has valid data.
    report = {
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
  }

  const finishedAt = new Date();

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
          const adminEmails = admins
            .map((u) => u.email)
            .filter((e): e is string => Boolean(e));
          await sendCleanupAlertEmail({
            adminEmails,
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
        const adminEmails = admins
          .map((u) => u.email)
          .filter((e): e is string => Boolean(e));
        await sendCleanupAlertEmail({
          adminEmails,
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

import * as fs from "node:fs";
import * as path from "node:path";
import { eq } from "drizzle-orm";
import { db, caseAttachments, mediaCleanupRuns, users } from "@workspace/db";
import { logger } from "./logger";
import { sendCleanupAlertEmail } from "./mail";

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

// ── Daily orphaned-media cleanup scheduler ──────────────────────────────────
// Mirrors the daily OneDrive backup scheduler in lib/backup.ts. Runs once per
// day at the configured UTC hour (default 08:00 UTC, an hour after the
// backup so we don't compete for IO). Override with CLEANUP_HOUR_UTC.

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
    // Build a zero-metrics placeholder so the DB insert always has valid data.
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

  const [row] = await db
    .insert(mediaCleanupRuns)
    .values({
      startedAt,
      finishedAt,
      dryRun: opts.dryRun,
      status,
      errorMessage,
      scannedFiles: report.scannedFiles,
      referencedFiles: report.referencedFiles,
      orphanCount: report.orphanCount,
      removedCount: report.removedCount,
      freedBytes: report.freedBytes,
      errorCount: report.errors.length,
      triggeredBy,
    })
    .returning({ id: mediaCleanupRuns.id });

  // Re-throw after persisting so callers can return a proper error response.
  if (fatalError !== null) {
    throw fatalError;
  }

  return { runId: row!.id, report, status, errorMessage };
}

export function startDailyOrphanedMediaCleanup() {
  if (scheduled) return;
  scheduled = true;

  const hourUtc = Math.max(
    0,
    Math.min(23, parseInt(process.env.CLEANUP_HOUR_UTC || "8", 10) || 8),
  );

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

      // Alert admins if files were removed or errors occurred.
      if (report.removedCount > 0 || report.errors.length > 0) {
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
      setTimeout(tick, msUntilNext(hourUtc));
    }
  };

  const initialDelay = msUntilNext(hourUtc);
  logger.info(
    {
      hourUtc,
      firstRunInMinutes: Math.round(initialDelay / 60000),
    },
    "Daily orphaned case-media cleanup scheduled",
  );
  setTimeout(tick, initialDelay);
}

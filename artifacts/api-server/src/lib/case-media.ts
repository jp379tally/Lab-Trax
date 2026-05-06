import * as fs from "node:fs";
import * as path from "node:path";
import { db, caseAttachments } from "@workspace/db";
import { logger } from "./logger";

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
    } catch (err: any) {
      report.errors.push({
        fileName,
        error: err?.message || String(err),
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

export function startDailyOrphanedMediaCleanup() {
  if (scheduled) return;
  scheduled = true;

  const hourUtc = Math.max(
    0,
    Math.min(23, parseInt(process.env.CLEANUP_HOUR_UTC || "8", 10) || 8),
  );

  const tick = async () => {
    try {
      logger.info(
        { startedAt: new Date().toISOString() },
        "Daily orphaned case-media cleanup starting",
      );
      const report = await cleanupOrphanedCaseMedia({ dryRun: false });
      logger.info(
        {
          scannedFiles: report.scannedFiles,
          referencedFiles: report.referencedFiles,
          orphanCount: report.orphanCount,
          removedCount: report.removedCount,
          freedBytes: report.freedBytes,
          errorCount: report.errors.length,
        },
        "Daily orphaned case-media cleanup OK",
      );
    } catch (err: any) {
      logger.error(
        { err: err?.message || String(err) },
        "Daily orphaned case-media cleanup FAILED",
      );
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

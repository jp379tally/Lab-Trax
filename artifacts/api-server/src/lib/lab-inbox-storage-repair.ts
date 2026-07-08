/**
 * One-time (idempotent) repair for legacy lab-inbox rows whose
 * storagePath / objectStorageKey hold a full public URL instead of the bare
 * stored filename.  The old mobile client finalized uploads with the full
 * media URL (e.g. `https://host/api/cases/attachment-file/<file>`), so those
 * rows can only be opened via read-time normalization in the serving routes.
 *
 * This pass rewrites URL-shaped values to the normalized bare filename so the
 * data is permanently clean and the read-time normalization becomes pure
 * defense-in-depth.  Rules:
 *  - A column is only rewritten when the normalized name is safe: non-empty,
 *    no slashes/backslashes, no "..".
 *  - Columns that cannot be normalized (external URLs, empty basenames) are
 *    left untouched and logged.  Rows are NEVER deleted (Lab Data Protection).
 *  - Idempotent: repaired rows no longer match the dirty predicate, and
 *    re-running against unrepairable rows performs no writes.
 *
 * Scheduled fire-and-forget from index.ts after the listener starts.  It runs
 * on every boot but the scan is bounded to rows containing a path separator,
 * so a clean database costs a single indexed-table scan and zero writes.
 */

import { eq, isNotNull, or, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { db, labInboxFiles } from "@workspace/db";
import { logger } from "./logger";
import { extractMediaFileName } from "./case-media";

/**
 * Canonicalizes an inbox storage reference to the bare stored filename.
 * Returns `null` when the value cannot be reduced to a safe bare filename
 * (external URL, empty result, or a path-traversal shape).
 */
export function normalizeInboxStorageName(
  raw: string | null | undefined,
): string | null {
  if (!raw) return null;
  const name = extractMediaFileName(raw);
  if (!name) return null;
  if (name.includes("/") || name.includes("\\") || name.includes("..")) {
    return null;
  }
  return name;
}

/** True when the stored value is not already a bare filename. */
function isDirtyStorageValue(value: string): boolean {
  return value.includes("/") || value.includes("\\");
}

/** SQL predicate mirroring isDirtyStorageValue (chr(92) = backslash). */
function dirtySql(column: AnyPgColumn): SQL {
  return sql`(strpos(${column}, '/') > 0 OR strpos(${column}, chr(92)) > 0)`;
}

export interface LabInboxStorageRepairSummary {
  scanned: number;
  repaired: number;
  skipped: number;
}

/**
 * Scans lab_inbox_files for URL-/path-shaped storagePath or objectStorageKey
 * values and rewrites each column to the normalized bare filename when safe.
 * Unrepairable columns are logged and left untouched.
 */
export async function repairLabInboxStorageNames(): Promise<LabInboxStorageRepairSummary> {
  const rows = await db
    .select({
      id: labInboxFiles.id,
      storagePath: labInboxFiles.storagePath,
      objectStorageKey: labInboxFiles.objectStorageKey,
    })
    .from(labInboxFiles)
    .where(
      or(
        dirtySql(labInboxFiles.storagePath),
        sql`(${isNotNull(labInboxFiles.objectStorageKey)} AND ${dirtySql(labInboxFiles.objectStorageKey)})`,
      ),
    );

  const summary: LabInboxStorageRepairSummary = {
    scanned: rows.length,
    repaired: 0,
    skipped: 0,
  };

  for (const row of rows) {
    const updates: Partial<{
      storagePath: string;
      objectStorageKey: string;
    }> = {};
    const unrepairable: string[] = [];

    if (isDirtyStorageValue(row.storagePath)) {
      const normalized = normalizeInboxStorageName(row.storagePath);
      if (normalized) {
        updates.storagePath = normalized;
      } else {
        unrepairable.push("storagePath");
      }
    }

    if (row.objectStorageKey && isDirtyStorageValue(row.objectStorageKey)) {
      const normalized = normalizeInboxStorageName(row.objectStorageKey);
      if (normalized) {
        updates.objectStorageKey = normalized;
      } else {
        unrepairable.push("objectStorageKey");
      }
    }

    if (unrepairable.length > 0) {
      logger.warn(
        { inboxFileId: row.id, columns: unrepairable },
        "lab-inbox storage repair: value cannot be normalized to a safe bare filename — left untouched",
      );
    }

    if (Object.keys(updates).length === 0) {
      summary.skipped++;
      continue;
    }

    await db
      .update(labInboxFiles)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(labInboxFiles.id, row.id));
    summary.repaired++;
  }

  return summary;
}

/**
 * Called once from index.ts after the server starts listening.  Runs the
 * repair in the background without blocking startup; failures are logged
 * and never crash the process.
 */
export function scheduleLabInboxStorageRepair(): void {
  setImmediate(() => {
    void (async () => {
      try {
        const summary = await repairLabInboxStorageNames();
        if (summary.scanned > 0) {
          logger.info(summary, "lab-inbox storage repair: complete");
        } else {
          logger.debug("lab-inbox storage repair: nothing to repair");
        }
      } catch (err) {
        logger.error({ err }, "lab-inbox storage repair: failed");
      }
    })();
  });
}

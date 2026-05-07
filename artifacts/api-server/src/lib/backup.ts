import * as fs from "node:fs";
import * as path from "node:path";
import archiver from "archiver";
import { db } from "@workspace/db";
import { users, labCases, systemSettings } from "@workspace/db";
import { eq } from "drizzle-orm";
import { uploadToOneDrive } from "./onedrive";
import { logger } from "./logger";

export interface BackupResult {
  fileName: string;
  size: number;
  webUrl: string;
  folder: string;
  counts: { users: number; cases: number };
}

export async function buildBackupZipBuffer(triggeredBy: string): Promise<{
  buffer: Buffer;
  fileName: string;
  counts: { users: number; cases: number };
}> {
  const allUsers = await db.select().from(users);
  const allCases = await db.select().from(labCases);
  const safeUsers = allUsers.map((u) => {
    const { password: _pw, ...rest } = u as any;
    return rest;
  });

  const dateStr = new Date().toISOString().split("T")[0];
  const fileName = `labtrax-backup-${dateStr}.zip`;
  const manifest = {
    version: "1.0",
    appName: "LabTrax",
    exportedAt: new Date().toISOString(),
    exportedBy: triggeredBy,
    counts: { users: safeUsers.length, cases: allCases.length },
    tables: ["users", "lab_cases"],
    note: "Passwords excluded. Media files included in media/ directory.",
  };

  const mediaDir = path.resolve(process.cwd(), "uploads", "case-media");
  const mediaExists = fs.existsSync(mediaDir);

  const buffer: Buffer = await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const archive = archiver("zip", { zlib: { level: 6 } });
    archive.on("data", (chunk: Buffer) => chunks.push(chunk));
    archive.on("end", () => resolve(Buffer.concat(chunks)));
    archive.on("error", reject);
    archive.append(JSON.stringify(manifest, null, 2), { name: "manifest.json" });
    archive.append(JSON.stringify(safeUsers, null, 2), {
      name: "data/users.json",
    });
    archive.append(JSON.stringify(allCases, null, 2), {
      name: "data/cases.json",
    });
    if (mediaExists) archive.directory(mediaDir, "media");
    archive.finalize();
  });

  return {
    buffer,
    fileName,
    counts: { users: safeUsers.length, cases: allCases.length },
  };
}

export async function runOneDriveBackup(triggeredBy: string): Promise<BackupResult> {
  const { buffer, fileName, counts } = await buildBackupZipBuffer(triggeredBy);
  const result = await uploadToOneDrive(buffer, fileName, "LabTrax Backups");
  return {
    fileName: result.name,
    size: result.size,
    webUrl: result.webUrl,
    folder: "LabTrax Backups",
    counts,
  };
}

/**
 * Key used in the system_settings table for the nightly backup hour (0–23 UTC).
 * When absent the env var BACKUP_HOUR_UTC is used (default 7).
 */
export const SETTING_BACKUP_HOUR_UTC = "backup_hour_utc";

/**
 * Read the nightly backup hour from the DB, falling back to the
 * BACKUP_HOUR_UTC env var (default 7).
 */
export async function getBackupHourUtc(): Promise<number> {
  const envHour = Math.max(
    0,
    Math.min(23, parseInt(process.env.BACKUP_HOUR_UTC || "7", 10) || 7),
  );
  try {
    const rows = await db
      .select()
      .from(systemSettings)
      .where(eq(systemSettings.key, SETTING_BACKUP_HOUR_UTC));
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

// ── Daily backup scheduler ───────────────────────────────────────────────────
// Runs once per day at the configured UTC hour (default 07:00 UTC ≈ 2-3am ET).
// Override with BACKUP_HOUR_UTC env var (0–23) or the backup_hour_utc system_settings row.

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

export async function startDailyOneDriveBackup() {
  if (scheduled) return;
  scheduled = true;

  const hourUtc = await getBackupHourUtc();

  const tick = async () => {
    try {
      logger.info(
        { startedAt: new Date().toISOString() },
        "Daily OneDrive backup starting",
      );
      const result = await runOneDriveBackup("scheduler:daily");
      logger.info(
        {
          fileName: result.fileName,
          size: result.size,
          cases: result.counts.cases,
          users: result.counts.users,
        },
        "Daily OneDrive backup OK",
      );
    } catch (err: any) {
      logger.error(
        { err: err?.message || String(err) },
        "Daily OneDrive backup FAILED",
      );
    } finally {
      // Re-schedule for the next day even if this run failed.
      setTimeout(tick, msUntilNext(hourUtc));
    }
  };

  const initialDelay = msUntilNext(hourUtc);
  logger.info(
    {
      hourUtc,
      firstRunInMinutes: Math.round(initialDelay / 60000),
    },
    "Daily OneDrive backup scheduled",
  );
  setTimeout(tick, initialDelay);
}

import * as fs from "node:fs";
import * as path from "node:path";
import archiver from "archiver";
import { db } from "../db";
import { users, labCases } from "../../shared/schema";
import { uploadToOneDrive } from "./onedrive";

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

// ── Daily backup scheduler ───────────────────────────────────────────────────
// Runs once per day at the configured UTC hour (default 07:00 UTC ≈ 2-3am ET).
// Override with BACKUP_HOUR_UTC env var (0–23).

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

export function startDailyOneDriveBackup() {
  if (scheduled) return;
  scheduled = true;

  const hourUtc = Math.max(
    0,
    Math.min(23, parseInt(process.env.BACKUP_HOUR_UTC || "7", 10) || 7),
  );

  const tick = async () => {
    const startedAt = new Date().toISOString();
    try {
      console.log(`[BACKUP] Daily OneDrive backup starting at ${startedAt}`);
      const result = await runOneDriveBackup("scheduler:daily");
      console.log(
        `[BACKUP] Daily OneDrive backup OK file=${result.fileName} size=${result.size} cases=${result.counts.cases} users=${result.counts.users}`,
      );
    } catch (err: any) {
      console.error(
        `[BACKUP] Daily OneDrive backup FAILED: ${err?.message || err}`,
      );
    } finally {
      // Re-schedule for the next day even if this run failed.
      setTimeout(tick, msUntilNext(hourUtc));
    }
  };

  const initialDelay = msUntilNext(hourUtc);
  console.log(
    `[BACKUP] Daily OneDrive backup scheduled for ${hourUtc.toString().padStart(2, "0")}:00 UTC (first run in ${Math.round(initialDelay / 60000)} min)`,
  );
  setTimeout(tick, initialDelay);
}

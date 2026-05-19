import * as fs from "node:fs";
import * as path from "node:path";
import archiver from "archiver";
import { db } from "@workspace/db";
import {
  users,
  labCases,
  systemSettings,
  organizations,
  cases as casesTable,
  caseAttachments,
  invoices,
  bankTransactions,
  pricingTiers,
  pricingOverrides,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { uploadToOneDrive } from "./onedrive";
import { logger } from "./logger";

export interface BackupCounts {
  users: number;
  labCases: number;
  organizations: number;
  cases: number;
  caseAttachments: number;
  invoices: number;
  bankTransactions: number;
  pricingTiers: number;
  pricingOverrides: number;
}

export interface BackupResult {
  fileName: string;
  size: number;
  webUrl: string;
  folder: string;
  counts: BackupCounts;
}

export async function buildBackupZipBuffer(triggeredBy: string): Promise<{
  buffer: Buffer;
  fileName: string;
  counts: BackupCounts;
}> {
  const [
    allUsers,
    allLabCases,
    allOrganizations,
    allCases,
    allCaseAttachments,
    allInvoices,
    allBankTransactions,
    allPricingTiers,
    allPricingOverrides,
  ] = await Promise.all([
    db.select().from(users),
    db.select().from(labCases),
    db.select().from(organizations),
    db.select().from(casesTable),
    db.select().from(caseAttachments),
    db.select().from(invoices),
    db.select().from(bankTransactions),
    db.select().from(pricingTiers),
    db.select().from(pricingOverrides),
  ]);

  const safeUsers = allUsers.map(({ password: _pw, ...rest }): Omit<typeof rest & { password: string }, "password"> => rest);

  const counts: BackupCounts = {
    users: safeUsers.length,
    labCases: allLabCases.length,
    organizations: allOrganizations.length,
    cases: allCases.length,
    caseAttachments: allCaseAttachments.length,
    invoices: allInvoices.length,
    bankTransactions: allBankTransactions.length,
    pricingTiers: allPricingTiers.length,
    pricingOverrides: allPricingOverrides.length,
  };

  const dateStr = new Date().toISOString().split("T")[0];
  const fileName = `labtrax-backup-${dateStr}.zip`;
  const manifest = {
    version: "1.1",
    appName: "LabTrax",
    exportedAt: new Date().toISOString(),
    exportedBy: triggeredBy,
    counts,
    tables: [
      "users",
      "lab_cases",
      "organizations",
      "cases",
      "case_attachments",
      "invoices",
      "bank_transactions",
      "pricing_tiers",
      "pricing_overrides",
    ],
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
    archive.append(JSON.stringify(safeUsers, null, 2), { name: "data/users.json" });
    archive.append(JSON.stringify(allLabCases, null, 2), { name: "data/lab_cases.json" });
    archive.append(JSON.stringify(allOrganizations, null, 2), { name: "data/organizations.json" });
    archive.append(JSON.stringify(allCases, null, 2), { name: "data/cases.json" });
    archive.append(JSON.stringify(allCaseAttachments, null, 2), { name: "data/case_attachments.json" });
    archive.append(JSON.stringify(allInvoices, null, 2), { name: "data/invoices.json" });
    archive.append(JSON.stringify(allBankTransactions, null, 2), { name: "data/bank_transactions.json" });
    archive.append(JSON.stringify(allPricingTiers, null, 2), { name: "data/pricing_tiers.json" });
    archive.append(JSON.stringify(allPricingOverrides, null, 2), { name: "data/pricing_overrides.json" });
    if (mediaExists) archive.directory(mediaDir, "media");
    archive.finalize();
  });

  return { buffer, fileName, counts };
}

export async function runOneDriveBackup(triggeredBy: string): Promise<BackupResult> {
  const { buffer, fileName, counts } = await buildBackupZipBuffer(triggeredBy);
  const result = await uploadToOneDrive(buffer, fileName, "LabTrax Backups", "rename");
  return {
    fileName: result.name,
    size: result.size,
    webUrl: result.webUrl,
    folder: "LabTrax Backups",
    counts,
  };
}

// ── Rolling backup settings keys ─────────────────────────────────────────────
export const SETTING_BACKUP_HOUR_UTC = "backup_hour_utc";
export const SETTING_ROLLING_BACKUP_ENABLED = "rolling_backup_enabled";
export const SETTING_ROLLING_BACKUP_LAST_RUN_AT = "rolling_backup_last_run_at";
export const SETTING_ROLLING_BACKUP_LAST_ERROR = "rolling_backup_last_error";

const ROLLING_BACKUP_FILENAME = "LabTrax-Rolling-Backup.zip";
const ROLLING_BACKUP_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const ROLLING_BACKUP_STARTUP_DELAY_MS = 30 * 1000; // 30-second delay at startup

// ── Rolling backup state helpers ─────────────────────────────────────────────

async function isRollingBackupEnabled(): Promise<boolean> {
  try {
    const rows = await db
      .select()
      .from(systemSettings)
      .where(eq(systemSettings.key, SETTING_ROLLING_BACKUP_ENABLED));
    const raw = rows[0]?.value ?? null;
    // Default to enabled if not set
    if (raw === null) return true;
    return raw !== "false";
  } catch {
    return true;
  }
}

async function persistRollingBackupSuccess(): Promise<void> {
  const now = new Date().toISOString();
  await db
    .insert(systemSettings)
    .values({ key: SETTING_ROLLING_BACKUP_LAST_RUN_AT, value: now })
    .onConflictDoUpdate({
      target: systemSettings.key,
      set: { value: now, updatedAt: new Date() },
    });
  // Clear any previous error
  await db
    .insert(systemSettings)
    .values({ key: SETTING_ROLLING_BACKUP_LAST_ERROR, value: null })
    .onConflictDoUpdate({
      target: systemSettings.key,
      set: { value: null, updatedAt: new Date() },
    });
}

async function persistRollingBackupError(message: string): Promise<void> {
  await db
    .insert(systemSettings)
    .values({ key: SETTING_ROLLING_BACKUP_LAST_ERROR, value: message })
    .onConflictDoUpdate({
      target: systemSettings.key,
      set: { value: message, updatedAt: new Date() },
    });
}

async function runRollingOneDriveBackup(): Promise<BackupResult> {
  const { buffer, counts } = await buildBackupZipBuffer("scheduler:rolling-15min");
  const result = await uploadToOneDrive(
    buffer,
    ROLLING_BACKUP_FILENAME,
    "LabTrax Backups",
    "replace",
  );
  return {
    fileName: result.name,
    size: result.size,
    webUrl: result.webUrl,
    folder: "LabTrax Backups",
    counts,
  };
}

// ── Rolling backup scheduler ─────────────────────────────────────────────────
// Fires immediately after a 30-second startup delay, then every 15 minutes.
// Silently overwrites LabTrax-Rolling-Backup.zip on OneDrive on every tick.

let rollingScheduled = false;

export async function start15MinRollingBackup() {
  if (rollingScheduled) return;
  rollingScheduled = true;

  const tick = async () => {
    try {
      const enabled = await isRollingBackupEnabled();
      if (!enabled) {
        logger.debug("Rolling OneDrive backup skipped (disabled via settings)");
        return;
      }
      logger.info(
        { startedAt: new Date().toISOString() },
        "Rolling OneDrive backup starting",
      );
      const result = await runRollingOneDriveBackup();
      await persistRollingBackupSuccess().catch((e) => {
        logger.warn({ err: e?.message }, "Failed to persist rolling backup success state");
      });
      logger.info(
        {
          fileName: result.fileName,
          size: result.size,
          cases: result.counts.cases,
          users: result.counts.users,
        },
        "Rolling OneDrive backup OK",
      );
    } catch (err: any) {
      const message = err?.message || String(err);
      logger.error({ err: message }, "Rolling OneDrive backup FAILED");
      await persistRollingBackupError(message).catch((e) => {
        logger.warn({ err: e?.message }, "Failed to persist rolling backup error state");
      });
    } finally {
      // Always schedule the next tick
      setTimeout(tick, ROLLING_BACKUP_INTERVAL_MS);
    }
  };

  logger.info(
    {
      intervalMinutes: 15,
      firstRunInSeconds: ROLLING_BACKUP_STARTUP_DELAY_MS / 1000,
    },
    "15-min rolling OneDrive backup scheduled",
  );
  setTimeout(tick, ROLLING_BACKUP_STARTUP_DELAY_MS);
}

// ── Daily backup scheduler ────────────────────────────────────────────────────
// Runs once per day at the configured UTC hour (default 07:00 UTC ≈ 2-3am ET).
// Override with BACKUP_HOUR_UTC env var (0–23) or the backup_hour_utc system_settings row.

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

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import archiver from "archiver";
import { db } from "@workspace/db";
import { systemSettings, users } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { uploadToOneDrive } from "./onedrive";
import { logger } from "./logger";
import { sendBackupNotificationEmail } from "./mail";

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
}

export interface BackupRunResult {
  size: number;
  completedAt: string;
  fileName: string;
  destination: BackupDestination;
  path?: string;
}

export type BackupDestination = "onedrive" | "local" | "network";

export const SETTING_BACKUP_HOUR_UTC = "backup_hour_utc";
export const SETTING_BACKUP_SCHEDULE_INTERVAL_MINUTES = "backup_schedule_interval_minutes";
export const SETTING_BACKUP_SCHEDULE_DESTINATION = "backup_schedule_destination";
export const SETTING_BACKUP_SCHEDULE_PATH = "backup_schedule_path";
export const SETTING_BACKUP_SCHEDULE_ENABLED = "backup_schedule_enabled";
export const SETTING_BACKUP_LAST_SUCCESSFUL_AT = "backup_last_successful_at";
export const SETTING_ROLLING_BACKUP_ENABLED = "rolling_backup_enabled";
export const SETTING_ROLLING_BACKUP_LAST_RUN_AT = "rolling_backup_last_run_at";
export const SETTING_ROLLING_BACKUP_LAST_ERROR = "rolling_backup_last_error";

export const ALL_SCHEDULE_SETTINGS = [
  SETTING_BACKUP_SCHEDULE_INTERVAL_MINUTES,
  SETTING_BACKUP_SCHEDULE_DESTINATION,
  SETTING_BACKUP_SCHEDULE_PATH,
  SETTING_BACKUP_SCHEDULE_ENABLED,
] as const;

/**
 * Run pg_dump --format=custom against DATABASE_URL.
 * Returns the raw binary dump buffer (typically compressed by pg_dump).
 * Throws if pg_dump exits non-zero or DATABASE_URL is not set.
 */
function buildPgDumpBuffer(): Buffer {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL is not set — cannot run pg_dump.");
  const result = spawnSync("pg_dump", ["--format=custom", `--dbname=${dbUrl}`], {
    maxBuffer: 2 * 1024 * 1024 * 1024, // 2 GB safety cap
    timeout: 10 * 60 * 1000,           // 10 min timeout
    encoding: "buffer",
  });
  if (result.status !== 0) {
    const stderr = result.stderr?.toString("utf8") || "unknown error";
    throw new Error(`pg_dump failed (exit ${result.status}): ${stderr}`);
  }
  if (!result.stdout || result.stdout.length === 0) {
    throw new Error("pg_dump produced empty output.");
  }
  return result.stdout as Buffer;
}

/**
 * Encrypt a buffer using AES-256-GCM.
 *
 * Output format (all big-endian):
 *   [4 bytes magic "LTRX"] [12 bytes IV] [16 bytes GCM auth-tag] [ciphertext]
 *
 * The encryption key is derived by SHA-256-hashing the BACKUP_ENCRYPTION_KEY
 * env var (preferred) or JWT_SECRET (fallback). Decryption requires the same
 * secret; document decrypt steps in the manifest inside the ZIP before encrypting.
 */
function encryptBuffer(plaintext: Buffer): Buffer {
  const secret = process.env.BACKUP_ENCRYPTION_KEY || process.env.JWT_SECRET;
  if (!secret) {
    throw new Error(
      "Backup encryption requires BACKUP_ENCRYPTION_KEY (or JWT_SECRET) to be set. " +
      "Set one of these environment variables before running a backup.",
    );
  }
  const key = createHash("sha256").update(secret).digest(); // 32-byte key
  const iv = randomBytes(12); // 96-bit IV for GCM
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag(); // 16 bytes
  const magic = Buffer.from("LTRX");
  return Buffer.concat([magic, iv, authTag, ciphertext]);
}

/**
 * Build a full LabTrax backup:
 *  1. Run pg_dump to capture the entire PostgreSQL database in custom format.
 *  2. Bundle the dump + case-media uploads into a ZIP archive.
 *  3. AES-256-GCM encrypt the ZIP buffer.
 *
 * The resulting `.zip.enc` file can be decrypted with the matching secret and
 * then restored with pg_restore (for the db dump) + extracting the media/ dir.
 */
export async function buildBackupZipBuffer(triggeredBy: string): Promise<{
  buffer: Buffer;
  fileName: string;
}> {
  const pgDump = buildPgDumpBuffer();

  const dateStr = new Date().toISOString().split("T")[0];
  const fileName = `labtrax-backup-${dateStr}.zip.enc`;

  const manifest = {
    version: "2.0",
    appName: "LabTrax",
    exportedAt: new Date().toISOString(),
    exportedBy: triggeredBy,
    dbFormat: "pg_dump:custom",
    decryptNote:
      "This file is AES-256-GCM encrypted. Format: 4-byte magic 'LTRX' + 12-byte IV + 16-byte GCM auth-tag + ciphertext. " +
      "Set BACKUP_ENCRYPTION_KEY (or JWT_SECRET) to the same value used during backup, derive a 32-byte key via SHA-256, " +
      "then decrypt to get the inner ZIP. Restore the database with: pg_restore --clean --if-exists -d <dbname> db/database.pgdump",
    mediaNote: "Case-media attachments are in the media/ directory of the inner ZIP.",
  };

  const mediaDir = path.resolve(process.cwd(), "uploads", "case-media");
  const mediaExists = fs.existsSync(mediaDir);

  const zipBuffer: Buffer = await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const archive = archiver("zip", { zlib: { level: 6 } });
    archive.on("data", (chunk: Buffer) => chunks.push(chunk));
    archive.on("end", () => resolve(Buffer.concat(chunks)));
    archive.on("error", reject);
    archive.append(JSON.stringify(manifest, null, 2), { name: "manifest.json" });
    archive.append(pgDump, { name: "db/database.pgdump" });
    if (mediaExists) archive.directory(mediaDir, "media");
    archive.finalize();
  });

  const buffer = encryptBuffer(zipBuffer);
  return { buffer, fileName };
}

export async function runOneDriveBackup(triggeredBy: string): Promise<BackupResult> {
  const { buffer, fileName } = await buildBackupZipBuffer(triggeredBy);
  const result = await uploadToOneDrive(buffer, fileName, "LabTrax Backups");
  return {
    fileName: result.name,
    size: result.size,
    webUrl: result.webUrl,
    folder: "LabTrax Backups",
  };
}

/**
 * Write an encrypted backup to a local filesystem path.
 * On Linux, UNC/SMB paths must be pre-mounted (e.g. via cifs-utils) so they
 * appear as a local directory — pass the mount point as targetPath.
 */
export async function runLocalBackup(
  triggeredBy: string,
  targetPath: string,
): Promise<BackupRunResult> {
  const { buffer, fileName } = await buildBackupZipBuffer(triggeredBy);
  const resolvedDir = path.resolve(targetPath);
  fs.mkdirSync(resolvedDir, { recursive: true });
  const destFile = path.join(resolvedDir, fileName);
  fs.writeFileSync(destFile, buffer);
  return {
    size: buffer.length,
    completedAt: new Date().toISOString(),
    fileName,
    destination: "local",
    path: destFile,
  };
}

/** Minimal interface covering the ssh2 API surface used by runSftpBackup. */
interface SshClient {
  on(event: "ready", listener: () => void): this;
  on(event: "error", listener: (err: Error) => void): this;
  sftp(callback: (err: Error | undefined, sftp: SftpSession) => void): void;
  connect(opts: { host: string; port: number; username: string; password?: string }): void;
  end(): void;
}
interface SftpSession {
  createWriteStream(path: string): NodeJS.WritableStream;
}
interface Ssh2Module {
  Client: new () => SshClient;
}

/**
 * Write an encrypted backup to an SFTP server.
 * destPath must be an sftp:// URL in the form:
 *   sftp://user@host[:port]/remote/directory
 * Embedded passwords are rejected at the schedule-save layer; authenticate
 * via SSH key by configuring the server to accept the API process's key.
 * Requires the `ssh2` npm package installed in api-server.
 */
async function runSftpBackup(
  triggeredBy: string,
  sftpUrl: string,
): Promise<BackupRunResult> {
  let parsed: URL;
  try {
    parsed = new URL(sftpUrl);
  } catch {
    throw new Error(`Invalid SFTP URL: ${sftpUrl}`);
  }
  if (parsed.protocol !== "sftp:") {
    throw new Error(`Expected sftp:// URL, got: ${parsed.protocol}`);
  }

  const { buffer, fileName } = await buildBackupZipBuffer(triggeredBy);

  // Dynamically import ssh2 — optional runtime dep. Absence surfaces a clear install message.
  let Ssh2Client: new () => SshClient;
  try {
    // @ts-expect-error — ssh2 is an optional runtime dep; the type is provided by SshClient above
    const ssh2 = (await import("ssh2")) as Ssh2Module;
    Ssh2Client = ssh2.Client;
  } catch {
    throw new Error(
      "SFTP backup requires the 'ssh2' package. " +
      "Run: pnpm --filter @workspace/api-server add ssh2",
    );
  }

  const host = parsed.hostname;
  const port = parsed.port ? parseInt(parsed.port, 10) : 22;
  const username = decodeURIComponent(parsed.username || "");
  const remoteDir = parsed.pathname || "/";
  const remoteFile = `${remoteDir.replace(/\/$/, "")}/${fileName}`;

  await new Promise<void>((resolve, reject) => {
    const conn = new Ssh2Client();
    conn.on("ready", () => {
      conn.sftp((err: Error | undefined, sftp: SftpSession) => {
        if (err) { conn.end(); return reject(err); }
        const writeStream = sftp.createWriteStream(remoteFile);
        writeStream.on("error", (e: Error) => { conn.end(); reject(e); });
        writeStream.on("close", () => { conn.end(); resolve(); });
        writeStream.end(buffer);
      });
    });
    conn.on("error", (e: Error) => reject(e));
    conn.connect({ host, port, username });
  });

  return {
    size: buffer.length,
    completedAt: new Date().toISOString(),
    fileName,
    destination: "network",
    path: remoteFile,
  };
}

async function recordSuccessfulBackup(): Promise<void> {
  const now = new Date().toISOString();
  try {
    await db
      .insert(systemSettings)
      .values({ key: SETTING_BACKUP_LAST_SUCCESSFUL_AT, value: now })
      .onConflictDoUpdate({
        target: systemSettings.key,
        set: { value: now, updatedAt: new Date() },
      });
  } catch {
    // Non-fatal — don't let a DB write failure prevent the backup result being returned.
  }
}

export async function getLastSuccessfulBackupAt(): Promise<string | null> {
  try {
    const rows = await db
      .select()
      .from(systemSettings)
      .where(eq(systemSettings.key, SETTING_BACKUP_LAST_SUCCESSFUL_AT));
    return rows[0]?.value ?? null;
  } catch {
    return null;
  }
}

export async function runBackup(
  triggeredBy: string,
  destination: BackupDestination,
  destPath?: string,
): Promise<BackupRunResult> {
  if (destination === "onedrive") {
    const { buffer, fileName } = await buildBackupZipBuffer(triggeredBy);
    const result = await uploadToOneDrive(buffer, fileName, "LabTrax Backups");
    const runResult: BackupRunResult = {
      size: result.size,
      completedAt: new Date().toISOString(),
      fileName: result.name,
      destination: "onedrive",
    };
    await recordSuccessfulBackup();
    return runResult;
  }
  if (destination === "local") {
    if (!destPath) throw new Error("A destination path is required for local backups.");
    const runResult = await runLocalBackup(triggeredBy, destPath);
    await recordSuccessfulBackup();
    return runResult;
  }
  if (destination === "network") {
    if (!destPath) throw new Error("A network path or sftp:// URL is required for network backups.");
    // sftp:// → SFTP transport; anything else → local filesystem (mounted UNC/NFS share)
    const runResult = destPath.startsWith("sftp://")
      ? await runSftpBackup(triggeredBy, destPath)
      : await runLocalBackup(triggeredBy, destPath);
    await recordSuccessfulBackup();
    return runResult;
  }
  throw new Error(`Unknown backup destination: ${destination}`);
}

/**
 * Key used in the system_settings table for the nightly backup hour (0–23 UTC).
 * When absent the env var BACKUP_HOUR_UTC is used (default 7).
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

export interface BackupScheduleConfig {
  intervalMinutes: number | null;
  destination: BackupDestination | null;
  path: string | null;
  enabled: boolean;
}

export async function getBackupScheduleConfig(): Promise<BackupScheduleConfig> {
  try {
    const rows = await db
      .select()
      .from(systemSettings)
      .where(
        sql`${systemSettings.key} in (${SETTING_BACKUP_SCHEDULE_INTERVAL_MINUTES}, ${SETTING_BACKUP_SCHEDULE_DESTINATION}, ${SETTING_BACKUP_SCHEDULE_PATH}, ${SETTING_BACKUP_SCHEDULE_ENABLED})`,
      );
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    const intervalRaw = byKey[SETTING_BACKUP_SCHEDULE_INTERVAL_MINUTES] ?? null;
    const intervalMinutes =
      intervalRaw !== null ? (parseInt(intervalRaw, 10) || null) : null;
    const destinationRaw = byKey[SETTING_BACKUP_SCHEDULE_DESTINATION] ?? null;
    const destination =
      destinationRaw === "onedrive" || destinationRaw === "local" || destinationRaw === "network"
        ? destinationRaw
        : null;
    const schedulePath = byKey[SETTING_BACKUP_SCHEDULE_PATH] ?? null;
    const enabledRaw = byKey[SETTING_BACKUP_SCHEDULE_ENABLED] ?? null;
    const enabled = enabledRaw === "true";
    return { intervalMinutes, destination, path: schedulePath, enabled };
  } catch {
    return { intervalMinutes: null, destination: null, path: null, enabled: false };
  }
}

async function getAdminEmails(): Promise<string[]> {
  try {
    const admins = await db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.role, "admin"));
    return admins.map((u) => u.email).filter((e): e is string => Boolean(e));
  } catch (err: unknown) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "[backup] Failed to load admin emails for notification; no notification will be sent",
    );
    return [];
  }
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
        },
        "Daily OneDrive backup OK",
      );
      try {
        const adminEmails = await getAdminEmails();
        await sendBackupNotificationEmail({
          adminEmails,
          triggeredBy: "scheduler:daily",
          success: true,
          result: {
            destination: "onedrive",
            fileName: result.fileName,
            size: result.size,
            completedAt: new Date().toISOString(),
          },
        });
      } catch (mailErr: unknown) {
        logger.error(
          { err: mailErr instanceof Error ? mailErr.message : String(mailErr) },
          "Daily OneDrive backup: success notification email failed",
        );
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error(
        { err: errMsg },
        "Daily OneDrive backup FAILED",
      );
      try {
        const adminEmails = await getAdminEmails();
        await sendBackupNotificationEmail({
          adminEmails,
          triggeredBy: "scheduler:daily",
          success: false,
          errorMessage: errMsg,
          destination: "onedrive",
        });
      } catch (mailErr: unknown) {
        logger.error(
          { err: mailErr instanceof Error ? mailErr.message : String(mailErr) },
          "Daily OneDrive backup: failure notification email failed",
        );
      }
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

// ── Dynamic recurring backup scheduler ──────────────────────────────────────
// Driven by system_settings rows written by PUT /api/admin/backup/schedule.
// The interval timer is replaced each time the schedule is updated.

let _scheduledIntervalTimer: ReturnType<typeof setInterval> | null = null;

async function fireScheduledBackup() {
  const config = await getBackupScheduleConfig();
  if (!config.enabled || !config.destination) return;
  const label = `scheduler:interval`;
  try {
    logger.info(
      { destination: config.destination, path: config.path },
      "Scheduled interval backup starting",
    );
    const result = await runBackup(label, config.destination, config.path ?? undefined);
    logger.info(
      { size: result.size, fileName: result.fileName },
      "Scheduled interval backup OK",
    );
    try {
      const adminEmails = await getAdminEmails();
      await sendBackupNotificationEmail({
        adminEmails,
        triggeredBy: "scheduler:interval",
        success: true,
        result: {
          destination: result.destination,
          fileName: result.fileName,
          size: result.size,
          completedAt: result.completedAt,
          path: result.path,
        },
      });
    } catch (mailErr: unknown) {
      logger.error(
        { err: mailErr instanceof Error ? mailErr.message : String(mailErr) },
        "Scheduled interval backup: success notification email failed",
      );
    }
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error(
      { err: errMsg },
      "Scheduled interval backup FAILED",
    );
    try {
      const adminEmails = await getAdminEmails();
      await sendBackupNotificationEmail({
        adminEmails,
        triggeredBy: "scheduler:interval",
        success: false,
        errorMessage: errMsg,
        destination: config.destination,
      });
    } catch (mailErr: unknown) {
      logger.error(
        { err: mailErr instanceof Error ? mailErr.message : String(mailErr) },
        "Scheduled interval backup: failure notification email failed",
      );
    }
  }
}

// ── 15-minute rolling OneDrive backup ────────────────────────────────────────
// Fires every 15 minutes when the OneDrive connector is available and
// rolling backup is enabled (default: enabled). Results and errors are stored
// in system_settings under the SETTING_ROLLING_BACKUP_* keys so the admin
// Settings → Backup panel can surface the last run status.

const ROLLING_BACKUP_INTERVAL_MS = 15 * 60 * 1000;
let _rollingBackupTimer: ReturnType<typeof setInterval> | null = null;

async function fireRollingBackup(): Promise<void> {
  try {
    const rows = await db
      .select()
      .from(systemSettings)
      .where(eq(systemSettings.key, SETTING_ROLLING_BACKUP_ENABLED));
    const enabledRaw = rows[0]?.value ?? null;
    const enabled = enabledRaw === null ? true : enabledRaw !== "false";
    if (!enabled) return;

    logger.info({ startedAt: new Date().toISOString() }, "Rolling 15-min backup starting");
    await runOneDriveBackup("scheduler:rolling");
    const now = new Date().toISOString();
    await db
      .insert(systemSettings)
      .values({ key: SETTING_ROLLING_BACKUP_LAST_RUN_AT, value: now })
      .onConflictDoUpdate({ target: systemSettings.key, set: { value: now, updatedAt: new Date() } });
    await db.delete(systemSettings).where(eq(systemSettings.key, SETTING_ROLLING_BACKUP_LAST_ERROR));
    logger.info({ completedAt: now }, "Rolling 15-min backup OK");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg }, "Rolling 15-min backup FAILED");
    try {
      await db
        .insert(systemSettings)
        .values({ key: SETTING_ROLLING_BACKUP_LAST_ERROR, value: msg })
        .onConflictDoUpdate({ target: systemSettings.key, set: { value: msg, updatedAt: new Date() } });
    } catch {
      // ignore secondary DB error
    }
  }
}

export function start15MinRollingBackup(): void {
  if (_rollingBackupTimer !== null) return;
  logger.info({ intervalMinutes: 15 }, "Rolling 15-min OneDrive backup scheduler started");
  _rollingBackupTimer = setInterval(() => { void fireRollingBackup(); }, ROLLING_BACKUP_INTERVAL_MS);
}

export async function restartScheduledBackupJob(): Promise<void> {
  if (_scheduledIntervalTimer !== null) {
    clearInterval(_scheduledIntervalTimer);
    _scheduledIntervalTimer = null;
  }
  const config = await getBackupScheduleConfig();
  if (!config.enabled || !config.intervalMinutes || !config.destination) {
    logger.info("[backup] Recurring backup schedule is disabled or not configured.");
    return;
  }
  const intervalMs = config.intervalMinutes * 60 * 1000;
  logger.info(
    { intervalMinutes: config.intervalMinutes, destination: config.destination },
    "[backup] Recurring backup schedule started",
  );
  _scheduledIntervalTimer = setInterval(fireScheduledBackup, intervalMs);
}

// ── 15-minute rolling OneDrive backup ────────────────────────────────────────
// Persists last-run timestamp and any error to system_settings so the admin
// panel can surface freshness and failures without querying logs.

let _rollingBackupScheduled = false;
const ROLLING_BACKUP_INTERVAL_MS = 15 * 60 * 1000;

async function persistRollingBackupStatus(error?: string | null) {
  const now = new Date().toISOString();
  const upsert = async (key: string, value: string) => {
    await db
      .insert(systemSettings)
      .values({ key, value })
      .onConflictDoUpdate({
        target: systemSettings.key,
        set: { value, updatedAt: new Date() },
      });
  };
  await upsert(SETTING_ROLLING_BACKUP_LAST_RUN_AT, now);
  await upsert(SETTING_ROLLING_BACKUP_LAST_ERROR, error ?? "");
}

export async function start15MinRollingBackup() {
  if (_rollingBackupScheduled) return;
  _rollingBackupScheduled = true;

  logger.info(
    { intervalMs: ROLLING_BACKUP_INTERVAL_MS },
    "15-min rolling OneDrive backup scheduled",
  );

  const tick = async () => {
    // Honour the admin toggle — default on when the setting is absent.
    try {
      const rows = await db
        .select()
        .from(systemSettings)
        .where(eq(systemSettings.key, SETTING_ROLLING_BACKUP_ENABLED));
      const raw = rows[0]?.value ?? null;
      const enabled = raw === null ? true : raw !== "false";
      if (!enabled) return;
    } catch {
      // If we can't read the setting, proceed with the backup to be safe.
    }

    try {
      const result = await runOneDriveBackup("scheduler:rolling-15min");
      logger.info({ fileName: result.fileName, size: result.size }, "15-min rolling OneDrive backup OK");
      await persistRollingBackupStatus(null);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, "15-min rolling OneDrive backup FAILED");
      try { await persistRollingBackupStatus(msg); } catch { /* swallow */ }
    }
  };

  setInterval(tick, ROLLING_BACKUP_INTERVAL_MS);
}
